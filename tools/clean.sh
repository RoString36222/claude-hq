#!/usr/bin/env bash
# Reclaim disk on a dev machine: everything here is rebuilt on demand.
#
#   tools/clean.sh          show what would go (a dry run)
#   tools/clean.sh --yes    remove it
#
# Removes: agent/workflow worktrees under .claude/worktrees that have no uncommitted changes
# (their branches stay), Rust debug builds and incremental caches in backend/ and dashboard-rs/,
# and the shared agent build dir. Keeps: the release binaries (the dashboard and the local Arena
# run from them), the main checkout, every branch, and any worktree with uncommitted work.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
GO=0; [ "${1:-}" = "--yes" ] && GO=1

size() { du -sh "$1" 2>/dev/null | cut -f1; }
gone() { if [ "$GO" = 1 ]; then rm -rf "$1"; echo "  removed $1 ($2)"; else echo "  would remove $1 ($2)"; fi; }

echo "Worktrees (.claude/worktrees):"
git worktree list --porcelain | awk '/^worktree /{print $2}' | grep "/.claude/worktrees/" | while read -r w; do
  if [ -n "$(git -C "$w" status --porcelain 2>/dev/null | grep -v '^??' || true)" ]; then
    echo "  keeping $w (uncommitted changes)"; continue
  fi
  s=$(size "$w")
  if [ "$GO" = 1 ]; then git worktree remove --force "$w" && echo "  removed $w ($s)"; else echo "  would remove $w ($s)"; fi
done
[ "$GO" = 1 ] && git worktree prune

echo "Rust build output (release binaries kept):"
for t in backend/target dashboard-rs/target; do
  for d in "$t/debug" "$t/release/incremental" "$t/tmp"; do [ -e "$d" ] && gone "$d" "$(size "$d")"; done
done
[ -e .cargo-shared-target ] && gone .cargo-shared-target "$(size .cargo-shared-target)"

[ "$GO" = 1 ] || echo "Dry run. Run: tools/clean.sh --yes"
