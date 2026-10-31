export const fmtT = t => (t ? new Date(t * 1000).toLocaleString() : '–')
export const fmtTime = t => (t ? new Date(t * 1000).toLocaleTimeString() : '–')
export const dur = s => {
  if (s == null) return '–'
  s = Math.max(0, s)
  if (s < 60) return `${s | 0}s`
  if (s < 3600) return `${(s / 60) | 0}m ${(s % 60) | 0}s`
  if (s < 86400) return `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`
  return `${(s / 86400) | 0}d ${((s % 86400) / 3600) | 0}h`
}
export const ago = t => (t ? dur(Date.now() / 1000 - t) + ' ago' : '–')
export const num = n => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))

export const TYPE = {
  hub:      { color: '#ffffff', label: 'Hermes agent' },      // the hub takes the theme's text colour at draw time (nodeBaseColor)
  source:   { color: '#6ad1ff', label: 'platform (telegram, tui, cron…)' },
  session:  { color: '#9aa7b8', label: 'session — sphere; colour = status below' },
  subagent: { color: '#9aa7b8', label: 'subagent — octahedron; colour = status below' },
  tool:     { color: '#ffb86b', label: 'tool call — cube; red when a call failed', alt: '#f85149' },
  model:    { color: '#f778ba', label: 'model — cylinder, size = tokens' },
  cron:     { color: '#ffd866', label: 'cron job — cone; red when the last run failed', alt: '#f85149' },
}
export const STATUS = {
  running:       { color: '#3fb950', label: 'running' },
  waiting:       { color: '#58a6ff', label: 'waiting for you (turn finished, chat open)' },
  stale:         { color: '#d29922', label: 'stale (idle > 30 min)' },
  ended:         { color: '#4f8f6a', label: 'ended cleanly' },
  ended_by_user: { color: '#6b7a8c', label: 'closed by user' },
  orphaned:      { color: '#f85149', label: 'orphaned by a restart' },
  failed:        { color: '#f85149', label: 'ended with tool errors' },
}
export const ACTIVE = '#ff4d4d'

// Base colour for a node before hover/search dimming.
// Rule: shape = type, colour = status. Sessions and subagents take exactly the STATUS colour,
// tools and cron jobs take their TYPE colour or its 'alt' (red) on failure. The legend uses the same tables.
export function nodeBaseColor(n) {
  if (n.type === 'session' || n.type === 'subagent') return STATUS[n.status]?.color || TYPE.session.color
  if (n.type === 'tool') return n.errors > 0 ? TYPE.tool.alt : TYPE.tool.color
  if (n.type === 'cron') return n.status === 'failed' ? TYPE.cron.alt : TYPE.cron.color
  if (n.type === 'hub') return palette().text
  return TYPE[n.type]?.color || '#999'
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
  return { bg: v('--bg', '#0b0f17'), panel: v('--panel', '#121a27'), line: v('--line', '#223049'), text: v('--text', '#e6edf7'),
           muted: v('--muted', '#8fa0b8'), accent: v('--accent', '#6ad1ff'), halo: v('--label-halo', 'rgba(11,15,23,.75)') }
}
export const PALETTE = { current: null }
export const palette = () => PALETTE.current || (PALETTE.current = readPalette())
