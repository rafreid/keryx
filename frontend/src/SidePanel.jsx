import React, { useState } from 'react'
import Section from './Section.jsx'
import { ACTIVE, STATUS, TYPE, ago, contextLevel, dur, fmtT, num } from './util.js'
import Shape from './Shapes.jsx'
import { nodeBaseColor } from './util.js'
import Analytics from './Analytics.jsx'
import Sessions from './Sessions.jsx'
import Logs from './Logs.jsx'
import Trace from './Trace.jsx'
import Tasks from './Tasks.jsx'
import Memory from './Memory.jsx'
import Board from './Board.jsx'
import { resumeCommand } from './grouping.js'
import { glyphOf } from './turns.js'

const TABS = ['overview', 'sessions', 'tasks', 'board', 'analytics', 'logs', 'memory']

export default function SidePanel({ node, cost, status, onClose, graph, tasks, hidden, toggleHidden, showAll, search, onSelect, tab, setTab }) {
  // tab badges (AionUi shows pending-approval counts on its sidebar): things that want attention
  const s = graph?.stats || {}
  const errs = (status?.checks || []).find(c => c.name === 'errors')
  const badges = {
    sessions: (s.running || 0) + (s.waiting || 0),
    tasks: (tasks?.delegations || []).filter(d => !/complet|fail|error|cancel/.test(d.state || '')).length
         + (tasks?.jobs || []).filter(j => j.state === 'error' || j.state === 'missed').length,
    logs: errs?.errors || 0,
    board: tasks?.kanban ? (tasks.kanban.counts.running || 0) + (tasks.kanban.counts.blocked || 0) + (tasks.kanban.counts.review || 0) : 0,
  }
  const badgeLevel = { sessions: 'ok', tasks: (tasks?.jobs || []).some(j => j.state === 'error' || j.state === 'missed') ? 'err' : 'ok', logs: 'err',
    board: tasks?.kanban?.attention ? 'err' : 'ok' }
  return (
    <div className="side">
      <div className="tabs">
        {TABS.map(t => <button key={t} className={tab === t && !node ? 'on' : ''} onClick={() => { onClose(); setTab(t) }}>
          {t}{badges[t] ? <span className={`badge ${badgeLevel[t]}`}>{badges[t]}</span> : null}
        </button>)}
      </div>
      {node ? <NodeDetail node={node} graph={graph} onClose={onClose} onSelect={onSelect} links={status?.links} />
        : tab === 'sessions' ? <Sessions graph={graph} selected={null} onSelect={onSelect} search={search} />
        : tab === 'tasks' ? <Tasks tasks={tasks} onSelect={onSelect} links={status?.links} />
        : tab === 'board' ? <Board onSelect={onSelect} links={status?.links} />
        : tab === 'analytics' ? <Analytics />
        : tab === 'logs' ? <Logs onSelect={onSelect} links={status?.links} />
        : tab === 'memory' ? <Memory />
        : <Overview cost={cost} status={status} graph={graph} hidden={hidden} toggleHidden={toggleHidden} showAll={showAll} onSelect={onSelect} setTab={setTab} />}
    </div>
  )
}

/** Context-window gauge: how full the model's context was at the last API call. */
function ContextGauge({ c }) {
  if (!c) return <span className="small">unknown</span>
  const lvl = contextLevel(c.pct)
  const src = { config: "window from model.context_length in Hermes' config.yaml", cache: "window Hermes probed for this model (context_length_cache.yaml)",
    table: "window from Keryx's built-in table", assumed: 'assumed window; set CONTEXT_LENGTH or let Hermes probe the model' }[c.source] || ''
  return (
    <div className="gauge" title={`${c.prompt_tokens.toLocaleString()} prompt tokens of ${c.limit.toLocaleString()}${src ? ` · ${src}` : ''}`}>
      <div className="bar"><i className={lvl} style={{ width: `${Math.min(100, c.pct)}%` }} /></div>
      <span className={lvl}>{c.pct.toFixed(0)}%</span> <span className="small">{num(c.prompt_tokens)} / {num(c.limit)}{c.assumed ? ' ~' : ''}</span>
    </div>
  )
}

