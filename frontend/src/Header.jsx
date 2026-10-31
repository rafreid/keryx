import React, { useState } from 'react'
import { requestDesktopPermission } from './notify.js'
import { playSound, unlockAudio } from './sounds.js'
import { tz } from './util.js'

const WINDOWS = [[1, 'last hour'], [6, '6 hours'], [24, '24 hours'], [168, '7 days'], [0, 'all time']]

export default function Header({ status, hours, setHours, view, setView, live, setLive, conn, cost, theme, setTheme, notify, setNotify, sound, setSound }) {
  const level = status?.level || 'amber'
  // the title dot summarises health; only checks that are not green stay inline, the rest sit behind one pill
  const checks = status?.checks || []
  const trouble = checks.filter(c => c.level !== 'green')
  const nRed = trouble.filter(c => c.level === 'red').length, nAmber = trouble.length - nRed
  const hermes = status?.hermes
  const [qr, setQr] = useState(false)
  const [health, setHealth] = useState(false)
  const toggleSound = () => {
    if (sound) { setSound(false); return }
    if (unlockAudio()) { setSound(true); playSound('ok') }          // the gesture unlocks audio; the chime confirms it works
  }
  const toggleNotify = async () => {
    if (notify) { setNotify(false); return }
    const ok = await requestDesktopPermission()
    setNotify(ok)
    if (!ok) alert('Desktop notifications are blocked for this site. In-app toasts still work.')
  }
  return (
    <div className="header">
      <h1 title={(status?.attention || []).filter(a => a.severity !== 'info').map(a => `${a.severity === 'red' ? '●' : '○'} ${a.label}`).join('\n') || 'all clear'}><span className={`dot ${level} ${level === 'red' ? 'pulse' : ''}`} />Keryx{status?.keryx ? <span className="ver">{status.keryx}</span> : null} <span className="small" style={{ fontWeight: 400 }} title={hermes ? `gateway ${hermes.state}${hermes.desired && hermes.desired !== hermes.state ? ` (wanted ${hermes.desired})` : ''} · pid ${hermes.pid ?? '?'} · ${hermes.sha || ''}` : ''}>· Hermes activity{hermes?.version ? ` · Hermes ${hermes.version}` : ''}</span> <span className="small tz" title="times are shown in this browser's zone; analytics days are counted in UTC">{tz()}</span></h1>
      <span className="healthwrap">
        <button className={`pill ${health ? 'on' : ''}`} onClick={() => setHealth(h => !h)} aria-expanded={health} aria-label="health checks"
                title={trouble.length ? trouble.map(c => `${c.name}: ${c.detail}`).join('\n') : 'every check is green'}>
          <span className={`dot ${level}`} />health{trouble.length ? <> · {nRed ? <span className="err">{nRed} red</span> : null}{nRed && nAmber ? ' · ' : ''}{nAmber ? <span className="warn">{nAmber} amber</span> : null}</> : ' · all green'}
        </button>
        {health && <div className="popover health">
          <table><tbody>{checks.map(c => (
            <tr key={c.name}><td><span className={`dot ${c.level}`} />{c.name.replace(/_/g, ' ')}</td><td>{c.detail}</td></tr>
          ))}</tbody></table>
          <div className="small">the title dot shows the worst check · the Overview's attention list says what to do about it</div>
        </div>}
      </span>
      {trouble.map(c => (
        <span key={c.name} className="check" title={(c.recent && c.recent.join('\n')) || c.last || c.detail}>
          <span className={`dot ${c.level}`} /><b>{c.name.replace(/_/g, ' ')}</b> {short(c.detail)}
        </span>
      ))}
      {cost?.totals && (
        <span className="check" title={`cache hit ${(cost.totals.cache_hit * 100).toFixed(0)}% · ${cost.totals.calls} API calls${cost.totals.cost_usd ? ` · cost ${cost.totals.cost_basis === 'actual' ? 'reported by the provider' : cost.totals.cost_basis === 'mixed' ? 'partly estimated' : 'estimated (~)'}` : ''}`}>
          <b>tokens</b> {fmtTok(cost.totals.input)} in · {fmtTok(cost.totals.output)} out
          {cost.totals.cost_usd ? ` · ${cost.totals.cost_basis === 'actual' ? '' : '~'}$${cost.totals.cost_usd.toFixed(2)}` : ''}
        </span>
      )}
      <div className="right">
        <select value={hours} onChange={e => setHours(Number(e.target.value))} aria-label="time window">
          {WINDOWS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
        <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')} aria-pressed={view === '3d'} aria-label="3D view">3D</button>
        <button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')} aria-pressed={view === '2d'} aria-label="2D view">2D</button>
        <button className={notify ? 'on' : ''} onClick={toggleNotify} aria-pressed={notify} aria-label="desktop notifications" title={notify ? 'desktop notifications on (replies, failures, cron)' : 'enable desktop notifications'}>{notify ? '🔔' : '🔕'}</button>
        <button className={sound ? 'on' : ''} onClick={toggleSound} aria-pressed={sound} aria-label="notification sounds" title={sound ? 'sounds on: a chime when Hermes replies, a knock for warnings, a falling tone for failures' : 'play a short sound with each notification'}>{sound ? '🔈' : '🔇'}</button>
        <span className="qrwrap">
          <button className={qr ? 'on' : ''} onClick={() => setQr(q => !q)} aria-expanded={qr} aria-label="open on your phone" title="open Keryx on your phone">📱</button>
          {qr && <div className="popover qr">
            <img src={`/api/qr?text=${encodeURIComponent(location.href)}`} alt="QR code of this page" width="168" height="168" />
            <div className="small" style={{ wordBreak: 'break-all' }}>{location.href}</div>
            <div className="small">scan from a phone on the same LAN or Tailscale network · then "add to home screen" to keep it as an app</div>
          </div>}
        </span>
        <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'switch to the light theme' : 'switch to the dark theme'} title="toggle theme">{theme === 'dark' ? '☾' : '☀'}</button>
        <button className={live ? 'on' : ''} onClick={() => setLive(!live)} aria-pressed={live} aria-label={live ? 'pause live updates' : 'resume live updates'} title={`connection: ${conn}`}>
          {live ? (conn === 'live' ? '● live' : `● ${conn}`) : '○ paused'}
        </button>
      </div>
    </div>
  )
}
const short = (t, n = 64) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t)
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0))
