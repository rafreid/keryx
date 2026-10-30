import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Header from './Header.jsx'
import NowStrip from './NowStrip.jsx'
import GraphView from './GraphView.jsx'
import SidePanel from './SidePanel.jsx'
import TimeAxis from './TimeAxis.jsx'
import { fetchGraphAt, submitToken, useDebounced, useLive } from './api.js'
import { fmtTime } from './util.js'
import { useNotifications } from './notify.js'
import { useNavHistory } from './history.js'

const params = new URLSearchParams(location.search)

export default function App() {
  const [hours, setHours] = useState(Number(params.get('hours') ?? 24))
  const [view, setView] = useState(params.get('view') === '2d' ? '2d' : '3d')
  const [live, setLive] = useState(true)
  const [tab, setTab] = useState('overview')
  // selection lives in the navigation history: every pick is a browser history entry (back/forward restore
  // the selection, the tab and the camera), and the URL hash is a shareable deep link
  const camRef = useRef(null)
  const graphRef = useRef(null)
  const labelOf = useCallback(id => graphRef.current?.nodes.find(n => n.id === id)?.label || id.split(':').pop(), [])
  const { selected, navigate, back, forward, go, trail, idx, restore } = useNavHistory({ tab, setTab, camRef, labelOf })
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [replayPos, setReplayPos] = useState(100)        // 100 = now
  const [recenterSignal, setRecenterSignal] = useState(0)
  const [band, setBand] = useState(null)       // {from, to} fractions of the window, or null
  const [visible, setVisible] = useState(null)
  const [spread, setSpread] = useState(() => { try { return Number(localStorage.getItem('keryx.spread')) || 1 } catch { return 1 } })
  const [spacingOpen, setSpacingOpen] = useState(false)
  useEffect(() => { try { localStorage.setItem('keryx.spread', String(spread)) } catch {} }, [spread])
  useEffect(() => { setBand(null) }, [hours])
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('keryx.theme') || 'dark' } catch { return 'dark' } })
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('keryx.theme', theme) } catch {} }, [theme])
  // ⌘K / Ctrl+K focuses the search box and opens the sessions tab
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); navigate(null, { tab: 'sessions' }); document.getElementById('search')?.focus() }
      if (e.key === 'Escape') { navigate(null); document.activeElement?.blur?.() }
      // Backspace = back, Shift+Backspace = forward — but never while typing in a field
      if (e.key === 'Backspace' && !isTyping(e.target)) { e.preventDefault(); e.shiftKey ? forward() : back() }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])
  // legend visibility toggles: keys like 'type:tool', 'status:stale', 'flag:active'
  const [hidden, setHidden] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('keryx.hidden') || '[]')) } catch { return new Set() } })
  const toggleHidden = useCallback(key => setHidden(h => {
    const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key)
    try { localStorage.setItem('keryx.hidden', JSON.stringify([...n])) } catch {}
    return n
  }), [])
  const showAll = useCallback(() => { setHidden(new Set()); try { localStorage.removeItem('keryx.hidden') } catch {} }, [])
  const [replayGraph, setReplayGraph] = useState(null)
  const { data, conn } = useLive(hours, live)
  const [notify, setNotify] = useState(() => { try { return localStorage.getItem('keryx.notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted' } catch { return false } })
  useEffect(() => { try { localStorage.setItem('keryx.notify', notify ? '1' : '0') } catch {} }, [notify])
  const { toasts, dismiss } = useNotifications(data, notify)

  // 3D is the default; the URL remembers only the window, so reopening the page always starts in 3D
  // (an explicit ?view=2d link still opens 2D).
  useEffect(() => {
    const p = new URLSearchParams(); p.set('hours', hours)
    history.replaceState(history.state, '', '?' + p.toString() + location.hash)   // keep the selection's hash + history state
  }, [hours])

  // ---- replay: scrub the window; off the right edge = live --------------
  const windowSec = hours > 0 ? hours * 3600 : Math.max(3600, (Date.now() / 1000) - (minStart(data?.graph) || Date.now() / 1000))
  const replayAt = replayPos >= 100 ? null : (Date.now() / 1000) - windowSec * (1 - replayPos / 100)
  const debouncedAt = useDebounced(replayAt, 150)
  useEffect(() => {
    if (debouncedAt == null) { setReplayGraph(null); return }
    let cancel = false
    fetchGraphAt(hours, debouncedAt).then(g => { if (!cancel) setReplayGraph(g) })
    return () => { cancel = true }
  }, [debouncedAt, hours])
  useEffect(() => { setReplayPos(100); setReplayGraph(null) }, [hours])

  const graph = replayGraph || data?.graph
  graphRef.current = graph
  const toggleCollapse = useCallback(id => setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }), [])
  // a compacted conversation is one node keyed by its first segment; a link to any later segment
  // (#session:<tip id>, a log line, a delegation) resolves to that node
  const resolved = (selected && graph?.aliases?.[selected]) || selected
  const selectedNode = useMemo(() => graph?.nodes.find(n => n.id === resolved) || null, [graph, resolved])
  const stats = graph?.stats || {}

  return (
    <div className="app">
      <Header status={data?.status} hours={hours} setHours={setHours} view={view} setView={setView}
              live={live} setLive={setLive} conn={conn} cost={data?.cost} theme={theme} setTheme={setTheme} notify={notify} setNotify={setNotify} />
      <div className="body">
        <div className="main">
          <NowStrip now={data?.now} selected={resolved} onSelect={navigate} />
          <div className="graphwrap">
            <GraphView graph={graph} view={view} windowSec={windowSec} selected={resolved} onSelect={navigate}
                       search={search} collapsed={collapsed} toggleCollapse={toggleCollapse} hidden={hidden} recenterSignal={recenterSignal} band={band} onVisible={setVisible} spread={spread}
                       camRef={camRef} restore={restore} />
            <TimeAxis windowSec={windowSec} band={band} setBand={setBand} />
            <div className="toolbar">
              <input id="search" type="search" placeholder="search sessions, requests, tools…  (⌘K)" value={search} onChange={e => setSearch(e.target.value)} />
              <div className="replay">
                <span>replay</span>
                <input type="range" min="0" max="100" step="0.5" value={replayPos} onChange={e => setReplayPos(Number(e.target.value))} />
                <span className="t">{replayAt ? `as of ${fmtTime(replayAt)}` : 'now (live)'}</span>
                {replayAt && <button onClick={() => setReplayPos(100)}>back to live</button>}
              </div>
              <button onClick={() => setRecenterSignal(n => n + 1)} title="frame the whole graph">⌖ recenter</button>
              <div className="spacing">
                <button className={spacingOpen || spread !== 1 ? 'on' : ''} onClick={() => setSpacingOpen(o => !o)} title="how far apart elements sit">⇔ spacing{spread !== 1 ? ` ${spread.toFixed(1)}×` : ''}</button>
                {spacingOpen && <div className="popover">
                  <div className="row">
                    <button className={spread === 0.7 ? 'on' : ''} onClick={() => setSpread(0.7)}>compact</button>
                    <button className={spread === 1 ? 'on' : ''} onClick={() => setSpread(1)}>normal</button>
                    <button className={spread === 1.5 ? 'on' : ''} onClick={() => setSpread(1.5)}>airy</button>
                    <button className={spread === 2.2 ? 'on' : ''} onClick={() => setSpread(2.2)}>wide</button>
                  </div>
                  <input type="range" min="0.5" max="2.5" step="0.05" value={spread} onChange={e => setSpread(Number(e.target.value))} />
                  <div className="small">{spread.toFixed(2)}× · scales rings, link lengths and repulsion; the time axis follows</div>
                </div>}
              </div>
              {collapsed.size > 0 && <button onClick={() => setCollapsed(new Set())}>expand all</button>}
              {band && <span className="chip">started {band.from === 0 ? 'within' : 'between'} {band.from === 0 ? '' : fmtFrac(band.from, windowSec) + ' and '}{fmtFrac(band.to, windowSec)} ago <a href="#" onClick={e => { e.preventDefault(); setBand(null) }}>✕</a></span>}
            </div>
            <Trail trail={trail} idx={idx} back={back} forward={forward} go={go} />
            <div className="stats">
              {visible?.filtered ? <>showing </> : null}
              sessions <b>{visible?.filtered ? `${visible.sessions} of ${stats.sessions ?? '–'}` : (stats.sessions ?? '–')}</b> · running <b>{visible?.filtered ? visible.running : (stats.running ?? 0)}</b> · active <b>{visible?.filtered ? visible.active : (stats.active ?? 0)}</b> ·
              tool calls <b>{visible?.filtered ? visible.tool_calls : (stats.tool_calls ?? 0)}</b>{(visible?.filtered ? visible.errors : stats.errors) ? <> · <span className="err">{visible?.filtered ? visible.errors : stats.errors} failed</span></> : null} ·
              {graph?.generated_at ? ` updated ${fmtTime(graph.as_of || graph.generated_at)}` : ' loading…'}
            </div>
          </div>
        </div>
        <SidePanel node={selectedNode} cost={data?.cost} status={data?.status} graph={graph} tasks={data?.tasks} onClose={() => navigate(null)}
                   hidden={hidden} toggleHidden={toggleHidden} showAll={showAll} search={search} onSelect={navigate} tab={tab} setTab={setTab} />
      </div>
      {conn === 'auth' && <TokenGate />}
      <div className="toasts">
        {toasts.map(t => <div key={t.id} className={`toast ${t.level}`} onClick={() => { if (t.node) { navigate(t.node) } dismiss(t.id) }}>
          <b>{t.title}</b>{t.body && <div className="small">{t.body}</div>}
        </div>)}
      </div>
    </div>
  )
}

