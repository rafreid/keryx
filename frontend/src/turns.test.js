import { describe, expect, it } from 'vitest'
import { buildTurns, exportMarkdown, findHits, visibleSteps, visibleTurns } from './turns.js'

const user = (text, ts) => ({ kind: 'user', text, ts })
const asst = (text, ts) => ({ kind: 'assistant', text, ts })
const call = (name, ts, extra = {}) => ({ kind: 'tool_call', name, ts, tool_kind: 'shell', title: name, args: '{}', result: 'ok', failed: false, duration: 1, result_ts: ts + 1, ...extra })

const steps = [
  user('fix the build', 100),
  call('terminal', 110),
  asst('looking at the error', 115),                     // intermediate note, not the reply
  call('patch', 120, { tool_kind: 'edit', diff: { op: 'update', path: 'src/x.py', added: 2, removed: 1 } }),
  call('terminal', 130, { failed: true, result: 'error: boom', exit_code: 1 }),
  asst('Done, but one test fails.', 140),
  { kind: 'event', name: 'model_switch', text: 'to gpt-5', ts: 141 },
  user('try again', 200),
  call('terminal', 210, { result: null }),                // still running
]

describe('buildTurns', () => {
  it('splits on user messages and lifts the closing assistant text into the reply', () => {
    const t = buildTurns(steps)
    expect(t).toHaveLength(2)
    expect(t[0].question.text).toBe('fix the build')
    expect(t[0].final.text).toBe('Done, but one test fails.')
    expect(t[0].steps.map(s => s.kind)).toEqual(['tool_call', 'assistant', 'tool_call', 'tool_call', 'event'])
    expect(t[0]).toMatchObject({ tools: 3, failed: 1, changes: 1, added: 2, removed: 1, pending: 0 })
    expect(t[0].duration).toBe(40)
    expect(t[0].compacted).toBe(false)
    expect(t[1].final).toBeNull()
    expect(t[1].pending).toBe(1)
  })
  it('opens an anonymous turn for steps before any user message', () => {
    const t = buildTurns([call('terminal', 5), asst('hi', 6)])
    expect(t[0].question).toBeNull()
    expect(t[0].final.text).toBe('hi')
    expect(t[0].ts).toBe(5)
  })
  it('handles an empty trace', () => { expect(buildTurns([])).toEqual([]) })
})

describe('filters and find', () => {
  const t = buildTurns(steps)
  it('chat hides steps, changes keeps only edits and drops turns without one', () => {
    expect(visibleSteps(t[0], 'chat')).toEqual([])
    expect(visibleSteps(t[0], 'changes').map(s => s.name)).toEqual(['patch'])
    expect(visibleTurns(t, 'changes')).toHaveLength(1)
    expect(visibleTurns(t, 'all')).toHaveLength(2)
  })
  it('find matches names, titles, args, results and reply text', () => {
    expect(findHits(t, 'boom').total).toBe(1)
    expect(findHits(t, 'x.py').total).toBe(1)
    expect(findHits(t, 'test fails').total).toBe(1)
    expect(findHits(t, '').total).toBe(0)
    const h = findHits(t, 'terminal')
    expect(h.total).toBe(3)
    expect(h.hit(t[0].steps[0])).toBe(true)
    expect(h.hit(t[0].question)).toBe(false)
  })
})

describe('exportMarkdown', () => {
  it('renders a header, one section per turn and the step list', () => {
    const trace = { session: { id: 's1', title: 'build fix', source: 'cli', model: 'gpt-5', started: 100, cwd: '/w', git_branch: 'main', compactions: 0 }, usage: [{ input: 10, output: 5, calls: 2 }], steps }
    const md = exportMarkdown(trace, buildTurns(steps))
    expect(md.startsWith('# build fix\n')).toBe(true)
    expect(md).toContain('- **working dir:** /w (main)')
    expect(md).toContain('## Turn 1 · 1970-01-01 00:01:40 UTC')
    expect(md).toContain('**You**\n\nfix the build')
    expect(md).toContain('Steps · 3 tool calls · 1 failed · 1 file edit (+2 −1)')
    expect(md).toContain('- ✕ **terminal** `terminal` (1s) exit 1')
    expect(md).toContain('- ✓ **patch** `patch` — src/x.py +2 −1')
    expect(md).toContain('_model switch_: to gpt-5')
    expect(md).toContain('**Hermes**\n\nDone, but one test fails.')
    expect(md).toContain('## Turn 2')
    expect(md).toContain('_(no reply yet)_')
  })
  it('escapes code fences inside tool output', () => {
    const md = exportMarkdown({ session: { id: 's' }, steps: [] }, buildTurns([call('terminal', 1, { result: 'a\n```\nb' })]))
    expect(md).not.toMatch(/\n```\nb/)
  })
})

describe('thinking steps', () => {
  const think = (text, ts, extra = {}) => ({ kind: 'thinking', text, ts, chars: text.length, truncated: false, ...extra })
  const withThought = [user('why is it slow', 100), think('The query has no index; check the plan.', 105), call('terminal', 110), asst('It needs an index.', 120)]
  it('counts reasoning per turn and keeps the reply detection', () => {
    const t = buildTurns(withThought)
    expect(t[0].thinking).toBe(1)
    expect(t[0].final.text).toBe('It needs an index.')
    expect(t[0].tools).toBe(1)
  })
  it('hides reasoning unless asked for', () => {
    const t = buildTurns(withThought)[0]
    expect(visibleSteps(t, 'all').map(s => s.kind)).toEqual(['tool_call'])
    expect(visibleSteps(t, 'all', true).map(s => s.kind)).toEqual(['thinking', 'tool_call'])
    expect(visibleSteps(t, 'changes', true)).toEqual([])
  })
  it('searches reasoning only while it is shown', () => {
    const t = buildTurns(withThought)
    expect(findHits(t, 'no index').total).toBe(0)
    expect(findHits(t, 'no index', true).total).toBe(1)
  })
  it('exports reasoning as a quote only when asked', () => {
    const t = buildTurns(withThought)
    const trace = { session: { id: 's', title: 'slow' }, steps: withThought }
    expect(exportMarkdown(trace, t)).not.toContain('thinking')
    const md = exportMarkdown(trace, t, { thinking: true })
    expect(md).toContain('💭 **thinking**')
    expect(md).toContain('  > The query has no index; check the plan.')
  })
})
