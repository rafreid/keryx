// 24-hour clock everywhere: '13:47:36' sorts, aligns (tabular-nums) and never wraps, where '1:47:36 PM' did all three
const H23 = { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }
export const fmtT = t => (t ? new Date(t * 1000).toLocaleString(undefined, { ...H23, year: 'numeric', month: 'short', day: 'numeric' }) : '–')
export const fmtTime = t => (t ? new Date(t * 1000).toLocaleTimeString(undefined, H23) : '–')
export const dur = s => {
  if (s == null) return '–'
  s = Math.max(0, s)
  if (s < 60) return `${s | 0}s`
  if (s < 3600) return `${(s / 60) | 0}m ${(s % 60) | 0}s`
  if (s < 86400) return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`
  return `${(s / 86400) | 0}d ${((s % 86400) / 3600) | 0}h`
}
export const ago = t => (t ? dur(Date.now() / 1000 - t) + ' ago' : '–')
/** '1 call', '2 calls': plain plurals for user-facing text. */
export const plural = (n, word, pl) => `${n ?? 0} ${(n ?? 0) === 1 ? word : (pl || word + 's')}`
export const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'local time' } }
export const num = n => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))

// Colours are CSS tokens (styles.css defines them per theme). DOM consumers use the var() strings below;
// the canvas and WebGL renderers read the literal values through palette() → nodeFill / linkFill.
export const TYPE = {
  hub:      { color: 'var(--text)', label: 'Hermes agent' },
  source:   { color: 'var(--n-platform)', label: 'platform (telegram, tui, cron…)' },
  session:  { color: 'var(--muted)', label: 'session — sphere; colour = status below' },
  subagent: { color: 'var(--muted)', label: 'subagent — octahedron; colour = status below' },
  tool:     { color: 'var(--n-tool)', label: 'tool call — cube; red when a call failed', alt: 'var(--n-fail)' },
  model:    { color: 'var(--n-model)', label: 'model — cylinder, size = tokens' },
  cron:     { color: 'var(--n-cron)', label: 'cron job — cone; red when the last run failed', alt: 'var(--n-fail)' },
}
export const STATUS = {
  running:       { color: 'var(--s-running)', label: 'running' },
  waiting:       { color: 'var(--s-waiting)', label: 'waiting for you' },
  stale:         { color: 'var(--s-stale)', label: 'stale, idle over 30 min' },
  ended:         { color: 'var(--s-ended)', label: 'ended' },
  ended_by_user: { color: 'var(--s-closed)', label: 'closed by user' },
  orphaned:      { color: 'var(--s-orphaned)', label: 'orphaned by a restart' },
  failed:        { color: 'var(--s-failed)', label: 'ended with tool errors' },
}
/** The halo drawn around anything touched in the last 5 min. A ring, never a fill: status colour stays visible. */
export const ACTIVE = 'var(--active)'

// Rule: shape = type, colour = status. Sessions and subagents take exactly the STATUS colour,
// tools and cron jobs take their TYPE colour or its 'alt' (red) on failure. The legend uses the same tables.
/** Colour as a CSS var() string, for the DOM (legend glyphs, cards, panel). */
export function nodeBaseColor(n) {
  if (n.type === 'session' || n.type === 'subagent') return STATUS[n.status]?.color || TYPE.session.color
  if (n.type === 'tool') return n.errors > 0 ? TYPE.tool.alt : TYPE.tool.color
  if (n.type === 'cron') return n.status === 'failed' ? TYPE.cron.alt : TYPE.cron.color
  return TYPE[n.type]?.color || 'var(--muted)'
}
/** The same rule as a literal colour, for canvas and WebGL (they cannot resolve var()). */
export function nodeFill(n, pal = palette()) {
  if (n.type === 'session' || n.type === 'subagent') return pal.status[n.status] || pal.muted
  if (n.type === 'tool') return n.errors > 0 ? pal.node.fail : pal.node.tool
  if (n.type === 'cron') return n.status === 'failed' ? pal.node.fail : pal.node.cron
  if (n.type === 'hub') return pal.text
  if (n.type === 'source') return pal.node.platform
  if (n.type === 'model') return pal.node.model
  return pal.muted
}
/** Link colour by kind; a link with failed calls goes red. */
export function linkFill(l, pal = palette()) {
  if (l.errors > 0) return pal.node.fail
  return pal.link[l.kind] || pal.link.link
}

// Age fade: brand-new = 1, oldest in window = floor.
export function ageAlpha(age, windowSec, floor = 0.28) {
  if (age == null || !windowSec) return 1
  const a = 1 - Math.min(1, Math.max(0, age) / windowSec)
  return floor + (1 - floor) * a
}

export function withAlpha(hex, a) {
  if (!hex.startsWith('#')) {                 // an rgb()/rgba() value from the stylesheet
    const m = hex.match(/[\d.]+/g) || []
    return `rgba(${m[0] || 0},${m[1] || 0},${m[2] || 0},${a.toFixed(3)})`
  }
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`
}

export const fmtIn = t => {            // "in 2h 5m" / "overdue 12m"
  if (!t) return '–'
  const d = t - Date.now() / 1000
  return d >= 0 ? `in ${dur(d)}` : `overdue ${dur(-d)}`
}
export const contextLevel = pct => (pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok')

/** Colours the graph renderers need as literal values (canvas and WebGL cannot read CSS variables): read from
 *  the stylesheet's tokens, so both themes share one definition. Re-read whenever the theme changes. */
export function readPalette() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb
  return {
    bg: v('--bg', '#0b0f17'), panel: v('--panel', '#121a27'), line: v('--line', '#223049'), text: v('--text', '#e6edf7'),
    muted: v('--muted', '#8fa0b8'), accent: v('--accent', '#6ad1ff'), halo: v('--label-halo', 'rgba(11,15,23,.75)'),
    active: v('--active', '#ffffff'), ageFloor: Number(v('--age-floor', '.28')) || 0.28,
    node: { platform: v('--n-platform', '#6ad1ff'), tool: v('--n-tool', '#ffb86b'), model: v('--n-model', '#f778ba'), cron: v('--n-cron', '#ffd866'), fail: v('--n-fail', '#f85149') },
    status: { running: v('--s-running', '#3fb950'), waiting: v('--s-waiting', '#58a6ff'), stale: v('--s-stale', '#d29922'), ended: v('--s-ended', '#4f8f6a'),
              ended_by_user: v('--s-closed', '#6b7a8c'), orphaned: v('--s-orphaned', '#f85149'), failed: v('--s-failed', '#f85149') },
    link: { link: v('--l-link', '#8ea0bf'), spawn: v('--l-spawn', '#c3a6ff'), branch: v('--l-branch', '#8fd3c5'), model: v('--l-model', '#f778ba') },
  }
}
export const PALETTE = { current: null }
export const palette = () => PALETTE.current || (PALETTE.current = readPalette())
