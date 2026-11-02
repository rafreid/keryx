---
name: stacked-prs
description: Open and merge Keryx's stacked pull requests in order with gh (retarget each to main, merge-commit, keep branches). Use when building a multi-PR feature stack or when the user says "merge all in order".
---

# Stacked PRs

Features that build on each other ship as a stack: each branch starts from the previous branch and
each PR targets the previous branch, so every diff shows only its own change.

## Opening a stack

```bash
git switch -c feat/first main            # first branch from main
# ... commit ...
gh pr create --base main --title "..." --body-file body.md
git switch -c feat/second feat/first     # next branch from the previous one
# ... commit ...
gh pr create --base feat/first --title "..." --body-file body.md
```

Write the body in a file in the scratchpad (no placeholder image links). End every body with the
attribution line Claude Code gives for PRs. Each PR must pass `backend`, `frontend` and `image`.

## Merging a stack

```bash
.claude/skills/stacked-prs/merge-stack.sh 23 24 25 26
```

For each PR number, in the order given, the script:

1. Waits for the PR's checks to finish and stops if any failed.
2. Retargets it to `main` (`gh pr edit N --base main`). GitHub recomputes the diff against main,
   which after the previous merge contains only this PR's commits.
3. Merges with a merge commit (`gh pr merge N --merge`), no branch deletion.

Order matters: bottom of the stack first. Branches stay in place after the merge; deleting them is
the user's decision. After the last merge, wait for `ci`, `image` and `pages build and deployment`
on main before deploying:

```bash
gh run list --branch main --limit 3
```

## Afterwards

Pull main (`git switch main && git pull --ff-only`) before running the `deploy` skill. Record the
stack in memory if it is a multi-day effort.
