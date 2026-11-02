#!/usr/bin/env bash
# Run Keryx's checks in CI order: backend pytest, frontend vitest, production build.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY=python3

stage() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

stage "backend: pytest"
(cd "$ROOT/backend" && "$PY" -m pytest) || { echo "FAILED: backend tests" >&2; exit 1; }

stage "frontend: vitest"
(cd "$ROOT/frontend" && npm test --silent) || { echo "FAILED: frontend tests" >&2; exit 1; }

stage "frontend: build"
(cd "$ROOT/frontend" && npm run build --silent) || { echo "FAILED: frontend build" >&2; exit 1; }

stage "all checks passed"
