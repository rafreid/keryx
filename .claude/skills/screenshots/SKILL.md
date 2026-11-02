---
name: screenshots
description: Regenerate the README and docs/img screenshots for Keryx from synthetic demo data with the Playwright MCP. Use when the user asks to update pictures or documentation images after a UI change.
---

# Screenshots

All published images come from the demo-data fixture, never from the live host. Start with the
`demo-data` skill (dev server on 9121 with `KERYX_SHOW_MEMORY=1`) and a fresh production build.

## The set

Each file in `docs/img/` has a fixed subject and viewport. Replace all of them together so the
gallery stays consistent in version and theme.

| File | Viewport | Shows |
|---|---|---|
| `graph.png` | 1440×900 dark | 3D graph, session node selected, side panel on Session tab |
| `session.png` | 1440×900 dark | Node detail: summary rows, trace, context mix |
| `tasks.png` | 1440×900 dark | Tasks tab (cron jobs and executions) |
| `board.png` | 1440×900 dark | Board tab (kanban lanes) |
| `logs.png` | 1440×900 dark | Logs tab with a filter applied |
| `analytics.png` | 1440×900 dark | Analytics tab: insights, providers, clock |
| `light.png` | 1440×900 light | Same as graph.png in the light theme |
| `phone-map.png` | 400×800 dark | Phone layout, map view |
| `phone-panel.png` | 400×800 dark | Phone layout, panel view |

## Procedure

1. Resize the Playwright browser to the viewport, navigate to `http://localhost:9121`.
2. Dismiss the first-run card (it stores `keryx.seen`), wait for the graph to settle (about 3s).
3. Click or key into the state the row describes. Use `[`/`]` to switch tabs.
4. Take the screenshot into `.playwright-mcp/<name>.png`, then copy it to `docs/img/<name>.png`.
5. Read the console; any error means the shot is invalid.

Light theme is toggled with the header theme button; on phones use the map/panel bar at the bottom.
The website `docs/index.html` is checked by serving `docs/` with `python3 -m http.server 9122`
(Playwright refuses `file:` URLs). After replacing images, confirm the published URLs return 200 once
Pages has deployed, for example `https://rafreid.github.io/keryx/img/board.png`.
