#!/usr/bin/env bash
# Host-owned deploy script for the Linear connector (linear-webhook-fancymatt).
# Triggered by the systemd path unit when Astrid touches the request file.
# Astrid CANNOT edit this file (lives outside her container mounts) — she can only
# request a deploy; this script defines exactly what a deploy does.
#
# AI-1832: All builds happen in a dedicated deploy worktree. The shared working
# tree (where agents have feature branches + uncommitted edits) is NEVER touched
# — not its HEAD, not its index, not its tracked files. Only dist/ is copied in.
set -uo pipefail

# AI-1868: connector decoupled from the life-os monorepo into its own repo.
# Paths re-pointed from the dead Code/repos/life-os/linear-webhook-fancymatt[-deploy].
REPO=/home/fancymatt/Code/repos/fancy-openclaw-linear-connector
DEPLOY_WT=/home/fancymatt/Code/repos/fancy-openclaw-linear-connector-deploy
SHARE=/home/fancymatt/.openclaw/linear-connector
RESULT="$SHARE/.deploy-result"
SERVICE=linear-webhook-fancymatt.service
DEPLOY_REF=origin/main
export PATH="/home/fancymatt/.nvm/versions/node/v24.15.0/bin:$PATH"

# AI-2589: support --dry-run for workflow YAML definitions preview.
DRY_RUN=
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

