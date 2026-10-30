import { describe, expect, it } from 'vitest'
import { allTags, displayTitle, groupSessions, projectOf, resumeCommand, stripTags, tagsOf, timeBucket } from './grouping.js'

const now = new Date(2026, 9, 30, 15, 0, 0).getTime() / 1000     // local 15:00 on 30 Oct 2026
const at = (daysAgo, hour = 10) => new Date(2026, 9, 30 - daysAgo, hour).getTime() / 1000
const s = (id, extra = {}) => ({ id: `session:${id}`, type: 'session', label: id, status: 'ended', ...extra })

describe('timeBucket', () => {
  it('buckets in local days', () => {
    expect(timeBucket(at(0, 1), now)).toBe('today')
    expect(timeBucket(at(1, 23), now)).toBe('yesterday')
    expect(timeBucket(at(3), now)).toBe('this week')
    expect(timeBucket(at(7), now)).toBe('earlier')
    expect(timeBucket(null, now)).toBe('earlier')
  })
})

describe('tags and titles', () => {
  it('extracts #tags and strips them from the title', () => {
    expect(tagsOf('fix build #infra #Urgent #infra')).toEqual(['infra', 'urgent'])
    expect(tagsOf('issue #123 and C#')).toEqual(['123'])
    expect(stripTags('fix build #infra  #urgent')).toBe('fix build')
  })
  it('falls back to the request when Hermes never titled the session', () => {
    expect(displayTitle(s('abc-123', { request: 'please fix the build' })).toString()).toBe('please fix the build')
    expect(displayTitle(s('abc', { label: 'Real title #x' }))).toBe('Real title')
    expect(displayTitle({ id: 'session:abcdef-1234', label: 'abcdef-1', request: 'r' })).toBe('r')   // a truncated id is still the id
  })
  it('projects come from the working directory', () => {
    expect(projectOf({ cwd: '/home/me/work/keryx/' })).toBe('keryx')
    expect(projectOf({ cwd: 'C:\\Users\\me\\proj' })).toBe('proj')
    expect(projectOf({})).toBe('no project')
  })
  it('builds the resume command from the lineage tip', () => {
    expect(resumeCommand({ id: 'session:root', tip: 'tip' })).toBe('hermes -r tip')
    expect(resumeCommand({ id: 'session:solo' })).toBe('hermes -r solo')
  })
})

describe('groupSessions', () => {
  const nodes = [
    s('a', { source: 'telegram', last: at(0), status: 'running' }),
    s('b', { source: 'telegram', last: at(1), cwd: '/w/keryx', label: 'b #infra' }),
    s('c', { source: 'cli', last: at(3), cwd: '/w/keryx' }),
    s('d', { source: 'cli', last: at(10), cwd: '/w/site', label: 'd #infra #web' }),
    { id: 'tool:x', type: 'tool', label: 'terminal' },
  ]
  it('pins first, running next, then the grouping; rows newest first', () => {
    const g = groupSessions(nodes, { mode: 'platform', pinned: new Set(['session:d']), now })
    expect(g.map(x => x.label)).toEqual(['pinned', 'running', 'cli', 'telegram'])   // equal sizes: alphabetical
    expect(g[3].rows.map(r => r.id)).toEqual(['session:b'])
  })
  it('groups by time in bucket order and by project by size', () => {
    expect(groupSessions(nodes, { mode: 'time', now }).map(x => x.label)).toEqual(['running', 'yesterday', 'this week', 'earlier'])
    const p = groupSessions(nodes, { mode: 'project', now })
    expect(p.map(x => x.label)).toEqual(['running', 'keryx', 'site'])
    expect(p[1].rows.map(r => r.id)).toEqual(['session:b', 'session:c'])
  })
  it('filters by tag and counts tags', () => {
    expect(groupSessions(nodes, { mode: 'time', tag: 'infra', now }).flatMap(x => x.rows.map(r => r.id))).toEqual(['session:b', 'session:d'])
    expect(allTags(nodes)).toEqual([{ tag: 'infra', count: 2 }, { tag: 'web', count: 1 }])
  })
})
