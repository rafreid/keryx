import React, { useEffect, useRef, useState } from 'react'
import { num } from './util.js'

const METRICS = { sessions: 'sessions', tool_calls: 'tool calls', tokens: 'tokens', cost_usd: 'cost' }
const fmt = (k, v) => (k === 'cost_usd' ? `$${v.toFixed(2)}` : k === 'tokens' ? num(v) : String(v))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A year of days, one cell each, darker = busier (the calendar cc-switch and GitHub draw). Days are UTC. */
export default function Heatmap({ data }) {
  const [metric, setMetric] = useState('sessions')
  const scroller = useRef(null)
  // the most recent weeks are the interesting ones: start scrolled to today
  useEffect(() => { const el = scroller.current; if (el) el.scrollLeft = el.scrollWidth }, [data?.start])
  if (!data?.days?.length) return null
  const max = data.max?.[metric] || 0
  const cell = 10, gap = 2, left = 22, top = 14
  const weeks = data.weeks
  const W = left + weeks * (cell + gap), H = top + 7 * (cell + gap)
  const today = new Date().toISOString().slice(0, 10)
  const level = v => (!v || !max ? 0 : v >= max * 0.75 ? 4 : v >= max * 0.5 ? 3 : v >= max * 0.25 ? 2 : 1)
  const months = []
  data.days.forEach((d, i) => {          // label a week when its Monday is in a new month
    if (i % 7 === 0 && (i === 0 || d.day.slice(0, 7) !== data.days[i - 7].day.slice(0, 7)) && i > 0)
      months.push({ x: left + (i / 7) * (cell + gap), m: MONTHS[Number(d.day.slice(5, 7)) - 1] })
  })
  const busiest = data.days.reduce((a, b) => (b[metric] > (a?.[metric] || 0) ? b : a), null)
  return (
    <div className="heat">
      <div className="row">
        <h3 style={{ margin: 0 }}>Last year</h3>
        <select value={metric} onChange={e => setMetric(e.target.value)}>{Object.entries(METRICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <span className="small">{data.active_days} active day{data.active_days === 1 ? '' : 's'}{data.streak ? ` · ${data.streak}-day streak` : ''}</span>
      </div>
      <div className="scroll-x" ref={scroller}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="heatmap" role="img" aria-label={`${METRICS[metric]} per day over the last year`}>
          {months.map((m, i) => <text key={i} x={m.x} y={9} className="axis">{m.m}</text>)}
          {[1, 3, 5].map(r => <text key={r} x={0} y={top + r * (cell + gap) + cell - 1} className="axis">{['', 'Mon', '', 'Wed', '', 'Fri', ''][r]}</text>)}
          {data.days.map((d, i) => {
            const w = Math.floor(i / 7), r = i % 7
            if (d.day > today) return null
            return <rect key={d.day} x={left + w * (cell + gap)} y={top + r * (cell + gap)} width={cell} height={cell} rx="2"
                         className={`c l${level(d[metric])} ${d.day === today ? 'today' : ''}`}>
              <title>{`${d.day}: ${fmt(metric, d[metric])} ${METRICS[metric]}${d.sessions ? ` · ${d.sessions} sessions · ${num(d.tokens)} tokens${d.cost_usd ? ` · $${d.cost_usd}` : ''}` : ''}`}</title>
            </rect>
          })}
        </svg>
      </div>
      <div className="small heatlegend">less <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> more{busiest?.[metric] ? ` · busiest ${busiest.day}: ${fmt(metric, busiest[metric])}` : ''}</div>
    </div>
  )
}