/** What fills the context window (hermes-workspace's context-bloat analysis, per session): parts, then tools. */
function ContextMix({ sessionId }) {
  const [c, setC] = useState(null)
  React.useEffect(() => {
    let dead = false
    const load = () => fetch(`/api/session/${encodeURIComponent(sessionId)}/context`).then(r => r.json()).then(d => { if (!dead) setC(d) }).catch(() => {})
    load(); const t = setInterval(load, 15000)
    return () => { dead = true; clearInterval(t) }
  }, [sessionId])
  if (!c || c.error || !c.total_chars) return null
  const parts = c.parts.filter(p => p.chars > 0)
  return (
    <>
      <h3>What fills the context <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>· {num(c.total_chars)} chars ≈ {num(c.est_tokens)} tokens{c.segments.length > 1 ? ' · current segment' : ''}</span></h3>
      <div className="mix" title={parts.map(p => `${p.label}: ${(p.share * 100).toFixed(0)}%`).join(' · ')}>
        {parts.map(p => <i key={p.kind} className={p.kind} style={{ width: `${p.share * 100}%` }} />)}
      </div>
      <div className="small mixl">{parts.map(p => <span key={p.kind}><i className={p.kind} />{p.label} {(p.share * 100).toFixed(0)}%</span>)}</div>
      {c.tools.length > 0 && <div className="mixtools">
        {c.tools.slice(0, 6).map(t => <div key={t.name} className="mt" title={`${t.calls} call${t.calls === 1 ? '' : 's'} · ${t.chars.toLocaleString()} chars`}>
          <span className="n">{glyphOf(t)} {t.name}</span><span className="b"><i style={{ width: `${Math.max(1, t.share * 100)}%` }} /></span><span className="small">{(t.share * 100).toFixed(0)}%</span>
        </div>)}
      </div>}
      {c.biggest[0] && c.biggest[0].chars > 2000 && <div className="small">largest output: {c.biggest[0].name}{c.biggest[0].title ? ` ${c.biggest[0].title}` : ''} · {num(c.biggest[0].chars)} chars · {ago(c.biggest[0].ts)}</div>}
    </>
  )
}

const OP = { write: '✎', patch: '✚', read: '👁', search: '⌕' }

/** Files a session touched, most recent first, one row per path (AionUi's preview panel tracks file changes). */
function Files({ files, limit = 14 }) {
  const seen = new Map()
  for (const f of [...files].reverse()) {
    const cur = seen.get(f.path)
    if (!cur) seen.set(f.path, { ...f, n: 1, ops: new Set([f.op]), added: f.added || 0, removed: f.removed || 0 })
    else { cur.n++; cur.ops.add(f.op); cur.added += f.added || 0; cur.removed += f.removed || 0 }
  }
  const rows = [...seen.values()].slice(0, limit)
  return (
    <div className="files">
      {rows.map(f => <div key={f.path} className={`file ${f.ops.has('write') || f.ops.has('patch') ? 'changed' : ''}`} title={`${[...f.ops].join(', ')} · ${f.n}× · ${fmtT(f.ts)}`}>
        <span className="op">{[...f.ops].map(o => OP[o]).join('')}</span><span className="path">{f.path}</span>
        <span className="small">{f.added || f.removed ? <span className="pm"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span> </span> : null}{ago(f.ts)}</span>
      </div>)}
      {seen.size > limit && <div className="small">… {seen.size - limit} more</div>}
    </div>
  )
}

