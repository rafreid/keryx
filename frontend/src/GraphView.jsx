import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import ForceGraph2D from 'react-force-graph-2d'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { forceCollide, forceX, forceY, forceZ } from 'd3-force-3d'
import { ACTIVE, STATUS, TYPE, ageAlpha, nodeBaseColor, withAlpha } from './util.js'
import { layoutTargets, LAYOUT, timeTicks, recencyY, recencyR } from './layout.js'

const LABELLED = new Set(['hub', 'source', 'session', 'subagent', 'cron', 'model'])

// ---- shape grammar: one geometry per node role (colour is reserved for state) ----
const GEOMETRY = {
  hub:      new THREE.IcosahedronGeometry(1, 1),            // faceted core
  source:   new THREE.TorusGeometry(1, 0.28, 12, 36),       // ring: a portal messages pass through
  session:  new THREE.SphereGeometry(1, 20, 20),            // sphere: a conversation
  subagent: new THREE.OctahedronGeometry(1, 0),             // cut gem: a child of a session
  tool:     new THREE.BoxGeometry(1.5, 1.5, 1.5),           // block of work
  model:    new THREE.CylinderGeometry(1, 1, 1.1, 24),      // engine / drum
  cron:     new THREE.ConeGeometry(1, 2, 18),               // pointer on a dial
}
export const radiusOf = n => Math.cbrt(n.val || 3) * (n.type === 'hub' ? 3.8 : n.type === 'source' ? 3.2 : n.type === 'model' ? 2.8 : 2.4)

/**
 * Renders the graph in 3D or 2D with:
 *  - shapes by role, colour by status, opacity by age
 *  - a semantic layout (hub centre, platform sectors, recency axis, orbits) via soft forces
 *  - stable node objects across live updates, hover highlight, search dimming, platform collapse
 *  - a breathing pulse on running sessions
 */
