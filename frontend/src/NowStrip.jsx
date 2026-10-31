import React from 'react'
import { STATUS, contextLevel, dur, plural } from './util.js'
import Shape from './Shapes.jsx'

export default function NowStrip({ now, selected, onSelect }) {
  const rows = (now?.running || []).filter(r => r.status === 'running' || r.status === 'stale' || r.status === 'waiting')
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
          <div className="step" title={r.last_step || ''}>{r.status === 'waiting' ? '✓ replied, your turn' : r.last_step ? '→ ' + r.last_step : '→ starting'}</div>
          {r.plan && <div className="plan small" title={r.plan.current ? `current step: ${r.plan.current}` : ''}>▶ plan {r.plan.done}/{r.plan.total}{r.plan.current ? ` · ${r.plan.current}` : ''}</div>}
          <div className="meta">
            <span>{r.source}</span><span>{dur(r.elapsed)} running</span><span>idle {dur(r.idle)}</span>
            <span>{plural(r.tool_calls, 'call')}{r.tool_errors ? <span className="err"> · {r.tool_errors} failed</span> : ''}</span>
            {r.calls_per_min > 0 && <span>{r.calls_per_min}/min</span>}
            {r.children > 0 && <span>{plural(r.children, 'subagent')}</span>}
            {r.git_branch && <span title={r.cwd || ''}>⎇ {r.git_branch}</span>}
            {r.compactions > 0 && <span title="the context window was compacted; Keryx shows the whole conversation as one session">⟲ {r.compactions}</span>}
            {r.context && <span className={contextLevel(r.context.pct)} title={`context window ${r.context.pct}% full`}>ctx {r.context.pct.toFixed(0)}%</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
