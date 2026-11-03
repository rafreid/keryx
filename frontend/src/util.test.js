import { describe, expect, it } from 'vitest'
import { ACTIVE, PALETTE, STATUS, TYPE, dur, fmtT, fmtTime, linkFill, nodeBaseColor, nodeFill, num, plural, withAlpha } from './util.js'

describe('time formatting', () => {
  it('uses a 24-hour clock that never wraps', () => {
    expect(fmtTime(1_700_000_000)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(fmtTime(0)).toBe('–')
    expect(fmtT(1_700_000_000)).toMatch(/\d{2}:\d{2}:\d{2}$/)
    expect(fmtT(1_700_000_000)).not.toMatch(/[AP]M/)
  })
  it('midnight is 00, not 24', () => {
    const midnight = new Date(2026, 0, 1, 0, 5, 7).getTime() / 1000
    expect(fmtTime(midnight)).toBe('00:05:07')
  })
})

describe('small helpers', () => {
  it('dur and plural', () => {
    expect(dur(59)).toBe('59s'); expect(dur(61)).toBe('1m 1s'); expect(dur(3600 * 26)).toBe('1d 2h')
    expect(plural(1, 'call')).toBe('1 call'); expect(plural(2, 'entry', 'entries')).toBe('2 entries')
  })
  it('num abbreviates', () => { expect(num(950)).toBe('950'); expect(num(58_000)).toBe('58.0k'); expect(num(2_500_000)).toBe('2.50M') })
})

describe('graph colours', () => {
  const pal = { text: '#e6edf7', muted: '#8fa0b8', active: '#ffffff',
    node: { platform: '#6ad1ff', tool: '#ffb86b', model: '#f778ba', cron: '#ffd866', fail: '#f85149' },
    status: { running: '#3fb950', orphaned: '#f85149' }, link: { link: '#8ea0bf', spawn: '#c3a6ff' } }
  it('DOM consumers get CSS var() strings so a theme switch re-colours them for free', () => {
    expect(nodeBaseColor({ type: 'session', status: 'running' })).toBe('var(--s-running)')
    expect(nodeBaseColor({ type: 'tool', errors: 2 })).toBe('var(--n-fail)')
    expect(nodeBaseColor({ type: 'cron', status: 'failed' })).toBe('var(--n-fail)')
    expect(nodeBaseColor({ type: 'source' })).toBe('var(--n-platform)')
    for (const v of Object.values({ ...TYPE, ...STATUS })) expect(v.color).toMatch(/^var\(--/)
    expect(ACTIVE).toBe('var(--active)')
  })
  it('renderers get literals from the palette with the same rule', () => {
    expect(nodeFill({ type: 'session', status: 'running' }, pal)).toBe('#3fb950')
    expect(nodeFill({ type: 'session', status: 'unknown' }, pal)).toBe('#8fa0b8')
    expect(nodeFill({ type: 'tool', errors: 1 }, pal)).toBe('#f85149')
    expect(nodeFill({ type: 'hub' }, pal)).toBe('#e6edf7')
    expect(nodeFill({ type: 'model' }, pal)).toBe('#f778ba')
    expect(linkFill({ kind: 'spawn' }, pal)).toBe('#c3a6ff')
    expect(linkFill({ kind: 'tool', errors: 1 }, pal)).toBe('#f85149')
    expect(linkFill({ kind: 'cron' }, pal)).toBe('#8ea0bf')
  })
  it('withAlpha handles hex and rgb() tokens', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255,0,0,0.500)')
    expect(withAlpha('rgba(11, 15, 23, .75)', 1)).toBe('rgba(11,15,23,1.000)')
    expect(PALETTE).toHaveProperty('current')
  })
})
