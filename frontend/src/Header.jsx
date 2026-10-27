import React from 'react'

const WINDOWS = [[1, 'last hour'], [6, '6 hours'], [24, '24 hours'], [168, '7 days'], [0, 'all time']]

export default function Header({ status, hours, setHours, view, setView, live, setLive, conn, cost }) {
  const level = status?.level || 'amber'
  return (
    <div className="header">
      <h1><span className={`dot ${level} ${level === 'red' ? 'pulse' : ''}`} />Keryx <span className="small" style={{ fontWeight: 400 }}>· Hermes activity</span></h1>
      {(status?.checks || []).map(c => (
        <span key={c.name} className="check" title={(c.recent && c.recent.join('\n')) || c.last || c.detail}>
          <span className={`dot ${c.level}`} /><b>{c.name}</b> {c.detail}
        </span>
      ))}
      {cost?.totals && (
        <span className="check" title={`cache hit ${(cost.totals.cache_hit * 100).toFixed(0)}% · ${cost.totals.calls} API calls`}>
          <b>tokens</b> {fmtTok(cost.totals.input)} in · {fmtTok(cost.totals.output)} out
          {cost.totals.cost_usd ? ` · $${cost.totals.cost_usd.toFixed(2)}` : ''}
        </span>
      )}
      <div className="right">
        <select value={hours} onChange={e => setHours(Number(e.target.value))}>
          {WINDOWS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
        <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>3D</button>
        <button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}>2D</button>
        <button className={live ? 'on' : ''} onClick={() => setLive(!live)} title={`connection: ${conn}`}>
          {live ? (conn === 'live' ? '● live' : `● ${conn}`) : '○ paused'}
        </button>
      </div>
    </div>
  )
}
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0))
