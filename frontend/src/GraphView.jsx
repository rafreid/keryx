import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import ForceGraph2D from 'react-force-graph-2d'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { forceCollide, forceX, forceY, forceZ } from 'd3-force-3d'
import { STATUS, TYPE, ageAlpha, linkFill, nodeFill, palette, withAlpha } from './util.js'
import { layoutTargets, LAYOUT, setSpread } from './layout.js'
import { useCameraPose } from './hooks/useCameraPose.js'
import { useTimeAxis3d, useRings2d } from './hooks/useTimeAxis.js'
import { cullLabels2d, cullLabels3d, labelHeight, labelText, labelVisible3d, rankByStart } from './labels.js'
import { fogRange, overviewPose, stemSegments } from './depth.js'

const LABELLED = new Set(['hub', 'source', 'session', 'subagent', 'cron', 'model'])
// label sizing and the overview budget live in labels.js (shared with the 2D painter and unit-tested)

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
const V = new THREE.Vector3()                    // scratch vector for label projection
const RING = new THREE.RingGeometry(1, 1.12, 48)  // selection / hover ring, scaled per node
export const radiusOf = n => Math.cbrt(n.val || 3) * (n.type === 'hub' ? 3.8 : n.type === 'source' ? 3.2 : n.type === 'model' ? 2.8 : 2.4)

/**
 * Renders the graph in 3D or 2D with:
 *  - shapes by role, colour by status, opacity by age
 *  - a semantic layout (hub centre, platform sectors, recency axis, orbits) via soft forces
 *  - stable node objects across live updates, hover highlight, search dimming, platform collapse
 *  - a breathing pulse on running sessions
 */
