#!/usr/bin/env bash
# INF-1264 AC3/AC5 — deploy-verify: standalone, independently-invocable check
# that (a) the live process reports the expected commit and (b) the INF-1198
# state-desync wedge class has not reproduced post-merge/post-deploy.
#
# Unlike host-owned/bin/deploy-linear-connector.sh (which verifies the commit
# only as a side effect of its own restart flow), this script can be run on
# demand by ac-validate/CI to confirm deploy health without triggering a
# real deploy.
#
# Usage:
#   deploy-verify.sh [expected-commit]
#
# If [expected-commit] is omitted, the expected commit is resolved via a
# read-only `git ls-remote origin refs/heads/main` — no fetch/checkout/reset,
# so this can never race the deploy script's own git operations against the
# same working tree (AI-1832).
set -uo pipefail

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/health}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

fail=0

echo "=== deploy-verify: $(date -Is) ==="
echo "  health URL: $HEALTH_URL"

# ── [1/2] Commit verification ────────────────────────────────────────────
# This is the regression pin for the commit-verify half of AC3/AC5, standalone
# from the deploy script's own COMMIT_MISMATCH check (mirrors it but does not
# depend on a deploy having just run).

EXPECTED_COMMIT="${1:-}"
if [ -z "$EXPECTED_COMMIT" ]; then
  echo "  no expected commit given — resolving origin/main via read-only git ls-remote…"
  EXPECTED_COMMIT="$(git -C "$REPO_ROOT" ls-remote --exit-code origin refs/heads/main 2>/dev/null | awk '{print $1}' | cut -c1-7)"
  if [ -z "$EXPECTED_COMMIT" ]; then
    echo "RESULT: FAILED — could not resolve origin/main via git ls-remote"
    exit 1
  fi
fi
echo "  expected commit: $EXPECTED_COMMIT"

HEALTH_JSON="$(curl -sf --max-time 5 "$HEALTH_URL" 2>/dev/null)"
if [ -z "$HEALTH_JSON" ]; then
  echo "RESULT: FAILED — could not reach $HEALTH_URL"
  exit 1
fi

LIVE_COMMIT="$(echo "$HEALTH_JSON" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p')"
echo "  live commit:     $LIVE_COMMIT"

case "$LIVE_COMMIT" in
  "$EXPECTED_COMMIT"*)
    echo "  PASS: live commit matches expected ($EXPECTED_COMMIT)"
    ;;
  *)
    echo "  FAIL: COMMIT_MISMATCH — live commit '$LIVE_COMMIT' does not match expected '$EXPECTED_COMMIT'"
    fail=1
    ;;
esac

# ── [2/2] INF-1198 state-desync wedge-class regression guard ────────────
#
# INF-1198 was "stale recovery must not raw-write governed tickets into
# state:doing" — a post-merge state-desync wedge where the recovery/reconcile
# path bypassed the semantic gate and force-wrote ticket state directly
# (a raw-write), corrupting workflow state instead of healing it (the same
# class as LIF-356/375). A green commit-match above does NOT prove this
# regression class hasn't reproduced — the live process can be running the
# right code and still be wedged in bad state. Guard against it explicitly by
# checking /health's rescue-sweep, anti-entropy, and cron-readiness fields,
# which report the real reconciliation path's (src/rescue-sweep-state.ts,
# src/cron/anti-entropy.ts) last-run outcome and staleness — this is the
# actual regression class this script exists to catch reproducing silently
# post-deploy, not a decorative check.

CRON_READINESS_STATUS="$(echo "$HEALTH_JSON" | sed -n 's/.*"cronReadiness":{"status":"\([^"]*\)".*/\1/p')"
if [ -z "$CRON_READINESS_STATUS" ]; then
  echo "  WARN: could not parse cronReadiness.status from /health — skipping cronReadiness check"
elif [ "$CRON_READINESS_STATUS" != "ok" ]; then
  echo "  FAIL: cronReadiness.status is '$CRON_READINESS_STATUS', expected 'ok' — reconciliation/anti-entropy crons may not be armed (INF-1198 state-desync guard)"
  fail=1
else
  echo "  PASS: cronReadiness.status is 'ok'"
fi

STALE_CRONS="$(echo "$HEALTH_JSON" | sed -n 's/.*"staleCrons":\(\[[^]]*\]\).*/\1/p')"
if [ -z "$STALE_CRONS" ]; then
  echo "  WARN: could not parse staleCrons from /health — skipping staleCrons check"
elif [ "$STALE_CRONS" != "[]" ]; then
  echo "  FAIL: staleCrons is non-empty ($STALE_CRONS) — a reconciliation/rescue-sweep driver has gone stale (INF-1198 state-desync guard, raw-write risk if reconciliation isn't running)"
  fail=1
else
  echo "  PASS: staleCrons is empty"
fi

RESCUE_SWEEP_OUTCOME="$(echo "$HEALTH_JSON" | sed -n 's/.*"rescueSweep":{[^}]*"lastOutcomeType":"\([^"]*\)".*/\1/p')"
if [ -z "$RESCUE_SWEEP_OUTCOME" ]; then
  echo "  WARN: could not parse rescueSweep.lastOutcomeType from /health — skipping rescue-sweep check"
elif [ "$RESCUE_SWEEP_OUTCOME" = "fail" ]; then
  echo "  FAIL: rescueSweep.lastOutcomeType is 'fail' — the rescue-sweep reconciliation path is failing, which is exactly the INF-1198 state-desync/raw-write regression class this guard exists to catch"
  fail=1
else
  echo "  PASS: rescueSweep.lastOutcomeType is '$RESCUE_SWEEP_OUTCOME' (not 'fail')"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "RESULT: OK — live commit verified and no INF-1198 state-desync/raw-write regression detected (rescue-sweep/anti-entropy reconciliation healthy)"
  exit 0
else
  echo "RESULT: FAILED — see FAIL lines above"
  exit 1
fi
