import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Header from './Header.jsx'
import NowStrip from './NowStrip.jsx'
import GraphView from './GraphView.jsx'
import SidePanel from './SidePanel.jsx'
import TimeAxis from './TimeAxis.jsx'
import { fetchGraphAt, useDebounced, useLive } from './api.js'
import { fmtTime } from './util.js'

const params = new URLSearchParams(location.search)

export default function App() {
  const [hours, setHours] = useState(Number(params.get('hours') ?? 24))
  const [view, setView] = useState(params.get('view') === '2d' ? '2d' : '3d')
  const [live, setLive] = useState(true)
  const [selected, setSelected] = useState(null)
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
  const [tab, setTab] = useState('overview')
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('keryx.theme') || 'dark' } catch { return 'dark' } })
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('keryx.theme', theme) } catch {} }, [theme])
  // ⌘K / Ctrl+K focuses the search box and opens the sessions tab
  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSelected(null); setTab('sessions'); document.getElementById('search')?.focus() }
      if (e.key === 'Escape') { setSelected(null); document.activeElement?.blur?.() }
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

  // 3D is the default; the URL remembers only the window, so reopening the page always starts in 3D
  // (an explicit ?view=2d link still opens 2D).
  useEffect(() => {
    const p = new URLSearchParams(); p.set('hours', hours)
    history.replaceState(null, '', '?' + p.toString())
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
  const toggleCollapse = useCallback(id => setCollapsed(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n }), [])
  const selectedNode = useMemo(() => graph?.nodes.find(n => n.id === selected) || null, [graph, selected])
  const stats = graph?.stats || {}

  return (
    <div className="app">
      <Header status={data?.status} hours={hours} setHours={setHours} view={view} setView={setView}
              live={live} setLive={setLive} conn={conn} cost={data?.cost} theme={theme} setTheme={setTheme} />
      <div className="body">
        <div className="main">
          <NowStrip now={data?.now} selected={selected} onSelect={setSelected} />
          <div className="graphwrap">
            <GraphView graph={graph} view={view} windowSec={windowSec} selected={selected} onSelect={setSelected}
                       search={search} collapsed={collapsed} toggleCollapse={toggleCollapse} hidden={hidden} recenterSignal={recenterSignal} band={band} onVisible={setVisible} spread={spread} />
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
            <div className="stats">
              {visible?.filtered ? <>showing </> : null}
              sessions <b>{visible?.filtered ? `${visible.sessions} of ${stats.sessions ?? '–'}` : (stats.sessions ?? '–')}</b> · running <b>{visible?.filtered ? visible.running : (stats.running ?? 0)}</b> · active <b>{visible?.filtered ? visible.active : (stats.active ?? 0)}</b> ·
              tool calls <b>{visible?.filtered ? visible.tool_calls : (stats.tool_calls ?? 0)}</b>{(visible?.filtered ? visible.errors : stats.errors) ? <> · <span className="err">{visible?.filtered ? visible.errors : stats.errors} failed</span></> : null} ·
              {graph?.generated_at ? ` updated ${fmtTime(graph.as_of || graph.generated_at)}` : ' loading…'}
            </div>
          </div>
        </div>
        <SidePanel node={selectedNode} cost={data?.cost} status={data?.status} graph={graph} onClose={() => setSelected(null)}
                   hidden={hidden} toggleHidden={toggleHidden} showAll={showAll} search={search} onSelect={setSelected} tab={tab} setTab={setTab} />
      </div>
    </div>
  )
}

const fmtFrac = (f, w) => { const sec = f * w; return sec < 3600 ? `${sec / 60 | 0}m` : sec < 86400 ? `${sec / 3600 | 0}h` : `${sec / 86400 | 0}d` }
const minStart = g => g ? Math.min(...g.nodes.filter(n => n.started).map(n => n.started)) : null
