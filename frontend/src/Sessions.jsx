import React, { useMemo, useState } from 'react'
import Shape from './Shapes.jsx'
import { STATUS, ago, dur, nodeBaseColor } from './util.js'

/** Session list grouped by platform; running pinned to the top; filtered by the search box. */
export default function Sessions({ graph, selected, onSelect, search }) {
  const [open, setOpen] = useState(() => new Set())
  const q = (search || '').trim().toLowerCase()
  const groups = useMemo(() => {
    const sess = (graph?.nodes || []).filter(n => (n.type === 'session' || n.type === 'subagent') &&
      (!q || `${n.label} ${n.request || ''} ${n.last_step || ''} ${n.source || ''}`.toLowerCase().includes(q)))
    const running = sess.filter(n => n.status === 'running').sort((a, b) => (b.last || 0) - (a.last || 0))
    const rest = sess.filter(n => n.status !== 'running')
    const by = new Map()
    for (const n of rest) { const k = n.source || 'unknown'; if (!by.has(k)) by.set(k, []); by.get(k).push(n) }
    for (const list of by.values()) list.sort((a, b) => (b.last || 0) - (a.last || 0))
    return { running, by: [...by.entries()].sort((a, b) => b[1].length - a[1].length) }
  }, [graph, q])
  const toggle = k => setOpen(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const Row = ({ n }) => (
    <div className={`srow ${selected === n.id ? 'sel' : ''}`} onClick={() => onSelect(n.id)}>
      <Shape type={n.type} color={nodeBaseColor(n)} />
      <div className="t">
        <div className="title">{n.label}</div>
        <div className="small">{STATUS[n.status]?.label || n.status} · {ago(n.last)} · {n.tool_calls} calls{n.tool_errors ? <span className="err"> · {n.tool_errors} failed</span> : null}{n.children ? ` · ${n.children} subagents` : ''}</div>
      </div>
    </div>
  )
  if (!groups.running.length && !groups.by.length) return <div className="small">no sessions in this window{q ? ' match the search' : ''}.</div>
  return (
    <div>
      {groups.running.length > 0 && <>
        <h3><span className="dot green pulse" />running</h3>
        {groups.running.map(n => <Row key={n.id} n={n} />)}
      </>}
      {groups.by.map(([src, list]) => {
        const isOpen = q ? true : !open.has(src)   // open by default; search forces open
        return <div key={src}>
          <h3 className="acc" onClick={() => toggle(src)}>{isOpen ? '▾' : '▸'} {src} <span className="small">· {list.length}</span></h3>
          {isOpen && list.map(n => <Row key={n.id} n={n} />)}
        </div>
      })}
      <div className="small" style={{ marginTop: 8 }}>press <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> to search · click a row to select it in the graph</div>
    </div>
  )
}
