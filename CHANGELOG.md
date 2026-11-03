# Changelog

Keryx versions are the `version` string in `backend/app.py`, shown in the page header and on `/api/health`.
Each entry links the pull requests that made it. The published image `ghcr.io/rafreid/keryx` carries
`latest` for the head of `main` and a version tag for each release.

## 2.9

A graph release from a visual and interaction review of the 3D view: fourteen findings, all addressed.
Nothing changed in what Keryx reads; the picture got honest colours, legible labels and depth.

- Graph colours are CSS tokens with a light block that clears 3:1 for every node and link (the old
  dark hexes fell to 1.3:1 on the light background); "active" is a halo ring and particles, never a
  red fill, so a running session stays green; switching theme repaints the WebGL background.
  ([#45](https://github.com/rafreid/keryx/pull/45))
- Labels keep ~11 px on screen at any zoom, a priority budget decides which the overview shows, a
  screen-space occlusion pass hides any that would overprint, and nothing outside the focused
  neighbourhood is labelled; the sprite textures are no longer re-rasterised every frame. Tool
  labels read "write_file ×3 · 1 failed". ([#46](https://github.com/rafreid/keryx/pull/46))
- Depth: a stem from every session to the floor ring, a 42° overview, an accent ring on the
  selection, fog tied to the camera distance, a key light that gives spheres a terminator.
  ([#47](https://github.com/rafreid/keryx/pull/47))
- The overview frames the sessions and platforms at 62 % of the canvas instead of 40 %; the hub is
  accent-coloured in both themes; the 2D canvas pauses its redraw loop under reduced motion.
  ([#48](https://github.com/rafreid/keryx/pull/48))
- Phone map: refits on rotation and panel resize, a label budget when zoomed out, more padding
  under the toolbar, the history trail hidden (the browser's back button does the same).
  ([#49](https://github.com/rafreid/keryx/pull/49))

## 2.8

A usability release from a full UX audit of 2.7: twenty-two findings, all addressed. Nothing changed
in what Keryx reads or stores; everything changed in how it tells you.

- Honest liveness: a connection strip under the header (`live · checked 3s ago · last change 4m ago`,
  `reconnecting…`, `backend unreachable since …`), SSE pings every 15 s, a setup card when there is no
  `state.db`, a lock-only shell when a token is required. ([#31](https://github.com/rafreid/keryx/pull/31))
- Header on a diet: brand, health pill, the single worst check, tokens and controls on one row; a `…`
  sheet on phones; inline SVG icons; wrapping panel tabs; a draggable panel edge. ([#32](https://github.com/rafreid/keryx/pull/32))
- Keyboard and motion: cards, attention lines, section headers, trace steps, kanban cards, cron jobs and
  incidents are real controls; toasts are a live region; reduced motion from the system or a switch.
  ([#33](https://github.com/rafreid/keryx/pull/33))
- Attention triage: needs action / watch / info with counts, "since", a per-device mute; the history
  trail is labelled. ([#34](https://github.com/rafreid/keryx/pull/34))
- Typography and small screens: 24-hour clock, 12 px floor, light-theme accents at 5:1, "N more" pill
  for the running strip; version 2.8. ([#35](https://github.com/rafreid/keryx/pull/35))
- Docs for all of the above. ([#36](https://github.com/rafreid/keryx/pull/36))

## 2.7

- Graph legibility: labels scale with distance, a clickable time ruler under the graph. ([#28](https://github.com/rafreid/keryx/pull/28))
- One refresh clock for every panel, a first-run card, relative "updated" labels. ([#27](https://github.com/rafreid/keryx/pull/27))
- Microcopy, keyboard and accessibility pass. ([#26](https://github.com/rafreid/keryx/pull/26))
- Header health pill, wider panel, node detail regrouped. ([#25](https://github.com/rafreid/keryx/pull/25))
- Light theme: overlays and graph colours from the tokens. ([#24](https://github.com/rafreid/keryx/pull/24))
- Phone layout: map / panel toggle, stacked body, gutters. ([#23](https://github.com/rafreid/keryx/pull/23))
- Version beside the title. ([#22](https://github.com/rafreid/keryx/pull/22))
- Docs refresh with new screenshots. ([#29](https://github.com/rafreid/keryx/pull/29))

## 2.6

- Notification sounds, synthesised in the browser; achievement unlocks from Hermes' own plugin state.
  ([#21](https://github.com/rafreid/keryx/pull/21))
- What fills the context, per session. ([#20](https://github.com/rafreid/keryx/pull/20))
- Analytics cards: insights, velocity, cache trend, provider mix, hour of day. ([#19](https://github.com/rafreid/keryx/pull/19))
- Attention list in the overview. ([#18](https://github.com/rafreid/keryx/pull/18))
- Context window from Hermes' probe cache and config; a pending-restart check. ([#17](https://github.com/rafreid/keryx/pull/17))

## 2.5

- Hermes' own session flags: pinned, hidden and internal sessions. ([#16](https://github.com/rafreid/keryx/pull/16))
- The model's reasoning in the reading view, on request. ([#15](https://github.com/rafreid/keryx/pull/15))
- Kanban board tab, read-only. ([#14](https://github.com/rafreid/keryx/pull/14))
- Gateway state file: per-platform health and the Hermes version. ([#13](https://github.com/rafreid/keryx/pull/13))

## 2.4

- Storage health check, web-app manifest. ([#12](https://github.com/rafreid/keryx/pull/12))
- Memory panel: `MEMORY.md` and `USER.md`, read-only, opt-in. ([#11](https://github.com/rafreid/keryx/pull/11))
- Sessions list: grouping, tags, pins, conversation search, resume command. ([#10](https://github.com/rafreid/keryx/pull/10))
- Analytics: year heatmap, per-day cost, skill ledger, 365-day window. ([#9](https://github.com/rafreid/keryx/pull/9))
- Session reading view: turns, outline, filters, find, Markdown export. ([#8](https://github.com/rafreid/keryx/pull/8))
- Micro-compaction merge rows hidden the way Hermes hides them. ([#7](https://github.com/rafreid/keryx/pull/7))
- Quick-start script, prebuilt image, rewritten README, project website. ([#6](https://github.com/rafreid/keryx/pull/6))
- The agent's plan (`todo_list`) and links into the Hermes dashboard. ([#5](https://github.com/rafreid/keryx/pull/5))

## 2.3

- Engineering: batched status, SQL-side trimming, one SSE watcher, optional token, health check,
  hooks, vitest. ([#4](https://github.com/rafreid/keryx/pull/4))
- Hermes' cron ledgers and newer columns: incidents, deliveries, missed slots, true cost, git context.
  ([#3](https://github.com/rafreid/keryx/pull/3))
- Logical sessions: compaction lineages folded into one node; event and compaction trace steps.
  ([#2](https://github.com/rafreid/keryx/pull/2))

## 2.2

- Track Hermes drift: session-tagged log lines, new end reasons, live message rows; tests and CI.
  ([#1](https://github.com/rafreid/keryx/pull/1))

## 2.1

- Waiting state, tasks board, context gauge, files touched, notifications.

## 2.0

- First public version: FastAPI backend, React front end on 3d-force-graph, the three-part grammar.
