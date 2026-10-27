import React from 'react'
import { STATUS, TYPE, ago, dur, fmtT, num } from './util.js'
import Shape from './Shapes.jsx'

export default function SidePanel({ node, cost, status, onClose, graph }) {
  if (!node) return <Overview cost={cost} status={status} graph={graph} />
  const rows = [['type', <span><Shape type={node.type} color={TYPE[node.type]?.color} />{TYPE[node.type]?.label || node.type}</span>]]
  if (node.type === 'session' || node.type === 'subagent') rows.push(
    ['status', <span className={cls(node.status)}>{STATUS[node.status]?.label || node.status}</span>],
    ['request', node.request || '–'], ['latest step', node.last_step || '–'],
    ['platform', node.source], ['model', node.model],
    ['started', fmtT(node.started)], ['last activity', `${fmtT(node.last)} (${ago(node.last)})`],
    ['duration', dur((node.ended || node.last) - node.started)],
    ['messages', `${node.messages} total · ${node.user_messages} from user`],
    ['tool calls', <span>{node.tool_calls}{node.tool_errors ? <span className="err"> · {node.tool_errors} failed</span> : null}</span>],
    ['rate', `${node.calls_per_min || 0} calls/min`], ['subagents', node.children || 0],
    ['end reason', node.end_reason || '–'], ['id', node.id.replace('session:', '')])
  if (node.type === 'tool') rows.push(['session', node.session], ['calls', node.calls],
    ['failed', <span className={node.errors ? 'err' : 'ok'}>{node.errors}</span>], ['last call', `${fmtT(node.last)} (${ago(node.last)})`])
  if (node.type === 'model') rows.push(['providers', (node.providers || []).join(', ') || '–'],
    ['input tokens', num(node.tokens_in)], ['output tokens', num(node.tokens_out)], ['cache reads', num(node.cache_read)],
    ['cache hit', `${((node.cache_hit || 0) * 100).toFixed(0)}%`], ['API calls', node.calls], ['est. cost', node.cost_usd ? `$${node.cost_usd}` : '–'])
  if (node.type === 'cron') rows.push(['schedule', node.schedule], ['mode', node.no_agent ? `script only (${node.script})` : 'agent prompt'],
    ['paused', node.paused ? 'yes' : 'no'], ['last run', `${fmtT(node.last_run)} · ${node.last_status || 'never'}`],
    ['next run', fmtT(node.next_run)], ['last error', node.last_error || '–'])
  if (node.type === 'source') rows.push(['sessions', graph?.nodes.filter(n => n.source === node.label && (n.type === 'session' || n.type === 'subagent')).length || 0],
    ['tip', 'click the node to collapse / expand'])
  return (
    <div className="side">
      <span className="close" onClick={onClose}>✕</span>
      <h2>{node.label}</h2>
      <table><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>
    </div>
  )
}

function Overview({ cost, status, graph }) {
  const s = graph?.stats || {}
  return (
    <div className="side">
      <h2>Overview</h2>
      <table><tbody>
        <tr><td>sessions in window</td><td>{s.sessions ?? '–'} ({s.subagents ?? 0} subagents)</td></tr>
        <tr><td>running / stale</td><td>{s.running ?? 0} / {s.stale ?? 0}</td></tr>
        <tr><td>active last 5 min</td><td>{s.active ?? 0}</td></tr>
        <tr><td>tool calls</td><td>{s.tool_calls ?? 0}{s.errors ? <span className="err"> · {s.errors} failed</span> : null}</td></tr>
        <tr><td>orphaned / failed</td><td>{s.orphaned ?? 0} / {s.failed ?? 0}</td></tr>
        <tr><td>cron</td><td>{s.cron_jobs ?? 0} jobs · {s.cron_runs ?? 0} runs</td></tr>
      </tbody></table>
      <h3>Health</h3>
      <table><tbody>{(status?.checks || []).map(c => (
        <tr key={c.name}><td><span className={`dot ${c.level}`} />{c.name}</td><td>{c.detail}{c.recent?.length ? <div className="small">{c.recent.map((l, i) => <div key={i}>{l}</div>)}</div> : null}</td></tr>
      ))}</tbody></table>
      <h3>Tokens by model</h3>
      <table className="cost"><thead><tr><td>model</td><td>in</td><td>out</td><td>cache</td><td>calls</td></tr></thead><tbody>
        {(cost?.models || []).map(m => <tr key={m.model}><td title={(m.providers || []).join(', ')}>{m.model}</td><td>{num(m.input)}</td><td>{num(m.output)}</td><td>{((m.cache_hit || 0) * 100) | 0}%</td><td>{m.calls}</td></tr>)}
        {cost?.totals && <tr><td><b>total</b></td><td>{num(cost.totals.input)}</td><td>{num(cost.totals.output)}</td><td>{((cost.totals.cache_hit || 0) * 100) | 0}%</td><td>{cost.totals.calls}</td></tr>}
      </tbody></table>
      {cost?.totals?.cost_usd ? <div className="small">estimated spend in window: ${cost.totals.cost_usd}</div>
        : <div className="small">subscription providers report no per-token cost; cache hit shows how much prompt reuse you get.</div>}
      <h3>Legend</h3>
      <table><tbody>
        {Object.entries(TYPE).map(([k, v]) => <tr key={k}><td><Shape type={k} color={v.color} />{k}</td><td>{v.label}</td></tr>)}
        {Object.entries(STATUS).map(([k, v]) => <tr key={k}><td><i className="dot" style={{ background: v.color }} />{k.replace(/_/g, ' ')}</td><td>{v.label}</td></tr>)}
        <tr><td><i className="dot" style={{ background: '#ff4d4d' }} />active</td><td>touched in the last 5 min; particles flow along active links</td></tr>
      </tbody></table>
      <h3>Reading the layout</h3>
      <div className="small">
        Shape says <b>what</b> a node is; colour says <b>how</b> it is doing; opacity says <b>how long ago</b>.<br />
        Hermes sits at the centre with platforms on a ring around it; each platform owns a wedge, and its sessions sit in that wedge ordered by start time.
        In 3D, fresh work floats near the top and older work settles downward; in 2D, recent sessions sit close to the hub and older ones drift outward.
        Subagents orbit the session that spawned them, tools cluster tightly around the session that called them, models sit on a shelf above, cron jobs fan out below their platform.
        Running sessions breathe. Hover to highlight a neighbourhood, click a platform to collapse it, drag the replay bar to scrub the window.
      </div>
    </div>
  )
}
const cls = s => (s === 'running' ? 'ok' : s === 'stale' ? 'warn' : s === 'orphaned' || s === 'failed' ? 'err' : '')
