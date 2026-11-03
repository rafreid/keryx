import { describe, expect, it } from 'vitest'
import { floorY, fogRange, overviewPose, stemSegments } from './depth.js'

describe('depth cues', () => {
  it('fog follows the camera distance and never collapses', () => {
    const a = fogRange(400), b = fogRange(800)
    expect(b.near / a.near).toBeCloseTo(2); expect(a.far).toBeGreaterThan(a.near)
    expect(fogRange(0).near).toBeGreaterThan(0)
  })
  it('stems drop sessions and cron jobs to the floor ring, skip the rest', () => {
    const out = new Float32Array(6 * 4)
    const nodes = [{ type: 'session', x: 10, y: 20, z: 30 }, { type: 'hub', x: 0, y: 0, z: 0 }, { type: 'cron', x: 1, y: -200, z: 1 }, { type: 'tool', x: 5, y: 5, z: 5 }, { type: 'subagent' }]
    expect(stemSegments(nodes, out)).toBe(2)
    expect([...out.slice(0, 6)]).toEqual([10, 20, 30, 10, floorY(), 30])
    expect(out[10]).toBe(-200)                                  // already below the floor: zero-length stem
  })
  it('stops at the buffer', () => {
    const out = new Float32Array(6)
    expect(stemSegments([{ type: 'session', x: 0, y: 0 }, { type: 'session', x: 1, y: 1 }], out)).toBe(1)
  })
  it('overview pose is elevated about 42 degrees', () => {
    const p = overviewPose(100)
    expect(Math.atan2(p.y, p.z) * 180 / Math.PI).toBeCloseTo(42, 0)
  })
})
