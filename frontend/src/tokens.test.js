import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * The graph palette lives in styles.css as tokens. Both themes must define the same set, and every
 * node and link colour must clear 3:1 against its background (WCAG 1.4.11, the floor for non-text).
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8')
const block = sel => {
  const i = css.indexOf(sel); const j = css.indexOf('}', i)
  const out = {}
  for (const m of css.slice(i, j).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const dark = block(':root {'), light = block(':root[data-theme="light"]')
const graphTokens = Object.keys(dark).filter(k => /^--(n|s|l)-|^--active$/.test(k))
const ageFloor = t => Number(t['--age-floor'])

const lum = h => {
  const n = parseInt(h.slice(1), 16)
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

describe('graph colour tokens', () => {
  it('exist for every role, status and link kind in both themes', () => {
    expect(graphTokens).toEqual(expect.arrayContaining(['--n-platform', '--n-tool', '--n-model', '--n-cron', '--n-fail',
      '--s-running', '--s-waiting', '--s-stale', '--s-ended', '--s-closed', '--s-orphaned', '--s-failed',
      '--l-link', '--l-spawn', '--l-branch', '--l-model', '--active']))
    for (const k of graphTokens) expect(light[k], `${k} missing from the light theme`).toBeDefined()
  })
  it('clear 3:1 on their theme background', () => {
    for (const [theme, t] of [['dark', dark], ['light', light]]) {
      for (const k of graphTokens) {
        expect(contrast(t[k], t['--bg']), `${k} on the ${theme} background`).toBeGreaterThanOrEqual(3)
      }
    }
  })
  it('fades old nodes less on the light theme', () => {
    expect(ageFloor(dark)).toBeGreaterThan(0); expect(ageFloor(light)).toBeGreaterThan(ageFloor(dark))
  })
  it('keeps "active" apart from the failure red', () => {
    for (const t of [dark, light]) expect(contrast(t['--active'], t['--n-fail'])).toBeGreaterThan(1.5)
  })
})
