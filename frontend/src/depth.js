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

/** Default camera pose: a 42° elevation reads the height axis, where 31° flattened it. */
export function overviewPose(span) {
  return { x: 0, y: span * 1.45, z: span * 1.6 }
}
export const SPAN_MIN = () => LAYOUT.sessionRadius + 60