export default function GraphView({ graph, view, windowSec, selected, onSelect, search, collapsed, toggleCollapse, hidden, recenterSignal }) {
  const fgRef = useRef()
  const wrapRef = useRef()
  const nodesRef = useRef(new Map())
  const meshes = useRef(new Map())          // node id -> { group, mesh, wire, label }
  const styleRef = useRef({ colorOf: () => '#fff', emphasised: () => true })
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
    for (const id of [...nodesRef.current.keys()]) if (!incoming.has(id)) { nodesRef.current.delete(id); meshes.current.delete(id) }

    const hidden_ = new Set()
    const childrenOf = new Map()
    for (const l of graph.links) {
      if (l.kind === 'platform' || l.kind === 'model') continue
      if (!childrenOf.has(l.source)) childrenOf.set(l.source, [])
      childrenOf.get(l.source).push(l.target)
    }
    const hide = id => { for (const c of childrenOf.get(id) || []) if (!hidden_.has(c)) { hidden_.add(c); hide(c) } }
    for (const src of collapsed) hide(src)
    for (const n of byId.values()) n.collapsedCount = collapsed.has(n.id) ? (childrenOf.get(n.id) || []).length : 0

    // legend toggles: hide whole roles, session statuses; tools follow their session
    const off = n => hidden?.has(`type:${n.type}`) || ((n.type === 'session' || n.type === 'subagent') && hidden?.has(`status:${n.status}`))
    const gone = new Set([...byId.values()].filter(off).map(n => n.id))
    for (const n of byId.values()) if (n.type === 'tool' && gone.has(`session:${n.session}`)) gone.add(n.id)
    const nodes = [...byId.values()].filter(n => !hidden_.has(n.id) && !gone.has(n.id))
    const keep = new Set(nodes.map(n => n.id))
    const links = graph.links.filter(l => keep.has(l.source) && keep.has(l.target)).map(l => ({ ...l }))
    const linked = new Set(links.flatMap(l => [l.source, l.target]))
    const visible = nodes.filter(n => n.type !== 'model' || linked.has(n.id))
    layoutTargets(visible, links, windowSec, view)      // writes tx/ty/tz (+ fx/fy/fz for pinned nodes)
    return { nodes: visible, links }
  }, [graph, collapsed, windowSec, view, hidden])

  // ---- time axis (3D): faint horizontal rings at nice intervals + labels on one side ----
  const axisRef = useRef(null)
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || view !== '3d') return
    const t = setTimeout(() => {
      const scene = fg.scene?.()
      if (!scene) return
      if (axisRef.current) scene.remove(axisRef.current)
      const g = new THREE.Group()
      const R = LAYOUT.sessionRadius + 22
      const axisX = -(LAYOUT.sessionRadius + 48)
      const ticks = timeTicks(windowSec)
      const lineMat = new THREE.LineBasicMaterial({ color: '#6ad1ff', transparent: true, opacity: 0.16 })
      const axisMat = new THREE.LineBasicMaterial({ color: '#8fa0b8', transparent: true, opacity: 0.5 })
      // vertical spine
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(axisX, recencyY(0), 0), new THREE.Vector3(axisX, recencyY(1), 0)]), axisMat))
      for (const tk of ticks) {
        const y = recencyY(tk.frac)
        const pts = []
        for (let i = 0; i <= 72; i++) { const a = (2 * Math.PI * i) / 72; pts.push(new THREE.Vector3(Math.cos(a) * R, y, Math.sin(a) * R)) }
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat))
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(axisX - 4, y, 0), new THREE.Vector3(axisX + 4, y, 0)]), axisMat))
        const label = new SpriteText(tk.label, 4.6, tk.frac === 0 ? '#e6edf7' : '#8fa0b8')
        label.position.set(axisX - 12, y, 0)
        g.add(label)
      }
      const title = new SpriteText('session start ↓', 4.2, '#6ad1ff')
      title.position.set(axisX, recencyY(0) + 10, 0)
      g.add(title)
      scene.add(g)
      axisRef.current = g
    }, 80)
    return () => clearTimeout(t)
  }, [view, windowSec])

  // 2D: concentric rings, recent sessions inside, drawn under the graph
  const paintRings = useCallback((ctx, scale) => {
    if (view !== '2d') return
    for (const tk of timeTicks(windowSec)) {
      const r = recencyR(tk.frac)
      ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI)
      ctx.lineWidth = 0.8 / scale; ctx.strokeStyle = 'rgba(106,209,255,0.16)'; ctx.stroke()
      ctx.font = `${Math.max(3, 9 / scale)}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      ctx.fillStyle = tk.frac === 0 ? 'rgba(230,237,247,0.85)' : 'rgba(143,160,184,0.85)'
      ctx.fillText(tk.frac === 0 ? 'started now' : `started ${tk.label}`, r * 0.707 + 2 / scale, -r * 0.707 - 2 / scale)
    }
  }, [view, windowSec])

  // ---- semantic forces --------------------------------------------------
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const s = n => n.ts ?? 0
    fg.d3Force('x', forceX(n => n.tx ?? 0).strength(s))
    fg.d3Force('y', forceY(n => n.ty ?? 0).strength(s))
    if (view === '3d') fg.d3Force('z', forceZ(n => n.tz ?? 0).strength(s)); else fg.d3Force('z', null)
    fg.d3Force('collide', forceCollide(n => radiusOf(n) + (view === '3d' ? 2 : 3)).strength(0.8))
    fg.d3Force('charge')?.strength(n => (n.type === 'tool' ? -15 : n.type === 'subagent' ? -40 : -70))
    fg.d3Force('link')?.distance(l => LAYOUT.linkDistance[l.kind] ?? 50)
      .strength(l => LAYOUT.linkStrength[l.kind] ?? 0.3)
    fg.d3ReheatSimulation?.()
  }, [view, data])

  // ---- camera: elevated three-quarter view, then fit to content once the layout settles ----
  const fitted = useRef(false)
  useEffect(() => {
    fitted.current = false
    const fg = fgRef.current
    if (!fg) return
    if (view === '3d') {
      const t = setTimeout(() => fg.cameraPosition({ x: 0, y: 230, z: 380 }, { x: 0, y: 0, z: 0 }, 0), 50)
      return () => clearTimeout(t)
    }
  }, [view])
  const frameAll = useCallback((ms = 900) => {
    const fg = fgRef.current
    if (!fg) return
    if (view === '3d') {
      // frame the whole structure: platform ring + session ring + recency depth + model shelf
      const span = Math.max(...data.nodes.map(n => Math.hypot(n.x || 0, n.y || 0, n.z || 0)), LAYOUT.sessionRadius + 60)
      fg.cameraPosition({ x: 0, y: span * 1.05, z: span * 1.75 }, { x: 0, y: -15, z: 0 }, ms)
    } else {
      fg.zoomToFit(ms, 50)
    }
  }, [view, data])
  const onEngineStop = useCallback(() => {
    if (fitted.current) return
    fitted.current = true
    frameAll()
  }, [frameAll])
  useEffect(() => { if (recenterSignal) frameAll(700) }, [recenterSignal])  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- fan-out: pin the selected session's tools on a ring facing the camera ----
  const fanned = useRef([])
  useEffect(() => {
    const fg = fgRef.current
    for (const n of fanned.current) { n.fanned = false; delete n.fx; delete n.fy; delete n.fz }
    fanned.current = []
    const owner = selected && data.nodes.find(n => n.id === selected)
    if (!fg || !owner || (owner.type !== 'session' && owner.type !== 'subagent')) { fg?.d3ReheatSimulation?.(); return }
    const sid = owner.id.replace('session:', '')
    const tools = data.nodes.filter(n => n.type === 'tool' && n.session === sid)
    if (!tools.length) return
    const cx = owner.x || 0, cy = owner.y || 0, cz = owner.z || 0
    // ring radius grows with count so neighbours stay ~16 units apart; a second ring beyond 14 tools
    const place = (list, radius, phase) => list.forEach((n, i) => {
      const a = phase + (2 * Math.PI * i) / list.length
      if (view === '3d') {
        const cam = fg.camera().position
        const d = new THREE.Vector3(cam.x - cx, cam.y - cy, cam.z - cz).normalize()
        const u = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize()
        if (!u.length()) u.set(1, 0, 0)
        const v = new THREE.Vector3().crossVectors(u, d).normalize()
        n.fx = cx + radius * (Math.cos(a) * u.x + Math.sin(a) * v.x)
        n.fy = cy + radius * (Math.cos(a) * u.y + Math.sin(a) * v.y)
        n.fz = cz + radius * (Math.cos(a) * u.z + Math.sin(a) * v.z)
      } else {
        n.fx = cx + radius * Math.cos(a); n.fy = cy + radius * Math.sin(a)
      }
      n.fanned = true
      fanned.current.push(n)
    })
    const inner = tools.slice(0, 14), outer = tools.slice(14)
    place(inner, Math.max(22, inner.length * 2.8), -Math.PI / 2)
    if (outer.length) place(outer, Math.max(22, inner.length * 2.8) + 20, -Math.PI / 2 + Math.PI / outer.length)
    // subagents spawned by this session get their own ring outside the tools
    const kids = data.nodes.filter(n => n.type === 'subagent' && n.parent === sid)
    if (kids.length) place(kids, Math.max(22, inner.length * 2.8) + (outer.length ? 42 : 26), Math.PI / 2)
    owner.fx = cx; owner.fy = cy; if (view === '3d') owner.fz = cz   // hold the session still while fanned
    owner.fanned = true; fanned.current.push(owner)
    fg.d3ReheatSimulation?.()
    // frame the ring (selection may come from a card, not a graph click)
    const ring = Math.max(22, inner.length * 2.8) + (outer.length ? 42 : kids.length ? 26 : 0)
    if (!framedFor.current.has(selected)) {
      framedFor.current.add(selected)
      if (view === '3d') {
        const cam = fg.camera().position
        const d = new THREE.Vector3(cam.x - cx, cam.y - cy, cam.z - cz).normalize().multiplyScalar(ring * 2.6 + 60)
        fg.cameraPosition({ x: cx + d.x, y: cy + d.y, z: cz + d.z }, { x: cx, y: cy, z: cz }, 800)
      } else {
        fg.centerAt(cx, cy, 600); fg.zoom(Math.max(1.5, Math.min(5, 260 / (ring + 40))), 600)
      }
    }
  }, [selected, data, view])
  const framedFor = useRef(new Set())
  useEffect(() => { if (!selected) framedFor.current.clear() }, [selected])

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

  const showActive = !hidden?.has('flag:active')
  const colorOf = useCallback(n => {
    const base = n.active && showActive ? ACTIVE : nodeBaseColor(n)
    let a = n.type === 'hub' || n.type === 'source' || n.type === 'model' ? 1 : ageAlpha(n.age, windowSec)
    if (!emphasised(n)) a *= 0.18
    return withAlpha(base, a)
  }, [windowSec, emphasised, showActive])
  styleRef.current = { colorOf, emphasised, selected, focusId, hoverId: hover }

  const linkColor = useCallback(l => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.get(l.source)
    const t = typeof l.target === 'object' ? l.target : nodesRef.current.get(l.target)
    const emph = (s && emphasised(s)) && (t && emphasised(t))
    const base = l.active && showActive ? ACTIVE : l.errors > 0 ? '#f85149' : l.kind === 'spawn' ? '#c3a6ff' : l.kind === 'model' ? '#f778ba' : '#8ea0bf'
    // model links stay whisper-faint unless their session is in focus
    const modelFaint = l.kind === 'model' && !(focusId && (s?.id === focusId || t?.id === focusId))
    const a = (l.kind === 'platform' ? 0.7 : ageAlpha(l.age, windowSec, 0.15) * 0.75) * (emph ? 1 : 0.1) * (modelFaint ? 0.25 : 1)
    return withAlpha(base, a)
  }, [windowSec, emphasised, focusId, showActive])

  const particles = l => (l.active && showActive ? 3 + Math.min(6, l.value || 1) : l.kind === 'tool' && (l.value || 0) > 3 ? 1 : 0)
  const particleSpeed = l => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.get(l.source)
    const rate = s?.calls_per_min || 0
    return l.active ? 0.006 + Math.min(0.02, rate * 0.002) : 0.003
  }

  const handleClick = useCallback(n => {
    if (n.type === 'source') { toggleCollapse(n.id); return }
    onSelect(n.id)
    if (n.type === 'session' || n.type === 'subagent') return   // the fan-out effect frames these
    if (view === '3d' && fgRef.current && n.x != null) {
      const d = 70, r = Math.hypot(n.x, n.y, n.z) || 1
      fgRef.current.cameraPosition({ x: n.x * (1 + d / r), y: n.y * (1 + d / r) + 20, z: n.z * (1 + d / r) }, n, 800)
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

  // ---- 3D objects: built once per node, restyled every frame -------------
  const threeObject = useCallback(n => {
    const r = radiusOf(n)
    const group = new THREE.Group()
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 1 })
    const mesh = new THREE.Mesh(GEOMETRY[n.type] || GEOMETRY.session, mat)
    mesh.scale.setScalar(r)
    if (n.type === 'source') mesh.rotation.x = Math.PI / 2          // ring lies flat on the floor plane
    if (n.type === 'cron') mesh.rotation.x = Math.PI                 // cone points down toward its platform
    group.add(mesh)
    let wire = null
    if (n.type === 'hub') {
      wire = new THREE.Mesh(GEOMETRY.hub, new THREE.MeshBasicMaterial({ color: '#6ad1ff', wireframe: true, transparent: true, opacity: 0.35 }))
      wire.scale.setScalar(r * 1.35)
      group.add(wire)
    }
    let label = null
    if (LABELLED.has(n.type) || n.type === 'tool') {
      const text = n.collapsedCount ? `${n.label} (+${n.collapsedCount})` : n.type === 'tool' ? `${n.label}${n.errors ? ` ✕${n.errors}` : ''} ×${n.calls}` : n.label
      label = new SpriteText(text.length > 34 ? text.slice(0, 33) + '…' : text)
      label.textHeight = n.type === 'hub' ? 8 : n.type === 'source' ? 6 : n.type === 'tool' ? 2.8 : 3.4
      label.position.y = -(r + (n.type === 'hub' ? 7 : 3.5))
      if (n.type === 'tool') label.visible = false
      group.add(label)
    }
    meshes.current.set(n.id, { group, mesh, wire, label, node: n })
    return group
  }, [])

  useEffect(() => {
    let raf
    const tick = () => {
      const t = performance.now()
      const { colorOf, emphasised, selected } = styleRef.current
      for (const { mesh, wire, label, node } of meshes.current.values()) {
        const css = colorOf(node)
        const m = css.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)
        if (m) {
          mesh.material.color.setRGB(m[1] / 255, m[2] / 255, m[3] / 255)
          mesh.material.opacity = +m[4]
          mesh.material.emissive?.setRGB(m[1] / 255 * 0.25, m[2] / 255 * 0.25, m[3] / 255 * 0.25)
        }
        const breathe = node.status === 'running' ? 1 + 0.12 * Math.sin(t / 420) : 1
        const sel = node.id === selected ? 1.35 : 1
        mesh.scale.setScalar(radiusOf(node) * breathe * sel)
        if (node.type !== 'source') mesh.rotation.y = node.type === 'tool' || node.type === 'subagent' ? t / 4000 : 0
        if (wire) { wire.rotation.y = t / 6000; wire.rotation.x = t / 9000 }
        if (label) {
          label.color = withAlpha(node.type === 'hub' ? '#ffffff' : '#e6edf7', emphasised(node) ? 0.9 : 0.12)
          if (node.type === 'tool') label.visible = !!node.fanned || node.id === styleRef.current.hoverId
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---- 2D painter: same shape grammar on canvas --------------------------
  const paint2d = useCallback((n, ctx, scale) => {
    const r = radiusOf(n)
    const col = colorOf(n)
    const breathe = n.status === 'running' ? 1 + 0.12 * Math.sin(performance.now() / 420) : 1
    drawShape(ctx, n.type, n.x, n.y, r * breathe, col)
    if (n.id === selected) { ctx.lineWidth = 1.5 / scale; ctx.strokeStyle = '#fff'; ctx.stroke() }
    const showToolLabel = n.type === 'tool' && (n.fanned || n.id === hover)
    if (showToolLabel || (LABELLED.has(n.type) && (scale > 1.4 || n.type === 'hub' || n.type === 'source'))) {
      const text = n.collapsedCount ? `${n.label} (+${n.collapsedCount})` : n.type === 'tool' ? `${n.label}${n.errors ? ` ✕${n.errors}` : ''} ×${n.calls}` : n.label
      ctx.font = `${Math.max(2.5, 10 / scale)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.fillStyle = withAlpha('#e6edf7', emphasised(n) ? 0.9 : 0.15)
      ctx.fillText(text.length > 40 ? text.slice(0, 39) + '…' : text, n.x, n.y + r + 1.5)
    }
  }, [colorOf, emphasised, selected, hover])

  const common = {
    ref: fgRef, graphData: data, width: size.w, height: size.h, nodeId: 'id',
    nodeLabel: tooltip, nodeVal: n => n.val || 3, onNodeClick: handleClick,
    onNodeHover: n => setHover(n ? n.id : null), onBackgroundClick: () => onSelect(null),
    linkColor, linkWidth: l => (l.kind === 'tool' ? Math.min(4, 0.4 + Math.log1p(l.value || 1)) : l.kind === 'spawn' ? 1.2 : l.kind === 'model' ? 0.3 : 0.6),
    linkDirectionalParticles: particles, linkDirectionalParticleSpeed: particleSpeed,
    linkDirectionalParticleWidth: l => (l.active ? 2.2 : 1),
    linkLabel: l => (l.kind === 'spawn' && l.goal ? `${l.state || ''} ${l.delivery || ''} — ${esc(l.goal)}` : ''),
    cooldownTicks: 200, warmupTicks: 30, onEngineStop,
  }

  return (
    <div className="canvas" ref={wrapRef}>
      {view === '3d'
        ? <ForceGraph3D {...common} backgroundColor="#0b0f17" showNavInfo={false}
            nodeThreeObject={threeObject} nodeThreeObjectExtend={false} linkOpacity={0.8} />
        : <ForceGraph2D {...common} backgroundColor="#0b0f17" nodeCanvasObject={paint2d} nodeCanvasObjectMode={() => 'replace'}
            linkDirectionalArrowLength={0} autoPauseRedraw={false} onRenderFramePre={paintRings} />}
    </div>
  )
}

