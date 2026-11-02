#!/usr/bin/env bash
# Build Keryx's front end, rsync the backend to the Hermes host, rebuild the container, verify health.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOST="${KERYX_HOST:-root@192.168.1.100}"
REMOTE_DIR="${KERYX_REMOTE_DIR:-/opt/keryx}"
COMPOSE_DIR="${KERYX_COMPOSE_DIR:-/opt/hermes}"
PORT="${KERYX_PORT:-9120}"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

WANT="$(sed -n 's/.*FastAPI(title="Keryx", version="\([^"]*\)").*/\1/p' "$ROOT/backend/app.py")"
[ -n "$WANT" ] || die "could not read the version from backend/app.py"
say "deploying Keryx $WANT from $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) @ $(git -C "$ROOT" rev-parse --short HEAD)"

say "building front end"
(cd "$ROOT/frontend" && npm run build --silent)
[ -f "$ROOT/backend/static/index.html" ] || die "backend/static/index.html missing after build"

say "syncing backend/ to $HOST:$REMOTE_DIR"
rsync -a --delete \
  --exclude .venv --exclude __pycache__ --exclude .pytest_cache --exclude keryx.log --exclude tests \
  "$ROOT/backend/" "$HOST:$REMOTE_DIR/"

say "rebuilding the keryx container"
ssh "$HOST" "cd $COMPOSE_DIR && docker compose up -d --build keryx" >/dev/null

say "waiting for /api/health"
GOT=""
for _ in $(seq 1 30); do
  GOT="$(ssh "$HOST" "wget -qO- http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [ -n "$GOT" ] && break
  sleep 2
done
[ -n "$GOT" ] || die "health never answered; try: ssh $HOST 'docker logs --tail 50 keryx'"

VER="$(printf '%s' "$GOT" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
[ "$VER" = "$WANT" ] || die "host reports version '$VER', expected '$WANT'"
printf '%s\n' "$GOT"
say "Keryx $VER is healthy on $HOST"
