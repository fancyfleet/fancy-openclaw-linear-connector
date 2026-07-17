#!/usr/bin/env bash
# AI-2574 — ai container: migrate git auth from personal SSH key to Developer App
#
# Acceptance Criteria (from ticket "What's needed"):
#   1. Mount or symlink the credential helper script from one of the agents that
#      already has it
#   2. Wire credential.https://github.com.helper in the container's git config
#   3. Remove the personal SSH key from the container's .ssh mount
#   4. Verify git operations (clone, fetch, push) work through the scoped App token
#   5. Update any git mirrors/docs that reference the old key
#
# These tests validate the FINAL state after the migration is complete. They are
# expected to FAIL now (no credential helper, SSH key still mounted) and PASS
# after the implementer runs the migration steps.
#
# Run against the host from a dev container (tdd) that shares the workspace root:
#   bash scripts/tests/ai-container-dev-app-migration.test.sh

set -uo pipefail

# --- Paths ---
AI_WORKSPACE="/home/node/.openclaw/workspace/ai"
AI_SECRETS_DIR="$AI_WORKSPACE/.secrets"
AI_COMPOSE_FILE="$AI_WORKSPACE/../containers/ai/docker-compose.yml"

# Fallback: the ai container compose is on the host under ~/.openclaw/containers/ai/.
# From in a dev container we can't see host ~/.openclaw/, but the implementer
# validates from the host shell.
#
# For container-side testing, we check the workspace-side artifacts that prove
# the migration was applied.

pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
no()   { echo "  FAIL: $1"; fail=$((fail+1)); }
skip() { echo "  SKIP: $1 (not testable from inside container)"; }

echo "== AC 1: Credential helper script present =="

if [ -f "$AI_SECRETS_DIR/gh-app-helper-venv.sh" ]; then
  ok "gh-app-helper-venv.sh exists in ai/.secrets/"
else
  no "gh-app-helper-venv.sh NOT found in ai/.secrets/ (expected path: $AI_SECRETS_DIR/gh-app-helper-venv.sh)"
fi

if [ -f "$AI_SECRETS_DIR/gh-app-credential-helper.py" ]; then
  ok "gh-app-credential-helper.py exists in ai/.secrets/"
else
  no "gh-app-credential-helper.py NOT found in ai/.secrets/"
fi

if [ -f "$AI_SECRETS_DIR/open-pr.py" ]; then
  ok "open-pr.py exists in ai/.secrets/"
else
  no "open-pr.py NOT found in ai/.secrets/"
fi

if [ -f "$AI_SECRETS_DIR/op-service-account-token" ]; then
  ok "op-service-account-token exists in ai/.secrets/"
  MODE=$(stat -c "%a" "$AI_SECRETS_DIR/op-service-account-token" 2>/dev/null || stat -f "%OLp" "$AI_SECRETS_DIR/op-service-account-token" 2>/dev/null)
  if [ "$MODE" = "600" ]; then
    ok "op-service-account-token has mode 600"
  else
    no "op-service-account-token has mode $MODE (expected 600)"
  fi
else
  no "op-service-account-token NOT found in ai/.secrets/"
fi

echo "== AC 2: Git config wired =="

# Check git global config for the credential helper
GIT_HELPER=$(git config --global --get credential.https://github.com.helper 2>/dev/null || true)
if echo "$GIT_HELPER" | grep -q "gh-app-helper-venv.sh"; then
  ok "credential.https://github.com.helper wired in global git config"
else
  no "credential.https://github.com.helper NOT wired in global git config (got: ${GIT_HELPER:-<unset>})"
fi

# Check useHttpPath is true
HTTP_PATH=$(git config --global --get credential.useHttpPath 2>/dev/null || true)
if [ "$HTTP_PATH" = "true" ]; then
  ok "credential.useHttpPath = true in global git config"
else
  no "credential.useHttpPath is NOT 'true' in global git config (got: ${HTTP_PATH:-<unset>})"
fi

echo "== AC 3: Personal SSH key removed from container =="

# From inside a dev container, we check that the ai workspace has no .ssh mount
# reference. The actual compose file lives on the host, so this check is marker-based:
# the implementer should touch a marker indicating the mount was removed.
MARKER_FILE="$AI_WORKSPACE/.dev-app-migration-complete"

if [ -f "$MARKER_FILE" ]; then
  ok "Migration marker present: .dev-app-migration-complete"
  # Verify the marker says the SSH mount was removed
  if grep -q "ssh-key-removed" "$MARKER_FILE" 2>/dev/null; then
    ok "SSH key removal confirmed in marker"
  else
    no "Marker present but does not confirm SSH key removal"
  fi
else
  skip "Compose file SSH mount check (requires host-level access — see manual verification below)"
fi

echo "== AC 4: Git operations work through App token =="

# Test that the credential helper can mint a token
HELPER="$AI_SECRETS_DIR/gh-app-helper-venv.sh"
if [ -x "$HELPER" ]; then
  TOKEN_OUTPUT=$(printf 'protocol=https\nhost=github.com\npath=fancyfleet/fancy-openclaw-linear-connector\n\n' | "$HELPER" get 2>&1 || true)

  if echo "$TOKEN_OUTPUT" | grep -q "^password="; then
    ok "Credential helper successfully mints a GitHub installation token"

    # Extract the token and verify it works
    TOKEN=$(echo "$TOKEN_OUTPUT" | sed -n 's/^password=//p')
    if [ -n "$TOKEN" ]; then
      INSTALL_CHECK=$(curl -s -H "Authorization: Bearer $TOKEN" \
        https://api.github.com/installation/repositories 2>&1 || true)
      TOTAL_REPOS=$(echo "$INSTALL_CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_count',0))" 2>/dev/null || echo "0")
      if [ "$TOTAL_REPOS" -gt 0 ]; then
        ok "Installation token has access to $TOTAL_REPOS repos"
      else
        no "Installation token returned 0 accessible repos (check installation permissions)"
      fi
    fi
  else
    no "Credential helper FAILED to mint token: $(echo "$TOKEN_OUTPUT" | head -3)"
  fi
else
  no "Credential helper script NOT executable at $HELPER"
fi

echo "== AC 5: Docs updated =="

DOC_PATHS=(
  "/home/node/obsidian-vault/life-os/infra/agents/agent-containers.md"
)

for DOC in "${DOC_PATHS[@]}"; do
  if [ -f "$DOC" ]; then
    # Check that the ai container section no longer references the personal SSH key
    if grep -q "personal SSH key\|\.ssh.*mount\|ssh.*key.*mount" "$DOC" 2>/dev/null; then
      no "Doc $DOC still references personal SSH key mount"
    else
      ok "Doc $DOC does NOT reference personal SSH key mount"
    fi

    # Check that the ai container section references the Developer App credential helper
    if grep -q "Developer App\|gh-app-helper\|dev-app-migration\|credential helper" "$DOC" 2>/dev/null; then
      ok "Doc $DOC updated with Developer App credential helper reference"
    else
      no "Doc $DOC does NOT reference Developer App credential helper"
    fi
  fi
done

echo ""
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
