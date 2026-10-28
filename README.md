# Keryx

Keryx is a live visual activity monitor for Hermes-Agents. It reads the agent's own records, its SQLite state, cron store and logs, without touching them, and turns them into a 3D force graph dashboard where shape, color and position inform. Keryx runs as a small FastAPI container beside Hermes-Agent and serves a React front end on port 9120.

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
| Side panel | tabs: overview (health, recent file changes, tokens, legend with show/hide checkboxes), sessions (grouped by platform, running pinned), tasks (delegations board + scheduled jobs), analytics (daily trend, model share, totals), logs (gateway/agent/error tails with level + keyword filters) | tabs carry badges for things that want attention; selecting a session shows its context gauge, the files it touched and its turn-by-turn trace with expandable tool arguments/results; selecting a tool cube lists its calls |

Session status: running, waiting for you (the session is open and the last message is Hermes' reply, so
the next move is yours — typical for a Telegram chat between messages), stale (mid-turn and idle > 30 min),
ended, closed by user, orphaned (killed by a gateway restart), failed (ended with tool errors). Tool failures come from the JSON result Hermes stores
(`exit_code` / `error`), not keyword matching. Nodes fade with age inside the window; particles flow on
links touched in the last 5 minutes and speed up with calls per minute. Hover highlights a neighbourhood,
search dims non-matches, clicking a platform collapses it, the replay bar re-queries the graph as of any
moment in the window.

The time axis at the left of the graph is clickable: each label selects the span between that tick and the next ("now" = the most recent step, "−1d" = started between one and two days ago) and the graph shows only sessions that started in it; the stats bar then reads "showing N of M". Click the label again or "show all" to clear.

The ⇔ spacing button (toolbar) scales how far apart everything sits: compact / normal / airy / wide presets or a slider from 0.5× to 2.5×. It scales the platform and session rings, the time-axis depth, the model shelf, link lengths, repulsion and collision padding together, so the structure keeps its shape. The setting is remembered per browser.

Keyboard: `⌘K` / `Ctrl+K` focuses search and opens the sessions tab; `Esc` clears the selection. The ☾/☀ button toggles light and dark themes.

Navigation history: every selection (graph click, now-card, side-panel link, toast) is a browser history entry that remembers the selection, the side-panel tab and the camera pose just before the move. The trail under the toolbar shows `‹ back`, the last few stops (click one to jump there) and `› forward`; the browser's own back/forward (Alt+←/→, ⌘[ ], trackpad swipe) do the same. The URL hash (`#session:…`, `#cron:…`) is a deep link: share it, or scan it from the 📱 QR popover, and the page opens on that node.

Ideas borrowed from [AionUi](https://github.com/iOfficeAI/AionUi):

- **Waiting vs. running.** AionUi marks a conversation that is waiting for the user differently from one
  that is still working, and notifies when a turn completes. Keryx now does both: the `waiting` status and
  the 🔔 button (in-app toasts always; desktop notifications when you allow them) for replies, failures,
  orphaned sessions, finished or failed delegations, cron failures and missed triggers.
- **Context usage.** Each session shows how full the model's context window was at the last API call
  (amber from 70 %, red from 90 %). Hermes does not record the window size, so Keryx assumes
  `CONTEXT_LENGTH` (default 400k, marked with ~) unless the model name matches a known family.
- **Task board.** The tasks tab lists every delegation Hermes handed to subagents (goals, who ran them,
  duration, delivery) and every scheduled job with a next-run countdown, last status, lateness, failure
  streak, a 20-run history strip and missed-trigger detection, plus the scheduler heartbeat.
- **Files touched.** The preview panel in AionUi tracks file changes; Keryx lists the files each session
  wrote, patched, read or searched, and the overview shows the most recent changes across sessions.
- **Diagnostics export.** ⤓ diagnostics in the overview downloads a privacy-safe JSON snapshot (counts,
  states, ids, redacted error lines; no prompts, message content, chat ids or keys) to attach to a bug report.
- **Open on a phone.** 📱 in the header shows a QR code of the current URL.

Ideas borrowed from [Ekko Studio](https://github.com/EKKOLearnAI/ekko-studio): usage analytics with a daily trend and model distribution, tool-call traces with argument/result expansion, sessions grouped by source with live ones pinned, a filterable log viewer, per-turn usage and cache-hit reporting, session search, and themes.

## API

- `GET /api/graph?hours=24[&at=<epoch>]`  nodes/links; `at` replays the graph as of that moment
- `GET /api/analytics?days=30`  daily trend (sessions, messages, tool calls, failures, tokens), model share, totals
- `GET /api/session/{id}/trace?limit=300[&tool=name]`  ordered steps (user / assistant / tool call with args + result)
- `GET /api/logs?file=errors|gateway|agent|boot|restart|dashboard-auth&level=WARNING&q=text&lines=200`
- `GET /api/tasks`    delegations (goals, children, duration, delivery) + cron jobs (next run, history, missed, streak) + scheduler heartbeat
- `GET /api/diagnostics`  redacted JSON snapshot for bug reports (download)
- `GET /api/qr?text=`  SVG QR code
- `GET /api/now`      running + waiting sessions digest
- `GET /api/status`   health checks
- `GET /api/cost?hours=24`  tokens/cost per model
- `GET /api/stream?hours=24`  server-sent events, one `update` per data change (keyed on file mtimes incl. the WAL)
- `GET /api/health`   liveness

## Tuning

`ACTIVE_WINDOW`, `STALE_AFTER` and `CONTEXT_LENGTH` (env or top of `app.py`); colours and labels in `frontend/src/util.js`.
