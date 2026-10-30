import React, { useEffect, useState } from 'react'
import { dur, fmtTime, num } from './util.js'

/** Turn-by-turn trace of a session (or one tool's calls), with expandable arguments / results. */
export default function Trace({ sessionId, tool }) {
  const [data, setData] = useState(null)
  const [openAll, setOpenAll] = useState(false)
  useEffect(() => {
    let dead = false
    setData(null)
    const load = () => fetch(`/api/session/${encodeURIComponent(sessionId)}/trace?limit=300${tool ? `&tool=${encodeURIComponent(tool)}` : ''}`)
      .then(r => r.json()).then(d => { if (!dead) setData(d) })
    load(); const t = setInterval(load, 10000)
    return () => { dead = true; clearInterval(t) }
  }, [sessionId, tool])
  if (!data) return <div className="small">loading trace…</div>
  if (data.error) return <div className="small err">{data.error}</div>
  const u = data.usage?.[0]
  return (
    <div>
      {!tool && u && <div className="small">usage: {num(u.input)} in · {num(u.output)} out · cache {((u.cache_hit || 0) * 100) | 0}% · {u.calls} API calls{u.cost_usd ? ` · $${u.cost_usd.toFixed(4)}` : ''}</div>}
      {!tool && data.session?.compactions > 0 && <div className="small">⟲ context compacted {data.session.compactions}× · {data.session.segments.length} segments, latest {data.session.tip.slice(0, 8)}</div>}
      <div className="row"><span className="small">{data.total} step{data.total === 1 ? '' : 's'}{data.truncated ? ' (showing last 300)' : ''}</span>
        <button onClick={() => setOpenAll(o => !o)}>{openAll ? 'collapse all' : 'expand all'}</button></div>
      <div className="trace">
        {data.steps.map((s, i) => <Step key={i} s={s} open={openAll} />)}
      </div>
    </div>
  )
}

function Step({ s, open }) {
  const [o, setO] = useState(false)
  const isOpen = open || o
  if (s.kind === 'user') return <div className="step user"><span className="when">{fmtTime(s.ts)}</span><b>you</b><div className="txt">{s.text}</div></div>
  if (s.kind === 'assistant') return <div className="step assistant"><span className="when">{fmtTime(s.ts)}</span><b>hermes</b><div className="txt">{s.text}</div></div>
  if (s.kind === 'compaction') return <div className="step compaction" title={`segment ${s.segment}`}><span className="when">{fmtTime(s.ts)}</span><b>⟲ compacted</b><span className="small">{s.text}</span></div>
  if (s.kind === 'event') return <div className="step event"><span className="when">{fmtTime(s.ts)}</span><b>{s.name.replace(/_/g, ' ')}</b>{s.text && <span className="small">{s.text}</span>}</div>
  return (
    <div className={`step tool ${s.failed ? 'failed' : ''}`} onClick={() => setO(v => !v)}>
      <span className="when">{fmtTime(s.ts)}</span>
      <b>{s.name}</b>
      <span className="small"> {s.failed ? '✕ failed' : s.result != null ? '✓' : '…'}{s.duration != null ? ` · ${dur(s.duration)}` : ''} {isOpen ? '▾' : '▸'}</span>
      {isOpen && <div className="detail">
        {s.args ? <><div className="k">arguments</div><pre>{pretty(s.args)}</pre></> : null}
        {s.result != null ? <><div className="k">result</div><pre>{s.result}</pre></> : null}
      </div>}
    </div>
  )
}
const pretty = a => { try { return JSON.stringify(JSON.parse(a), null, 1) } catch { return a } }
