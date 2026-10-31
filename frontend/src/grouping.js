/**
 * Session-list helpers (pure, unit-tested): grouping by platform / time / project, #tags in titles,
 * pins. The ideas come from cc-switch's session manager and hermes-webui's sidebar.
 */

export const GROUPINGS = { platform: 'by platform', time: 'by time', project: 'by project' }

/** Today / Yesterday / This week / Earlier, in the viewer's local time. */
export function timeBucket(ts, now = Date.now() / 1000) {
  if (!ts) return 'earlier'
  const d = new Date(ts * 1000), n = new Date(now * 1000)
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(n) - day(d)) / 86400000)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff < 7) return 'this week'
  return 'earlier'
}
export const TIME_ORDER = ['today', 'yesterday', 'this week', 'earlier']

/** The project a session belongs to: the last path segment of its working directory. */
export function projectOf(node) {
  const cwd = node.cwd || ''
  if (!cwd) return 'no project'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.at(-1) || cwd
}

/** #tags typed into a session title ("fix build #infra #urgent") → ['infra', 'urgent']. */
export function tagsOf(label) {
  const out = []
  for (const m of String(label || '').matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{1,24})\b/gu)) if (!out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase())
  return out
}
export const stripTags = label => String(label || '').replace(/(?:^|\s)#[\p{L}\p{N}_-]{1,24}\b/gu, '').replace(/\s{2,}/g, ' ').trim()

/** What a row is called: the title, or when Hermes never titled the session (label is the id), the request. */
export function displayTitle(node) {
  const label = stripTags(node.label)
  const id = (node.id || '').replace('session:', '')
  if (!label || label === id || id.startsWith(label)) return node.request || label || id
  return label
}

/** Pinned here (this browser) or pinned in Hermes' own session picker (`sessions.pinned`). */
export const isPinned = (n, pinned) => pinned.has(n.id) || !!n.pinned

/**
 * Split sessions into ordered groups for the list. Pinned sessions (here or in Hermes) come first as
 * their own group, running sessions next, then the chosen grouping, and Hermes' internal sessions
 * (one-shot CLI calls, tool helpers, kanban workers) last in a group of their own, as hermes-desktop
 * keeps them out of its conversation list. Sessions Hermes hides from its own picker are left out
 * unless `hidden` is true. Returns [{key, label, rows}] with rows newest first.
 */
export function groupSessions(nodes, { mode = 'platform', pinned = new Set(), tag = null, hidden = false, now = Date.now() / 1000 } = {}) {
  const sess = nodes.filter(n => n.type === 'session' || n.type === 'subagent')
    .filter(n => hidden || !n.hidden)
    .filter(n => !tag || tagsOf(n.label).includes(tag))
    .sort((a, b) => (b.last || 0) - (a.last || 0))
  const groups = []
  const pins = sess.filter(n => isPinned(n, pinned))
  if (pins.length) groups.push({ key: 'pinned', label: 'pinned', rows: pins })
  const rest = sess.filter(n => !isPinned(n, pinned))
  const running = rest.filter(n => n.status === 'running')
  if (running.length) groups.push({ key: 'running', label: 'running', rows: running })
  const others = rest.filter(n => n.status !== 'running' && !n.internal)
  const by = new Map()
  const keyOf = n => (mode === 'time' ? timeBucket(n.last || n.started, now) : mode === 'project' ? projectOf(n) : (n.source || 'unknown'))
  for (const n of others) { const k = keyOf(n); if (!by.has(k)) by.set(k, []); by.get(k).push(n) }
  let keys = [...by.keys()]
  if (mode === 'time') keys.sort((a, b) => TIME_ORDER.indexOf(a) - TIME_ORDER.indexOf(b))
  else keys.sort((a, b) => by.get(b).length - by.get(a).length || a.localeCompare(b))
  for (const k of keys) groups.push({ key: `${mode}:${k}`, label: k, rows: by.get(k) })
  const internal = rest.filter(n => n.status !== 'running' && n.internal)
  if (internal.length) groups.push({ key: 'internal', label: 'internal', rows: internal })
  return groups
}

/** How many sessions in the window Hermes hides from its own picker (so the list can offer to show them). */
export const hiddenCount = nodes => nodes.filter(n => (n.type === 'session' || n.type === 'subagent') && n.hidden).length

/** Every tag in the window with its count, most used first. */
export function allTags(nodes) {
  const n = new Map()
  for (const s of nodes) if (s.type === 'session' || s.type === 'subagent') for (const t of tagsOf(s.label)) n.set(t, (n.get(t) || 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }))
}

/** The command that reopens a session in a terminal (Hermes' -r/--resume accepts the id). */
export const resumeCommand = node => `hermes -r ${node.tip || (node.id || '').replace('session:', '')}`
