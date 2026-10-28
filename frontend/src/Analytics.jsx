import React, { useEffect, useState } from 'react'
import { num } from './util.js'

/** Usage analytics: daily trend (bars + table), model distribution, totals. */
export default function Analytics() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [metric, setMetric] = useState('tool_calls')
  useEffect(() => {
    let dead = false
    const load = () => fetch(`/api/analytics?days=${days}`).then(r => r.json()).then(d => { if (!dead) setData(d) })
    load(); const t = setInterval(load, 60000)
    return () => { dead = true; clearInterval(t) }
  }, [days])
  if (!data) return <div className="small">loading analytics…</div>
  const t = data.totals || {}
  const rows = data.days || []
  const METRICS = { tool_calls: 'tool calls', sessions: 'sessions', user_messages: 'user messages', tokens_in: 'tokens in', tokens_out: 'tokens out', tool_errors: 'tool errors' }
  const max = Math.max(1, ...rows.map(r => r[metric] || 0))
  const W = 300, H = 90, bw = W / Math.max(1, rows.length)
  return (
    <div>
      <div className="row">
        <select value={days} onChange={e => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map(d => <option key={d} value={d}>{d} days</option>)}
        </select>
        <select value={metric} onChange={e => setMetric(e.target.value)}>
          {Object.entries(METRICS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="tiles">
        <Tile label="sessions" value={t.sessions} sub={`${t.sessions_per_day}/day · ${t.subagents} subagents`} />
        <Tile label="tool calls" value={num(t.tool_calls)} sub={t.tool_errors ? <span className="err">{t.tool_errors} failed</span> : 'no failures'} />
        <Tile label="tokens" value={`${num(t.tokens_in)} in`} sub={`${num(t.tokens_out)} out · ${t.api_calls} calls`} />
        <Tile label="cache hit" value={`${((t.cache_hit || 0) * 100).toFixed(0)}%`} sub={t.cost_usd ? `est. $${t.cost_usd}` : 'subscription (no per-token cost)'} />
      </div>
      <h3>{METRICS[metric]} per day {t.busiest_day ? <span className="small">· busiest {t.busiest_day}</span> : null}</h3>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="bars" preserveAspectRatio="none">
        {rows.map((r, i) => {
          const v = r[metric] || 0, h = (v / max) * H
          const err = metric === 'tool_calls' && r.tool_errors ? (r.tool_errors / max) * H : 0
          return <g key={r.day}>
            <rect x={i * bw + 0.5} y={H - h} width={Math.max(0.5, bw - 1)} height={h} className="bar"><title>{r.day}: {v}</title></rect>
            {err > 0 && <rect x={i * bw + 0.5} y={H - err} width={Math.max(0.5, bw - 1)} height={err} className="bar err" />}
            {(i === 0 || i === rows.length - 1 || (rows.length > 10 && i % Math.ceil(rows.length / 5) === 0)) &&
              <text x={i * bw + bw / 2} y={H + 11} className="axis" textAnchor="middle">{r.day.slice(5)}</text>}
          </g>
        })}
      </svg>
      <h3>Models</h3>
      <table className="cost"><thead><tr><td>model</td><td>share</td><td>in</td><td>out</td><td>cache</td><td>calls</td></tr></thead><tbody>
        {(data.models || []).map(m => <tr key={m.model}>
          <td title={(m.providers || []).join(', ')}><div className="sharebar" style={{ width: `${Math.max(2, m.share * 100)}%` }} />{m.model}</td>
          <td>{(m.share * 100).toFixed(0)}%</td><td>{num(m.input)}</td><td>{num(m.output)}</td><td>{((m.cache_hit || 0) * 100) | 0}%</td><td>{m.calls}</td></tr>)}
      </tbody></table>
      <h3>Daily table</h3>
      <div className="scroll"><table className="cost"><thead><tr><td>day</td><td>sess</td><td>msgs</td><td>calls</td><td>fail</td><td>tok in</td><td>tok out</td></tr></thead><tbody>
        {[...rows].reverse().filter(r => r.sessions || r.tool_calls || r.user_messages).map(r =>
          <tr key={r.day}><td>{r.day.slice(5)}</td><td>{r.sessions}</td><td>{r.user_messages}</td><td>{r.tool_calls}</td><td className={r.tool_errors ? 'err' : ''}>{r.tool_errors || ''}</td><td>{num(r.tokens_in)}</td><td>{num(r.tokens_out)}</td></tr>)}
      </tbody></table></div>
      <div className="small">days are UTC; tokens are attributed to the day a session started.</div>
    </div>
  )
}
const Tile = ({ label, value, sub }) => <div className="tile"><div className="v">{value ?? '–'}</div><div className="l">{label}</div><div className="s">{sub}</div></div>
