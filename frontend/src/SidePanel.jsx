import React, { useCallback, useState } from 'react'
import { ACTIVE, STATUS, TYPE, ago, contextLevel, dur, fmtT, num } from './util.js'
import Shape from './Shapes.jsx'
import { nodeBaseColor } from './util.js'
import Analytics from './Analytics.jsx'
import Sessions from './Sessions.jsx'
import Logs from './Logs.jsx'
import Trace from './Trace.jsx'
import Tasks from './Tasks.jsx'

const TABS = ['overview', 'sessions', 'tasks', 'analytics', 'logs']

export default function SidePanel({ node, cost, status, onClose, graph, tasks, hidden, toggleHidden, showAll, search, onSelect, tab, setTab }) {
  // tab badges (AionUi shows pending-approval counts on its sidebar): things that want attention
  const s = graph?.stats || {}
  const errs = (status?.checks || []).find(c => c.name === 'errors')
  const badges = {
    sessions: (s.running || 0) + (s.waiting || 0),
    tasks: (tasks?.delegations || []).filter(d => !/complet|fail|error|cancel/.test(d.state || '')).length
         + (tasks?.jobs || []).filter(j => j.state === 'error' || j.state === 'missed').length,
    logs: errs?.errors || 0,
  }
  const badgeLevel = { sessions: 'ok', tasks: (tasks?.jobs || []).some(j => j.state === 'error' || j.state === 'missed') ? 'err' : 'ok', logs: 'err' }
  return (
    <div className="side">
      <div className="tabs">
        {TABS.map(t => <button key={t} className={tab === t && !node ? 'on' : ''} onClick={() => { onClose(); setTab(t) }}>
          {t}{badges[t] ? <span className={`badge ${badgeLevel[t]}`}>{badges[t]}</span> : null}
        </button>)}
      </div>
      {node ? <NodeDetail node={node} graph={graph} onClose={onClose} onSelect={onSelect} />
        : tab === 'sessions' ? <Sessions graph={graph} selected={null} onSelect={onSelect} search={search} />
        : tab === 'tasks' ? <Tasks tasks={tasks} onSelect={onSelect} />
        : tab === 'analytics' ? <Analytics />
        : tab === 'logs' ? <Logs />
        : <Overview cost={cost} status={status} graph={graph} hidden={hidden} toggleHidden={toggleHidden} showAll={showAll} onSelect={onSelect} />}
    </div>
  )
}

/** Context-window gauge: how full the model's context was at the last API call. */
function ContextGauge({ c }) {
  if (!c) return <span className="small">unknown</span>
  const lvl = contextLevel(c.pct)
  return (
    <div className="gauge" title={`${c.prompt_tokens.toLocaleString()} prompt tokens of ${c.limit.toLocaleString()}${c.assumed ? ' (assumed window; set CONTEXT_LENGTH)' : ''}`}>
      <div className="bar"><i className={lvl} style={{ width: `${Math.min(100, c.pct)}%` }} /></div>
      <span className={lvl}>{c.pct.toFixed(0)}%</span> <span className="small">{num(c.prompt_tokens)} / {num(c.limit)}{c.assumed ? ' ~' : ''}</span>
    </div>
  )
}

const OP = { write: '✎', patch: '✚', read: '👁', search: '⌕' }

/** Files a session touched, most recent first, one row per path (AionUi's preview panel tracks file changes). */
function Files({ files, limit = 14 }) {
  const seen = new Map()
  for (const f of [...files].reverse()) {
    const cur = seen.get(f.path)
    if (!cur) seen.set(f.path, { ...f, n: 1, ops: new Set([f.op]) })
    else { cur.n++; cur.ops.add(f.op) }
  }
  const rows = [...seen.values()].slice(0, limit)
  return (
    <div className="files">
      {rows.map(f => <div key={f.path} className={`file ${f.ops.has('write') || f.ops.has('patch') ? 'changed' : ''}`} title={`${[...f.ops].join(', ')} · ${f.n}× · ${fmtT(f.ts)}`}>
        <span className="op">{[...f.ops].map(o => OP[o]).join('')}</span><span className="path">{f.path}</span><span className="small">{ago(f.ts)}</span>
      </div>)}
      {seen.size > limit && <div className="small">… {seen.size - limit} more</div>}
    </div>
  )
}

