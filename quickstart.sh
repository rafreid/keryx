#!/usr/bin/env bash
# Keryx quick start: find the Hermes data directory, start Keryx beside it, open the page.
#
#   ./quickstart.sh                 # Docker if available, otherwise Python
#   ./quickstart.sh --build         # build the image from this checkout instead of pulling it
#   ./quickstart.sh --python        # skip Docker, run uvicorn directly
#   HERMES_HOME=/srv/hermes ./quickstart.sh   # point at a non-standard data directory
#
# Keryx only reads the Hermes data directory (state.db, cron/, logs/). It never writes to it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${GRAPH_PORT:-9120}"
MODE=auto
for a in "$@"; do
  case "$a" in
    --build) MODE=build ;;
    --python) MODE=python ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. where is Hermes' data? -------------------------------------------------------------
if [ -z "${HERMES_HOME:-}" ]; then
  for cand in "$HOME/.hermes" /opt/hermes-data /opt/data; do
    if [ -f "$cand/state.db" ]; then HERMES_HOME="$cand"; break; fi
  done
fi
[ -n "${HERMES_HOME:-}" ] || die "could not find a Hermes data directory (no state.db in ~/.hermes, /opt/hermes-data or /opt/data).
  Native install: it is ~/.hermes.  Hermes in Docker: the host directory you mount at /opt/data.
  Then run:  HERMES_HOME=/path/to/it ./quickstart.sh"
[ -f "$HERMES_HOME/state.db" ] || die "$HERMES_HOME has no state.db. Start Hermes once, or check the path."
[ -r "$HERMES_HOME/state.db" ] || die "$HERMES_HOME/state.db is not readable by $(id -un). Hermes keeps its directory mode 0700: run this as the user who owns it."
say "Hermes data: $HERMES_HOME"

# owner of the data directory: Keryx must run as that user to read a 0700 directory
if stat -c %u "$HERMES_HOME" >/dev/null 2>&1; then
  UID_="$(stat -c %u "$HERMES_HOME")"; GID_="$(stat -c %g "$HERMES_HOME")"
else
  UID_="$(stat -f %u "$HERMES_HOME")"; GID_="$(stat -f %g "$HERMES_HOME")"
fi

# ---- 2. Docker or Python? ------------------------------------------------------------------
have_docker() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
if [ "$MODE" = auto ]; then
  if have_docker; then MODE=docker; else MODE=python; say "Docker not available, running with Python"; fi
fi

wait_healthy() {
  for _ in $(seq 1 40); do
    if curl -fs "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"state_db":true'; then
      say "Keryx is up: http://localhost:$PORT/"
      [ -n "${HERMES_DASHBOARD_URL:-}" ] || echo "    tip: HERMES_DASHBOARD_URL=http://<host>:9119 adds links into the Hermes dashboard"
      return 0
    fi
    sleep 1
  done
  die "Keryx did not answer on port $PORT. Check the logs: $1"
}

case "$MODE" in
  docker|build)
    have_docker || die "Docker with the compose plugin is required for this mode (or use --python)"
    export HERMES_HOME HERMES_UID="$UID_" HERMES_GID="$GID_" GRAPH_PORT="$PORT"
    if [ "$MODE" = build ]; then
      [ -f backend/static/index.html ] || { command -v npm >/dev/null || die "--build needs Node 18+ (npm) to build the front end"
        say "building the front end"; (cd frontend && npm install --no-audit --no-fund && npm run build); }
      say "building the image"; docker compose build keryx
    else
      say "pulling the Keryx image"
      if ! docker compose pull keryx 2>/dev/null; then
        say "pull failed (offline, or no published image yet); building from this checkout instead"
        exec "$0" --build
      fi
    fi
    docker compose up -d keryx
    wait_healthy "docker compose logs keryx"
    ;;
  python)
    command -v python3 >/dev/null || die "python3 is required"
    if [ ! -f backend/static/index.html ]; then
      command -v npm >/dev/null || die "the front end is not built and npm is missing. Install Node 18+ or use Docker."
      say "building the front end"; (cd frontend && npm install --no-audit --no-fund && npm run build)
    fi
    [ -d backend/.venv ] || { say "creating a virtualenv"; python3 -m venv backend/.venv; }
    backend/.venv/bin/pip install -q -r backend/requirements.txt
    say "starting uvicorn on port $PORT (logs: backend/keryx.log)"
    # fully detached (own session where setsid exists, no inherited pipes) so a calling shell never waits on it
    DETACH=""; command -v setsid >/dev/null 2>&1 && DETACH=setsid
    (cd backend && HERMES_DATA="$HERMES_HOME" nohup $DETACH .venv/bin/uvicorn app:app --host 0.0.0.0 --port "$PORT" < /dev/null > keryx.log 2>&1 &)
    wait_healthy "backend/keryx.log"
    echo "    stop it with:  pkill -f 'uvicorn app:app.*--port $PORT'"
    ;;
esac
