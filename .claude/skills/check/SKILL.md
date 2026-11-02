---
name: check
description: Run the full Keryx verification locally in CI order (backend pytest, frontend vitest, production build). Use before opening a PR, after merging a stack, or when the user asks to "run the tests" or "check everything".
---

# Check

Run `.claude/skills/check/check.sh` from anywhere; it uses absolute paths. It mirrors `ci.yml`:

1. `pytest` in `backend/` with the project venv (`backend/.venv`).
2. `npm test` in `frontend/` (vitest, `src/**/*.test.js`).
3. `npm run build` in `frontend/`, which refreshes `backend/static`.

The script stops at the first failure and prints which stage failed. Paste the failing output into
the reply; never report green on a partial run.

Backend-only edits still need step 1 and step 3 is harmless. Frontend edits need steps 2 and 3.
A deploy must follow a successful step 3, because the container copies `backend/static`.
