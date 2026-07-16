#!/usr/bin/env bash
set -euo pipefail
#
# connector-worktree-remove.sh — remove an isolated connector worktree created
# by connector-worktree.sh (AI-2475).
#
# Refuses to remove a worktree that has uncommitted changes unless --force is
# given, so cleanup can't silently discard work-in-progress. Always prunes stale
# registrations at the end.
#
# Usage:
#   scripts/connector-worktree-remove.sh <branch-name> [--force|-f]

BRANCH="${1:?usage: connector-worktree-remove.sh <branch-name> [--force]}"

FORCE=""
case "${2:-}" in
  --force|-f) FORCE="--force" ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
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
