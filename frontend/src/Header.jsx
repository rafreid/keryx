import React, { useState } from 'react'
import { requestDesktopPermission } from './notify.js'

const WINDOWS = [[1, 'last hour'], [6, '6 hours'], [24, '24 hours'], [168, '7 days'], [0, 'all time']]

export default function Header({ status, hours, setHours, view, setView, live, setLive, conn, cost, theme, setTheme, notify, setNotify }) {
  const level = status?.level || 'amber'
  const [qr, setQr] = useState(false)
  const toggleNotify = async () => {
    if (notify) { setNotify(false); return }
    const ok = await requestDesktopPermission()
    setNotify(ok)
    if (!ok) alert('Desktop notifications are blocked for this site. In-app toasts still work.')
  }
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
        <button className={notify ? 'on' : ''} onClick={toggleNotify} title={notify ? 'desktop notifications on (replies, failures, cron)' : 'enable desktop notifications'}>{notify ? '🔔' : '🔕'}</button>
        <span className="qrwrap">
          <button className={qr ? 'on' : ''} onClick={() => setQr(q => !q)} title="open Keryx on your phone">📱</button>
          {qr && <div className="popover qr">
            <img src={`/api/qr?text=${encodeURIComponent(location.href)}`} alt="QR code of this page" width="168" height="168" />
            <div className="small" style={{ wordBreak: 'break-all' }}>{location.href}</div>
            <div className="small">scan from a phone on the same LAN or Tailscale network</div>
          </div>}
        </span>
        <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="toggle theme">{theme === 'dark' ? '☾' : '☀'}</button>
        <button className={live ? 'on' : ''} onClick={() => setLive(!live)} title={`connection: ${conn}`}>
          {live ? (conn === 'live' ? '● live' : `● ${conn}`) : '○ paused'}
        </button>
      </div>
    </div>
  )
}
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0))