/** The agent's own task list (Hermes' todo_list tool), newest revision across the lineage. */
function Plan({ sessionId }) {
  const [data, setData] = useState(null)
  React.useEffect(() => {
    let dead = false
    const load = () => fetch(`/api/session/${encodeURIComponent(sessionId)}/todo`).then(r => r.json()).then(d => { if (!dead) setData(d) }).catch(() => {})
    load(); const t = setInterval(load, 10000)
    return () => { dead = true; clearInterval(t) }
  }, [sessionId])
  const todo = data?.todo
  if (!todo) return null
  const s = todo.summary
  return (
    <>
      <h3>Plan <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>· {s.completed}/{s.total} done{s.in_progress ? ` · ${s.in_progress} in progress` : ''}{s.cancelled ? ` · ${s.cancelled} cancelled` : ''} · {ago(todo.ts)}</span></h3>
      <ol className="plan">
        {todo.items.map(i => <li key={i.id} className={i.status}><span className="mark">{PLAN_MARK[i.status]}</span>{i.content}</li>)}
      </ol>
    </>
  )
}
const PLAN_MARK = { completed: '✓', in_progress: '▶', pending: '○', cancelled: '✕' }

function NodeDetail({ node, graph, onClose, onSelect, links }) {
  const rows = [['type', <span><Shape type={node.type} color={nodeBaseColor(node)} />{(TYPE[node.type]?.label || node.type).split(' — ')[0]}</span>]]
  const isSession = node.type === 'session' || node.type === 'subagent'
  if (isSession) rows.push(
    ['status', <span className={cls(node.status)}>{STATUS[node.status]?.label || node.status}</span>],
    ['request', node.request || '–'], ['latest step', node.last_step || '–'],
    ['platform', node.source], ['model', node.model],
    ['started', fmtT(node.started)], ['last activity', `${fmtT(node.last)} (${ago(node.last)})`],
    ['duration', dur((node.ended || node.last) - node.started)],
    ['messages', `${node.messages} total · ${node.user_messages} from user`],
    ['tool calls', <span>{node.tool_calls}{node.tool_errors ? <span className="err"> · {node.tool_errors} failed</span> : null}</span>],
    ['rate', `${node.calls_per_min || 0} calls/min`], ['subagents', node.children || 0],
    ['plan', node.plan ? <span>{node.plan.done}/{node.plan.total} done{node.plan.current ? <span className="small"> · ▶ {node.plan.current}</span> : null}</span> : '–'],
    ['context', <ContextGauge c={node.context} />],
    ['compactions', node.compactions ? <span title={`segments: ${(node.segments || []).join(' → ')}`}>⟲ {node.compactions}× · {(node.segments || []).length} segments · latest {String(node.tip || '').slice(0, 8)}</span> : 'none'],
    ['end reason', node.end_reason || '–'])
  if (isSession && node.usage) rows.push(
    ['tokens', `${num(node.usage.tokens_in)} in · ${num(node.usage.tokens_out)} out`],
    ['cache reads', `${num(node.usage.cache_read)} (${node.usage.tokens_in + node.usage.cache_read ? ((node.usage.cache_read / (node.usage.tokens_in + node.usage.cache_read)) * 100).toFixed(0) : 0}% hit)`],
    ['API calls', node.usage.api_calls], [costLabel(node.usage.cost_basis), node.usage.cost_usd ? `$${node.usage.cost_usd}` : node.usage.cost_basis === 'included' ? 'included in subscription' : '–'])
  if (isSession && node.usage?.reasoning) rows.push(['reasoning tokens', num(node.usage.reasoning)])
  if (isSession && (node.cwd || node.git_branch)) rows.push(['working dir', <span title={node.cwd || ''}>{node.cwd || '–'}{node.git_branch ? <span className="small"> · ⎇ {node.git_branch}</span> : null}</span>])
  if (isSession && node.profile) rows.push(['profile', node.profile])
  if (isSession && node.task) rows.push(['kanban card', <span title={`board ${node.task.board} · ${node.task.id}`}>{node.task.title} <span className="small">· {node.task.status}</span></span>])
  if (isSession && node.handoff) rows.push(['handoff', node.handoff])
  if (isSession && node.archived) rows.push(['archived', 'yes'])
  if (isSession && (node.pinned || node.hidden || node.internal)) rows.push(['in Hermes', [node.pinned ? '★ pinned' : null, node.hidden ? 'hidden from the session list' : null, node.internal ? `internal (${node.source})` : null].filter(Boolean).join(' · ')])
  if (isSession && node.parent) rows.push([node.fork === 'branch' ? 'branched from' : 'parent', <a href="#" onClick={e => { e.preventDefault(); onSelect(`session:${node.parent}`) }}>{graph?.nodes.find(n => n.id === `session:${node.parent}`)?.label || node.parent}</a>])
  if (isSession) rows.push(['id', node.id.replace('session:', '')])
  if (node.type === 'tool') rows.push(['session', node.session], ['calls', node.calls],
    ['failed', <span className={node.errors ? 'err' : 'ok'}>{node.errors}</span>], ['last call', `${fmtT(node.last)} (${ago(node.last)})`])
  if (node.type === 'model') rows.push(['providers', (node.providers || []).join(', ') || '–'],
    ['input tokens', num(node.tokens_in)], ['output tokens', num(node.tokens_out)], ['cache reads', num(node.cache_read)],
    ['cache hit', `${((node.cache_hit || 0) * 100).toFixed(0)}%`], ['cache writes', num(node.cache_write)], ['reasoning tokens', num(node.reasoning)],
    ['API calls', node.calls], [costLabel(node.cost_basis), node.cost_usd ? `$${node.cost_usd}` : node.cost_basis === 'included' ? 'included in subscription' : '–'])
  if (node.type === 'cron') rows.push(['schedule', node.schedule], ['mode', node.no_agent ? `script only (${node.script})` : 'agent prompt'],
    ['tip', 'run history and next-run countdown live in the tasks tab'],
    ['paused', node.paused ? 'yes' : 'no'], ['last run', `${fmtT(node.last_run)} · ${node.last_status || 'never'}`],
    ['next run', fmtT(node.next_run)], ['last error', node.last_error || '–'])
  if (node.type === 'source') rows.push(['sessions', graph?.nodes.filter(n => n.source === node.label && (n.type === 'session' || n.type === 'subagent')).length || 0],
    ['tip', 'click the node to collapse / expand'])
  return (
    <div>
      <span className="close" onClick={onClose}>✕</span>
      <h2>{node.label}</h2>
      <table><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
      {isSession && links?.chat_resume && <div className="small" style={{ marginTop: 6 }}><a href={links.chat_resume + encodeURIComponent(node.tip || node.id.replace('session:', ''))} target="_blank" rel="noreferrer">open in the Hermes dashboard ↗</a></div>}
      {isSession && <Resume node={node} />}
      {node.type === 'cron' && links?.cron && <div className="small" style={{ marginTop: 6 }}><a href={links.cron} target="_blank" rel="noreferrer">manage in the Hermes dashboard ↗</a></div>}
      {isSession && <Plan sessionId={node.id.replace('session:', '')} />}
      {isSession && <ContextMix sessionId={node.id.replace('session:', '')} />}
      {isSession && node.files?.length > 0 && <><h3>Files touched <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>· ✎ write ✚ patch 👁 read ⌕ search</span></h3><Files files={node.files} /></>}
      {isSession && <><h3>Trace</h3><Trace sessionId={node.id.replace('session:', '')} /></>}
      {node.type === 'tool' && <><h3>Calls</h3><Trace sessionId={node.session} tool={node.label} /></>}
    </div>
  )
}

