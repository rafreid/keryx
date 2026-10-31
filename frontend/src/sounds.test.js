import { describe, expect, it } from 'vitest'
import { toneFor } from './sounds.js'

describe('toneFor', () => {
  it('gives each level a distinct phrase', () => {
    const ok = toneFor('ok'), err = toneFor('err'), warn = toneFor('warn'), info = toneFor('info')
    expect(ok.notes.map(n => n[0])).toEqual([...ok.notes.map(n => n[0])].sort((a, b) => a - b))     // rising
    expect(err.notes.map(n => n[0])).toEqual([...err.notes.map(n => n[0])].sort((a, b) => b - a))   // falling
    expect(warn.notes).toHaveLength(2)
    expect(info.notes).toHaveLength(1)
    expect(new Set([ok, err, warn, info].map(t => JSON.stringify(t))).size).toBe(4)
  })
  it('keeps every phrase short', () => {
    for (const l of ['ok', 'err', 'warn', 'info', 'unknown']) for (const [, at, len] of toneFor(l).notes) expect(at + len).toBeLessThan(0.6)
  })
})
