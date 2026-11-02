---
name: demo-data
description: Build a synthetic Hermes data directory and run a Keryx dev server against it on port 9121 for browser checks and screenshots. Use whenever Keryx must be seen running locally, never against real Hermes data.
---

# Demo data and dev server

Keryx screenshots and browser verification use synthetic data only. The generator reuses the
pytest fixture writers in `backend/tests/conftest.py`, so the demo directory always matches what the
tests cover (sessions in every state, a retrying gateway platform, two kanban boards, reasoning
messages, achievements, cron jobs, logs, skills, memories).

## Build the directory

```bash
backend/.venv/bin/python .claude/skills/demo-data/make_demo_data.py <scratchpad>/demo-data
```

Use the session scratchpad directory for the path. The script refuses to replace a directory it did
not create itself (it leaves a `.keryx-demo` marker), so a typo can't wipe real data. Times in the
fixture are relative to now; regenerate when a screenshot needs "active" sessions to look fresh.

## Run the backend

```bash
cd backend && HERMES_DATA=<scratchpad>/demo-data KERYX_SHOW_MEMORY=1 \
  .venv/bin/uvicorn app:app --port 9121 > <scratchpad>/keryx-dev.log 2>&1
```

Run it in the background. There is no `--reload`; restart after any backend edit. Build the front
end first (`cd frontend && npm run build`) because the backend serves `backend/static`. Confirm with:

```bash
curl -s http://localhost:9121/api/health
```

Port 9120 is production on the host; always use 9121 locally. Set `HERMES_DASHBOARD_URL` too when a
change touches the "open in Hermes dashboard" links.

## Browser checks

Use the Playwright MCP against `http://localhost:9121`. Save screenshots under `.playwright-mcp/`
only. After each render read the console for errors; a component that throws renders as a blank
panel. Check 1440×900 in both themes and 400×800 for the phone layout.
