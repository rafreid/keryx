# Keryx

Keryx (κῆρυξ, the Greek herald who carried messages for Hermes) watches the Hermes agent.
Live view of what the Hermes agent is doing: a health header, a "right now" strip of running
sessions, and a 3D/2D force graph of sessions, subagents, tools, models and cron jobs, built on
[3d-force-graph](https://github.com/vasturiano/3d-force-graph) via react-force-graph.

- Away from home (Tailscale): http://100.99.160.22:9120/
- On the home LAN: http://192.168.1.100:9120/
- Deep links: `?hours=24&view=2d`
- Repository: https://github.com/rafreid/keryx

## Layout

```
backend/   FastAPI app (app.py), Dockerfile, requirements.txt, static/ (built front end)
frontend/  Vite + React source; `npm run build` writes into backend/static
```

Runs as the `keryx` service in `/opt/hermes/docker-compose.yml`, built from `/opt/keryx`
(a copy of `backend/`). It mounts the Hermes data volume and reads it through in-memory snapshots.

## Deploy after a change

```bash
cd ~/HERMES/keryx/frontend && npm run build          # only if the UI changed
cd ~/HERMES && scp -r keryx/backend/{app.py,requirements.txt,Dockerfile,static} root@100.99.160.22:/opt/keryx/
ssh root@100.99.160.22 'cd /opt/hermes && docker compose up -d --build keryx'
```

## What it shows

| Area | Source | Notes |
|---|---|---|
| Health header | `gateway_heartbeats`, `logs/gateway.log`, cron executions, `logs/errors.log`, session end reasons | green / amber / red per check; worst drives the title dot |
| Right now | sessions with no `ended_at` | user request, latest assistant step or tool call, elapsed, idle, calls/min, subagents |
| Graph | `sessions`, `messages`, `session_model_usage`, `async_delegations`, `cron/*` | per-session tool rings, spawn links carry delegation state and goal |
| Side panel | tabs: overview (health, tokens, legend with show/hide checkboxes), sessions (grouped by platform, running pinned), analytics (daily trend, model share, totals), logs (gateway/agent/error tails with level + keyword filters) | selecting a session shows its turn-by-turn trace with expandable tool arguments/results; selecting a tool cube lists its calls |

Session status: running, stale (idle > 30 min), ended, closed by user, orphaned (killed by a gateway
restart), failed (ended with tool errors). Tool failures come from the JSON result Hermes stores
(`exit_code` / `error`), not keyword matching. Nodes fade with age inside the window; particles flow on
links touched in the last 5 minutes and speed up with calls per minute. Hover highlights a neighbourhood,
search dims non-matches, clicking a platform collapses it, the replay bar re-queries the graph as of any
moment in the window.

Keyboard: `⌘K` / `Ctrl+K` focuses search and opens the sessions tab; `Esc` clears the selection. The ☾/☀ button toggles light and dark themes.

Ideas borrowed from [Ekko Studio](https://github.com/EKKOLearnAI/ekko-studio): usage analytics with a daily trend and model distribution, tool-call traces with argument/result expansion, sessions grouped by source with live ones pinned, a filterable log viewer, per-turn usage and cache-hit reporting, session search, and themes.

## API

- `GET /api/graph?hours=24[&at=<epoch>]`  nodes/links; `at` replays the graph as of that moment
- `GET /api/analytics?days=30`  daily trend (sessions, messages, tool calls, failures, tokens), model share, totals
- `GET /api/session/{id}/trace?limit=300[&tool=name]`  ordered steps (user / assistant / tool call with args + result)
- `GET /api/logs?file=errors|gateway|agent|boot|restart|dashboard-auth&level=WARNING&q=text&lines=200`
- `GET /api/now`      running sessions digest
- `GET /api/status`   health checks
- `GET /api/cost?hours=24`  tokens/cost per model
- `GET /api/stream?hours=24`  server-sent events, one `update` per data change (keyed on file mtimes incl. the WAL)
- `GET /api/health`   liveness

## Tuning

`ACTIVE_WINDOW` and `STALE_AFTER` (env or top of `app.py`); colours and labels in `frontend/src/util.js`.
