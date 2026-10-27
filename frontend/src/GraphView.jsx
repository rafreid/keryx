import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import ForceGraph2D from 'react-force-graph-2d'
import SpriteText from 'three-spritetext'
import { ACTIVE, STATUS, TYPE, ageAlpha, nodeBaseColor, withAlpha } from './util.js'

const LABELLED = new Set(['hub', 'source', 'session', 'subagent', 'cron', 'model'])

/**
 * Renders the graph in 3D or 2D. Keeps node objects stable across updates so the
 * layout does not re-explode; applies age fade, status colours, hover highlight,
 * search dimming and platform collapsing.
 */
export default function GraphView({ graph, view, windowSec, selected, onSelect, search, collapsed, toggleCollapse }) {
  const fgRef = useRef()
  const wrapRef = useRef()
  const nodesRef = useRef(new Map())
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  // ---- merge incoming data into stable node objects, apply collapse ------
  const data = useMemo(() => {
    if (!graph) return { nodes: [], links: [] }
    const incoming = new Set()
    const byId = new Map()
    for (const n of graph.nodes) {
      incoming.add(n.id)
      let cur = nodesRef.current.get(n.id)
      if (cur) Object.assign(cur, n); else { cur = { ...n }; nodesRef.current.set(n.id, cur) }
      byId.set(n.id, cur)
    }
    for (const id of [...nodesRef.current.keys()]) if (!incoming.has(id)) nodesRef.current.delete(id)

    // collapse: hide everything reachable below a collapsed platform (except shared model nodes)
    const hidden = new Set()
    const childrenOf = new Map()
    for (const l of graph.links) {
      if (l.kind === 'platform' || l.kind === 'model') continue
      if (!childrenOf.has(l.source)) childrenOf.set(l.source, [])
      childrenOf.get(l.source).push(l.target)
    }
    const hide = id => { for (const c of childrenOf.get(id) || []) if (!hidden.has(c)) { hidden.add(c); hide(c) } }
    for (const src of collapsed) hide(src)
    for (const src of collapsed) { const n = byId.get(src); if (n) n.collapsedCount = (childrenOf.get(src) || []).length }
    for (const n of byId.values()) if (!collapsed.has(n.id)) n.collapsedCount = 0

    const nodes = [...byId.values()].filter(n => !hidden.has(n.id))
    const keep = new Set(nodes.map(n => n.id))
    const links = graph.links.filter(l => keep.has(l.source) && keep.has(l.target)).map(l => ({ ...l }))
    // models with no visible sessions vanish when collapsed
    const linked = new Set(links.flatMap(l => [l.source, l.target]))
    return { nodes: nodes.filter(n => n.type !== 'model' || linked.has(n.id)), links }
  }, [graph, collapsed])

  // ---- neighbourhood for hover highlight ---------------------------------
  const neighbours = useMemo(() => {
    const m = new Map()
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? l.source.id : l.source
      const t = typeof l.target === 'object' ? l.target.id : l.target
      if (!m.has(s)) m.set(s, new Set()); if (!m.has(t)) m.set(t, new Set())
      m.get(s).add(t); m.get(t).add(s)
    }
    return m
  }, [data])

  const q = (search || '').trim().toLowerCase()
  const matches = useCallback(n => !q || `${n.label} ${n.request || ''} ${n.last_step || ''} ${n.source || ''} ${n.model || ''}`.toLowerCase().includes(q), [q])
  const focusId = hover || selected
  const emphasised = useCallback(n => {
    if (q && !matches(n)) return false
    if (!focusId) return true
    return n.id === focusId || neighbours.get(focusId)?.has(n.id)
  }, [q, matches, focusId, neighbours])

  const colorOf = useCallback(n => {
    const base = n.active ? ACTIVE : nodeBaseColor(n)
    let a = n.type === 'hub' || n.type === 'source' ? 1 : ageAlpha(n.age, windowSec)
    if (!emphasised(n)) a *= 0.18
    return withAlpha(base, a)
  }, [windowSec, emphasised])

  const linkColor = useCallback(l => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.get(l.source)
    const t = typeof l.target === 'object' ? l.target : nodesRef.current.get(l.target)
    const emph = (s && emphasised(s)) && (t && emphasised(t))
    const base = l.active ? ACTIVE : l.errors > 0 ? '#f85149' : l.kind === 'spawn' ? '#c3a6ff' : '#8ea0bf'
    const a = (l.kind === 'platform' ? 0.7 : ageAlpha(l.age, windowSec, 0.15) * 0.75) * (emph ? 1 : 0.1)
    return withAlpha(base, a)
  }, [windowSec, emphasised])

  const sizeOf = n => (n.val || 3) * (n.id === focusId ? 1.6 : 1)
  const particles = l => (l.active ? 3 + Math.min(6, l.value || 1) : l.kind === 'tool' && (l.value || 0) > 3 ? 1 : 0)
  const particleSpeed = l => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.get(l.source)
    const rate = s?.calls_per_min || 0
    return l.active ? 0.006 + Math.min(0.02, rate * 0.002) : 0.003
  }

  const handleClick = useCallback(n => {
    if (n.type === 'source') { toggleCollapse(n.id); return }
    onSelect(n.id)
    if (view === '3d' && fgRef.current && n.x != null) {
      const d = 80, r = Math.hypot(n.x, n.y, n.z) || 1
      fgRef.current.cameraPosition({ x: n.x * (1 + d / r), y: n.y * (1 + d / r), z: n.z * (1 + d / r) }, n, 800)
    } else if (view === '2d' && fgRef.current && n.x != null) {
      fgRef.current.centerAt(n.x, n.y, 600); fgRef.current.zoom(3, 600)
    }
  }, [onSelect, toggleCollapse, view])

  const tooltip = n => {
    const st = STATUS[n.status]?.label
    const extra = n.type === 'session' || n.type === 'subagent'
      ? `${st} · ${n.messages} msgs · ${n.tool_calls} calls${n.tool_errors ? ` · ${n.tool_errors} errors` : ''}`
      : n.type === 'tool' ? `${n.calls} calls${n.errors ? `, ${n.errors} failed` : ''}`
      : n.type === 'model' ? `${fmt(n.tokens_in)} in · ${fmt(n.tokens_out)} out · cache ${((n.cache_hit || 0) * 100) | 0}%`
      : n.type === 'cron' ? `${n.schedule || ''} · last ${n.last_status || 'never'}`
      : n.type === 'source' ? (n.collapsedCount ? `collapsed (${n.collapsedCount}) — click to expand` : 'click to collapse')
      : ''
    return `<div style="background:#121a27;border:1px solid #223049;border-radius:6px;padding:6px 8px;max-width:320px;color:#e6edf7">
      <b>${esc(n.label)}</b><br><span style="color:#8fa0b8">${esc(TYPE[n.type]?.label || n.type)}</span>${extra ? '<br>' + esc(extra) : ''}</div>`
  }

  // ---- 3D label sprites on top of the default spheres --------------------
  const threeObject = useCallback(n => {
    if (!LABELLED.has(n.type)) return false
    const text = n.collapsedCount ? `${n.label} (+${n.collapsedCount})` : n.label
    const s = new SpriteText(text.length > 34 ? text.slice(0, 33) + '…' : text)
    s.color = n.type === 'hub' ? '#fff' : withAlpha('#e6edf7', emphasised(n) ? 0.9 : 0.15)
    s.textHeight = n.type === 'hub' ? 6 : n.type === 'source' ? 4.5 : 2.6
    s.position.y = -(Math.cbrt(n.val || 3) * 4 + 3)
    return s
  }, [emphasised])

  // ---- 2D painter --------------------------------------------------------
  const paint2d = useCallback((n, ctx, scale) => {
    const r = Math.cbrt(n.val || 3) * 2.2
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI); ctx.fillStyle = colorOf(n); ctx.fill()
    if (n.id === selected) { ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = '#fff'; ctx.stroke() }
    if (LABELLED.has(n.type) && (scale > 1.4 || n.type === 'hub' || n.type === 'source')) {
      const text = n.collapsedCount ? `${n.label} (+${n.collapsedCount})` : n.label
      ctx.font = `${Math.max(2.5, 10 / scale)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha('#e6edf7', emphasised(n) ? 0.9 : 0.15)
      ctx.fillText(text.length > 40 ? text.slice(0, 39) + '…' : text, n.x, n.y + r + 1)
    }
  }, [colorOf, emphasised, selected])

  useEffect(() => { fgRef.current?.d3Force('charge')?.strength(view === '3d' ? -80 : -120) }, [view])

  const common = {
    ref: fgRef, graphData: data, width: size.w, height: size.h, nodeId: 'id',
    nodeLabel: tooltip, nodeVal: sizeOf, onNodeClick: handleClick,
    onNodeHover: n => setHover(n ? n.id : null), onBackgroundClick: () => onSelect(null),
    linkColor, linkWidth: l => (l.kind === 'tool' ? Math.min(4, 0.4 + Math.log1p(l.value || 1)) : l.kind === 'spawn' ? 1.2 : 0.6),
    linkDirectionalParticles: particles, linkDirectionalParticleSpeed: particleSpeed,
    linkDirectionalParticleWidth: l => (l.active ? 2.2 : 1), linkLabel: l => (l.kind === 'spawn' && l.goal ? `${l.state || ''} ${l.delivery || ''} — ${esc(l.goal)}` : ''),
    cooldownTicks: 120, warmupTicks: 20,
  }

  return (
    <div className="canvas" ref={wrapRef}>
      {view === '3d'
        ? <ForceGraph3D {...common} backgroundColor="#0b0f17" showNavInfo={false} nodeColor={colorOf} nodeOpacity={0.95}
            nodeThreeObject={threeObject} nodeThreeObjectExtend={true} linkOpacity={0.8} />
        : <ForceGraph2D {...common} backgroundColor="#0b0f17" nodeCanvasObject={paint2d} nodeCanvasObjectMode={() => 'replace'}
            linkDirectionalArrowLength={0} />}
    </div>
  )
}

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0))
