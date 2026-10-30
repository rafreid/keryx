import React from 'react'
import { ago, dur, fmtIn, fmtT } from './util.js'
import Section from './Section.jsx'

/**
 * Task board (after AionUi's Team Mode task board + scheduled-tasks page):
 * what Hermes delegated to subagents, and what its scheduler is going to do next.
 */
export default function Tasks({ tasks, onSelect, links }) {
  const del = tasks?.delegations || []
  const jobs = tasks?.jobs || []
  const sched = tasks?.scheduler
  const incidents = tasks?.incidents || []
  const openInc = incidents.filter(i => i.open)
  const deliveries = tasks?.deliveries
  const groups = [
    ['in progress', del.filter(d => !/complet|fail|error|cancel/.test(d.state || ''))],
    ['completed', del.filter(d => /complet/.test(d.state || ''))],
    ['failed', del.filter(d => /fail|error|cancel/.test(d.state || ''))],
  ]
  return (
    <div>
      <h2>Tasks</h2>
      <Section id="delegations" title="Delegations" summary={del.length ? groups.filter(([, l]) => l.length).map(([n, l]) => `${l.length} ${n}`).join(' · ') : 'none yet'}>
        {!del.length && <div className="small">no delegations recorded yet. They appear when Hermes calls delegate_task.</div>}
        {groups.map(([name, list]) => list.length ? <Section key={name} id={`deleg-${name.replace(' ', '')}`} title={name} summary={`${list.length}`} level={name === 'failed' ? 'err' : name === 'in progress' ? 'ok' : ''} sub>
          {list.map(d => <Delegation key={d.id} d={d} onSelect={onSelect} />)}
        </Section> : null)}
      </Section>

      <Section id="jobs" title="Scheduled jobs" summary={<><span className={`dot ${sched?.alive ? 'green' : 'red'}`} />{jobs.length} job{jobs.length === 1 ? '' : 's'}{jobs.some(j => j.state === 'error' || j.state === 'missed') ? <span className="err"> · needs attention</span> : ''}</>}>
        <div className="small" style={{ marginBottom: 6 }}>
          {links?.cron && <a href={links.cron} target="_blank" rel="noreferrer" style={{ float: 'right' }}>manage in the Hermes dashboard ↗</a>}
          <span className={`dot ${sched?.alive ? 'green' : 'red'}`} />
          scheduler {sched?.alive ? `alive · tick ${ago(sched.heartbeat)}` : sched?.heartbeat ? `silent since ${ago(sched.heartbeat)}` : 'never seen'}
        </div>
        {!jobs.length && <div className="small">no cron jobs defined.</div>}
        {jobs.map(j => <Job key={j.id} j={j} onSelect={onSelect} />)}
      </Section>

      {incidents.length > 0 && <Section id="incidents" title="Incidents" level={openInc.length ? 'err' : ''}
          summary={openInc.length ? <span className="err">{openInc.length} open</span> : `${incidents.length} resolved`}>
        <div className="small" style={{ marginBottom: 4 }}>Hermes groups repeated cron failures by job and error signature: <i>detected</i> → <i>alerted</i> → <i>resolved</i> (ran fine again) or <i>closed</i> (acknowledged with <code>hermes cron</code>).</div>
        {incidents.map(i => <div key={i.id} className={`task incident ${i.open ? 'open' : ''}`} onClick={() => onSelect(`cron:${i.job_id}`)} title="select the job in the graph">
          <div className="t"><b>{i.job}</b><span className={`tag ${i.open ? 'failed' : i.state === 'closed' ? 'paused' : 'done'}`}>{i.state}</span><span className="small">{i.failure_type}</span></div>
          <div className="small err">{i.error}</div>
          <div className="small">first {ago(i.first_seen_at)} · last {ago(i.last_seen_at)}{i.closed_at ? ` · closed ${ago(i.closed_at)}` : ''}</div>
        </div>)}
      </Section>}

      {deliveries && (deliveries.pending + deliveries.delivering + deliveries.failed > 0 || deliveries.delivered > 0) &&
        <Section id="deliveries" title="Deliveries" level={deliveries.failed ? 'err' : deliveries.pending + deliveries.delivering ? 'warn' : ''}
            summary={`${deliveries.delivered} delivered${deliveries.pending + deliveries.delivering ? ` · ${deliveries.pending + deliveries.delivering} queued` : ''}${deliveries.failed ? ` · ${deliveries.failed} failed` : ''}`}>
          <div className="small" style={{ marginBottom: 4 }}>cron results waiting to reach their chat, or that could not be delivered.</div>
          {!deliveries.recent.length && <div className="small">nothing queued or failed.</div>}
          {deliveries.recent.map(d => <div key={d.execution_id} className="task">
            <div className="t"><b>{d.job || d.execution_id}</b><span className={`tag ${d.status === 'failed' ? 'failed' : 'running'}`}>{d.status}</span>{d.for_failure ? <span className="small">failure notice</span> : null}</div>
            <div className="small">{ago(d.created_at)}{d.error ? <span className="err"> · {d.error}</span> : null}</div>
          </div>)}
        </Section>}
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
  const tag = j.state === 'scheduled' || j.state === 'running' ? 'running' : j.state === 'paused' ? 'paused' : 'failed'
  return (
    <div className="task job" onClick={() => onSelect(`cron:${j.id}`)} title="select in the graph">
      <div className="t"><b>{j.name}</b><span className={`tag ${tag}`}>{j.state}</span></div>
      <div className="small">{j.schedule} · {j.mode}{j.deliver ? ` · → ${j.deliver}` : ''}</div>
      <div className="small">
        next <b className={j.missed ? 'err' : ''}>{fmtIn(j.next_run)}</b> ({fmtT(j.next_run)})
        {j.last_run ? <> · last {j.last_status || '?'} {ago(j.last_run)}{j.lateness != null ? ` (${j.lateness.toFixed(0)}s late)` : ''}</> : ' · never run'}
        {j.failure_streak ? <span className="err"> · {j.failure_streak} failures in a row</span> : null}
        {j.missed_count > 1 ? <span className="err"> · {j.missed_count} missed slots</span> : null}
        {j.state === 'running' && j.progress_at ? <span> · running, progress {ago(j.progress_at)}</span> : null}
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
