import React from 'react'
import { num } from './util.js'

/**
 * Analytics cards after hermes-workspace's dashboard: insight callouts, velocity with momentum,
 * cache-hit trend, provider mix, and when Hermes works (hour of day, weekday × hour). All pure
 * renders of the /api/analytics payload.
 */

export function Insights({ items }) {
  if (!items?.length) return null
  return <div className="insights">{items.map((i, k) => <div key={k} className={`insight ${i.tone}`}>{i.text}</div>)}</div>
}

/** Tiny inline sparkline: values → polyline in a fixed box. */
export function Spark({ values, width = 90, height = 22, cls = '' }) {
  const v = values || []
  if (v.length < 2) return null
  const max = Math.max(1, ...v), step = width / (v.length - 1)
  const pts = v.map((x, i) => `${(i * step).toFixed(1)},${(height - 2 - (x / max) * (height - 4)).toFixed(1)}`).join(' ')
  return <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`spark ${cls}`} aria-hidden><polyline points={pts} /></svg>
}

export function Velocity({ v }) {
  if (!v) return null
  const d = v.delta_pct
  return (
    <div className="tile">
      <div className="v">{v.per_day}<span className="small"> /day</span></div>
      <div className="l">sessions per day</div>
      <div className="s">{d == null ? 'not enough history for a trend' : <span className={d > 0 ? 'ok' : d < 0 ? 'warn' : ''}>{d > 0 ? '▲' : d < 0 ? '▼' : '▶'} {Math.abs(d)}% vs first half</span>} <Spark values={v.spark} /></div>
    </div>
  )
}

/** Cache hit per day across the window: cache_read / (cache_read + tokens_in). */
export function CacheTrend({ days, totals }) {
  const rate = (days || []).map(r => (r.cache_read + r.tokens_in ? r.cache_read / (r.cache_read + r.tokens_in) : 0))
  const active = rate.filter((_, i) => days[i].cache_read + days[i].tokens_in > 0)
  return (
    <div className="tile">
      <div className="v">{((totals?.cache_hit || 0) * 100).toFixed(0)}%</div>
      <div className="l">cache hit</div>
      <div className="s">{num(totals?.cache_read)} cached · {num(totals?.tokens_in)} fresh{active.length > 1 ? <> <Spark values={rate} /></> : null}</div>
    </div>
  )
}

const HUES = ['var(--accent)', 'var(--green)', 'var(--amber)', 'var(--blue)', 'var(--red)', 'var(--muted)']

/** Provider mix donut (CSS conic gradient) with a legend; Hermes records the billing provider per session. */
export function Providers({ list }) {
  if (!list?.length) return null
  let acc = 0
  const stops = list.map((p, i) => { const from = acc; acc += p.share * 100; return `${HUES[i % HUES.length]} ${from.toFixed(1)}% ${acc.toFixed(1)}%` })
  return (
    <div className="provmix">
      <div className="donut" style={{ background: `conic-gradient(${stops.join(', ')})` }} title="share of tokens by billing provider"><i /></div>
      <div className="legend">
        {list.map((p, i) => <div key={p.provider} className="small"><span className="sw" style={{ background: HUES[i % HUES.length] }} />{p.provider} <b>{(p.share * 100).toFixed(0)}%</b> · {num(p.tokens)} tokens · {p.sessions} session{p.sessions === 1 ? '' : 's'}{p.cost_usd ? ` · $${p.cost_usd.toFixed(2)}` : ''}</div>)}
      </div>
    </div>
  )
}

/** Hour-of-day strip and weekday × hour grid, UTC. */
export function Clock({ c }) {
  if (!c) return null
  const max = Math.max(1, ...c.hours.map(h => h.tool_calls + h.sessions))
  const cell = 9, gap = 2, left = 26, W = left + 24 * (cell + gap), H = 7 * (cell + gap)
  const level = v => (!v || !c.max ? 0 : v >= c.max * 0.75 ? 4 : v >= c.max * 0.5 ? 3 : v >= c.max * 0.25 ? 2 : 1)
  return (
    <div className="clock">
      <div className="small">by hour of day ({c.tz}){c.peak_hour != null ? ` · busiest around ${String(c.peak_hour).padStart(2, '0')}:00` : ''}</div>
      <svg viewBox={`0 0 ${W} 36`} width={W} height={36} className="hours" aria-label="activity by hour of day">
        {c.hours.map(h => { const v = h.tool_calls + h.sessions, ht = (v / max) * 26
          return <g key={h.hour}><rect x={left + h.hour * (cell + gap)} y={28 - ht} width={cell} height={ht} className="bar"><title>{String(h.hour).padStart(2, '0')}:00 · {h.sessions} sessions · {h.tool_calls} tool calls</title></rect>
            {h.hour % 6 === 0 && <text x={left + h.hour * (cell + gap)} y={35} className="axis">{String(h.hour).padStart(2, '0')}</text>}</g> })}
      </svg>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="heatmap" aria-label="tool calls by weekday and hour">
        {c.grid.map((row, r) => <g key={r}>
          <text x={0} y={r * (cell + gap) + cell - 1} className="axis">{c.weekdays[r]}</text>
          {row.map((v, h) => <rect key={h} x={left + h * (cell + gap)} y={r * (cell + gap)} width={cell} height={cell} rx={2} className={`c l${level(v)}`}><title>{c.weekdays[r]} {String(h).padStart(2, '0')}:00 · {v} tool calls</title></rect>)}
        </g>)}
      </svg>
    </div>
  )
}
