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
  hub:      { color: '#ffffff', label: 'Hermes agent' },
  source:   { color: '#6ad1ff', label: 'platform (telegram, tui, cron…)' },
  session:  { color: '#9aa7b8', label: 'session — sphere; colour = status below' },
  subagent: { color: '#9aa7b8', label: 'subagent — octahedron; colour = status below' },
  tool:     { color: '#ffb86b', label: 'tool call — cube; red when a call failed', alt: '#f85149' },
  model:    { color: '#f778ba', label: 'model — cylinder, size = tokens' },
  cron:     { color: '#ffd866', label: 'cron job — cone; red when the last run failed', alt: '#f85149' },
}
export const STATUS = {
  running:       { color: '#3fb950', label: 'running' },
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
  return TYPE[n.type]?.color || '#999'
}

// Age fade: brand-new = 1, oldest in window = floor.
export function ageAlpha(age, windowSec, floor = 0.28) {
  if (age == null || !windowSec) return 1
  const a = 1 - Math.min(1, Math.max(0, age) / windowSec)
  return floor + (1 - floor) * a
}

export function withAlpha(hex, a) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`
}
