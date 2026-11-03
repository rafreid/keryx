/**
 * Graph label rules shared by the 3D and 2D renderers.
 *
 * Labels keep a constant size on screen: in 3D the sprite height follows the camera distance, in 2D
 * the font divides by the zoom. Because every label is then ~11 px tall, the overview cannot show
 * all of them, so a priority order decides which survive: the selection and hover first, then the
 * structure (hub, platforms), then sessions that need attention, then the newest.
 */
export const LABEL_PX = 11                 // target text height on screen
export const LABEL_SCALE = { hub: 1.35, source: 1.15, session: 1, subagent: 1, cron: 1, model: 1, tool: 0.85 }
export const LABEL_FAR = 300               // 3D: closer than this every session is labelled; farther, only the priority set
export const LABEL_OVERVIEW_N = 4          // newest sessions still labelled in the overview
const TAN_HALF_FOV = Math.tan((75 / 2) * Math.PI / 180)   // react-force-graph-3d's camera fov

/** What a node's label says. Tools carry their call count and failures. */
export function labelText(n) {
  const text = n.collapsedCount ? `${n.label} (+${n.collapsedCount})`
    : n.type === 'tool' ? `${n.label} ×${n.calls}${n.errors ? ` · ${n.errors} failed` : ''}`
    : n.label || ''
  return text.length > 40 ? text.slice(0, 39) + '…' : text
}

/** 3D sprite height (world units) for ~LABEL_PX px at `dist`, quantised so the texture is not redrawn every frame. */
export function labelHeight(dist, canvasH, type) {
  const units = (LABEL_PX * 2 * TAN_HALF_FOV / Math.max(1, canvasH)) * dist * (LABEL_SCALE[type] ?? 1)
  return Math.max(1, Math.round(units * 2) / 2)
}

/** Newest-first rank among sessions and subagents (0 = started most recently); other nodes get none. */
export function rankByStart(nodes) {
  const sess = nodes.filter(n => n.type === 'session' || n.type === 'subagent').sort((a, b) => (b.started || 0) - (a.started || 0))
  for (const n of nodes) n.labelRank = undefined
  sess.forEach((n, i) => { n.labelRank = i })
  return nodes
}

/** Lower is more important. */
export function labelPriority(n, { selected, hover } = {}) {
  if (n.id === selected) return 0
  if (n.id === hover) return 1
  if (n.type === 'hub') return 2
  if (n.type === 'source') return 3
  if (n.type === 'tool') return n.fanned ? 4 : 99
  if (n.status === 'running') return 5
  if (n.status === 'waiting') return 6
  if (n.type === 'cron' || n.type === 'model') return 8
  return 10 + (n.labelRank ?? 50)
}

/** 3D: is this node's label shown at camera distance `dist`? */
export function labelVisible3d(n, dist, { selected, hover, searching, dimmed } = {}) {
  if (n.id === selected || n.id === hover) return true
  if (n.type === 'hub' || n.type === 'source') return true
  if (dimmed) return false                                     // outside the focused neighbourhood (or a search miss): no label
  if (n.type === 'tool') return !!n.fanned
  if (searching) return true                                   // search already dims the misses; label the hits
  if (dist < LABEL_FAR) return true
  return n.status === 'running' || n.status === 'waiting' || (n.labelRank ?? 99) < LABEL_OVERVIEW_N
}

/**
 * Greedy occlusion: items arrive as { n, x0, y0, x1, y1 } boxes in one coordinate space. Placed by priority;
 * a box that would overprint one already placed loses, unless it is the selection or the hover. Writes `n.labelOn`.
 */
export function cullBoxes(items, { selected, hover } = {}) {
  const placed = []
  items.sort((a, b) => labelPriority(a.n, { selected, hover }) - labelPriority(b.n, { selected, hover }))
  const on = []
  for (const it of items) {
    const hit = placed.some(b => it.x0 < b.x1 && it.x1 > b.x0 && it.y0 < b.y1 && it.y1 > b.y0)
    it.n.labelOn = !hit || it.n.id === selected || it.n.id === hover
    if (it.n.labelOn) { placed.push(it); on.push(it.n.id) }
  }
  return on
}

const PAD = 1.5                            // margin around each box: measured widths exclude the halo padding, and adjacent labels still need air
const LABELLED = new Set(['hub', 'source', 'session', 'subagent', 'cron', 'model'])
export const wantsLabel = (n, hover) => (n.type === 'tool' ? !!n.fanned || n.id === hover : LABELLED.has(n.type))

/** 2D: boxes in world units under the node (the painter divides by zoom, so `fontSize` already is). */
export function cullLabels2d(nodes, { selected, hover, fontSize, radiusOf, emphasised = () => true, measure }) {
  for (const n of nodes) n.labelOn = false
  const items = []
  for (const n of nodes) {
    if (n.x == null || !wantsLabel(n, hover)) continue
    if (!emphasised(n) && n.type !== 'hub' && n.type !== 'source' && n.id !== selected && n.id !== hover) continue
    const text = labelText(n)
    const w = (measure ? measure(text) : text.length * fontSize * 0.56) * PAD, h = fontSize * 1.25 * PAD
    const x0 = n.x - w / 2, y0 = n.y + radiusOf(n) + 1.5
    items.push({ n, x0, y0, x1: x0 + w, y1: y0 + h })
  }
  return cullBoxes(items, { selected, hover })
}

/** 3D: boxes in screen pixels from projected label anchors ({ n, sx, sy, aspect }: sprite centre and width/height). */
export function cullLabels3d(projected, { selected, hover }) {
  const items = projected.map(({ n, sx, sy, aspect }) => {
    const px = LABEL_PX * (LABEL_SCALE[n.type] ?? 1)
    const h = px * 1.3 * PAD
    const w = aspect ? h * aspect : labelText(n).length * px * 0.56 * PAD
    return { n, x0: sx - w / 2, y0: sy - h / 2, x1: sx + w / 2, y1: sy + h / 2 }   // a sprite is centred on its anchor
  })
  return cullBoxes(items, { selected, hover })
}
