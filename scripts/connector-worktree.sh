#!/usr/bin/env bash
set -euo pipefail
#
# connector-worktree.sh — create an isolated git worktree for connector dev
# work on a single ticket/branch (AI-2475).
#
# WHY: multiple agent sessions share one connector clone. With one working tree
# and one HEAD, a concurrent session's `git checkout` yanks your checkout out
# from under you mid-edit, and a `git add -A` in one session can capture
# another's half-finished state under the wrong commit message. A worktree
# gives each session its OWN HEAD, index, and files, sharing only .git/objects.
#
# Worktrees live under .worktrees/<slug> (gitignored) so `git add -A` in the
# primary tree can never re-capture them as gitlinks — the trap that put two
# broken gitlinks on main in the first place.
#
# Usage:
#   scripts/connector-worktree.sh <branch-name> [base-ref]
#
# Output: the absolute worktree path on stdout (last line). All progress goes to
# stderr, so callers can safely:
#   cd "$(scripts/connector-worktree.sh ai-2500-my-fix)"
#
# Behavior:
#   - existing local branch   -> checked out into the worktree
#   - existing remote branch  -> tracked (origin/<branch>) into the worktree
#   - new branch              -> created off base-ref (default origin/main)
#   - already-present worktree -> reused idempotently

BRANCH="${1:?usage: connector-worktree.sh <branch-name> [base-ref]}"
BASE_REF="${2:-origin/main}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Slugify: worktree dir names can't contain '/' from branch names like feat/x.
SLUG="$(printf '%s' "$BRANCH" | tr '/ ' '--' | tr -cd 'A-Za-z0-9._-')"
WT_PATH="$REPO_ROOT/.worktrees/$SLUG"

if git -C "$REPO_ROOT" worktree list --porcelain | grep -qxF "worktree $WT_PATH"; then
  echo "worktree already present, reusing: $WT_PATH" >&2
  echo "$WT_PATH"
  exit 0
fi

git -C "$REPO_ROOT" fetch --quiet origin \
  || echo "warning: git fetch failed; branching from local refs" >&2

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$REPO_ROOT" worktree add "$WT_PATH" "$BRANCH" >&2
elif git -C "$REPO_ROOT" ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git -C "$REPO_ROOT" worktree add -B "$BRANCH" "$WT_PATH" "origin/$BRANCH" >&2
else
  git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WT_PATH" "$BASE_REF" >&2
fi

echo "$WT_PATH"
