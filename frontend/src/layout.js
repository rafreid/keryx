/**
 * Semantic layout: assigns a target position (tx, ty, tz) and a pull strength (ts) to every node,
 * and pins structural nodes (fx, fy, fz). Forces in GraphView pull nodes toward these targets while
 * links and collisions still resolve locally, so the picture is both meaningful and readable.
 *
 * 3D:  floor plane = x/z.  hub at the origin; platforms on a ring, each owning an angular sector;
 *      sessions inside their platform's sector, ordered by start time around the sector;
 *      y = recency (fresh work at the top, old work settles down); models on a shelf above the hub;
 *      subagents orbit their parent; tools orbit their session; cron jobs sit below their platform ring.
 * 2D:  same sectors, with recency mapped to distance from the hub instead (recent = close).
 */
const BASE = {
  platformRadius: 60,
  sessionRadius: 125,       // 3D ring radius for sessions
  sessionRadius2d: [110, 260], // 2D: recent → far
  depth: 120,               // 3D: vertical span of the recency axis
  modelShelf: 110,
  linkDistance: { platform: 75, session: 60, spawn: 30, tool: 14, model: 120, cron: 45 },
  linkStrength: { platform: 0.05, session: 0.04, spawn: 0.5, tool: 0.9, model: 0.01, cron: 0.1 },
}
const scaled = k => ({
  spread: k,
  platformRadius: BASE.platformRadius * k,
  sessionRadius: BASE.sessionRadius * k,
  sessionRadius2d: BASE.sessionRadius2d.map(v => v * k),
  depth: BASE.depth * k,
  modelShelf: BASE.modelShelf * k,
  linkDistance: Object.fromEntries(Object.entries(BASE.linkDistance).map(([a, v]) => [a, v * k])),
  linkStrength: BASE.linkStrength,
})
/** Live layout constants; `setSpread` rescales every distance (1 = default, <1 compact, >1 airy). */
export let LAYOUT = scaled(1)
export function setSpread(k) { LAYOUT = scaled(Math.max(0.4, Math.min(3, k || 1))) }

