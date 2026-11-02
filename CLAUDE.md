# Keryx

Live, read-only 3D activity monitor for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
It reads the Hermes data directory (`state.db`, `gateway_state.json`, `kanban*.db`, cron store, logs,
skills, memories) and renders sessions, tools, delegations and jobs as a force graph with a side panel.
Public repo `rafreid/keryx`, MIT, published as `ghcr.io/rafreid/keryx`.

**Keryx never writes to Hermes data.** Every feature is observation only. Decline anything that would
make Keryx mutate sessions, tasks, config or memory, and say why.

## Layout

- `backend/app.py` is the whole backend (FastAPI, single file, about 6k lines). The version string
  lives in `FastAPI(title="Keryx", version="…")` and is exposed on `/api/health` and `/api/status`
  as `keryx`; the header shows it. Bump it there and nowhere else.
- `backend/tests/` is pytest. `conftest.py` builds a miniature Hermes data dir (`write_state_db`,
  `write_cron`, `write_logs`, `write_skills`, `write_memory`, `write_gateway_state`, `write_kanban`,
  `write_achievements`) with times relative to now. Add fixture rows there when a feature needs new data.
- `frontend/` is Vite + React 18 + react-force-graph. `npm run build` emits into `backend/static`
  (gitignored; the FastAPI app serves it). Unit tests are vitest, `src/**/*.test.js`, node environment.
- `docs/` is the GitHub Pages site (`index.html`, `img/`). `README.md` and `docs/index.html` are kept
  in step with each other when features ship.
- `docker-compose.yml` and `quickstart.sh` are what users run. `.github/workflows/ci.yml` runs
  backend, frontend and an image smoke test on every PR; `release.yml` publishes the image on main.

## Commands

```bash
cd backend && .venv/bin/python -m pytest          # backend tests (venv already exists)
cd frontend && npm test                           # vitest
cd frontend && npm run build                      # production bundle into backend/static
.claude/skills/check/check.sh                     # all three, in order
```

Local dev against synthetic data (never point a dev server at real Hermes data for screenshots):

```bash
backend/.venv/bin/python .claude/skills/demo-data/make_demo_data.py <scratchpad>/demo-data
cd backend && HERMES_DATA=<scratchpad>/demo-data KERYX_SHOW_MEMORY=1 \
  .venv/bin/uvicorn app:app --port 9121           # no --reload: restart after backend edits
```

Port 9120 is the real deployment port; use 9121 for dev so the two never collide.

## Backend conventions

- Data access goes through `Snapshot` copies keyed on file mtime and `cached()` keyed on
  `data_signature()`. New readers follow that pattern so a busy Hermes never blocks Keryx.
- Every error string a client can see passes through `redact()`. Paths, `argv` and anything from
  `gateway_state.json` beyond what `gateway_summary` whitelists never leave the backend.
- `/api/diagnostics` must never include memory or message content.
- The memory panel is off unless `KERYX_SHOW_MEMORY` is set. Keep it that way.
- Use `plural(n, word, pl)` for counts. No "(s)" strings anywhere, on either side.
- Context window resolution order is Hermes' `context_length_cache.yaml`, then `config.yaml`
  `model:` section, then the built-in table, then `CONTEXT_LENGTH`. Report the `source` with the limit.
- Status checks produce `{level, kind, label, detail}`; `worst_of` folds them. Attention items go
  through `attention_list()` and carry `node`/`tab` so the UI can jump to them.

## Frontend conventions

- Refetching is driven by `hooks/useTick.js`: `useRefetch(load, deps, fallbackMs)` runs on the SSE
  tick, `useClock` for "updated Xs ago". Do not add independent `setInterval` polling.
- Colours for canvas and WebGL come from `readPalette()`/`palette()` in `util.js`, which read CSS
  tokens, so both themes stay correct. Never hard-code a colour in `GraphView.jsx` or `TimeAxis.jsx`.
- Both themes and the phone layout (`useMedia(NARROW)`, `.app.narrow`) are first-class. Check a
  change at 1440×900 dark, 1440×900 light and 400×800 before calling it done.
- Tabs are listed once in `tabs.js`; `[`/`]` cycle them. Add aria-labels to new icon buttons.
- Session grouping and pin/hidden/internal rules live in `grouping.js` and have tests.

## Security lines

- Screenshots and demo data are synthetic (the conftest fixture). Never capture real prompts, real
  session titles or anything from the live host.
- Never read or quote `/Users/rafreid/HERMES/hermes.txt` or `/Users/rafreid/AFLUXSYSTEMS/afluxsystems.txt`.
- Do not change repo visibility, delete remote branches, or touch GHCR package settings. Those
  are the user's calls.

## Git and PR workflow

- Work on feature branches; one PR per concern, stacked when a feature depends on the previous one
  (`feat/…`, `fix/…`, `docs/…`, `chore/…`). Open PRs with `gh`; the body ends with the attribution line.
- Stacked PRs are merged in order with the `stacked-prs` skill: retarget to `main`, merge-commit,
  never delete branches. Branch cleanup is the user's call.
- CI check names: `backend`, `frontend`, `image`; on main also `pages build and deployment`.
- Commit messages: imperative subject, body explains why. Tests accompany backend and frontend changes.

## Deployment

Production runs on the user's Proxmox host `root@192.168.1.100` where Hermes runs in Docker
(data dir `/opt/hermes-data`, mounted at `/opt/data`). Keryx source lives flat in `/opt/keryx`
(`app.py`, `static/`, `Dockerfile`, `requirements.txt`) and is built by the Hermes compose file in
`/opt/hermes`. Use the `deploy` skill; it builds the front end, rsyncs, rebuilds the container and
checks that `/api/health` reports the expected version. Redeploy after merging to main, not from a branch.

## Verifying in a browser

Use the Playwright MCP against the dev server on 9121 with demo data. Screenshots must be saved
under `.playwright-mcp/` (gitignored); other paths are refused. `file:` URLs are blocked, so serve
`docs/` with `python3 -m http.server 9122` to check the website. Read the console after a render:
a ReferenceError in a component shows as a blank panel, not an error page.

## Gotchas already paid for

- Parallel Bash calls share one shell cwd. Scripts use absolute paths or `os.chdir()` first.
- zsh globs `--include=*.py` and bare `*`; quote them.
- `short(None, n)` returns `''`, so add `or None` when a nullable field is expected.
- `as_of` is always set on the graph payload; show "as of" only when `graph.replay` is set.
- A later CSS rule in `styles.css` overrides the phone media block; scope with `.app.narrow …`.
- SVG class names in `Cards.jsx` double as layout hooks; a new chart needs its own class.
