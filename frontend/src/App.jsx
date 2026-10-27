import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Header from './Header.jsx'
import NowStrip from './NowStrip.jsx'
import GraphView from './GraphView.jsx'
import SidePanel from './SidePanel.jsx'
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

  useEffect(() => {
    const p = new URLSearchParams(); p.set('hours', hours); p.set('view', view)
    history.replaceState(null, '', '?' + p.toString())
  }, [hours, view])

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
              live={live} setLive={setLive} conn={conn} cost={data?.cost} />
      <div className="body">
        <div className="main">
          <NowStrip now={data?.now} selected={selected} onSelect={setSelected} />
          <div className="graphwrap">
            <GraphView graph={graph} view={view} windowSec={windowSec} selected={selected} onSelect={setSelected}
                       search={search} collapsed={collapsed} toggleCollapse={toggleCollapse} hidden={hidden} recenterSignal={recenterSignal} />
            <div className="toolbar">
              <input type="search" placeholder="search sessions, requests, tools…" value={search} onChange={e => setSearch(e.target.value)} />
              <div className="replay">
                <span>replay</span>
                <input type="range" min="0" max="100" step="0.5" value={replayPos} onChange={e => setReplayPos(Number(e.target.value))} />
                <span className="t">{replayAt ? `as of ${fmtTime(replayAt)}` : 'now (live)'}</span>
                {replayAt && <button onClick={() => setReplayPos(100)}>back to live</button>}
              </div>
              <button onClick={() => setRecenterSignal(n => n + 1)} title="frame the whole graph">⌖ recenter</button>
              {collapsed.size > 0 && <button onClick={() => setCollapsed(new Set())}>expand all</button>}
            </div>
            <div className="stats">
              sessions <b>{stats.sessions ?? '–'}</b> · running <b>{stats.running ?? 0}</b> · active <b>{stats.active ?? 0}</b> ·
              tool calls <b>{stats.tool_calls ?? 0}</b>{stats.errors ? <> · <span className="err">{stats.errors} failed</span></> : null} ·
              {graph?.generated_at ? ` updated ${fmtTime(graph.as_of || graph.generated_at)}` : ' loading…'}
            </div>
          </div>
        </div>
        <SidePanel node={selectedNode} cost={data?.cost} status={data?.status} graph={graph} onClose={() => setSelected(null)}
                   hidden={hidden} toggleHidden={toggleHidden} showAll={showAll} />
      </div>
    </div>
  )
}

const minStart = g => g ? Math.min(...g.nodes.filter(n => n.started).map(n => n.started)) : null
