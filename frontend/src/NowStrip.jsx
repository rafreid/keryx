import React, { useEffect, useRef, useState } from 'react'
import { STATUS, contextLevel, dur, plural } from './util.js'
import Shape from './Shapes.jsx'
import { pressable } from './a11y.js'

export default function NowStrip({ now, selected, onSelect }) {
  const rows = (now?.running || []).filter(r => r.status === 'running' || r.status === 'stale' || r.status === 'waiting')
  const ref = useRef(null)
  const [hiddenN, setHiddenN] = useState(0)      // cards off the right edge: the strip says so instead of looking merely cut off
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const count = () => {
      const right = el.getBoundingClientRect().right
      setHiddenN([...el.querySelectorAll('.card')].filter(c => c.getBoundingClientRect().left + 40 > right).length)
    }
    count()
    el.addEventListener('scroll', count, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(count) : null
    ro?.observe(el)
    return () => { el.removeEventListener('scroll', count); ro?.disconnect() }
  }, [rows.length])
  return (
    <div className="now" role="list" aria-label="sessions in progress" ref={ref}>
      {rows.map(r => (
        <div key={r.id} className={`card ${selected === 'session:' + r.id ? 'sel' : ''}`} role="listitem">
          <div className="t" {...pressable(() => onSelect('session:' + r.id), { className: 't', 'aria-label': `${r.status}: ${r.title}. Open its details`, 'aria-pressed': selected === 'session:' + r.id })}>
            <span className={`tag ${r.status}`}>{r.status}</span>
            <Shape type={r.is_subagent ? 'subagent' : 'session'} color={STATUS[r.status]?.color || 'var(--muted)'} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
          </div>
          <div className="cardbody" onClick={() => onSelect('session:' + r.id)}>
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
        </div>
      ))}
      {hiddenN > 0 && <button type="button" className="more" onClick={() => ref.current?.scrollBy({ left: 260, behavior: 'smooth' })} aria-label={`${hiddenN} more ${hiddenN === 1 ? 'session' : 'sessions'} to the right; scroll`}>{hiddenN} more ›</button>}
    </div>
  )
}
