/**
 * Turn grouping for the session reading view (the shape cc-switch's session reader uses):
 * a user question, the steps Hermes took (tool calls, events, intermediate notes), the final reply.
 * Pure functions over the /api/session/{id}/trace payload so they can be unit-tested.
 */

// one glyph per tool kind (backend TOOL_KINDS); plain text so it reads in both themes
export const KIND_GLYPH = {
  shell: '$', read: '👁', search: '⌕', write: '✎', edit: '✚', web: '🌐', browser: '🧭', agent: '⬡', ask: '?',
  todo: '☑', memory: '🧠', media: '▣', cron: '⏱', skill: '✦', message: '✉', mcp: '⚙', other: '•',
}
export const glyphOf = s => KIND_GLYPH[s?.tool_kind] || KIND_GLYPH.other

/** Group flat trace steps into turns. A `user` step opens a turn; an `assistant` step that closes the
 *  turn (nothing but events after it) is the final reply, any other assistant text is an intermediate note. */
export function buildTurns(steps) {
  const turns = []
  let cur = null
  const open = q => { cur = { question: q, steps: [], final: null, ts: q ? q.ts : null }; turns.push(cur) }
  for (const s of steps || []) {
    if (s.kind === 'user') { open(s); continue }
    if (!cur) open(null)
    if (cur.ts == null) cur.ts = s.ts
    cur.steps.push(s)
  }
  for (const t of turns) {
    let i = t.steps.length - 1
    while (i >= 0 && (t.steps[i].kind === 'event' || t.steps[i].kind === 'compaction')) i--
    if (i >= 0 && t.steps[i].kind === 'assistant') t.final = t.steps.splice(i, 1)[0]
    Object.assign(t, summarize(t))
  }
  return turns
}

export function summarize(turn) {
  const tools = turn.steps.filter(s => s.kind === 'tool_call')
  // events and compaction markers can sit hours after the work (a compaction happens when the next
  // message arrives), so the turn's length runs from the question to the reply or the last tool call
  const first = turn.question?.ts ?? turn.steps[0]?.ts ?? turn.final?.ts
  const lastTool = tools.at(-1)
  const last = turn.final?.ts ?? lastTool?.result_ts ?? lastTool?.ts ?? first
  return {
    compacted: turn.steps.some(s => s.kind === 'compaction'),
    tools: tools.length,
    failed: tools.filter(s => s.failed).length,
    pending: tools.filter(s => s.result == null && !s.failed).length,
    changes: tools.filter(s => s.diff).length,
    added: tools.reduce((n, s) => n + (s.diff?.added || 0), 0),
    removed: tools.reduce((n, s) => n + (s.diff?.removed || 0), 0),
    duration: first != null && last != null ? Math.max(0, last - first) : null,
  }
}

/** Steps of a turn under a reader filter: all · chat (question and reply only) · changes (file edits only). */
export function visibleSteps(turn, filter) {
  if (filter === 'chat') return []
  if (filter === 'changes') return turn.steps.filter(s => s.diff)
  return turn.steps
}

/** Turns that still have something to show under the filter. */
export const visibleTurns = (turns, filter) =>
  filter === 'changes' ? turns.filter(t => t.changes > 0) : turns

/** Text the in-session find box searches for one step. */
export function stepText(s) {
  if (!s) return ''
  if (s.kind === 'tool_call') return [s.name, s.title, s.args, s.result, s.diff?.path].filter(Boolean).join('\n')
  return [s.name, s.text].filter(Boolean).join('\n')
}

/** Mark every turn with how many of its parts match `q` (case-insensitive); 0 hides nothing, it just dims. */
export function findHits(turns, q) {
  const needle = (q || '').trim().toLowerCase()
  if (!needle) return { total: 0, hit: () => false }
  const ids = new Set()
  let total = 0
  for (const t of turns) {
    for (const s of [t.question, ...t.steps, t.final]) {
      if (s && stepText(s).toLowerCase().includes(needle)) { ids.add(s); total++ }
    }
  }
  return { total, hit: s => ids.has(s) }
}

const clock = t => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '')
const fence = (text, lang = '') => '```' + lang + '\n' + String(text || '').replace(/```/g, '`​``') + '\n```'

/** The whole session as Markdown: header, then one section per turn. Previews only (what the trace carries). */
export function exportMarkdown(trace, turns) {
  const s = trace.session || {}
  const u = trace.usage?.[0]
  const out = [`# ${s.title || s.id}`, '']
  const meta = [
    ['session', s.id], ['platform', s.source], ['model', s.model], ['started', clock(s.started)],
    ['ended', s.ended ? `${clock(s.ended)} (${s.end_reason || 'ended'})` : 'still open'],
    ['working dir', s.cwd ? `${s.cwd}${s.git_branch ? ` (${s.git_branch})` : ''}` : null],
    ['compactions', s.compactions ? `${s.compactions} (${(s.segments || []).join(' → ')})` : null],
    ['usage', u ? `${u.input} in · ${u.output} out · ${u.calls} API calls${u.cost_usd ? ` · $${u.cost_usd}` : ''}` : null],
  ]
  for (const [k, v] of meta) if (v) out.push(`- **${k}:** ${v}`)
  out.push('', `_${turns.length} turn${turns.length === 1 ? '' : 's'} · exported from Keryx${trace.truncated ? ` · only the last ${trace.steps.length} steps were loaded` : ''}_`, '')
  turns.forEach((t, i) => {
    out.push(`## Turn ${i + 1}${t.question ? ` · ${clock(t.question.ts)}` : ''}`, '')
    if (t.question) out.push('**You**', '', t.question.text || '', '')
    if (t.steps.length) {
      out.push(`<details><summary>Steps · ${t.tools} tool call${t.tools === 1 ? '' : 's'}${t.failed ? ` · ${t.failed} failed` : ''}${t.changes ? ` · ${t.changes} file edit${t.changes === 1 ? '' : 's'} (+${t.added} −${t.removed})` : ''}</summary>`, '')
      for (const st of t.steps) {
        if (st.kind === 'tool_call') {
          const mark = st.failed ? '✕' : st.result != null ? '✓' : '…'
          out.push(`- ${mark} **${st.name}** ${st.title ? `\`${st.title.replace(/`/g, "'")}\`` : ''}${st.diff ? ` — ${st.diff.path} +${st.diff.added} −${st.diff.removed}` : ''}${st.duration != null ? ` (${Math.round(st.duration)}s)` : ''}${st.exit_code ? ` exit ${st.exit_code}` : ''}`)
          if (st.args) out.push('', '  arguments:', '', indent(fence(pretty(st.args), 'json')), '')
          if (st.result != null) out.push('  result:', '', indent(fence(st.result + (st.truncated ? '\n…' : ''))), '')
        } else if (st.kind === 'compaction') out.push(`- ⟲ **context compacted** — ${st.text}`)
        else if (st.kind === 'event') out.push(`- _${(st.name || '').replace(/_/g, ' ')}_${st.text ? `: ${st.text}` : ''}`)
        else if (st.kind === 'assistant') out.push(`- **Hermes (note):** ${st.text || ''}`)
      }
      out.push('', '</details>', '')
    }
    if (t.final) out.push('**Hermes**', '', t.final.text || '', '')
    else if (!t.steps.length && !t.question) out.push('_(empty turn)_', '')
    else if (!t.final) out.push('_(no reply yet)_', '')
  })
  return out.join('\n')
}

const indent = text => text.split('\n').map(l => '  ' + l).join('\n')
export const pretty = a => { try { return JSON.stringify(JSON.parse(a), null, 1) } catch { return a } }