{
  echo "=== linear-connector deploy $(date -Is) ==="

  # ── [0/5] Pre-flight: encryption key validation + stale-.env quarantine ───
  # INF-272 Items 1 & 4: validate that .env in the deploy worktree references
  # a valid encryption key that can decrypt agents.json, and detect stale
  # emergency-restore .env files by checksum comparison.
  #
  # This runs BEFORE any git operation so a bad .env never reaches a restart.
  echo "[0/5] pre-flight: encryption key validation + stale-.env quarantine…"

  ENV_CHKSUM_FILE="$SHARE/.env.checksum"
  ENV_PATH="$DEPLOY_WT/.env"

  # ── [0.1/5] Source .env for key reference validation ───────────────────
  if [ ! -f "$ENV_PATH" ]; then
    echo "RESULT: ENV_MISSING — deploy worktree .env not found at $ENV_PATH"
    echo "         The service cannot start without it. Restore .env from backup"
    echo "         or re-run the onboard wizard. See linear-connector/DEPLOY.md."
    exit 1
  fi
  # shellcheck source=/dev/null
  set -a; source "$ENV_PATH"; set +a

  # ── [0.2/5] Validate encryption key reference ─────────────────────────
  KEY_FILE_VAR="LINEAR_CONNECTOR_ENCRYPTION_KEY_FILE"
  KEY_VAR="LINEAR_CONNECTOR_ENCRYPTION_KEY"
  KEY_SOURCE=
  KEY_VALUE=

  if [ -n "${!KEY_FILE_VAR:-}" ]; then
    KEY_SOURCE="$KEY_FILE_VAR (${!KEY_FILE_VAR})"
    if [ ! -f "${!KEY_FILE_VAR}" ]; then
      echo "RESULT: KEY_FILE_MISSING — $KEY_FILE_VAR points to '${!KEY_FILE_VAR}' which does not exist"
      echo "         The connector cannot start without a valid encryption key."
      echo "         Restore the key file or update .env to reference the correct path."
      exit 1
    fi
    KEY_VALUE="$(cat "${!KEY_FILE_VAR}" | tr -d '[:space:]')"
  elif [ -n "${!KEY_VAR:-}" ]; then
    KEY_SOURCE="$KEY_VAR (inline)"
    KEY_VALUE="${!KEY_VAR}"
  else
    echo "RESULT: KEY_NOT_CONFIGURED — neither $KEY_FILE_VAR nor $KEY_VAR is set in .env"
    exit 1
  fi

  # Validate key looks like base64-encoded 32 bytes (44 chars with padding)
  KEY_LEN=${#KEY_VALUE}
  if [ "$KEY_LEN" -lt 40 ] || [ "$KEY_LEN" -gt 48 ]; then
    echo "RESULT: KEY_INVALID_LENGTH — key from $KEY_SOURCE is ${KEY_LEN} chars, expected ~44 for base64 32-byte key"
    exit 1
  fi
  if ! echo "$KEY_VALUE" | grep -qE '^[A-Za-z0-9+/=]+$'; then
    echo "RESULT: KEY_INVALID_FORMAT — key from $KEY_SOURCE contains non-base64 characters"
    exit 1
  fi

  # ── [0.3/5] Trial-decrypt agents.json ───────────────────────────────────
  AGENTS_FILE="$DEPLOY_WT/agents.json"
  if [ -f "$AGENTS_FILE" ]; then
    AGENTS_RAW=$(head -1 "$AGENTS_FILE")
    AGENTS_PARSE_OK=
    if echo "$AGENTS_RAW" | grep -qE '"version":\s*[0-9]+".*"alg":\s*"AES-256-GCM"' 2>/dev/null || head -5 "$AGENTS_FILE" | grep -q '"alg":.*"AES-256-GCM"' 2>/dev/null; then
      # Attempt trial decrypt via node (available via the PATH set above)
      DECRYPT_RESULT=$(node -e "
        const crypto = require('crypto');
        const fs = require('fs');
        try {
          const raw = fs.readFileSync('$AGENTS_FILE', 'utf8');
          const data = JSON.parse(raw);
          if (!data.alg || data.alg !== 'AES-256-GCM') {
            console.log('NOT_ENCRYPTED');
            process.exit(0);
          }
          const key = Buffer.from('$KEY_VALUE', 'base64');
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
          decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
          const pt = Buffer.concat([decipher.update(Buffer.from(data.ct, 'base64')), decipher.final()]);
          const parsed = JSON.parse(pt.toString('utf8'));
          console.log('OK:' + Object.keys(parsed).length + ' agents');
        } catch (e) {
          console.log('FAIL:' + e.message.replace(/\n/g, ' '));
        }
      " 2>&1)

      case "$DECRYPT_RESULT" in
        OK:*)
          echo "        agents.json decrypts successfully ($DECRYPT_RESULT)"
          AGENTS_PARSE_OK=1
          ;;
        NOT_ENCRYPTED)
          echo "        agents.json is not encrypted — plaintext, acceptable"
          AGENTS_PARSE_OK=1
          ;;
        *)
          echo "RESULT: AGENTS_DECRYPT_FAILED — $DECRYPT_RESULT"
          echo "         The encryption key in .env cannot decrypt agents.json."
          echo "         This is exactly the condition that caused the 2026-07-21"
          echo "         fleet-wide OAuth outage (INF-272). Aborting deploy."
          echo "         Fix: ensure .env references the correct encryption key."
          exit 1
          ;;
      esac
    else
      echo "        agents.json exists but is not an encrypted format — plaintext, acceptable"
      AGENTS_PARSE_OK=1
    fi

    if [ -z "$AGENTS_PARSE_OK" ]; then
      echo "RESULT: AGENTS_PARSE_FAILED — could not determine if agents.json is decryptable"
      exit 1
    fi
  else
    echo "        no agents.json found — deploying fresh (acceptable for initial setup)"
  fi

  # ── [0.4/5] Stale-.env quarantine (Item 4) ─────────────────────────────
  CURRENT_CHKSUM=$(sha256sum "$ENV_PATH" | cut -d' ' -f1)
  if [ -f "$ENV_CHKSUM_FILE" ]; then
    PRIOR_CHKSUM=$(cat "$ENV_CHKSUM_FILE")
    if [ "$CURRENT_CHKSUM" != "$PRIOR_CHKSUM" ]; then
      echo "        .env checksum changed since last successful deploy"
      echo "        prior: $PRIOR_CHKSUM"
      echo "        current: $CURRENT_CHKSUM"
      # The encryption key validation already passed in [0.2] and [0.3],
      # so the .env is usable — log a warning and continue. This catches
      # the case where an emergency-restore .env was swapped in but happens
      # to have the right key (or where a legit .env update was made).
      echo "        WARNING: .env changed since last deploy — verify this change was intentional"
      echo "        Stale-.env quarantine check passed (key is valid for agents.json)"
    fi
  else
    echo "        no prior .env checksum — recording baseline"
  fi

  # ── [1/5] Validate deploy worktree is REAL, not just present ──────────────
  # AI-2409: a bare existence check ([ -e "$DEPLOY_WT/.git" ]) passes on a
  # DANGLING gitdir pointer — a worktree whose admin entry
  # ($REPO/.git/worktrees/<name>/) was pruned/removed out from under it while
  # the dir on disk survived, still holding its gitignored runtime state
  # (.env, agents.json, data/ SQLite DBs). That state fell through to [2/5]
  # and died on a raw FETCH_FAILED instead of an actionable message. Validate
  # the worktree is genuinely registered with git instead of merely present.
  echo "[1/5] validate deploy worktree at $DEPLOY_WT…"
  wt_valid() { git -C "$DEPLOY_WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
  if ! wt_valid; then
    if [ ! -d "$DEPLOY_WT" ]; then
      echo "RESULT: FAILED — deploy worktree not found at $DEPLOY_WT"
      echo "         Recreate with: git -C $REPO worktree add $DEPLOY_WT origin/main"
      echo "         Then restore runtime state (.env, agents.json, data/) — see linear-connector/DEPLOY.md."
      exit 1
    fi
    # Dir exists but git doesn't recognize it as a worktree — the AI-2409
    # dangling-gitdir state. Attempt a NON-DESTRUCTIVE self-heal that rebuilds
    # only the admin metadata under $REPO/.git/worktrees/<name>/ and preserves
    # the worktree's live runtime state (.env, agents.json, data/ are all
    # gitignored, so nothing on disk is checked out over or deleted). We do
    # NOT `worktree add [--force]` here: it refuses a populated path, and
    # clobbering the dir would destroy the live agent registry + SQLite DBs.
    echo "        deploy worktree present but not registered — attempting non-destructive self-heal (AI-2409)…"
    ptr=$(sed -n 's/^gitdir: //p' "$DEPLOY_WT/.git" 2>/dev/null)
    name=${ptr##*/worktrees/}
    if [ -n "$name" ] && [ "$name" != "$ptr" ]; then
      git -C "$REPO" worktree prune 2>&1 || true
      admin="$REPO/.git/worktrees/$name"
      mkdir -p "$admin"
      printf '%s/.git\n' "$DEPLOY_WT" > "$admin/gitdir"
      printf '../..\n' > "$admin/commondir"
      git -C "$REPO" rev-parse HEAD > "$admin/HEAD" 2>/dev/null || true
      git -C "$REPO" worktree repair "$DEPLOY_WT" 2>&1 || true
    fi
    if wt_valid; then
      echo "        self-heal OK — deploy worktree re-registered, runtime state intact"
    else
      echo "RESULT: FAILED — deploy worktree at $DEPLOY_WT has a dangling git metadata"
      echo "         pointer and self-heal did not recover it."
      echo "         This dir holds LIVE runtime state (.env, agents.json, data/ SQLite) — do NOT"
      echo "         delete it. Recover the git metadata manually, e.g.:"
      echo "           git -C $REPO worktree prune && git -C $REPO worktree repair $DEPLOY_WT"
      echo "         or rebuild the admin entry under $REPO/.git/worktrees/. See linear-connector/DEPLOY.md."
      exit 1
    fi
  fi

  # ── [2/5] Pin deploy worktree to origin/main ─────────────────────────────
  # The deploy worktree is a dedicated build tree — agents never work in it.
  # We fetch + hard-reset it to origin/main. This does NOT touch the shared
  # working tree at all.
  echo "[2/5] pin deploy worktree to $DEPLOY_REF…"
  if ! git -C "$DEPLOY_WT" fetch origin main 2>&1; then
    echo "RESULT: FETCH_FAILED — could not fetch $DEPLOY_REF; service left untouched"
    exit 1
  fi
  if ! git -C "$DEPLOY_WT" reset --hard HEAD 2>&1; then
    echo "RESULT: RESET_FAILED — could not clear tracked deploy worktree changes before checkout"
    exit 1
  fi
  # Clean + reset in the deploy worktree only. The shared tree is untouched.
  if ! git -C "$DEPLOY_WT" checkout --detach "$DEPLOY_REF" 2>&1; then
    echo "RESULT: CHECKOUT_FAILED — could not check out $DEPLOY_REF in deploy worktree"
    exit 1
  fi
  if ! git -C "$DEPLOY_WT" reset --hard "$DEPLOY_REF" 2>&1; then
    echo "RESULT: RESET_FAILED — could not reset deploy worktree to $DEPLOY_REF"
    exit 1
  fi
  DEPLOY_COMMIT=$(git -C "$DEPLOY_WT" rev-parse --short HEAD)
  echo "        deploy worktree now at $DEPLOY_REF @ $DEPLOY_COMMIT"

  # ── [3/5] Build in the deploy worktree ──────────────────────────────────
  # Ensure backend deps (incl. devDeps like typescript/tsc) are present before
  # building — the worktree's node_modules can be created without devDeps, which
  # made `npm run build` fail with `tsc: not found` (AI-1893). Mirrors the web
  # step below, which already installs before building. npm ci is lockfile-exact.
  echo "[3/5] install backend deps in deploy worktree (npm ci)…"
  if ! npm --prefix "$DEPLOY_WT" ci --no-audit --no-fund 2>&1; then
    echo "RESULT: BUILD_FAILED — backend dependency install (npm ci) failed, NOT restarted"
    exit 1
  fi
  echo "[3/5] build backend in deploy worktree (npm run build)…"
  export CONNECTOR_DEPLOY_BUILD=1 CONNECTOR_DEPLOY=1
  if ! npm --prefix "$DEPLOY_WT" run build 2>&1; then
    echo "RESULT: BUILD_FAILED — service left running on previous build, NOT restarted"
    exit 1
  fi
  echo "[3.5/5] build web frontend (npm --prefix web run build)…"
  if ! (npm --prefix "$DEPLOY_WT/web" install --no-audit --no-fund 2>&1 && npm --prefix "$DEPLOY_WT/web" run build 2>&1); then
    echo "RESULT: WEB_BUILD_FAILED — service left running on previous build, NOT restarted"
    exit 1
  fi

  # ── [4/5] Sync dist/ to shared tree (atomic swap) ────────────────────────
  # We only copy the build output. Source files, index, HEAD, stash —
  # everything in the shared working tree stays exactly as it was.
  echo "[4/5] sync dist/ to shared tree ($REPO)…"
  if [ ! -d "$DEPLOY_WT/dist" ]; then
    echo "RESULT: BUILD_OUTPUT_MISSING — dist/ not found in deploy worktree"
    exit 1
  fi
  # Use rsync with --delete to ensure dist/ exactly matches the build.
  # --backup --backup-dir gives us a rollback if something goes wrong.
  DIST_BACKUP="$REPO/dist.pre-deploy-$(date +%s)"
  if ! rsync -a --delete --backup --backup-dir="$DIST_BACKUP" "$DEPLOY_WT/dist/" "$REPO/dist/" 2>&1; then
    echo "RESULT: RSYNC_FAILED — could not copy dist/ to shared tree"
    exit 1
  fi
  echo "        dist/ synced (backup at $DIST_BACKUP if rollback needed)"
  # Also sync web/dist/ (frontend SPA) if present.
  if [ -d "$DEPLOY_WT/web/dist" ]; then
    WEB_DIST_BACKUP="$REPO/web/dist.pre-deploy-$(date +%s)"
    rsync -a --delete --backup --backup-dir="$WEB_DIST_BACKUP" "$DEPLOY_WT/web/dist/" "$REPO/web/dist/" 2>&1
    echo "        web/dist/ synced (backup at $WEB_DIST_BACKUP if rollback needed)"
  fi

  # Stamp the deployed commit hash into dist/ so /health reports the
  # correct commit even when the shared working tree is on a feature branch.
  #
  # AI-2357: the service's WorkingDirectory is the DEPLOY worktree (drop-in
  # 20-deploy-repo.conf, AI-2305), so resolveStartupCommit() reads
  # $DEPLOY_WT/dist/DEPLOY_COMMIT — NOT the shared tree. Stamping only $REPO
  # left the deploy-worktree stamp frozen at whatever wrote it last, so /health
  # reported a stale commit forever and no deploy could be verified from it.
  # Stamp the tree the service actually runs from; keep $REPO for back-compat.
  printf '%s' "$DEPLOY_COMMIT" > "$DEPLOY_WT/dist/DEPLOY_COMMIT"
  printf '%s' "$DEPLOY_COMMIT" > "$REPO/dist/DEPLOY_COMMIT"

  # ── [4.5/5] Sync workflow YAML definitions to WORKFLOW_DEFS_DIR ────
  echo "[4.5/5] sync workflow YAML definitions to $SHARE/workflows/…"
  WORKFLOW_DEFS_DIR="$SHARE/workflows"
  if [ -d "$DEPLOY_WT/src/registered-defs" ]; then
    if [ -n "$DRY_RUN" ]; then
      echo "        dry-run: would sync yaml files from $DEPLOY_WT/src/registered-defs/ to $WORKFLOW_DEFS_DIR/"
      for f in "$DEPLOY_WT/src/registered-defs/"*.yaml; do
        [ -f "$f" ] && echo "          would copy: $(basename "$f")"
      done
    else
      mkdir -p "$WORKFLOW_DEFS_DIR"
      WORKFLOW_DEFS_BACKUP="$SHARE/workflows.pre-deploy-$(date +%s)"
      for live_yaml in "$WORKFLOW_DEFS_DIR/"*.yaml; do
        [ -e "$live_yaml" ] || continue
        live_base=$(basename "$live_yaml")
        if [ ! -f "$DEPLOY_WT/src/registered-defs/$live_base" ]; then
          mkdir -p "$WORKFLOW_DEFS_BACKUP"
          mv "$live_yaml" "$WORKFLOW_DEFS_BACKUP/$live_base"
        fi
      done
      if ! rsync -a --backup --backup-dir="$WORKFLOW_DEFS_BACKUP" \
        "$DEPLOY_WT/src/registered-defs/"*.yaml "$WORKFLOW_DEFS_DIR/" 2>&1; then
        echo "RESULT: WORKFLOW_DEF_SYNC_FAILED — could not sync registered workflow defs; NOT restarted"
        exit 1
      fi
      WORKFLOW_DEFS_DELTA=
      for source_yaml in "$DEPLOY_WT/src/registered-defs/"*.yaml; do
        source_base=$(basename "$source_yaml")
        if ! cmp -s "$source_yaml" "$WORKFLOW_DEFS_DIR/$source_base"; then
          WORKFLOW_DEFS_DELTA="${WORKFLOW_DEFS_DELTA}${WORKFLOW_DEFS_DELTA:+
}changed: $source_base"
        fi
      done
      for live_yaml in "$WORKFLOW_DEFS_DIR/"*.yaml; do
        [ -e "$live_yaml" ] || continue
        live_base=$(basename "$live_yaml")
        if [ ! -f "$DEPLOY_WT/src/registered-defs/$live_base" ]; then
          WORKFLOW_DEFS_DELTA="${WORKFLOW_DEFS_DELTA}${WORKFLOW_DEFS_DELTA:+
}extra: $live_base"
        fi
      done
      if [ -n "$WORKFLOW_DEFS_DELTA" ]; then
        echo "RESULT: WORKFLOW_DEF_DRIFT — $WORKFLOW_DEFS_DIR does not match registered-defs after sync; NOT restarted"
        printf '%s\n' "$WORKFLOW_DEFS_DELTA" | sed 's/^/        /'
        exit 1
      fi
      echo "        workflow YAML definitions synced (backup at $WORKFLOW_DEFS_BACKUP if rollback needed)"
    fi
  else
    echo "        src/registered-defs/ not found — skipping (non-fatal)"
  fi

  # ── [4.6/5] Record .env checksum for stale-.env quarantine (INF-272 Item 4) ──
  printf '%s' "$CURRENT_CHKSUM" > "$ENV_CHKSUM_FILE"
  echo "        .env checksum recorded ($CURRENT_CHKSUM)"

  # ── [5/5] Zero-gap restart + health check ──────────────────────────────
  #
  # The old approach (systemctl --user restart) creates a dead window on port
  # 3100 between SIGTERM and the new process binding. For a fleet where every
  # GraphQL call routes through :3100, even 500ms produces ECONNREFUSED flaps.
  #
  # Zero-gap strategy (INF-153):
  #   1. Start the fresh build as a warm standby on port 3101
  #   2. Verify it passes its own /health check
  #   3. Install an iptables OUTPUT DNAT redirecting 127.0.0.1:3100 → 3101
  #   4. Stop the old process — traffic seamlessly flows to the standby via NAT
  #   5. Start the new systemd-managed process (it binds 3100 behind the NAT)
  #   6. Verify /health on 3100 and remove the NAT rule
  #   7. Kill the warm standby
  #
  # Result: the port is never unbound during the swap.
  echo "[5/5] zero-gap restart ($SERVICE)…"

  ALT_PORT=3101
  WARM_PID=
  CLEANUP_DONE=

  cleanup() {
    [ -n "$CLEANUP_DONE" ] && return
    CLEANUP_DONE=1
    # Remove iptables rule if it was created
    sudo iptables -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport 3100 -j DNAT --to-destination 127.0.0.1:$ALT_PORT 2>/dev/null || true
    # Kill warm standby if still alive
    [ -n "$WARM_PID" ] && kill "$WARM_PID" 2>/dev/null || true
    # Restore route_localnet if we changed it
    [ -n "$_ROUTE_LOCALNET_WAS" ] && sysctl -q -w net.ipv4.conf.all.route_localnet="$_ROUTE_LOCALNET_WAS" 2>/dev/null || true
  }
  trap cleanup EXIT

  # ── [5.1/7] Start warm standby on alt port ────────────────────────────
  echo "[5.1/7] start warm standby on :$ALT_PORT…"
  (cd "$DEPLOY_WT" && PORT=$ALT_PORT node dist/index.js) &
  WARM_PID=$!

  echo "[5.2/7] health check on :$ALT_PORT…"
  WARM_OK=
  for i in $(seq 1 10); do
    sleep 1
    if curl -sf --max-time 2 "http://127.0.0.1:$ALT_PORT/health" >/dev/null 2>&1; then
      WARM_OK=1
      echo "        warm standby healthy after ${i}s (pid=$WARM_PID)"
      break
    fi
  done
  if [ -z "$WARM_OK" ]; then
    echo "RESULT: WARM_STANDBY_FAILED — new build did not pass health check on :$ALT_PORT within 10s"
    exit 1
  fi

  # ── [5.3/7] Install iptables DNAT redirect 3100 → 3101 ─────────────────
  # route_localnet is needed because Linux treats 127.0.0.0/8 as martians
  # and drops DNAT packets destined for loopback without it.
  echo "[5.3/7] install iptables DNAT 127.0.0.1:3100 → :$ALT_PORT…"
  _ROUTE_LOCALNET_WAS=$(sysctl -n net.ipv4.conf.all.route_localnet 2>/dev/null || echo 0)
  sudo sysctl -q -w net.ipv4.conf.all.route_localnet=1 2>/dev/null || \
    { echo "RESULT: SYSCTL_FAILED — could not set route_localnet=1"; exit 1; }
  sudo iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 3100 -j DNAT --to-destination 127.0.0.1:$ALT_PORT 2>&1 || \
    { echo "RESULT: IPTABLES_FAILED — could not add DNAT rule"; exit 1; }

  # ── [5.4/7] Stop old service ──────────────────────────────────────────
  # The old process SIGTERMs; its port 3100 is now DNAT'd to the warm standby.
  # No connection sees a dead port.
  echo "[5.4/7] stop old service…"
  systemctl --user stop "$SERVICE" 2>&1 || \
    { echo "WARN: systemctl stop exited $? — continuing"; }

  # ── [5.5/7] Start new service ──────────────────────────────────────────
  # systemd starts the new process on port 3100. The iptables DNAT is still in
  # place so there's no gap — the standby handled everything during the flip.
  echo "[5.5/7] start new service…"
  systemctl --user start "$SERVICE" 2>&1 || \
    { echo "RESULT: FAILED — systemctl start errored"; exit 1; }

  # ── [5.6/7] Health check + commit verification ─────────────────────────
  echo "[5.6/7] health check (http://127.0.0.1:3100/health)…"
  SERVICE_OK=
  for i in $(seq 1 10); do
    sleep 2
    if curl -sf --max-time 3 http://127.0.0.1:3100/health >/dev/null 2>&1; then
      SERVICE_OK=1
      break
    fi
  done

  # Remove iptables DNAT — the new service handles 3100 directly now
  echo "[5.7/7] removing iptables DNAT…"
  sudo iptables -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport 3100 -j DNAT --to-destination 127.0.0.1:$ALT_PORT 2>&1 || true
  # Kill warm standby
  kill "$WARM_PID" 2>/dev/null || true
  WARM_PID=
  # Restore route_localnet
  sysctl -q -w net.ipv4.conf.all.route_localnet="$_ROUTE_LOCALNET_WAS" 2>/dev/null || true
  unset _ROUTE_LOCALNET_WAS
  trap - EXIT

  if [ -z "$SERVICE_OK" ]; then
    echo "RESULT: UNHEALTHY — restarted but /health did not pass within 20s. Check: journalctl --user -u $SERVICE"
    exit 2
  fi

  SHARED_WT=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)
  LIVE_COMMIT=$(curl -sf --max-time 3 http://127.0.0.1:3100/health 2>/dev/null \
    | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')
  case "$LIVE_COMMIT" in
    "$DEPLOY_COMMIT"*)
      echo "RESULT: OK — deployed $DEPLOY_REF @ $DEPLOY_COMMIT, healthy after $((i*2))s ($(date -Is))"
      echo "        verified: /health reports commit $LIVE_COMMIT"
      echo "        zero-gap swap: no dead window on port 3100"
      echo "        shared working tree UNTOUCHED: $SHARED_WT"
      exit 0
      ;;
    *)
      echo "RESULT: COMMIT_MISMATCH — service is healthy but reports commit '$LIVE_COMMIT', expected '$DEPLOY_COMMIT'."
      echo "        The running process is NOT the code just built. Do NOT treat this as deployed."
      echo "        NOTE: the iptables DNAT was removed, so port 3100 is handled by whatever process"
      echo "        currently holds it. Check: journalctl --user -u $SERVICE"
      exit 3
      ;;
  esac
} > "$RESULT" 2>&1
