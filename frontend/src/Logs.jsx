import React, { useEffect, useState } from 'react'
import { fmtTime } from './util.js'

/** Tail of a Hermes log file, filterable by level and keyword, refreshed every 15 s. */
export default function Logs({ onSelect, links }) {
  const [file, setFile] = useState('errors')
  const [level, setLevel] = useState('WARNING')
  const [q, setQ] = useState('')
  const [data, setData] = useState(null)
  useEffect(() => {
    let dead = false
    const load = () => fetch(`/api/logs?file=${file}&level=${level}&q=${encodeURIComponent(q)}&lines=150`).then(r => r.json()).then(d => { if (!dead) setData(d) })
    load(); const t = setInterval(load, 15000)
    return () => { dead = true; clearInterval(t) }
  }, [file, level, q])
  return (
    <div>
      <div className="row">
        <select value={file} onChange={e => setFile(e.target.value)}>
          {(data?.files || [{ key: 'errors', name: 'errors.log' }]).map(f => <option key={f.key} value={f.key}>{f.name}{f.size ? ` (${(f.size / 1024) | 0} KB)` : ''}</option>)}
        </select>
        <select value={level} onChange={e => setLevel(e.target.value)}>
          {['DEBUG', 'INFO', 'WARNING', 'ERROR'].map(l => <option key={l} value={l}>{l}+</option>)}
        </select>
        <input type="search" placeholder="keyword" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 80 }} />
      </div>
      {data && <div className="small">{links?.logs && <a href={links.logs} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>Hermes dashboard logs ↗</a>}{data.matched} matching · {Object.entries(data.counts || {}).filter(([, n]) => n).map(([l, n]) => `${l.toLowerCase()} ${n}`).join(' · ')}</div>}
      <div className="loglist">
        {(data?.entries || []).slice().reverse().map((e, i) => (
          <div key={i} className={`log ${e.level.toLowerCase()}`}>
            <span className="when">{e.ts ? fmtTime(e.ts) : ''}</span>
            <span className="lvl">{e.level}</span>
            <span className="logger" title={e.logger}>{e.logger.split('.').slice(-1)[0]}</span>
            {e.session && <a className="sess" href="#" title={`logged inside session ${e.session} · click to select it`}
               onClick={ev => { ev.preventDefault(); ev.stopPropagation(); onSelect?.(`session:${e.session}`) }}>{e.session.slice(0, 8)}</a>}
            <pre>{e.msg}</pre>
          </div>
        ))}
        {data && !data.entries?.length && <div className="small">nothing at this level.</div>}
      </div>
    </div>
  )
}