export function layoutTargets(nodes, links, windowSec, view) {
  const is3d = view === '3d'
  const byId = new Map(nodes.map(n => [n.id, n]))
  const platforms = nodes.filter(n => n.type === 'source').sort((a, b) => a.label.localeCompare(b.label))
  const K = Math.max(1, platforms.length)
  const sectorOf = new Map()

  for (const n of nodes) { if (n.fanned) continue; delete n.fx; delete n.fy; delete n.fz; n.ts = 0 }

  // hub: pinned at the origin
  const hub = byId.get('hermes')
  if (hub) { hub.fx = 0; hub.fy = 0; if (is3d) hub.fz = 0 }

  // platforms: pinned on a ring, one sector each (first sector at 12 o'clock, clockwise)
  platforms.forEach((p, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / K
    sectorOf.set(p.id, { angle, width: (2 * Math.PI / K) * 0.78 })
    const [px, pz] = [Math.cos(angle) * LAYOUT.platformRadius, Math.sin(angle) * LAYOUT.platformRadius]
    if (is3d) { p.fx = px; p.fy = 0; p.fz = pz } else { p.fx = px; p.fy = pz }
  })

  // models: shelf above the hub (3D) or a row at the top (2D)
  const models = nodes.filter(n => n.type === 'model')
  models.forEach((m, i) => {
    const off = (i - (models.length - 1) / 2) * 40
    if (is3d) { m.fx = off; m.fy = LAYOUT.modelShelf; m.fz = 0 } else { m.fx = off; m.fy = -LAYOUT.sessionRadius2d[1] - 40 }
  })

  // sessions: sector by platform, angular order by start time, recency on y (3D) or radius (2D)
  const sessions = nodes.filter(n => n.type === 'session' && !(n.parent && byId.has(`session:${n.parent}`)))
  const groups = new Map()
  for (const s of sessions) {
    const key = `src:${s.source || 'unknown'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }
  const now = Date.now() / 1000
  // 0 = started just now … 1 = started at the far edge of the window (position encodes START time)
  const recency = n => Math.min(1, Math.max(0, (n.started ? now - n.started : windowSec) / (windowSec || 1)))
  for (const [key, list] of groups) {
    const sec = sectorOf.get(key) || { angle: -Math.PI / 2, width: Math.PI / 2 }
    list.sort((a, b) => (b.started || 0) - (a.started || 0))
    list.forEach((s, i) => {
      const f = list.length === 1 ? 0.5 : i / (list.length - 1)
      const angle = sec.angle - sec.width / 2 + sec.width * f
      const rec = recency(s)
      if (is3d) {
        s.tx = Math.cos(angle) * LAYOUT.sessionRadius
        s.tz = Math.sin(angle) * LAYOUT.sessionRadius
        s.ty = 30 - rec * LAYOUT.depth
      } else {
        const r = LAYOUT.sessionRadius2d[0] + rec * (LAYOUT.sessionRadius2d[1] - LAYOUT.sessionRadius2d[0])
        s.tx = Math.cos(angle) * r
        s.ty = Math.sin(angle) * r
      }
      s.ts = 0.5
    })
  }

  // subagents: gently toward their parent's target (links do the orbiting)
  for (const n of nodes) {
    if (n.type !== 'subagent') continue
    const parent = byId.get(`session:${n.parent}`) || findParent(n, links, byId)
    if (parent && parent.tx != null) {
      n.tx = parent.tx; n.ty = (parent.ty ?? 0) + (is3d ? -12 : 0); n.tz = parent.tz; n.ts = 0.12
    } else {
      // orphan subagent (parent outside the window): treat like a session in its sector
      const sec = sectorOf.get(`src:${n.source || 'unknown'}`) || { angle: Math.PI / 2 }
      const rec = recency(n)
      if (is3d) { n.tx = Math.cos(sec.angle) * LAYOUT.sessionRadius; n.tz = Math.sin(sec.angle) * LAYOUT.sessionRadius; n.ty = 30 - rec * LAYOUT.depth }
      else { const r = LAYOUT.sessionRadius2d[0] + rec * 180; n.tx = Math.cos(sec.angle) * r; n.ty = Math.sin(sec.angle) * r }
      n.ts = 0.35
    }
  }

  // tools: hug their session (the short strong link makes the orbit)
  for (const n of nodes) {
    if (n.type !== 'tool') continue
    const owner = byId.get(`session:${n.session}`)
    if (owner && owner.tx != null) { n.tx = owner.tx; n.ty = owner.ty; n.tz = owner.tz; n.ts = 0.03 }
  }

  // cron jobs: fan out just outside the cron platform, below the floor in 3D
  const crons = nodes.filter(n => n.type === 'cron')
  const csec = sectorOf.get('src:cron')
  crons.forEach((c, i) => {
    const angle = (csec?.angle ?? Math.PI / 2) + (i - (crons.length - 1) / 2) * 0.25
    const r = LAYOUT.platformRadius + 45
    if (is3d) { c.tx = Math.cos(angle) * r; c.tz = Math.sin(angle) * r; c.ty = -25 } else { c.tx = Math.cos(angle) * r; c.ty = Math.sin(angle) * r }
    c.ts = 0.5
  })
}

function findParent(n, links, byId) {
  for (const l of links) {
    const t = typeof l.target === 'object' ? l.target.id : l.target
    if (l.kind === 'spawn' && t === n.id) return byId.get(typeof l.source === 'object' ? l.source.id : l.source)
  }
  return null
}

/** Nice tick marks for the time axis: [{ frac (0 = now … 1 = window edge), label }]. */
export function timeTicks(windowSec) {
  const steps = [600, 1800, 3600, 7200, 4 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400, 30 * 86400]
  const step = steps.find(st => windowSec / st <= 8) || steps[steps.length - 1]
  const out = [{ frac: 0, label: 'now' }]
  for (let t = step; t <= windowSec + 1; t += step) out.push({ frac: t / windowSec, label: '−' + fmtSpan(t) })
  return out
}
const fmtSpan = s => (s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d`)

/** Where a recency fraction lands: y in 3D, radius in 2D (mirrors layoutTargets). */
export const recencyY = frac => 30 - frac * LAYOUT.depth
export const recencyR = frac => LAYOUT.sessionRadius2d[0] + frac * (LAYOUT.sessionRadius2d[1] - LAYOUT.sessionRadius2d[0])