function NodeDetail({ node, graph, onClose, onSelect }) {
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
    ['context', <ContextGauge c={node.context} />],
    ['end reason', node.end_reason || '–'])
  if (isSession && node.usage) rows.push(
    ['tokens', `${num(node.usage.tokens_in)} in · ${num(node.usage.tokens_out)} out`],
    ['cache reads', `${num(node.usage.cache_read)} (${node.usage.tokens_in + node.usage.cache_read ? ((node.usage.cache_read / (node.usage.tokens_in + node.usage.cache_read)) * 100).toFixed(0) : 0}% hit)`],
    ['API calls', node.usage.api_calls], ['est. cost', node.usage.cost_usd ? `$${node.usage.cost_usd}` : '–'])
  if (isSession && node.parent) rows.push(['parent', <a href="#" onClick={e => { e.preventDefault(); onSelect(`session:${node.parent}`) }}>{graph?.nodes.find(n => n.id === `session:${node.parent}`)?.label || node.parent}</a>])
  if (isSession) rows.push(['id', node.id.replace('session:', '')])
  if (node.type === 'tool') rows.push(['session', node.session], ['calls', node.calls],
    ['failed', <span className={node.errors ? 'err' : 'ok'}>{node.errors}</span>], ['last call', `${fmtT(node.last)} (${ago(node.last)})`])
  if (node.type === 'model') rows.push(['providers', (node.providers || []).join(', ') || '–'],
    ['input tokens', num(node.tokens_in)], ['output tokens', num(node.tokens_out)], ['cache reads', num(node.cache_read)],
    ['cache hit', `${((node.cache_hit || 0) * 100).toFixed(0)}%`], ['API calls', node.calls], ['est. cost', node.cost_usd ? `$${node.cost_usd}` : '–'])
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
      {isSession && node.files?.length > 0 && <><h3>Files touched <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>· ✎ write ✚ patch 👁 read ⌕ search</span></h3><Files files={node.files} /></>}
      {isSession && <><h3>Trace</h3><Trace sessionId={node.id.replace('session:', '')} /></>}
      {node.type === 'tool' && <><h3>Calls</h3><Trace sessionId={node.session} tool={node.label} /></>}
    </div>
  )
}

function Overview({ cost, status, graph, hidden, toggleHidden, showAll, onSelect }) {
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
      <Section id="health" title="Health" summary={<span className={`dot ${status?.level || 'amber'}`} />}>
      <table><tbody>{(status?.checks || []).map(c => (
        <tr key={c.name}><td><span className={`dot ${c.level}`} />{c.name}</td><td>{c.detail}{c.recent?.length ? <div className="small">{c.recent.map((l, i) => <div key={i}>{l}</div>)}</div> : null}</td></tr>
      ))}</tbody></table>
      </Section>
      {changes.length > 0 && <Section id="files" title="Recent file changes" summary={`${changes.length}`}>
        <div className="files">{changes.map(f => <div key={f.path} className="file changed" title={`${f.label} · ${fmtT(f.ts)}`}>
          <span className="op">{OP[f.op]}</span><a className="path" href="#" onClick={e => { e.preventDefault(); onSelect(f.node) }}>{f.path}</a><span className="small">{ago(f.ts)}</span>
        </div>)}</div></Section>}
      <Section id="tokens" title="Tokens by model" summary={cost?.totals ? `${num(cost.totals.input)} in · ${num(cost.totals.output)} out` : ''}>
      <table className="cost"><thead><tr><td>model</td><td>in</td><td>out</td><td>cache</td><td>calls</td></tr></thead><tbody>
        {(cost?.models || []).map(m => <tr key={m.model}><td title={(m.providers || []).join(', ')}>{m.model}</td><td>{num(m.input)}</td><td>{num(m.output)}</td><td>{((m.cache_hit || 0) * 100) | 0}%</td><td>{m.calls}</td></tr>)}
        {cost?.totals && <tr><td><b>total</b></td><td>{num(cost.totals.input)}</td><td>{num(cost.totals.output)}</td><td>{((cost.totals.cache_hit || 0) * 100) | 0}%</td><td>{cost.totals.calls}</td></tr>}
      </tbody></table>
      {cost?.totals?.cost_usd ? <div className="small">estimated spend in window: ${cost.totals.cost_usd}</div>
        : <div className="small">subscription providers report no per-token cost; cache hit shows how much prompt reuse you get.</div>}
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

/** Collapsible overview section; open state is remembered per browser (keryx.ov.<id>). */
function Section({ id, title, summary, children }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(`keryx.ov.${id}`) !== '0' } catch { return true } })
  const toggle = useCallback(() => setOpen(o => { try { localStorage.setItem(`keryx.ov.${id}`, o ? '0' : '1') } catch {} return !o }), [id])
  return (
    <div className={`section ${open ? 'open' : 'closed'}`}>
      <h3 className="acc" onClick={toggle}>{open ? '▾' : '▸'} {title}{summary ? <span className="small sum"> · {summary}</span> : null}</h3>
      {open && children}
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
const cls = s => (s === 'running' ? 'ok' : s === 'waiting' ? 'info' : s === 'stale' ? 'warn' : s === 'orphaned' || s === 'failed' ? 'err' : '')
