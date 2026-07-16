#!/usr/bin/env bash
set -euo pipefail
#
# connector-worktree-remove.sh — remove or reap isolated connector worktrees
# created by connector-worktree.sh (AI-2475, prune/age-out added AI-2481).
#
# Two modes:
#
#   Named removal:  connector-worktree-remove.sh <branch-name> [--force|-f]
#   Bulk prune:     connector-worktree-remove.sh --prune [--age-days N] [--dry-run]
#
# NAMED removal refuses to remove a worktree that has uncommitted changes unless
# --force is given, so cleanup can't silently discard work-in-progress.
#
# --PRUNE reaps worktrees that are DONE, and is designed to run unattended from
# cron against the shared clone even while other sessions are active. It removes a
# worktree only when:
#   - its tree is CLEAN, AND
#   - its branch is already merged into origin/main (the work landed), OR
#   - --age-days N is given and the branch tip's commit is older than N days.
# A DIRTY worktree is NEVER removed by --prune — it is reported and kept. Removing
# a worktree never deletes its branch ref, so even an unpushed-but-clean branch
# loses no commits when reaped; only uncommitted changes could be lost, and those
# are exactly what the clean-gate protects. Creating/removing a worktree never
# moves the shared clone's primary HEAD (the AI-2475 invariant), so this is safe
# to run while sessions work in the bare tree.
#
# Both modes always end with `git worktree prune` to clear stale registrations.

# The MAIN working tree is always the first entry of `git worktree list`, no
# matter which worktree we were invoked from. Deriving it this way (rather than
# `git rev-parse --show-toplevel`, which returns the *current* worktree) means the
# script is correct whether run from the shared clone or from inside a worktree,
# and prune only ever touches paths under "$REPO_ROOT/.worktrees/".
REPO_ROOT="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"

# _prune_one <worktree-path> <branch-ref> — decide + act for a single worktree,
# updating the outer-scope counters (removed / kept_dirty / kept_active). Reads
# globals AGE_DAYS, DRY_RUN, NOW, REPO_ROOT set by prune mode.
_prune_one() {
  local wt="$1" ref="$2" branch=""
  [ -n "$ref" ] && branch="${ref#refs/heads/}"

  # Dirty tree → never reap.
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    echo "keep (dirty): $wt" >&2
    kept_dirty=$((kept_dirty + 1))
    return 0
  fi

  local reap=""
  if [ -n "$branch" ] \
     && git -C "$REPO_ROOT" merge-base --is-ancestor "refs/heads/$branch" origin/main 2>/dev/null; then
    reap="merged"
  elif [ -n "$AGE_DAYS" ] && [ -n "$branch" ]; then
    local tip_ts age_days
    tip_ts="$(git -C "$REPO_ROOT" log -1 --format=%ct "refs/heads/$branch" 2>/dev/null || echo "")"
    if [ -n "$tip_ts" ]; then
      age_days=$(( (NOW - tip_ts) / 86400 ))
      [ "$age_days" -ge "$AGE_DAYS" ] && reap="aged(${age_days}d)"
    fi
  fi

  if [ -z "$reap" ]; then
    echo "keep (active): $wt" >&2
    kept_active=$((kept_active + 1))
    return 0
  fi

  if [ -n "$DRY_RUN" ]; then
    echo "would remove ($reap): $wt" >&2
  else
    git -C "$REPO_ROOT" worktree remove "$wt"
    echo "removed ($reap): $wt" >&2
  fi
  removed=$((removed + 1))
}

# ── prune mode ──────────────────────────────────────────────────────────────
if [ "${1:-}" = "--prune" ]; then
  shift
  AGE_DAYS=""
  DRY_RUN=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --age-days) AGE_DAYS="${2:?--age-days needs a number}"; shift 2 ;;
      --dry-run)  DRY_RUN="1"; shift ;;
      *) echo "unknown --prune option: $1" >&2; exit 2 ;;
    esac
  done

  git -C "$REPO_ROOT" fetch --quiet origin \
    || echo "warning: git fetch failed; merged-check uses stale origin/main" >&2

  NOW="$(date +%s)"
  removed=0 kept_dirty=0 kept_active=0

  # Walk worktrees, skipping the primary tree (== REPO_ROOT). Trailing `echo`
  # emits the blank line that terminates the last record.
  wt=""; br=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) wt="${line#worktree }" ;;
      "branch "*)   br="${line#branch }" ;;   # e.g. refs/heads/ai-2481-foo
      "")
        # Only ever consider worktrees living under the managed .worktrees/ dir.
        # The main tree and any hand-made external worktree are never touched.
        case "$wt" in
          "$REPO_ROOT"/.worktrees/*) _prune_one "$wt" "$br" ;;
        esac
        wt=""; br=""
        ;;
    esac
  done < <(git -C "$REPO_ROOT" worktree list --porcelain; echo)

  echo "prune summary: removed=$removed kept_dirty=$kept_dirty kept_active=$kept_active" >&2
  git -C "$REPO_ROOT" worktree prune
  exit 0
fi

# ── named-removal mode ──────────────────────────────────────────────────────
BRANCH="${1:?usage: connector-worktree-remove.sh <branch-name> [--force] | --prune [--age-days N] [--dry-run]}"

FORCE=""
case "${2:-}" in
  --force|-f) FORCE="--force" ;;
esac

SLUG="$(printf '%s' "$BRANCH" | tr '/ ' '--' | tr -cd 'A-Za-z0-9._-')"
WT_PATH="$REPO_ROOT/.worktrees/$SLUG"

if [ ! -e "$WT_PATH" ]; then
  echo "no worktree at: $WT_PATH — pruning stale registrations" >&2
  git -C "$REPO_ROOT" worktree prune
  exit 0
fi

if [ -n "$FORCE" ]; then
  git -C "$REPO_ROOT" worktree remove --force "$WT_PATH"
elif ! git -C "$REPO_ROOT" worktree remove "$WT_PATH" 2>/dev/null; then
  echo "refusing to remove: $WT_PATH has uncommitted changes or is dirty." >&2
  echo "commit and push first, or re-run with --force to discard them." >&2
  exit 1
fi

echo "removed worktree: $WT_PATH" >&2
git -C "$REPO_ROOT" worktree prune
