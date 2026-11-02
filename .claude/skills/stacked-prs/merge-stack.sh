#!/usr/bin/env bash
# Merge stacked PRs in order: wait for checks, retarget to main, merge-commit, keep the branch.
# Usage: merge-stack.sh <pr-number> [<pr-number> ...]   (bottom of the stack first)
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <pr-number> [...]" >&2; exit 2; }

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

for n in "$@"; do
  state="$(gh pr view "$n" --json state -q .state)"
  if [ "$state" = "MERGED" ]; then say "#$n already merged, skipping"; continue; fi
  [ "$state" = "OPEN" ] || { echo "#$n is $state, stopping" >&2; exit 1; }

  say "#$n: waiting for checks"
  gh pr checks "$n" --watch --fail-fast || { echo "#$n has failing checks, stopping" >&2; exit 1; }

  say "#$n: retargeting to main"
  gh pr edit "$n" --base main >/dev/null

  say "#$n: merging"
  gh pr merge "$n" --merge
done

say "stack merged; main workflows:"
gh run list --branch main --limit 3