/** Canvas shapes mirroring the 3D geometries. Leaves the path open so callers can stroke a selection ring. */
export function drawShape(ctx, type, x, y, r, fill) {
  ctx.beginPath()
  switch (type) {
    case 'hub': ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill()
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, 2 * Math.PI); ctx.lineWidth = r * 0.18; ctx.strokeStyle = withAlpha('#6ad1ff', 0.5); ctx.stroke()
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); return
    case 'source': ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.lineWidth = r * 0.5; ctx.strokeStyle = fill; ctx.stroke(); return
    case 'subagent': ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r * 1.2); ctx.lineTo(x - r, y); ctx.closePath(); break
    case 'tool': ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7); break
    case 'model': { const w = r * 1.3, h = r * 0.9
      ctx.roundRect ? ctx.roundRect(x - w, y - h, 2 * w, 2 * h, r * 0.4) : ctx.rect(x - w, y - h, 2 * w, 2 * h); break }
    case 'cron': ctx.moveTo(x, y + r * 1.1); ctx.lineTo(x + r, y - r * 0.9); ctx.lineTo(x - r, y - r * 0.9); ctx.closePath(); break
    default: ctx.arc(x, y, r, 0, 2 * Math.PI)
  }
  ctx.fillStyle = fill; ctx.fill()
}

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const fmt = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0))
