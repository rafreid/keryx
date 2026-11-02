---
name: deploy
description: Build Keryx and redeploy it to the user's Hermes host (rsync to /opt/keryx, rebuild the keryx container, verify /api/health). Use when the user says "redeploy", "deploy", or "merge and redeploy" after the merge is done.
---

# Deploy

Production is the Hermes host `root@192.168.1.100`. Keryx lives flat in `/opt/keryx` and is built by
the Hermes compose project in `/opt/hermes` (`docker compose up -d --build keryx`).

## Preconditions

- Be on `main` with the merged changes pulled (`git pull --ff-only`). Deploying a branch is wrong
  unless the user explicitly asks for it.
- `.claude/skills/check/check.sh` passed, or at least `npm run build` just ran, because the
  container copies `backend/static`.

## Run

```bash
.claude/skills/deploy/deploy.sh
```

The script:

1. Reads the expected version from `backend/app.py`.
2. Builds the front end.
3. Rsyncs `backend/` to `/opt/keryx` (deleting removed files, excluding `.venv`, caches, tests, logs).
4. Rebuilds and restarts the `keryx` service.
5. Polls `/api/health` on the host until it answers, then checks the reported version matches.

Override `KERYX_HOST`, `KERYX_REMOTE_DIR` or `KERYX_COMPOSE_DIR` in the environment if the host
layout changes. The script never touches Hermes' data directory.

## Report

State the version reported by health, and whether it is a parity rebuild (no app change since the
last deploy) or a real update. If health never answers, show the container logs:

```bash
ssh root@192.168.1.100 'docker logs --tail 50 keryx'
```
