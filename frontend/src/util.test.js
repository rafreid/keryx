import { describe, expect, it } from 'vitest'
import { dur, fmtT, fmtTime, num, plural } from './util.js'

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