/**
 * Where you have been: ‹ back, a few recent stops (click any to jump there), › forward.
 * Mirrors the browser history, so Alt+← / ⌘[ and a trackpad swipe do the same thing.
 */
function Trail({ trail, idx, back, forward, go }) {
  if (trail.length < 2) return null
  const from = Math.max(0, Math.min(idx - 3, trail.length - 5))
  const slice = trail.slice(from, from + 5)
  const prev = trail[idx - 1], next = trail[idx + 1]
  return (
    <div className="trail">
      <button disabled={!prev} onClick={back} title={prev ? `back to ${prev.label}  (Backspace, Alt+← or ⌘[)` : 'nothing to go back to'}>‹</button>
      {from > 0 && <span className="small">…</span>}
      {slice.map((en, j) => {
        const i = from + j
        return <React.Fragment key={en.seq}>
          {j > 0 && <span className="sep">›</span>}
          <a href="#" className={i === idx ? 'cur' : i > idx ? 'ahead' : ''} onClick={e => { e.preventDefault(); go(i - idx) }} title={en.id || `${en.label} tab`}>{en.label}</a>
        </React.Fragment>
      })}
      {from + 5 < trail.length && <span className="small">…</span>}
      <button disabled={!next} onClick={forward} title={next ? `forward to ${next.label}  (Shift+Backspace, Alt+→ or ⌘])` : 'nothing ahead'}>›</button>
    </div>
  )
}

/** Shown when the backend answers 401: KERYX_TOKEN is set and this browser has no cookie yet. */
function TokenGate() {
  const [t, setT] = useState('')
  const [bad, setBad] = useState(false)
  const go = async e => { e.preventDefault(); if (!(await submitToken(t))) setBad(true) }
  return (
    <div className="gate">
      <form onSubmit={go}>
        <h2>Keryx is locked</h2>
        <div className="small">This Keryx runs with <code>KERYX_TOKEN</code> set. Paste the token once; it is kept as a cookie in this browser.</div>
        <input type="password" autoFocus placeholder="token" value={t} onChange={e => { setT(e.target.value); setBad(false) }} />
        {bad && <div className="small err">that token was refused</div>}
        <button type="submit" className="on">unlock</button>
      </form>
    </div>
  )
}

const isTyping = el => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
const fmtFrac = (f, w) => { const sec = f * w; return sec < 3600 ? `${sec / 60 | 0}m` : sec < 86400 ? `${sec / 3600 | 0}h` : `${sec / 86400 | 0}d` }
const minStart = g => g ? Math.min(...g.nodes.filter(n => n.started).map(n => n.started)) : null
