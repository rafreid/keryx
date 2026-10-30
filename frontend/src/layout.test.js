import { describe, expect, it } from 'vitest'
import { LAYOUT, layoutTargets, setSpread, timeTicks, recencyY } from './layout.js'

const node = (id, type, extra = {}) => ({ id, type, label: id, ...extra })

describe('timeTicks', () => {
  it('starts at now and never exceeds eight steps', () => {
    for (const w of [3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400]) {
      const t = timeTicks(w)
      expect(t[0]).toEqual({ frac: 0, label: 'now' })
      expect(t.length).toBeLessThanOrEqual(9)
      expect(t.at(-1).frac).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
  it('labels in minutes, hours or days', () => {
    expect(timeTicks(3600).map(t => t.label)).toEqual(['now', '−10m', '−20m', '−30m', '−40m', '−50m', '−1h'])
    expect(timeTicks(86400)[1].label).toBe('−4h')
  })
})

describe('layoutTargets', () => {
  const now = Date.now() / 1000
  const graph = () => [
    node('hermes', 'hub'),
    node('src:telegram', 'source'), node('src:cli', 'source'),
    node('session:a', 'session', { source: 'telegram', started: now - 60 }),
    node('session:b', 'session', { source: 'telegram', started: now - 3000 }),
    node('session:c', 'session', { source: 'cli', started: now - 10 }),
    node('session:k', 'subagent', { source: 'telegram', parent: 'a', started: now - 30 }),
    node('tool:a:terminal', 'tool', { session: 'a' }),
    node('model:gpt', 'model'),
    node('cron:j', 'cron'),
  ]
  it('pins the hub, platforms and models, and gives sessions soft targets', () => {
    setSpread(1)
    const nodes = graph()
    layoutTargets(nodes, [], 3600, '3d')
    const by = Object.fromEntries(nodes.map(n => [n.id, n]))
    expect([by.hermes.fx, by.hermes.fy, by.hermes.fz]).toEqual([0, 0, 0])
    expect(Math.hypot(by['src:telegram'].fx, by['src:telegram'].fz)).toBeCloseTo(LAYOUT.platformRadius)
    expect(by['model:gpt'].fy).toBe(LAYOUT.modelShelf)
    expect(by['session:a'].fx).toBeUndefined()
    expect(by['session:a'].ts).toBe(0.5)
    expect(Math.hypot(by['session:a'].tx, by['session:a'].tz)).toBeCloseTo(LAYOUT.sessionRadius)
  })
  it('puts recent sessions higher than old ones (3D) and closer to the hub (2D)', () => {
    const nodes = graph()
    layoutTargets(nodes, [], 3600, '3d')
    const by = Object.fromEntries(nodes.map(n => [n.id, n]))
    expect(by['session:a'].ty).toBeGreaterThan(by['session:b'].ty)
    expect(by['session:a'].ty).toBeCloseTo(recencyY(60 / 3600), 1)
    const nodes2 = graph()
    layoutTargets(nodes2, [], 3600, '2d')
    const by2 = Object.fromEntries(nodes2.map(n => [n.id, n]))
    expect(Math.hypot(by2['session:a'].tx, by2['session:a'].ty)).toBeLessThan(Math.hypot(by2['session:b'].tx, by2['session:b'].ty))
  })
  it('keeps each platform\'s sessions inside its own sector', () => {
    const nodes = graph()
    layoutTargets(nodes, [], 3600, '3d')
    const by = Object.fromEntries(nodes.map(n => [n.id, n]))
    const ang = n => Math.atan2(n.tz ?? n.fz, n.tx ?? n.fx)
    const dist = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))
    expect(dist(ang(by['session:a']), ang(by['src:telegram']))).toBeLessThan(Math.PI / 2)
    expect(dist(ang(by['session:c']), ang(by['src:cli']))).toBeLessThan(Math.PI / 2)
  })
  it('subagents follow their parent and tools hug their session', () => {
    const nodes = graph()
    layoutTargets(nodes, [], 3600, '3d')
    const by = Object.fromEntries(nodes.map(n => [n.id, n]))
    expect(by['session:k'].tx).toBe(by['session:a'].tx)
    expect(by['tool:a:terminal'].tx).toBe(by['session:a'].tx)
    expect(by['tool:a:terminal'].ts).toBeLessThan(by['session:k'].ts)
  })
  it('setSpread scales every distance together and is clamped', () => {
    setSpread(2)
    expect(LAYOUT.sessionRadius).toBe(250)
    expect(LAYOUT.linkDistance.tool).toBe(28)
    setSpread(99)
    expect(LAYOUT.spread).toBe(3)
    setSpread(1)
  })
})
