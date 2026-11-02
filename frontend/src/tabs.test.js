import { describe, expect, it } from 'vitest'
import { TABS, troubleCounts, worstCheck } from './tabs.js'

const checks = [
  { name: 'gateway', level: 'green' }, { name: 'whatsapp', level: 'amber' },
  { name: 'cron', level: 'red' }, { name: 'errors', level: 'amber' }, { name: 'kanban', level: 'red' },
]

describe('header summary helpers', () => {
  it('keeps the first red check as the one inline chip, else the first amber', () => {
    expect(worstCheck(checks).name).toBe('cron')
    expect(worstCheck(checks.filter(c => c.level !== 'red')).name).toBe('whatsapp')
    expect(worstCheck(checks.filter(c => c.level === 'green'))).toBeNull()
    expect(worstCheck(undefined)).toBeNull()
  })
  it('counts red and amber for the pill', () => {
    expect(troubleCounts(checks)).toEqual({ red: 2, amber: 2, total: 4 })
    expect(troubleCounts([])).toEqual({ red: 0, amber: 0, total: 0 })
  })
  it('lists seven tabs with overview first', () => {
    expect(TABS[0]).toBe('overview')
    expect(TABS).toHaveLength(7)
  })
})
