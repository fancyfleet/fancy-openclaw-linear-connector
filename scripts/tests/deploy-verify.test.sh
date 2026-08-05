#!/usr/bin/env bash
# INF-1264 AC3/AC5 — deploy-verify: confirms the live commit AND that
# post-merge state-desync wedges (LIF-356/375/INF-1198 class) don't reproduce.
#
# TDD failing tests: these assert a distinct, independently-invocable
# deploy-verify capability exists on top of the existing deploy script.
# host-owned/bin/deploy-linear-connector.sh already curls /health and fails
# loudly on a commit mismatch (COMMIT_MISMATCH, exit 3) as part of ITS OWN
# restart flow — that part is a regression pin below (expected to PASS today).
# What does NOT exist yet is (a) a verify step that can run independently of
# a live deploy (so ac-validate/CI can invoke it standalone) and (b) a check
# tying that verify step to the INF-1198 state-desync regression class. Those
# assertions FAIL today.
#
# Design: scan-based, like deploy-linear-connector.test.sh — grep the real
# script(s) for required patterns instead of simulating a deploy, so the test
# can't accidentally "implement" the behavior itself.
set -uo pipefail
pass=0; fail=0
ok(){ echo "  PASS: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_SCRIPT="${DEPLOY_SCRIPT_PATH:-$REPO_ROOT/host-owned/bin/deploy-linear-connector.sh}"
# Independently-invocable verify script — does not exist yet (AC3).
VERIFY_SCRIPT="${DEPLOY_VERIFY_SCRIPT_PATH:-$REPO_ROOT/host-owned/bin/deploy-verify.sh}"

if [ ! -f "$DEPLOY_SCRIPT" ]; then
  echo "FATAL: deploy-linear-connector.sh not found at $DEPLOY_SCRIPT. Can't run tests."
  exit 1
fi

echo "Testing deploy-verify capability."
echo "  deploy script:  $DEPLOY_SCRIPT"
echo "  verify script:  $VERIFY_SCRIPT (expected to exist per AC3)"
echo ""

# ═════════════════════════════════════════════════════════════════════════════
# Regression pin: existing commit-mismatch check in the deploy script.
# This part of AC3/AC5 ("confirms the live commit") is already implemented —
# expected to PASS today. Kept here so a future refactor can't silently drop it
# while adding the new INF-1198 guard below.
# ═════════════════════════════════════════════════════════════════════════════

echo "=== Regression pin: deploy script confirms the live commit post-restart ==="
echo ""

if grep -q "COMMIT_MISMATCH" "$DEPLOY_SCRIPT"; then
  ok "deploy script fails loudly (COMMIT_MISMATCH) when /health's live commit != the commit just built"
else
  no "deploy script no longer verifies the live commit against the deployed commit"
fi

if grep -q "LIVE_COMMIT" "$DEPLOY_SCRIPT"; then
  ok "deploy script reads the live commit from /health before declaring success"
else
  no "deploy script does not read the live commit from /health"
fi

# ═════════════════════════════════════════════════════════════════════════════
# AC3 (new, part 1): a deploy-verify capability must be invocable independently
# of triggering a live deploy — e.g. a standalone script, or a --verify-only /
# --dry-run-verify flag on the existing deploy script — so ac-validate and CI
# can confirm deploy health without re-deploying.
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC3: deploy-verify is independently invocable (not only as a side effect of deploying) ==="
echo ""

if [ -f "$VERIFY_SCRIPT" ]; then
  ok "AC3.1: a standalone deploy-verify script exists ($VERIFY_SCRIPT)"
else
  no "AC3.1: no standalone deploy-verify script found at $VERIFY_SCRIPT"
fi

if [ -f "$VERIFY_SCRIPT" ] && grep -q "http://127.0.0.1:3100/health\|\$HEALTH_URL\|/health" "$VERIFY_SCRIPT" 2>/dev/null; then
  ok "AC3.2: deploy-verify script checks /health independently"
else
  no "AC3.2: deploy-verify script does not check /health (or does not exist)"
fi

# ═════════════════════════════════════════════════════════════════════════════
# AC3 (new, part 2) / AC5 — deploy-verify must also confirm the post-merge
# state-desync wedge class (LIF-356/375/INF-1198) does not reproduce, not just
# that the process reports the right commit. A green commit check with the
# wedge silently reproduced is exactly the failure this AC closes.
# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "=== AC3/AC5: deploy-verify guards against the INF-1198 state-desync wedge class reproducing ==="
echo ""

if [ -f "$VERIFY_SCRIPT" ] && grep -qi "INF-1198\|state-desync\|raw-write" "$VERIFY_SCRIPT" 2>/dev/null; then
  ok "AC3.3: deploy-verify explicitly guards the INF-1198 state-desync regression class"
else
  no "AC3.3: deploy-verify has no guard tying it to the INF-1198 state-desync regression class"
fi

if [ -f "$VERIFY_SCRIPT" ] && grep -qi "rescue-sweep\|anti-entropy\|reconciliation" "$VERIFY_SCRIPT" 2>/dev/null; then
  ok "AC3.4: deploy-verify names the specific reconciliation/rescue-sweep path the wedge class came from"
else
  no "AC3.4: deploy-verify does not reference the reconciliation/rescue-sweep path implicated in the wedge class"
fi

# ── Summary ─────────────────────────────────────────────────────────────

echo ""
echo "========================"
echo " $pass passed, $fail failed"
echo "========================"
[ "$fail" -eq 0 ]
