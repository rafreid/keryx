import { LAYOUT, recencyY } from './layout.js'

/**
 * 3D depth cues, pure parts (the hook in GraphView feeds three.js):
 *  - stems: a thin vertical line from every session down to the floor ring, so height (= start time)
 *    reads even from a shallow camera angle;
 *  - fog: tied to the camera distance, so what is behind the structure fades a little at any zoom
 *    and nothing disappears when the user zooms out.
 */
export const FOG_NEAR = 0.9, FOG_FAR = 2.8          // multiples of the camera-to-target distance

export function fogRange(dist) {
  const d = Math.max(50, dist || 0)
  return { near: d * FOG_NEAR, far: d * FOG_FAR }
}

/** The floor the stems drop to: the oldest ring of the time axis. */
export const floorY = () => recencyY(1)

export const hasStem = n => (n.type === 'session' || n.type === 'subagent' || n.type === 'cron') && n.x != null

/**
 * Fill `out` (a Float32Array of 6 floats per stem) with the segments; returns the number of stems written.
 * Nodes already on the floor get no visible stem (zero-length segment).
 */
export function stemSegments(nodes, out, floor = floorY()) {
  let k = 0
  for (const n of nodes) {
    if (!hasStem(n)) continue
    if (k * 6 + 6 > out.length) break
    const y = n.y ?? 0
    out[k * 6] = n.x; out[k * 6 + 1] = y; out[k * 6 + 2] = n.z || 0
    out[k * 6 + 3] = n.x; out[k * 6 + 4] = Math.min(y, floor); out[k * 6 + 5] = n.z || 0
    k++
  }
  return k
}

/** Default camera pose at distance `dist` from the target: a 42° elevation reads the height axis, where 31° flattened it. */
export const ELEVATION = 42 * Math.PI / 180
export function overviewPose(dist) {
  return { x: 0, y: dist * Math.sin(ELEVATION), z: dist * Math.cos(ELEVATION) }
}

const TAN_HALF_FOV = Math.tan((75 / 2) * Math.PI / 180)   // react-force-graph-3d's camera fov
export const FILL = 0.62                                    // the structure's bounding sphere spans this much of the shorter canvas edge

/** Radius of the structure worth framing: sessions, platforms, tools and cron jobs, around the orbit target. */
export function structureRadius(nodes, target = { x: 0, y: -15, z: 0 }) {
  let r = LAYOUT.sessionRadius + 30
  for (const n of nodes) {
    if (n.type === 'model' || n.x == null) continue                // the model shelf sits high and would inflate the fit
    r = Math.max(r, Math.hypot(n.x - target.x, (n.y ?? 0) - target.y, (n.z || 0) - target.z))
  }
  return r
}

/** Camera distance that fits a bounding sphere of `radius` into FILL of the view, whichever edge is shorter. */
export function fitDistance(radius, width, height) {
  const aspect = Math.max(0.2, (width || 1) / (height || 1))
  const halfTan = TAN_HALF_FOV * Math.min(1, aspect)             // the horizontal half-angle is narrower on a portrait canvas
  return radius / (FILL * halfTan)
}
