import React, { useCallback, useState } from 'react'

/**
 * Collapsible side-panel section; open state is remembered per browser (keryx.ov.<id>).
 * The heading holds a real button (aria-expanded) so the section opens from the keyboard too.
 */
export default function Section({ id, title, summary, level = '', sub = false, defaultOpen = true, children }) {
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(`keryx.ov.${id}`); return v == null ? defaultOpen : v !== '0' } catch { return defaultOpen } })
  const toggle = useCallback(() => setOpen(o => { try { localStorage.setItem(`keryx.ov.${id}`, o ? '0' : '1') } catch {} return !o }), [id])
  const button = (
    <button type="button" className="accbtn" onClick={toggle} aria-expanded={open} aria-controls={`sec-${id}`}>
      <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span> {title}{summary ? <span className={`${sub ? '' : 'small '}sum`}> · {summary}</span> : null}
    </button>
  )
  return (
    <div className={`section ${open ? 'open' : 'closed'}`}>
      {sub ? <div className={`gh acc ${level}`}>{button}</div> : <h3 className="acc">{button}</h3>}
      <div id={`sec-${id}`} hidden={!open}>{open && children}</div>
    </div>
  )
}
