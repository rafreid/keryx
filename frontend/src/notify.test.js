import { describe, expect, it } from 'vitest'
import { diffEvents, snapshot } from './notify.js'

const bundle = (sessions, extra = {}) => ({
  graph: { nodes: sessions.map(([id, status, sub]) => ({ id: `session:${id}`, type: sub ? 'subagent' : 'session', status, label: id })) },
  tasks: { delegations: extra.delegations || [], jobs: extra.jobs || [] },
  status: { checks: [{ name: 'errors', level: extra.errors || 'green', detail: 'n' }] },
})

describe('diffEvents', () => {
  it('announces a reply that waits for the user, once', () => {
    const was = snapshot(bundle([['a', 'running']]))
    const cur = snapshot(bundle([['a', 'waiting']]))
    expect(diffEvents(was, cur)).toEqual([{ level: 'ok', title: 'Hermes replied — waiting for you', body: 'a', node: 'session:a' }])
    expect(diffEvents(cur, cur)).toEqual([])
  })
  it('announces new top-level sessions but not new subagents', () => {
    const was = snapshot(bundle([]))
    const cur = snapshot(bundle([['a', 'running'], ['k', 'running', true]]))
    expect(diffEvents(was, cur).map(e => e.title)).toEqual(['Session started'])
  })
  it('flags failures, orphans and quiet sessions', () => {
    const was = snapshot(bundle([['a', 'running'], ['b', 'running'], ['c', 'running']]))
    const cur = snapshot(bundle([['a', 'failed'], ['b', 'orphaned'], ['c', 'stale']]))
    expect(diffEvents(was, cur).map(e => [e.level, e.title])).toEqual([
      ['err', 'Session ended with tool errors'], ['err', 'Session orphaned by a restart'], ['warn', 'Session went quiet']])
  })
  it('reports delegation and cron state changes and the error log turning red', () => {
    const was = snapshot(bundle([], { delegations: [{ id: 'd', state: 'running', goal: 'g', parent: 'a' }], jobs: [{ id: 'j', state: 'scheduled', name: 'nightly' }] }))
    const cur = snapshot(bundle([], { delegations: [{ id: 'd', state: 'completed', goal: 'g', parent: 'a' }], jobs: [{ id: 'j', state: 'missed', name: 'nightly' }], errors: 'red' }))
    expect(diffEvents(was, cur).map(e => e.title)).toEqual(['Delegation completed', 'Cron job missed its trigger', 'Errors piling up'])
    expect(diffEvents(was, cur)[0].node).toBe('session:a')
  })
})

import { plural } from './util.js'
describe('plural', () => {
  it('writes real words', () => {
    expect(plural(1, 'call')).toBe('1 call')
    expect(plural(2, 'call')).toBe('2 calls')
    expect(plural(0, 'subagent')).toBe('0 subagents')
    expect(plural(undefined, 'job')).toBe('0 jobs')
    expect(plural(3, 'entry', 'entries')).toBe('3 entries')
  })
})
