/** Side-panel tabs, in order; `[` and `]` cycle through them. The icon names index Icons.jsx. */
export const TABS = ['overview', 'sessions', 'tasks', 'board', 'analytics', 'logs', 'memory']

/** The worst non-green check, for the single chip the desktop header keeps inline. */
export function worstCheck(checks) {
  const trouble = (checks || []).filter(c => c.level !== 'green')
  return trouble.find(c => c.level === 'red') || trouble[0] || null
}

/** Red and amber counts for the pill and the phone bar. */
export function troubleCounts(checks) {
  const trouble = (checks || []).filter(c => c.level !== 'green')
  const red = trouble.filter(c => c.level === 'red').length
  return { red, amber: trouble.length - red, total: trouble.length }
}
