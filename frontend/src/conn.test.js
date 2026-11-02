import { describe, expect, it } from 'vitest'
import { connInfo } from './conn.js'

const now = 1_700_000_000_000
const T = s => now - s * 1000

describe('connInfo', () => {
  it('live: says when it last heard from the backend and when the data last changed', () => {
    const i = connInfo({ conn: 'live', seenAt: T(3), dataAt: T(241), now })
    expect(i.level).toBe('green')
    expect(i.text).toBe('live')
    expect(i.detail).toBe('checked 3s ago · last change 4m 1s ago')
  })
  it('stalled or polling reads as reconnecting and dates the snapshot', () => {
    for (const conn of ['stalled', 'polling']) {
      const i = connInfo({ conn, seenAt: T(40), dataAt: T(40), now })
      expect(i.level).toBe('amber')
      expect(i.text).toBe('reconnecting…')
      expect(i.detail).toMatch(/^showing data from /)
    }
  })
  it('offline is red and keeps the last snapshot on screen', () => {
    const i = connInfo({ conn: 'offline', seenAt: T(90), dataAt: T(90), downSince: T(60), now })
    expect(i.level).toBe('red')
    expect(i.text).toMatch(/^backend unreachable since /)
    expect(i.detail).toBe('showing the last snapshot')
    expect(connInfo({ conn: 'offline', now }).detail).toBe('nothing loaded yet')
  })
  it('paused wins over every connection state', () => {
    const i = connInfo({ conn: 'offline', live: false, dataAt: T(5), now })
    expect(i.level).toBe('muted')
    expect(i.text).toBe('live updates paused')
  })
  it('connecting is amber with no detail', () => {
    expect(connInfo({ conn: 'connecting', now })).toEqual({ level: 'amber', text: 'connecting…', detail: '' })
  })
})
