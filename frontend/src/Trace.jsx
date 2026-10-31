import React, { useEffect, useMemo, useRef, useState } from 'react'
import { dur, fmtTime, num } from './util.js'
import { buildTurns, exportMarkdown, findHits, glyphOf, pretty, visibleSteps, visibleTurns } from './turns.js'
import { useRefetch } from './hooks/useTick.js'

/**
 * Session reading view: the conversation as turns (your question → the steps Hermes took → its reply),
 * with an outline to jump between questions, an all / chat / changes filter, find-in-session and a
 * Markdown export. With `tool` set it is the flat list of one tool's calls instead.
 */
export default function Trace({ sessionId, tool }) {
  const [data, setData] = useState(null)
  const [openAll, setOpenAll] = useState(false)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [copied, setCopied] = useState(false)
  const [thinking, setThinking] = useState(() => { try { return localStorage.getItem('keryx.thinking') === '1' } catch { return false } })
  const toggleThinking = () => setThinking(v => { try { localStorage.setItem('keryx.thinking', v ? '0' : '1') } catch {} return !v })
  useEffect(() => { setData(null); setQ(''); setFilter('all') }, [sessionId, tool])
  useRefetch(dead => fetch(`/api/session/${encodeURIComponent(sessionId)}/trace?limit=300${tool ? `&tool=${encodeURIComponent(tool)}` : ''}`)
    .then(r => r.json()).then(d => { if (!dead()) setData(d) }).catch(() => {}), [sessionId, tool])
  const turns = useMemo(() => (data && !tool ? buildTurns(data.steps) : []), [data, tool])
  const hits = useMemo(() => findHits(turns, q, thinking), [turns, q, thinking])
  if (!data) return <div className="small">loading trace…</div>
  if (data.error) return <div className="small err">{data.error}</div>
  const u = data.usage?.[0]
  if (tool) return (
    <div>
      <div className="row"><span className="small">{data.total} call{data.total === 1 ? '' : 's'}{data.truncated ? ' (showing last 300)' : ''}</span>
        <button onClick={() => setOpenAll(o => !o)}>{openAll ? 'collapse all' : 'expand all'}</button></div>
      <div className="trace">{data.steps.map((s, i) => <Step key={i} s={s} open={openAll} />)}</div>
    </div>
  )
  const shown = visibleTurns(turns, filter)
  const changes = turns.reduce((n, t) => n + t.changes, 0)
  const md = () => exportMarkdown(data, turns, { thinking })
  const copy = async () => {
    try { await navigator.clipboard.writeText(md()); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { download() }
  }
  const download = () => {
    const blob = new Blob([md()], { type: 'text/markdown' })
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${slug(data.session?.title || sessionId)}.md` })
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <div className="reader">
      {u && <div className="small">usage: {num(u.input)} in · {num(u.output)} out · cache {((u.cache_hit || 0) * 100) | 0}% · {u.calls} API calls{u.cost_usd ? ` · $${u.cost_usd.toFixed(4)}` : ''}</div>}
      {data.session?.compactions > 0 && <div className="small">⟲ context compacted {data.session.compactions}× · {data.session.segments.length} segments, latest {data.session.tip.slice(0, 8)}</div>}
      <div className="row">
        <span className="seg">
          {[['all', 'all'], ['chat', 'chat'], ['changes', `changes${changes ? ` ${changes}` : ''}`]].map(([k, l]) =>
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)} disabled={k === 'changes' && !changes}>{l}</button>)}
        </span>
        <input type="search" placeholder="find in session" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
        {data.thinking > 0 && <button className={thinking ? 'on' : ''} onClick={toggleThinking} aria-pressed={thinking} aria-label="show the model's reasoning" title={thinking ? 'hide the model\'s reasoning' : `show the model's reasoning (${data.thinking} step${data.thinking === 1 ? '' : 's'})`}>💭</button>}
        <button onClick={() => setOpenAll(o => !o)} aria-pressed={openAll} aria-label="expand or collapse every step" title="expand or collapse every step">{openAll ? '⊟' : '⊞'}</button>
        <button onClick={copy} aria-label="copy the session as Markdown" title="copy the whole session as Markdown">{copied ? 'copied ✓' : '⎘ md'}</button>
        <button onClick={download} aria-label="download the session as Markdown" title="download the session as a Markdown file">⤓</button>
      </div>
      <div className="small">{turns.length} turn{turns.length === 1 ? '' : 's'} · {data.total} step{data.total === 1 ? '' : 's'}{data.truncated ? ' (showing last 300)' : ''}{data.thinking > 0 && !thinking ? ` · ${data.thinking} thinking hidden` : ''}{q.trim() ? <> · <b className={hits.total ? '' : 'err'}>{hits.total} match{hits.total === 1 ? '' : 'es'}</b></> : null}</div>
      {turns.length > 2 && <Outline turns={turns} shown={shown} />}
      <div className="trace">
        {shown.map(t => <Turn key={turns.indexOf(t)} i={turns.indexOf(t)} t={t} filter={filter} openAll={openAll} hits={hits} dim={!!q.trim()} thinking={thinking} />)}
        {!shown.length && <div className="small">nothing to show under this filter.</div>}
      </div>
    </div>
  )
}

/** Every question in the session, with its step count and failures; click to jump. */
function Outline({ turns, shown }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('keryx.outline') !== '0' } catch { return true } })
  const toggle = () => setOpen(o => { try { localStorage.setItem('keryx.outline', o ? '0' : '1') } catch {} return !o })
  return (
    <div className="outline">
      <div className="gh acc" onClick={toggle}>{open ? '▾' : '▸'} outline <span className="small">· {turns.length} questions</span></div>
      {open && <ol>
        {turns.map((t, i) => <li key={i} className={shown.includes(t) ? '' : 'off'}>
          <a href="#" onClick={e => { e.preventDefault(); document.getElementById(`turn-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
             title={t.question?.text || '(no question: Hermes acted on its own)'}>
            <span className="n">{i + 1}</span>
            <span className="q">{t.question ? t.question.text : <i>— no question —</i>}</span>
            <span className="small m">{t.tools ? `${t.tools}` : ''}{t.failed ? <span className="err"> ✕{t.failed}</span> : null}{t.changes ? <span className="warn"> ✎{t.changes}</span> : null}{t.pending ? ' …' : ''}</span>
          </a>
        </li>)}
      </ol>}
    </div>
  )
}

function Turn({ i, t, filter, openAll, hits, dim, thinking }) {
  const steps = visibleSteps(t, filter, thinking)
  const [open, setOpen] = useState(null)      // null = default (collapsed when busy), true / false after a click
  const isOpen = openAll || (open ?? (steps.length <= 4 || t.failed > 0 || t.pending > 0))
  const cls = s => (dim ? (hits.hit(s) ? ' hit' : ' miss') : '')
  return (
    <div className="turn" id={`turn-${i}`}>
      {t.question
        ? <div className={`step user${cls(t.question)}`}><span className="when">{fmtTime(t.question.ts)}</span><b>you</b><div className="txt">{t.question.text}</div></div>
        : <div className="step user auto"><span className="when">{fmtTime(t.ts)}</span><b>hermes</b> <span className="small">acted without a new question (wake-up, delegation result or cron)</span></div>}
      {steps.length > 0 && <>
        <div className="steps-head acc" onClick={() => setOpen(o => !(o ?? isOpen))}>
          {isOpen ? '▾' : '▸'} steps · {t.tools} tool call{t.tools === 1 ? '' : 's'}{thinking && t.thinking ? ` · ${t.thinking} thinking` : ''}
          {t.failed ? <span className="err"> · {t.failed} failed</span> : null}
          {t.changes ? <span className="warn"> · {t.changes} edit{t.changes === 1 ? '' : 's'} +{t.added} −{t.removed}</span> : null}
          {t.pending ? <span className="info"> · running</span> : null}
          {t.duration != null && t.duration > 0 ? <span className="small"> · {dur(t.duration)}</span> : null}
          {dim && steps.some(s => hits.hit(s)) && !isOpen ? <span className="info"> · match inside</span> : null}
        </div>
        {isOpen && steps.map((s, j) => <Step key={j} s={s} open={openAll} cls={cls(s)} />)}
      </>}
      {t.final
        ? <div className={`step assistant final${cls(t.final)}`}><span className="when">{fmtTime(t.final.ts)}</span><b>hermes</b><div className="txt">{t.final.text}</div></div>
        : filter !== 'changes' && <div className="step small pending">{t.pending ? '… working' : t.compacted ? 'the context was compacted before a reply; the conversation continues in the next turn' : t.steps.length ? 'turn ended without a reply' : ''}</div>}
    </div>
  )
}

function Step({ s, open, cls = '' }) {
  const [o, setO] = useState(false)
  const isOpen = open || o
  if (s.kind === 'user') return <div className={`step user${cls}`}><span className="when">{fmtTime(s.ts)}</span><b>you</b><div className="txt">{s.text}</div></div>
  if (s.kind === 'assistant') return <div className={`step assistant note${cls}`}><span className="when">{fmtTime(s.ts)}</span><b>hermes</b><div className="txt">{s.text}</div></div>
  if (s.kind === 'thinking') return (
    <div className={`step thinking${cls}`} onClick={() => setO(v => !v)} title={isOpen ? 'collapse' : 'expand the reasoning'}>
      <span className="when">{fmtTime(s.ts)}</span><b>💭 thinking</b>
      <span className="small st"> {s.chars.toLocaleString()} chars{s.truncated ? ' · head only' : ''} {isOpen ? '▾' : '▸'}</span>
      <div className={`txt ${isOpen ? '' : 'clamp'}`}>{s.text}</div>
    </div>
  )
  if (s.kind === 'compaction') return <div className={`step compaction${cls}`} title={`segment ${s.segment}`}><span className="when">{fmtTime(s.ts)}</span><b>⟲ compacted</b> <span className="small">{s.text}</span></div>
  if (s.kind === 'event') return <div className={`step event${cls}`}><span className="when">{fmtTime(s.ts)}</span><b>{s.name.replace(/_/g, ' ')}</b>{s.text && <> <span className="small">{s.text}</span></>}</div>
  return (
    <div className={`step tool ${s.failed ? 'failed' : ''}${cls}`} onClick={() => setO(v => !v)}>
      <span className="when">{fmtTime(s.ts)}</span>
      <span className="glyph" title={s.tool_kind}>{glyphOf(s)}</span><b>{s.name}</b>
      {s.title ? <span className="title" title={s.title}>{s.title}</span> : null}
      <span className="small st"> {s.failed ? '✕ failed' : s.result != null ? '✓' : '…'}{s.exit_code ? ` exit ${s.exit_code}` : ''}{s.duration != null ? ` · ${dur(s.duration)}` : ''} {isOpen ? '▾' : '▸'}</span>
      {s.diff && <div className="diffline"><span className="add">+{s.diff.added}</span> <span className="del">−{s.diff.removed}</span> <span className="path">{s.diff.path}</span></div>}
      {isOpen && <div className="detail">
        {s.args ? <><div className="k">arguments</div><pre>{pretty(s.args)}</pre></> : null}
        {s.result != null ? <><div className="k">result{s.lines > 1 ? ` · ${s.lines} lines` : ''}{s.truncated ? ' · truncated' : ''}</div><pre>{s.result}</pre></> : null}
      </div>}
    </div>
  )
}
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session'
