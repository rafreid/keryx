/**
 * Triage helpers for the Overview's attention list. Pure, unit-tested.
 *
 * Mutes are per browser: {id: signature}. A mute lasts until the item changes (its label or detail
 * differs from the signature) or disappears, so a known outage stops shouting while a new error on
 * the same item still shows up. Keryx never writes to Hermes; this is viewer state only.
 */
export const GROUPS = [
  { key: 'red', title: 'Needs action', cls: 'err' },
  { key: 'amber', title: 'Watch', cls: 'warn' },
  { key: 'info', title: 'Info', cls: 'info' },
]

export const signature = a => `${a.label}\u0000${a.detail || ''}`

export function loadMutes() {
  try { return JSON.parse(localStorage.getItem('keryx.mute') || '{}') } catch { return {} }
}
export function saveMutes(m) {
  try { Object.keys(m).length ? localStorage.setItem('keryx.mute', JSON.stringify(m)) : localStorage.removeItem('keryx.mute') } catch {}
}

/**
 * Split items into shown and muted, dropping mutes whose item changed or went away.
 * Returns {shown, muted, mutes} where `mutes` is the cleaned map to store back.
 */
export function applyMutes(items, mutes) {
  const shown = [], muted = [], kept = {}
  for (const a of items) {
    if (mutes[a.id] && mutes[a.id] === signature(a)) { muted.push(a); kept[a.id] = mutes[a.id] } else shown.push(a)
  }
  return { shown, muted, mutes: kept }
}

/** Items grouped by severity in GROUPS order, with counts; empty groups are left out. */
export function groupBySeverity(items) {
  return GROUPS.map(g => ({ ...g, items: items.filter(a => a.severity === g.key) })).filter(g => g.items.length)
}

/** "2 need action · 5 to watch · 1 info" for the section header. */
export function summarise(groups) {
  const n = k => groups.find(g => g.key === k)?.items.length || 0
  const parts = []
  if (n('red')) parts.push(`${n('red')} need${n('red') === 1 ? 's' : ''} action`)
  if (n('amber')) parts.push(`${n('amber')} to watch`)
  if (n('info')) parts.push(`${n('info')} info`)
  return parts.join(' · ') || 'all clear'
}
