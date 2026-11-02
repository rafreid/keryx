import { describe, expect, it, vi } from 'vitest'
import { pressable } from './a11y.js'

const key = (key, target, currentTarget = target) => ({ key, target, currentTarget, preventDefault: vi.fn() })

describe('pressable', () => {
  it('is a focusable button that fires on click, Enter and Space', () => {
    const fn = vi.fn()
    const p = pressable(fn)
    expect(p.role).toBe('button')
    expect(p.tabIndex).toBe(0)
    p.onClick('click'); expect(fn).toHaveBeenCalledWith('click')
    const el = {}
    const enter = key('Enter', el); p.onKeyDown(enter); expect(enter.preventDefault).toHaveBeenCalled()
    const space = key(' ', el); p.onKeyDown(space)
    expect(fn).toHaveBeenCalledTimes(3)
  })
  it('ignores other keys and keys that come from a control nested inside', () => {
    const fn = vi.fn()
    const p = pressable(fn)
    const el = {}, inner = {}
    p.onKeyDown(key('a', el))
    p.onKeyDown(key('Enter', inner, el))          // a link inside the card: its own Enter, not ours
    expect(fn).not.toHaveBeenCalled()
  })
  it('passes extra props through', () => {
    expect(pressable(() => {}, { 'aria-label': 'open' })['aria-label']).toBe('open')
  })
})
