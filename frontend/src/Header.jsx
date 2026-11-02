import React from 'react'
import { requestDesktopPermission } from './notify.js'
import { playSound, unlockAudio } from './sounds.js'
import { troubleCounts, worstCheck } from './tabs.js'
import { usePopover } from './hooks/usePopover.js'
import Icon from './Icons.jsx'

const WINDOWS = [[1, 'last hour'], [6, '6 hours'], [24, '24 hours'], [168, '7 days'], [0, 'all time']]

/**
 * Desktop: brand · health pill (every check lives in its popover) · the single worst check · tokens · controls.
 * Phone (`narrow`): one row, brand and the live toggle, everything else behind a "more" sheet; the
 * health count sits in the map/panel bar instead.
 */
export default function Header({ status, hours, setHours, view, setView, live, setLive, cost, theme, setTheme, notify, setNotify, sound, setSound, onHelp, onNotice, narrow }) {
  const level = status?.level || 'amber'
  const checks = status?.checks || []
  const trouble = checks.filter(c => c.level !== 'green')
  const { red: nRed, amber: nAmber } = troubleCounts(checks)
  const worst = worstCheck(checks)
  const hermes = status?.hermes
  const [qr, setQr, qrRef] = usePopover()
  const [health, setHealth, healthRef] = usePopover()
  const [more, setMore, moreRef] = usePopover()
  const toggleSound = () => {
    if (sound) { setSound(false); return }
    if (unlockAudio()) { setSound(true); playSound('ok') }          // the gesture unlocks audio; the chime confirms it works
  }
  const toggleNotify = async () => {
    if (notify) { setNotify(false); return }
    const ok = await requestDesktopPermission()
    setNotify(ok)
    if (!ok) onNotice?.({ level: 'warn', title: 'Desktop notifications are blocked for this site', body: 'In-app toasts still work. Allow notifications in the browser\'s site settings to change that.' })
  }
  const controls = (
    <>
      <select value={hours} onChange={e => setHours(Number(e.target.value))} aria-label="time window">
        {WINDOWS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
      </select>
      <span className="seg" role="group" aria-label="graph view">
        <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')} aria-pressed={view === '3d'} aria-label="3D view">3D</button>
        <button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')} aria-pressed={view === '2d'} aria-label="2D view">2D</button>
      </span>
      <button className={`ic ${notify ? 'on' : ''}`} onClick={toggleNotify} aria-pressed={notify} aria-label="desktop notifications" title={notify ? 'desktop notifications on (replies, failures, cron)' : 'enable desktop notifications'}><Icon name={notify ? 'bell' : 'bellOff'} /><span className="lbl">alerts</span></button>
      <button className={`ic ${sound ? 'on' : ''}`} onClick={toggleSound} aria-pressed={sound} aria-label="notification sounds" title={sound ? 'sounds on: a chime when Hermes replies, a knock for warnings, a falling tone for failures' : 'play a short sound with each notification'}><Icon name={sound ? 'sound' : 'soundOff'} /><span className="lbl">sound</span></button>
      <span className="qrwrap" ref={qrRef}>
        <button className={`ic ${qr ? 'on' : ''}`} onClick={() => setQr(q => !q)} aria-expanded={qr} aria-label="open on your phone" title="open Keryx on your phone"><Icon name="phone" /><span className="lbl">phone</span></button>
        {qr && <div className="popover qr">
          <img src={`/api/qr?text=${encodeURIComponent(location.href)}`} alt="QR code of this page" width="168" height="168" />
          <div className="small" style={{ wordBreak: 'break-all' }}>{location.href}</div>
          <div className="small">scan from a phone on the same LAN or Tailscale network · then "add to home screen" to keep it as an app</div>
        </div>}
      </span>
      <button className="ic" onClick={onHelp} aria-label="how to read Keryx" title="how to read this"><Icon name="help" /><span className="lbl">help</span></button>
      <button className="ic" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'switch to the light theme' : 'switch to the dark theme'} title="toggle theme"><Icon name={theme === 'dark' ? 'moon' : 'sun'} /><span className="lbl">{theme === 'dark' ? 'dark' : 'light'}</span></button>
    </>
  )
  const liveButton = (
    <button className={`ic ${live ? 'on' : ''}`} onClick={() => setLive(!live)} aria-pressed={live} aria-label={live ? 'pause live updates' : 'resume live updates'} title={live ? 'pause live updates; the strip below says how current the picture is' : 'resume live updates'}>
      <Icon name={live ? 'pause' : 'play'} />{live ? 'live' : 'paused'}
    </button>
  )
  const brand = (
    <div className="brand" title={(status?.attention || []).filter(a => a.severity !== 'info').map(a => `${a.severity === 'red' ? '●' : '○'} ${a.label}`).join('\n') || 'all clear'}>
      <span className={`dot ${level} ${level === 'red' ? 'pulse' : ''}`} aria-hidden="true" />
      <h1>Keryx</h1>
      {status?.keryx ? <span className="ver">{status.keryx}</span> : null}
      {!narrow && <span className="sub" title={`Hermes activity monitor${hermes ? ` · gateway ${hermes.state}${hermes.desired && hermes.desired !== hermes.state ? ` (wanted ${hermes.desired})` : ''} · pid ${hermes.pid ?? '?'} · ${hermes.sha || ''}` : ''}`}>{hermes?.version ? `Hermes ${hermes.version}` : 'Hermes activity'}</span>}
    </div>
  )
  if (narrow) return (
    <div className="header narrow" ref={moreRef}>
      {brand}
      <div className="right">
        {liveButton}
        <button className={`ic ${more ? 'on' : ''}`} onClick={() => setMore(m => !m)} aria-expanded={more} aria-label="more controls" title="window, view, alerts, sound, phone, help, theme"><Icon name="more" /></button>
      </div>
      {more && <div className="sheet" role="group" aria-label="controls">{controls}</div>}
    </div>
  )
  return (
    <div className="header">
      {brand}
      <span className="healthwrap" ref={healthRef}>
        <button className={`pill ${health ? 'on' : ''}`} onClick={() => setHealth(h => !h)} aria-expanded={health} aria-label="health checks"
                title={!status ? 'no status received yet' : trouble.length ? trouble.map(c => `${c.name}: ${c.detail}`).join('\n') : 'every check is green'}>
          <span className={`dot ${level}`} />health{!status ? ' · waiting for data' : trouble.length ? <> · {nRed ? <span className="err">{nRed} red</span> : null}{nRed && nAmber ? ' · ' : ''}{nAmber ? <span className="warn">{nAmber} amber</span> : null}</> : ' · all green'}
        </button>
        {health && <div className="popover health">
          <table><tbody>{checks.map(c => (
            <tr key={c.name}><td><span className={`dot ${c.level}`} />{c.name.replace(/_/g, ' ')}</td><td>{c.detail}</td></tr>
          ))}</tbody></table>
          <div className="small">the title dot shows the worst check · the Overview's attention list says what to do about it · Esc closes</div>
        </div>}
      </span>
      {worst && (
        <span className="check" title={(worst.recent && worst.recent.join('\n')) || worst.last || worst.detail}>
          <span className={`dot ${worst.level}`} /><b>{worst.name.replace(/_/g, ' ')}</b> {short(worst.detail)}
          {trouble.length > 1 ? <span className="small"> · {trouble.length - 1} more in health</span> : null}
        </span>
      )}
      {cost?.totals && (
        <span className="check" title={`cache hit ${(cost.totals.cache_hit * 100).toFixed(0)}% · ${cost.totals.calls} API calls${cost.totals.cost_usd ? ` · cost ${cost.totals.cost_basis === 'actual' ? 'reported by the provider' : cost.totals.cost_basis === 'mixed' ? 'partly estimated' : 'estimated (~)'}` : ''}`}>
          <b>tokens</b> {fmtTok(cost.totals.input)} in · {fmtTok(cost.totals.output)} out
          {cost.totals.cost_usd ? ` · ${cost.totals.cost_basis === 'actual' ? '' : '~'}$${cost.totals.cost_usd.toFixed(2)}` : ''}
        </span>
      )}
      <div className="right">
        {controls}
        {liveButton}
      </div>
    </div>
  )
}
const short = (t, n = 72) => (t && t.length > n ? t.slice(0, n - 1) + '…' : t)
const fmtTok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0))
