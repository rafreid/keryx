import { describe, expect, it } from 'vitest'
import { LABEL_FAR, cullLabels2d, cullLabels3d, labelHeight, labelPriority, labelText, labelVisible3d, rankByStart } from './labels.js'

const s = (id, extra = {}) => ({ id, type: 'session', label: id, ...extra })

describe('labelText', () => {
  it('spells out tool failures instead of a glyph that looks like the count', () => {
    expect(labelText({ type: 'tool', label: 'write_file', calls: 3, errors: 1 })).toBe('write_file ×3 · 1 failed')
    expect(labelText({ type: 'tool', label: 'terminal', calls: 2 })).toBe('terminal ×2')
    expect(labelText({ type: 'source', label: 'telegram', collapsedCount: 5 })).toBe('telegram (+5)')
    expect(labelText(s('x'.repeat(60)))).toHaveLength(40)
  })
})

describe('labelHeight', () => {
  it('scales with distance so the text stays about 11 px tall, in half-unit steps', () => {
    const near = labelHeight(100, 600, 'session'), far = labelHeight(400, 600, 'session')
    expect(far / near).toBeCloseTo(4, 0)
    expect(near * 2 % 1).toBe(0)
    expect(labelHeight(400, 600, 'hub')).toBeGreaterThan(far)
    expect(labelHeight(400, 1200, 'session')).toBeLessThan(far)    // a taller canvas needs fewer units per pixel
  })
})

describe('3D visibility budget', () => {
  const nodes = rankByStart([s('a', { started: 300 }), s('b', { started: 200 }), s('c', { started: 100 }), s('d', { started: 50 }), s('e', { started: 10 }), s('f', { started: 5, status: 'running' }),
    { id: 'hub', type: 'hub', label: 'Hermes' }, { id: 'src:cli', type: 'source', label: 'cli' }, { id: 't', type: 'tool', label: 'bash', calls: 1 }])
  const by = id => nodes.find(n => n.id === id)
  it('labels everything up close', () => { for (const n of nodes) if (n.type !== 'tool') expect(labelVisible3d(n, LABEL_FAR - 1)).toBe(true) })
  it('zoomed out keeps the structure, the running, the newest four, the selection and hover', () => {
    const far = LABEL_FAR * 3
    expect(labelVisible3d(by('hub'), far)).toBe(true); expect(labelVisible3d(by('src:cli'), far)).toBe(true)
    expect(labelVisible3d(by('f'), far)).toBe(true)                       // running
    expect(['a', 'b', 'c', 'd'].map(id => labelVisible3d(by(id), far))).toEqual([true, true, true, true])
    expect(labelVisible3d(by('e'), far)).toBe(false)
    expect(labelVisible3d(by('e'), far, { selected: 'e' })).toBe(true)
    expect(labelVisible3d(by('e'), far, { hover: 'e' })).toBe(true)
    expect(labelVisible3d(by('e'), far, { searching: true })).toBe(true)
  })
  it('a dimmed node (outside the focused neighbourhood) keeps no label unless it is structure', () => {
    expect(labelVisible3d(by('f'), 10, { dimmed: true })).toBe(false)
    expect(labelVisible3d(by('hub'), 10, { dimmed: true })).toBe(true)
    expect(labelVisible3d({ ...by('t'), fanned: true }, 10, { dimmed: true })).toBe(false)
  })
  it('tools are labelled only when fanned out or hovered', () => {
    expect(labelVisible3d(by('t'), 10)).toBe(false)
    expect(labelVisible3d({ ...by('t'), fanned: true }, 10)).toBe(true)
    expect(labelVisible3d(by('t'), 10, { hover: 't' })).toBe(true)
  })
})

describe('3D occlusion', () => {
  it('boxes are centred on the sprite anchor, so two labels one line apart collide', () => {
    const a = { id: 'a', type: 'hub', label: 'Hermes' }, b = s('b', { label: 'long chat (branch)', labelRank: 0 })
    expect(cullLabels3d([{ n: a, sx: 100, sy: 100 }, { n: b, sx: 110, sy: 112 }], {})).toEqual(['a'])
    expect(cullLabels3d([{ n: a, sx: 100, sy: 100 }, { n: b, sx: 110, sy: 140 }], {}).sort()).toEqual(['a', 'b'])
  })
  it('uses the sprite aspect ratio for the width when given', () => {
    const a = { id: 'a', type: 'source', label: 'tui' }, b = s('b', { label: 'x', labelRank: 0 })
    expect(cullLabels3d([{ n: a, sx: 100, sy: 100, aspect: 10 }, { n: b, sx: 160, sy: 100, aspect: 1 }], {})).toEqual(['a'])
    expect(cullLabels3d([{ n: a, sx: 100, sy: 100 }, { n: b, sx: 160, sy: 100 }], {}).sort()).toEqual(['a', 'b'])
  })
})

describe('2D occlusion', () => {
  const r = () => 4
  it('hides a label that would overprint a higher-priority one', () => {
    const nodes = rankByStart([s('new', { x: 0, y: 0, started: 100 }), s('old', { x: 3, y: 2, started: 10 })])
    expect(cullLabels2d(nodes, { fontSize: 11, radiusOf: r })).toEqual(['new'])
    expect(nodes.find(n => n.id === 'old').labelOn).toBe(false)
  })
  it('skips dimmed nodes', () => {
    const nodes = rankByStart([s('a', { x: 0, y: 0 }), s('b', { x: 400, y: 0 })])
    expect(cullLabels2d(nodes, { fontSize: 11, radiusOf: r, emphasised: n => n.id === 'a' })).toEqual(['a'])
  })
  it('measures text when a measure function is given', () => {
    const nodes = rankByStart([s('a', { x: 0, y: 0, started: 100 }), s('b', { x: 60, y: 0, started: 10 })])
    expect(cullLabels2d(nodes, { fontSize: 11, radiusOf: r, measure: () => 200 })).toEqual(['a'])
    expect(cullLabels2d(nodes, { fontSize: 11, radiusOf: r, measure: () => 20 }).sort()).toEqual(['a', 'b'])
  })
  it('keeps labels that do not collide, and the selection always', () => {
    const nodes = rankByStart([s('a', { x: 0, y: 0, started: 100 }), s('b', { x: 400, y: 0, started: 10 }), s('c', { x: 2, y: 1, started: 1 })])
    expect(cullLabels2d(nodes, { fontSize: 11, radiusOf: r }).sort()).toEqual(['a', 'b'])
    expect(cullLabels2d(nodes, { selected: 'c', fontSize: 11, radiusOf: r }).sort()).toEqual(['b', 'c'])
  })
  it('orders selection, hover, structure, running, waiting, newest', () => {
    const p = n => labelPriority(n, { selected: 'sel', hover: 'hov' })
    const seq = [s('sel'), s('hov'), { id: 'h', type: 'hub' }, { id: 'p', type: 'source' }, { id: 't', type: 'tool', fanned: true }, s('r', { status: 'running' }), s('w', { status: 'waiting' }), s('n', { labelRank: 0 }), s('o', { labelRank: 9 }), { id: 'u', type: 'tool' }]
    const ps = seq.map(p)
    expect([...ps].sort((a, b) => a - b)).toEqual(ps)
  })
})
