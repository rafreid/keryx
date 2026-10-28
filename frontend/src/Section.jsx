import React, { useCallback, useState } from 'react'

/** Collapsible side-panel section; open state is remembered per browser (keryx.ov.<id>). */
export default function Section({ id, title, summary, level = '', sub = false, children }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(`keryx.ov.${id}`) !== '0' } catch { return true } })
  const toggle = useCallback(() => setOpen(o => { try { localStorage.setItem(`keryx.ov.${id}`, o ? '0' : '1') } catch {} return !o }), [id])
  return (
    <div className={`section ${open ? 'open' : 'closed'}`}>
      {sub
        ? <div className={`gh acc ${level}`} onClick={toggle}>{open ? '▾' : '▸'} {title}{summary ? <span className="sum"> · {summary}</span> : null}</div>
        : <h3 className="acc" onClick={toggle}>{open ? '▾' : '▸'} {title}{summary ? <span className="small sum"> · {summary}</span> : null}</h3>}
      {open && children}
    </div>
  )
}
