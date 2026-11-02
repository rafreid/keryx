/**
 * Props that make a clickable element a real control: focusable, announced as a button, and
 * activated by Enter or Space as well as a click. Spread onto a div/span that has to stay a block
 * (cards, rows) because a <button> cannot hold block content.
 */
export function pressable(fn, extra = {}) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: fn,
    onKeyDown: e => {
      if (e.target !== e.currentTarget) return                       // a link or button inside handles its own keys
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e) }
    },
    ...extra,
  }
}

/** The user's motion preference: an explicit choice in this browser wins over the OS setting. */
export function reduceMotionPref() {
  try {
    const v = localStorage.getItem('keryx.motion')
    if (v === '1') return true
    if (v === '0') return false
  } catch {}
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
