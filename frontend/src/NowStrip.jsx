import React from 'react'
import { STATUS, dur } from './util.js'
import Shape from './Shapes.jsx'

export default function NowStrip({ now, selected, onSelect }) {
  const rows = (now?.running || []).filter(r => r.status === 'running' || r.status === 'stale')
  return (
    <div className="now">
      {rows.map(r => (
        <div key={r.id} className={`card ${selected === 'session:' + r.id ? 'sel' : ''}`} onClick={() => onSelect('session:' + r.id)}>
          <div className="t">
            <span className={`tag ${r.status}`}>{r.status}</span>
            <Shape type={r.is_subagent ? 'subagent' : 'session'} color={STATUS[r.status]?.color || '#9aa7b8'} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
          </div>
          <div className="req" title={r.request || ''}>{r.request || '(no user request recorded)'}</div>
          <div className="step" title={r.last_step || ''}>{r.last_step ? '→ ' + r.last_step : '→ waiting'}</div>
          <div className="meta">
            <span>{r.source}</span><span>{dur(r.elapsed)} running</span><span>idle {dur(r.idle)}</span>
            <span>{r.tool_calls} calls{r.tool_errors ? <span className="err"> · {r.tool_errors} errors</span> : ''}</span>
            {r.calls_per_min > 0 && <span>{r.calls_per_min}/min</span>}
            {r.children > 0 && <span>{r.children} subagents</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