export default function GraphView({ graph, view, windowSec, selected, onSelect, search, collapsed, toggleCollapse, hidden, recenterSignal, band, onVisible, spread = 1, camRef, restore, theme, reduceMotion = false }) {
  const stillRef = useRef(reduceMotion); stillRef.current = reduceMotion   // read inside the animation loop without restarting it
  const fgRef = useRef()
  const framedFor = useRef(new Set())       // selections whose ring has already been framed by the camera
  const camTarget = useRef(null)            // where the camera is flying to (history restore), while it flies

  useCameraPose({ fgRef, camRef, view, restore, selected, framedFor, camTarget })
  const wrapRef = useRef()
  const nodesRef = useRef(new Map())
  const meshes = useRef(new Map())          // node id -> { group, mesh, wire, label }
  const styleRef = useRef({ colorOf: () => '#fff', emphasised: () => true })
  const prevSpread = useRef(spread)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const sizeRef = useRef(size); sizeRef.current = size
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
    // time band: keep only sessions/subagents that STARTED inside the selected span
    const nowS = Date.now() / 1000
    const inBand = n => {
      if (!band || (n.type !== 'session' && n.type !== 'subagent')) return true
      const age = n.started ? nowS - n.started : Infinity
      return age >= band.from * windowSec && age < band.to * windowSec + (band.to >= 1 ? Infinity : 0)
    }
    const gone = new Set([...byId.values()].filter(n => off(n) || !inBand(n)).map(n => n.id))
    for (const n of byId.values()) if (n.type === 'tool' && gone.has(`session:${n.session}`)) gone.add(n.id)
    const nodes = [...byId.values()].filter(n => !hidden_.has(n.id) && !gone.has(n.id))
    const keep = new Set(nodes.map(n => n.id))
    const links = graph.links.filter(l => keep.has(l.source) && keep.has(l.target)).map(l => ({ ...l }))
    const linked = new Set(links.flatMap(l => [l.source, l.target]))
    const visible = nodes.filter(n => n.type !== 'model' || linked.has(n.id))
    setSpread(spread)
    layoutTargets(visible, links, windowSec, view)      // writes tx/ty/tz (+ fx/fy/fz for pinned nodes)
    rankByStart(visible)                                 // labelRank: which sessions keep a label in the overview
    // spacing changed: move everything immediately (pinned → anchor, others scale), then let forces refine
    if (prevSpread.current !== spread) {
      const ratio = spread / (prevSpread.current || 1)
      prevSpread.current = spread
      for (const n of visible) {
        if (n.fx != null) { n.x = n.fx; n.y = n.fy ?? n.y; if (n.fz != null) n.z = n.fz }
        else if (n.x != null) { n.x *= ratio; n.y *= ratio; if (n.z != null) n.z *= ratio }
        if (n.vx != null) { n.vx = 0; n.vy = 0; if (n.vz != null) n.vz = 0 }
      }
    }
    window.__keryx = { nodes: visible, layout: LAYOUT }   // debug handle
    return { nodes: visible, links }
  }, [graph, collapsed, windowSec, view, hidden, band, spread])

  useTimeAxis3d(fgRef, view, windowSec, band, spread, theme)

  // ---- 3D depth cues: stems from each session to the floor ring, fog tied to the camera distance ----
  const stems = useRef(null)                 // { line, buf } in the scene; positions refreshed every frame
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || view !== '3d') return
    const t = setTimeout(() => {
      const scene = fg.scene?.()
      if (!scene) return
      const pal = palette()
      if (stems.current) scene.remove(stems.current.line)
      const buf = new Float32Array(6 * 2048)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(buf, 3))
      geo.setDrawRange(0, 0)
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: pal.muted, transparent: true, opacity: 0.28 }))
      scene.add(line)
      stems.current = { line, buf }
      scene.fog = new THREE.Fog(pal.bg, 400, 1200)
    }, 80)
    return () => clearTimeout(t)
  }, [view, theme])

  const paintRings = useRings2d(view, windowSec, band, theme)

  // report what is actually drawn (band / legend / collapse filters) for the stats bar
  useEffect(() => {
    if (!onVisible) return
    const sess = data.nodes.filter(n => n.type === 'session' || n.type === 'subagent')
    onVisible({ sessions: sess.length, running: sess.filter(n => n.status === 'running').length, active: sess.filter(n => n.active).length,
      tool_calls: sess.reduce((a, n) => a + (n.tool_calls || 0), 0), errors: sess.reduce((a, n) => a + (n.tool_errors || 0), 0),
      filtered: !!band || (hidden && hidden.size > 0) || collapsed.size > 0 })
  }, [data, band, hidden, collapsed, onVisible])

  // ---- semantic forces --------------------------------------------------
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const s = n => n.ts ?? 0
    fg.d3Force('x', forceX(n => n.tx ?? 0).strength(s))
    fg.d3Force('y', forceY(n => n.ty ?? 0).strength(s))
    if (view === '3d') fg.d3Force('z', forceZ(n => n.tz ?? 0).strength(s)); else fg.d3Force('z', null)
    const k = LAYOUT.spread
    fg.d3Force('collide', forceCollide(n => radiusOf(n) + (view === '3d' ? 2 : 3) * k).strength(0.8))
    fg.d3Force('charge')?.strength(n => (n.type === 'tool' ? -15 : n.type === 'subagent' ? -40 : -70) * k)
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
      const t = setTimeout(() => fg.cameraPosition(overviewPose(215), { x: 0, y: 0, z: 0 }, 0), 50)
      return () => clearTimeout(t)
    }
  }, [view])
  const frameAll = useCallback((ms = 900) => {
    const fg = fgRef.current
    if (!fg) return
    if (view === '3d') {
      // frame the whole structure: platform ring + session ring + recency depth + model shelf
      const span = Math.max(...data.nodes.map(n => Math.hypot(n.x || 0, n.y || 0, n.z || 0)), LAYOUT.sessionRadius + 60)
      // trackball controls let a drag roll the camera; put "up" back to +y so the picture comes back
      // exactly as on first load: floor flat, hub centred, time axis on the left
      const cam = fg.camera(), ctl = fg.controls()
      if (cam) cam.up.set(0, 1, 0)
      if (ctl?.target) ctl.target.set(0, -15, 0)
      const p = overviewPose(span)
      fg.cameraPosition({ x: p.x, y: p.y - 15, z: p.z }, { x: 0, y: -15, z: 0 }, ms)
    } else {
      fg.zoomToFit(ms, 50)
    }
  }, [view, data])
  const selectedRef = useRef(selected); selectedRef.current = selected
  const onEngineStop = useCallback(() => {
    if (fitted.current) return
    fitted.current = true
    // a deep link (#session:…) arrived before the layout settled: frame that node, not the whole graph
    const sel = selectedRef.current && data.nodes.find(n => n.id === selectedRef.current)
    if (sel && sel.x != null) { framedFor.current.delete(sel.id); setRefit(n => n + 1) }
    else frameAll()
  }, [frameAll, data])
  const [refit, setRefit] = useState(0)
  useEffect(() => { if (recenterSignal) frameAll(700) }, [recenterSignal])  // eslint-disable-line react-hooks/exhaustive-deps
  // note: spacing changes deliberately do NOT reframe the camera, so the spread is visible on screen; use ⌖ recenter to refit

  // ---- fan-out: pin the selected session's tools on a ring facing the camera ----
  const fanned = useRef([])
  useEffect(() => {
    const fg = fgRef.current
    for (const n of fanned.current) { n.fanned = false; delete n.fx; delete n.fy; delete n.fz }
    fanned.current = []
    const owner = selected && data.nodes.find(n => n.id === selected)
    if (!fg || !owner || (owner.type !== 'session' && owner.type !== 'subagent')) {
      fg?.d3ReheatSimulation?.()
      if (fg && owner && owner.x != null && !framedFor.current.has(owner.id)) {   // plain node: fly in close
        framedFor.current.add(owner.id)
        if (view === '3d') {
          const d = 70, r = Math.hypot(owner.x, owner.y, owner.z) || 1
          fg.cameraPosition({ x: owner.x * (1 + d / r), y: owner.y * (1 + d / r) + 20, z: owner.z * (1 + d / r) }, owner, 800)
        } else { fg.centerAt(owner.x, owner.y, 600); fg.zoom(3, 600) }
      }
      return
    }
    const sid = owner.id.replace('session:', '')
    const tools = data.nodes.filter(n => n.type === 'tool' && n.session === sid)
    if (!tools.length) return
    const cx = owner.x || 0, cy = owner.y || 0, cz = owner.z || 0
    // ring radius grows with count so neighbours stay ~16 units apart; a second ring beyond 14 tools
    const place = (list, radius, phase) => list.forEach((n, i) => {
      const a = phase + (2 * Math.PI * i) / list.length
      if (view === '3d') {
        const cam = camTarget.current || fg.camera().position   // face the pose we are flying to, if any
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
  }, [selected, data, view, refit])
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
  // fill = status (or role) colour, always; "active" is a halo ring on top, so a running session stays green
  const colorOf = useCallback(n => {
    let a = n.type === 'hub' || n.type === 'source' || n.type === 'model' ? 1 : ageAlpha(n.age, windowSec, palette().ageFloor)
    if (!emphasised(n)) a *= 0.18
    return withAlpha(nodeFill(n), a)
  }, [windowSec, emphasised, theme])
  const haloOf = useCallback(n => (n.active && showActive ? withAlpha(palette().active, emphasised(n) ? 0.8 : 0.12) : null), [showActive, emphasised])
  styleRef.current = { colorOf, haloOf, emphasised, selected, focusId, hoverId: hover, searching: !!q }

  const linkColor = useCallback(l => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.get(l.source)
    const t = typeof l.target === 'object' ? l.target : nodesRef.current.get(l.target)
    const emph = (s && emphasised(s)) && (t && emphasised(t))
    const base = l.active && showActive ? palette().active : linkFill(l)
    // model links stay whisper-faint unless their session is in focus
    const modelFaint = l.kind === 'model' && !(focusId && (s?.id === focusId || t?.id === focusId))
    const a = (l.kind === 'platform' ? 0.7 : ageAlpha(l.age, windowSec, 0.15) * 0.75) * (emph ? 1 : 0.1) * (modelFaint ? 0.25 : 1)
    return withAlpha(base, a)
  }, [windowSec, emphasised, focusId, showActive])

  const particles = l => (reduceMotion ? 0 : l.active && showActive ? 3 + Math.min(6, l.value || 1) : l.kind === 'tool' && (l.value || 0) > 3 ? 1 : 0)
  const particleSpeed = l => {
    const s = typeof l.source === 'object' ? l.source : nodesRef.current.get(l.source)
    const rate = s?.calls_per_min || 0
    return l.active ? 0.006 + Math.min(0.02, rate * 0.002) : 0.003
  }

  const handleClick = useCallback(n => {
    if (n.type === 'source') { toggleCollapse(n.id); return }
    onSelect(n.id)                     // the fan-out effect frames the selection
  }, [onSelect, toggleCollapse])

  const tooltip = n => {
    const st = STATUS[n.status]?.label
    const extra = n.type === 'session' || n.type === 'subagent'
      ? `${st} · ${n.messages} msgs · ${n.tool_calls} calls${n.tool_errors ? ` · ${n.tool_errors} errors` : ''}`
      : n.type === 'tool' ? `${n.calls} calls${n.errors ? `, ${n.errors} failed` : ''}`
      : n.type === 'model' ? `${fmt(n.tokens_in)} in · ${fmt(n.tokens_out)} out · cache ${((n.cache_hit || 0) * 100) | 0}%`
      : n.type === 'cron' ? `${n.schedule || ''} · last ${n.last_status || 'never'}`
      : n.type === 'source' ? (n.collapsedCount ? `collapsed (${n.collapsedCount}) — click to expand` : 'click to collapse')
      : ''
    return `<div style="background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 8px;max-width:320px;color:var(--text)">
      <b>${esc(n.label)}</b><br><span style="color:var(--muted)">${esc(TYPE[n.type]?.label || n.type)}</span>${extra ? '<br>' + esc(extra) : ''}</div>`
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
    // "active" halo: a translucent shell that the render loop shows while the node was touched in the last 5 min
    const halo = new THREE.Mesh(GEOMETRY.session, new THREE.MeshBasicMaterial({ color: palette().active, transparent: true, opacity: 0.25, depthWrite: false }))
    halo.scale.setScalar(r * 1.55); halo.visible = false
    group.add(halo)
    // selection ring: a flat annulus turned to face the camera each frame; also used, fainter, for hover
    const ring = new THREE.Mesh(RING, new THREE.MeshBasicMaterial({ color: palette().accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }))
    ring.visible = false
    group.add(ring)
    let wire = null
    if (n.type === 'hub') {
      wire = new THREE.Mesh(GEOMETRY.hub, new THREE.MeshBasicMaterial({ color: palette().accent, wireframe: true, transparent: true, opacity: 0.35 }))
      wire.scale.setScalar(r * 1.35)
      group.add(wire)
    }
    let label = null
    if (LABELLED.has(n.type) || n.type === 'tool') {
      label = new SpriteText(labelText(n))
      label.textHeight = 4                      // the render loop sets the real height from the camera distance
      label.backgroundColor = palette().halo; label.padding = 0.6; label.borderRadius = 1   // halo: readable over links and the floor in both themes
      label.position.y = -(r + (n.type === 'hub' ? 7 : 3.5))
      if (n.type === 'tool') label.visible = false
      group.add(label)
    }
    meshes.current.set(n.id, { group, mesh, wire, halo, ring, label, node: n })
    return group
  }, [])

  useEffect(() => {
    let raf
    const tick = () => {
      const t = performance.now()
      const { colorOf, haloOf, emphasised, selected, hoverId, searching } = styleRef.current
      const cam = fgRef.current?.camera?.()
      const { w: canvasW, h: canvasH } = sizeRef.current
      const pal = palette()
      const candidates = []                             // labels that pass the distance rule; occlusion decides next
      // fog and stems follow the camera and the layout
      const fg3 = fgRef.current
      const scene = fg3?.scene?.()
      if (cam && scene?.fog) {
        const tgt = fg3.controls?.()?.target
        const dist = tgt ? cam.position.distanceTo(tgt) : cam.position.length()
        const { near, far } = fogRange(dist)
        scene.fog.near = near; scene.fog.far = far
        if (scene.fog.color.getHexString() !== pal.bg.replace('#', '')) scene.fog.color.set(pal.bg)
      }
      if (stems.current) {
        const { line, buf } = stems.current
        const k = stemSegments(Array.from(meshes.current.values(), e => e.node), buf)
        line.geometry.setDrawRange(0, k * 2)
        line.geometry.attributes.position.needsUpdate = true
        if (line.material.color.getHexString() !== pal.muted.replace('#', '')) line.material.color.set(pal.muted)
      }
      for (const entry of meshes.current.values()) {
        const { mesh, wire, halo, ring, label, node } = entry
        const css = colorOf(node)
        if (css !== entry.css) {                          // parse the colour string only when it changes
          entry.css = css
          const m = css.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)
          if (m) {
            mesh.material.color.setRGB(m[1] / 255, m[2] / 255, m[3] / 255)
            mesh.material.opacity = +m[4]
            mesh.material.emissive?.setRGB(m[1] / 255 * 0.25, m[2] / 255 * 0.25, m[3] / 255 * 0.25)
          }
        }
        const still = stillRef.current
        const breathe = node.status === 'running' && !still ? 1 + 0.12 * Math.sin(t / 420) : 1
        const sel = node.id === selected ? 1.35 : 1
        mesh.scale.setScalar(radiusOf(node) * breathe * sel)
        if (halo) {
          const h = haloOf(node)
          const hm = h && h.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)
          halo.visible = !!hm
          if (hm) { halo.material.color.setRGB(hm[1] / 255, hm[2] / 255, hm[3] / 255); halo.material.opacity = +hm[4] * 0.3; halo.scale.setScalar(radiusOf(node) * breathe * sel * 1.55) }
        }
        if (ring) {
          const isSel = node.id === selected, isHover = node.id === hoverId && !isSel
          ring.visible = isSel || isHover
          if (ring.visible && cam) {
            ring.quaternion.copy(cam.quaternion)                // face the camera
            ring.scale.setScalar(radiusOf(node) * sel * breathe * 1.6)
            ring.material.opacity = isSel ? 0.9 : 0.45
            if (entry.ringCol !== pal.accent) { entry.ringCol = pal.accent; ring.material.color.set(pal.accent) }
          }
          if (label) label.position.y = -(radiusOf(node) * (ring.visible ? sel * 1.7 : 1) + (node.type === 'hub' ? 7 : 3.5))   // below the ring when there is one
        }
        if (node.type !== 'source') mesh.rotation.y = !still && (node.type === 'tool' || node.type === 'subagent') ? t / 4000 : 0
        if (wire && !still) { wire.rotation.y = t / 6000; wire.rotation.x = t / 9000 }
        if (wire && entry.accent !== pal.accent) { entry.accent = pal.accent; wire.material.color.set(pal.accent) }
        if (label) {
          // every SpriteText setter re-rasterises its canvas, so write only on change (and the height in half-unit steps)
          const col = withAlpha(pal.text, emphasised(node) ? 0.95 : 0.12)
          if (entry.labelCol !== col) { entry.labelCol = col; label.color = col }
          if (label.backgroundColor !== pal.halo) label.backgroundColor = pal.halo
          if (cam && node.x != null) {
            const dist = Math.hypot(cam.position.x - node.x, cam.position.y - node.y, cam.position.z - (node.z || 0))
            const h = labelHeight(dist, canvasH, node.type)
            if (entry.labelH !== h) { entry.labelH = h; label.textHeight = h }
            if (labelVisible3d(node, dist, { selected, hover: hoverId, searching, dimmed: !emphasised(node) })) candidates.push(entry); else label.visible = false
          }
        }
      }
      if (cam && candidates.length) {
        // screen-space occlusion: project each candidate and hide the ones that would overprint a higher-priority label
        const projected = []
        for (const e of candidates) {
          V.set(e.node.x, e.node.y - radiusOf(e.node) - 3.5, e.node.z || 0).project(cam)
          if (V.z > 1) { e.label.visible = false; continue }
          projected.push({ n: e.node, sx: (V.x + 1) / 2 * canvasW, sy: (1 - V.y) / 2 * canvasH, aspect: e.label.scale.x / (e.label.scale.y || 1), e })
        }
        cullLabels3d(projected, { selected, hover: hoverId })
        for (const p of projected) p.e.label.visible = !!p.n.labelOn
        if (window.__keryxDebug) window.__keryx.labels = projected.map(p => ({ label: p.n.label, sx: p.sx | 0, sy: p.sy | 0, aspect: +p.aspect.toFixed(2), on: p.n.labelOn, h: p.e.label.textHeight }))
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
    const breathe = n.status === 'running' && !reduceMotion ? 1 + 0.12 * Math.sin(performance.now() / 420) : 1
    drawShape(ctx, n.type, n.x, n.y, r * breathe, col)
    if (n.id === selected) { ctx.lineWidth = 1.5 / scale; ctx.strokeStyle = palette().text; ctx.stroke() }
    const halo = haloOf(n)
    if (halo) { ctx.beginPath(); ctx.arc(n.x, n.y, r * breathe * 1.5, 0, 2 * Math.PI); ctx.lineWidth = 1.2 / scale; ctx.strokeStyle = halo; ctx.stroke() }
    if (n.labelOn) {                                   // decided per frame by the occlusion pass in framePre
      ctx.font = `${Math.max(3, 11 / scale)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      const t = labelText(n)
      ctx.lineWidth = 3 / scale; ctx.lineJoin = 'round'; ctx.strokeStyle = withAlpha(palette().bg, emphasised(n) ? 0.85 : 0.15)
      ctx.strokeText(t, n.x, n.y + r + 1.5)                                        // halo keeps labels legible over links in both themes
      ctx.fillStyle = withAlpha(palette().text, emphasised(n) ? 0.95 : 0.15)
      ctx.fillText(t, n.x, n.y + r + 1.5)
    }
  }, [colorOf, haloOf, emphasised, selected, hover, theme, reduceMotion])
  // 2D: rings under the graph, then the label occlusion pass (labels are ~11 px on screen whatever the zoom,
  // so they are placed by priority and the ones that would overprint another are hidden for this frame)
  const framePre = useCallback((ctx, scale) => {
    paintRings(ctx, scale)
    const fontSize = Math.max(3, 11 / scale)
    ctx.font = `${fontSize}px sans-serif`
    cullLabels2d(data.nodes, { selected, hover, fontSize, radiusOf, emphasised, measure: t => ctx.measureText(t).width })
  }, [paintRings, data, selected, hover, emphasised])

  const common = {
    ref: fgRef, graphData: data, width: size.w, height: size.h, nodeId: 'id',
    nodeLabel: tooltip, nodeVal: n => n.val || 3, onNodeClick: handleClick,
    onNodeHover: n => setHover(n ? n.id : null), onBackgroundClick: () => onSelect(null),
    linkColor, linkWidth: l => (l.kind === 'tool' ? Math.min(4, 0.4 + Math.log1p(l.value || 1)) : l.kind === 'spawn' ? 1.2 : l.kind === 'model' ? 0.3 : 0.6),
    linkDirectionalParticles: particles, linkDirectionalParticleSpeed: particleSpeed,
    linkDirectionalParticleWidth: l => (l.active ? 2.2 : 1),
    linkLabel: l => (l.kind === 'spawn' && l.goal ? `${l.state || ''} ${l.delivery || ''} — ${esc(l.goal)}` : l.kind === 'branch' ? 'branched conversation' : ''),
    cooldownTicks: 500, warmupTicks: 60, d3AlphaDecay: 0.012, d3VelocityDecay: 0.35, onEngineStop,
  }

  const bg = palette().bg
  const lights = useMemo(() => {
    const key = new THREE.DirectionalLight(0xffffff, 0.85 * Math.PI)
    key.position.set(0.6, 1, 0.8)                  // upper front-right: spheres get a terminator, cones a lit face
    return [new THREE.AmbientLight(0xcccccc, 0.8 * Math.PI), key]
  }, [])
  return (
    <div className="canvas" ref={wrapRef} role="region" aria-label="Activity graph. It is drawn on a canvas and cannot be read by a screen reader; the same sessions, tools and jobs are listed in the Sessions, Tasks and Board tabs.">
      {view === '3d'
        ? <ForceGraph3D {...common} backgroundColor={bg} showNavInfo={false}
            nodeThreeObject={threeObject} nodeThreeObjectExtend={false} linkOpacity={0.8} lights={lights} />
        : <ForceGraph2D {...common} backgroundColor={bg} nodeCanvasObject={paint2d} nodeCanvasObjectMode={() => 'replace'}
            linkDirectionalArrowLength={0} autoPauseRedraw={false} onRenderFramePre={framePre} />}
    </div>
  )
}

/** Canvas shapes mirroring the 3D geometries. Leaves the path open so callers can stroke a selection ring. */
export function drawShape(ctx, type, x, y, r, fill) {
  ctx.beginPath()
  switch (type) {
    case 'hub': ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = fill; ctx.fill()
      ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, 2 * Math.PI); ctx.lineWidth = r * 0.18; ctx.strokeStyle = withAlpha(palette().accent, 0.5); ctx.stroke()
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