/** hermes-workspace's attention card: everything red or amber in one ranked list, each line leading to a node or a tab. */
function Attention({ items, onSelect, setTab }) {
  const go = a => { if (a.node) onSelect(a.node); else if (a.tab) setTab(a.tab) }
  const worst = items.find(a => a.severity === 'red') ? 'err' : items.find(a => a.severity === 'amber') ? 'warn' : ''
  const n = items.filter(a => a.severity !== 'info').length
  return (
    <Section id="attention" title="Attention" level={worst} summary={n ? <span className={worst}>{n} need{n === 1 ? 's' : ''} a look</span> : 'all clear'}>
      {!items.length && <div className="small">nothing needs you right now.</div>}
      {items.map(a => <div key={a.id} className={`att ${a.severity}`} onClick={() => go(a)} title={a.node ? 'select in the graph' : `open the ${a.tab} tab`}>
        <span className={`dot ${a.severity === 'info' ? 'blue' : a.severity}`} />
        <span className="src">{a.source}</span>
        <span className="lbl">{a.label}</span>
        {a.detail ? <div className="small det">{a.detail}</div> : null}
      </div>)}
    </Section>
  )
}

function Overview({ cost, status, graph, hidden, toggleHidden, showAll, onSelect, setTab }) {
  const s = graph?.stats || {}
  const changes = (graph?.nodes || []).flatMap(n => (n.files || []).filter(f => f.op === 'write' || f.op === 'patch').map(f => ({ ...f, node: n.id, label: n.label })))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0)).filter((f, i, a) => a.findIndex(g => g.path === f.path) === i).slice(0, 8)
  return (
    <div>
      <h2>Overview <a className="small dl" href="/api/diagnostics" download title="privacy-safe JSON snapshot for bug reports: counts, states, ids, redacted errors — no prompts, no keys">⤓ diagnostics</a></h2>
      <table><tbody>
        <tr><td>sessions in window</td><td>{s.sessions ?? '–'} ({s.subagents ?? 0} subagents)</td></tr>
        <tr><td>running / waiting / stale</td><td>{s.running ?? 0} / {s.waiting ?? 0} / {s.stale ?? 0}</td></tr>
        <tr><td>active last 5 min</td><td>{s.active ?? 0}</td></tr>
        <tr><td>tool calls</td><td>{s.tool_calls ?? 0}{s.errors ? <span className="err"> · {s.errors} failed</span> : null}</td></tr>
        <tr><td>orphaned / failed</td><td>{s.orphaned ?? 0} / {s.failed ?? 0}</td></tr>
        <tr><td>cron</td><td>{s.cron_jobs ?? 0} jobs · {s.cron_runs ?? 0} runs</td></tr>
      </tbody></table>
      {status?.attention && <Attention items={status.attention} onSelect={onSelect} setTab={setTab} />}
      <Section id="health" title="Health" summary={<span className={`dot ${status?.level || 'amber'}`} />}>
      <table><tbody>{(status?.checks || []).map(c => (
        <tr key={c.name}><td><span className={`dot ${c.level}`} />{c.name.replace(/_/g, ' ')}</td><td>{c.detail}{c.recent?.length ? <div className="small">{c.recent.map((l, i) => <div key={i}>{l}</div>)}</div> : null}</td></tr>
      ))}</tbody></table>
      </Section>
      {changes.length > 0 && <Section id="files" title="Recent file changes" summary={`${changes.length}`}>
        <div className="files">{changes.map(f => <div key={f.path} className="file changed" title={`${f.label} · ${fmtT(f.ts)}`}>
          <span className="op">{OP[f.op]}</span><a className="path" href="#" onClick={e => { e.preventDefault(); onSelect(f.node) }}>{f.path}</a>
          <span className="small">{f.added || f.removed ? <span className="pm"><span className="add">+{f.added}</span> <span className="del">−{f.removed}</span> </span> : null}{ago(f.ts)}</span>
        </div>)}</div></Section>}
      <Section id="tokens" title="Tokens by model" summary={cost?.totals ? `${num(cost.totals.input)} in · ${num(cost.totals.output)} out` : ''}>
      <table className="cost"><thead><tr><td>model</td><td>in</td><td>out</td><td>cache</td><td>calls</td></tr></thead><tbody>
        {(cost?.models || []).map(m => <tr key={m.model}><td title={(m.providers || []).join(', ')}>{m.model}</td><td>{num(m.input)}</td><td>{num(m.output)}</td><td>{((m.cache_hit || 0) * 100) | 0}%</td><td>{m.calls}</td></tr>)}
        {cost?.totals && <tr><td><b>total</b></td><td>{num(cost.totals.input)}</td><td>{num(cost.totals.output)}</td><td>{((cost.totals.cache_hit || 0) * 100) | 0}%</td><td>{cost.totals.calls}</td></tr>}
      </tbody></table>
      {cost?.totals?.cost_usd ? <div className="small">{cost.totals.cost_basis === 'actual' ? 'spend in window (provider-reported)' : cost.totals.cost_basis === 'mixed' ? 'spend in window (part provider-reported, part estimated)' : 'estimated spend in window'}: ${cost.totals.cost_usd}</div>
        : <div className="small">{cost?.totals?.cost_basis === 'included' ? 'subscription: usage is included, no per-token cost.' : 'no cost recorded; cache hit shows how much prompt reuse you get.'}</div>}
      </Section>
      <Section id="legend" title="Legend" summary={<>untick to hide{hidden?.size ? <> · {hidden.size} hidden · <a href="#" onClick={e => { e.preventDefault(); e.stopPropagation(); showAll() }}>show all</a></> : null}</>}>
      <table className="legend"><tbody>
        <tr><td colSpan="2" className="small">shape = what it is</td></tr>
        {Object.entries(TYPE).map(([k, v]) => <LegendRow key={k} id={`type:${k}`} hidden={hidden} toggle={toggleHidden}
          glyph={<><Shape type={k} color={v.color} />{v.alt && <Shape type={k} color={v.alt} />}</>} name={k} desc={v.label} />)}
        <tr><td colSpan="2" className="small">colour = how a session is doing</td></tr>
        {Object.entries(STATUS).map(([k, v]) => <LegendRow key={k} id={`status:${k}`} hidden={hidden} toggle={toggleHidden}
          glyph={<><Shape type="session" color={v.color} /><Shape type="subagent" color={v.color} /></>} name={k.replace(/_/g, ' ')} desc={v.label} />)}
        <LegendRow id="flag:active" hidden={hidden} toggle={toggleHidden} glyph={<><Shape type="session" color={ACTIVE} /><Shape type="tool" color={ACTIVE} /></>} name="active" desc="any node or link touched in the last 5 min, with particles" />
      </tbody></table>
      </Section>
      <Section id="layout" title="Reading the layout">
      <div className="small">
        Shape says <b>what</b> a node is; colour says <b>how</b> it is doing; opacity says <b>how long ago</b>.<br />
        Hermes sits at the centre with platforms on a ring around it; each platform owns a wedge, and its sessions sit in that wedge.
        The time axis shows when a session <b>started</b>: in 3D the rings step downward from "now" at the top; in 2D the rings grow outward from the hub.
        Subagents orbit the session that spawned them, tools cluster tightly around the session that called them, models sit on a shelf above, cron jobs fan out below their platform.
        Running sessions breathe. Hover to highlight a neighbourhood, click a platform to collapse it, drag the replay bar to scrub the window.
      </div>
      </Section>
    </div>
  )
}

function LegendRow({ id, hidden, toggle, glyph, name, desc }) {
  const on = !hidden?.has(id)
  return (
    <tr className={on ? '' : 'off'}>
      <td><label><input type="checkbox" checked={on} onChange={() => toggle(id)} />{glyph}{name}</label></td>
      <td>{desc}</td>
    </tr>
  )
}
/** The terminal command that continues this conversation (Hermes' -r/--resume takes the session id). */
function Resume({ node }) {
  const [copied, setCopied] = useState(false)
  const cmd = resumeCommand(node)
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {} }
  return (
    <div className="resume small" title="run this where Hermes is installed to pick the conversation up in a terminal">
      resume in a terminal: <code>{cmd}</code> <a href="#" onClick={e => { e.preventDefault(); copy() }}>{copied ? 'copied ✓' : 'copy'}</a>
    </div>
  )
}

const costLabel = b => (b === 'actual' ? 'cost' : b === 'estimated' ? 'est. cost' : 'cost')
const cls = s => (s === 'running' ? 'ok' : s === 'waiting' ? 'info' : s === 'stale' ? 'warn' : s === 'orphaned' || s === 'failed' ? 'err' : '')
