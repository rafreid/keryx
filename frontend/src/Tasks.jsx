import React from 'react'
import { ago, dur, fmtIn, fmtT } from './util.js'

/**
 * Task board (after AionUi's Team Mode task board + scheduled-tasks page):
 * what Hermes delegated to subagents, and what its scheduler is going to do next.
 */
export default function Tasks({ tasks, onSelect }) {
  const del = tasks?.delegations || []
  const jobs = tasks?.jobs || []
  const sched = tasks?.scheduler
  const groups = [
    ['in progress', del.filter(d => !/complet|fail|error|cancel/.test(d.state || ''))],
    ['completed', del.filter(d => /complet/.test(d.state || ''))],
    ['failed', del.filter(d => /fail|error|cancel/.test(d.state || ''))],
  ]
  return (
    <div>
      <h2>Tasks</h2>
      <h3>Delegations <span className="small" style={{ textTransform: 'none', letterSpacing: 0 }}>· work handed to subagents</span></h3>
      {!del.length && <div className="small">no delegations recorded yet. They appear when Hermes calls delegate_task.</div>}
      {groups.map(([name, list]) => list.length ? <div key={name}>
        <div className={`gh ${name === 'failed' ? 'err' : name === 'in progress' ? 'ok' : ''}`}>{name} · {list.length}</div>
        {list.map(d => <Delegation key={d.id} d={d} onSelect={onSelect} />)}
      </div> : null)}

      <h3>Scheduled jobs</h3>
      <div className="small" style={{ marginBottom: 6 }}>
        <span className={`dot ${sched?.alive ? 'green' : 'red'}`} />
        scheduler {sched?.alive ? `alive · tick ${ago(sched.heartbeat)}` : sched?.heartbeat ? `silent since ${ago(sched.heartbeat)}` : 'never seen'}
      </div>
      {!jobs.length && <div className="small">no cron jobs defined.</div>}
      {jobs.map(j => <Job key={j.id} j={j} onSelect={onSelect} />)}
    </div>
  )
}

function Delegation({ d, onSelect }) {
  const open = !/complet|fail|error|cancel/.test(d.state || '')
  return (
    <div className="task">
      <div className="t">
        <span className={`tag ${open ? 'running' : /complet/.test(d.state) ? 'done' : 'failed'}`}>{d.state}</span>
        <span className="small">{d.dispatched ? ago(d.dispatched) : ''}{d.duration != null ? ` · ${dur(d.duration)}` : ''}{d.delivery ? ` · ${d.delivery}` : ''}</span>
      </div>
      {d.parent && <div className="small">from <a href="#" onClick={e => { e.preventDefault(); onSelect(`session:${d.parent}`) }}>{d.parent_title || d.parent}</a></div>}
      <ol className="goals">{(d.goals?.length ? d.goals : [d.goal]).filter(Boolean).map((g, i) => <li key={i}>{g}</li>)}</ol>
      {d.children?.length > 0 && <div className="small">subagents: {d.children.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<a href="#" onClick={e => { e.preventDefault(); onSelect(`session:${c.id}`) }}>{c.title}</a></span>)}</div>}
      {d.summary && <div className="small">result: {d.summary}</div>}
    </div>
  )
}

function Job({ j, onSelect }) {
  const tag = j.state === 'scheduled' ? 'running' : j.state === 'paused' ? 'paused' : 'failed'
  return (
    <div className="task job" onClick={() => onSelect(`cron:${j.id}`)} title="select in the graph">
      <div className="t"><b>{j.name}</b><span className={`tag ${tag}`}>{j.state}</span></div>
      <div className="small">{j.schedule} · {j.mode}{j.deliver ? ` · → ${j.deliver}` : ''}</div>
      <div className="small">
        next <b className={j.missed ? 'err' : ''}>{fmtIn(j.next_run)}</b> ({fmtT(j.next_run)})
        {j.last_run ? <> · last {j.last_status || '?'} {ago(j.last_run)}{j.lateness != null ? ` (${j.lateness.toFixed(0)}s late)` : ''}</> : ' · never run'}
        {j.failure_streak ? <span className="err"> · {j.failure_streak} failures in a row</span> : null}
      </div>
      {j.paused_reason && <div className="small warn">paused: {j.paused_reason}</div>}
      {j.last_error && <div className="small err">{j.last_error}</div>}
      {j.history?.length > 0 && <div className="hist">
        {[...j.history].reverse().map((h, i) => <i key={i} className={h.status === 'completed' ? 'ok' : h.status === 'running' ? 'run' : 'bad'}
          title={`${fmtT(h.started)} · ${h.status}${h.duration != null ? ` · ${dur(h.duration)}` : ''}${h.delivery ? ` · ${h.delivery}` : ''}${h.error ? `\n${h.error}` : ''}`} />)}
        <span className="small"> last {j.history.length} runs</span>
      </div>}
    </div>
  )
}
