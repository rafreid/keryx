import { describe, expect, it } from 'vitest'
import { applyMutes, groupBySeverity, signature, summarise } from './attention.js'

const items = [
  { id: 'inc', severity: 'red', label: 'cron job failing: sync', detail: 'boom' },
  { id: 'wa', severity: 'amber', label: 'whatsapp retrying', detail: 'bridge exited' },
  { id: 'blocked', severity: 'amber', label: '1 kanban card blocked', detail: '' },
  { id: 'waiting', severity: 'info', label: '3 sessions waiting for you', detail: '' },
]

describe('attention triage', () => {
  it('groups by severity in order and counts them', () => {
    const g = groupBySeverity(items)
    expect(g.map(x => [x.title, x.items.length])).toEqual([['Needs action', 1], ['Watch', 2], ['Info', 1]])
    expect(summarise(g)).toBe('1 needs action · 2 to watch · 1 info')
    expect(summarise(groupBySeverity([]))).toBe('all clear')
    expect(summarise(groupBySeverity(items.slice(1, 3)))).toBe('2 to watch')
  })
  it('hides a muted item until its label or detail changes', () => {
    const mutes = { wa: signature(items[1]) }
    let r = applyMutes(items, mutes)
    expect(r.shown.map(a => a.id)).toEqual(['inc', 'blocked', 'waiting'])
    expect(r.muted.map(a => a.id)).toEqual(['wa'])
    const changed = items.map(a => (a.id === 'wa' ? { ...a, detail: 'fatal: logged out' } : a))
    r = applyMutes(changed, mutes)
    expect(r.shown.map(a => a.id)).toContain('wa')
    expect(r.mutes).toEqual({})                                   // the stale mute is dropped
  })
  it('drops mutes for items that went away', () => {
    const r = applyMutes(items.slice(0, 1), { wa: signature(items[1]), inc: signature(items[0]) })
    expect(r.mutes).toEqual({ inc: signature(items[0]) })
  })
})
