import React, { useEffect, useState } from 'react'
import Section from './Section.jsx'
import { ago, dur, fmtT } from './util.js'
import { getJSON } from './api.js'

/**
 * Hermes' kanban queue, read-only (hermes-desktop's Kanban tab): the board as lanes in Hermes' own
 * column order, a card per task, and a detail drawer with the comment thread, run history and event
 * timeline. Moving cards, dispatching and commenting stay in `hermes kanban` and the dashboard.
 */
export default function Board({ onSelect, links }) {
  const [board, setBoard] = useState(() => { try { return localStorage.getItem('keryx.board') || '' } catch { return '' } })
  const [archived, setArchived] = useState(false)
  const [data, setData] = useState(null)
  const [openId, setOpenId] = useState(null)
  useEffect(() => {
    let dead = false
    const load = () => getJSON(`/api/kanban?board=${encodeURIComponent(board)}&archived=${archived ? 1 : 0}`).then(d => { if (!dead) setData(d) }).catch(() => {})
    load(); const t = setInterval(load, 10000)
    return () => { dead = true; clearInterval(t) }
  }, [board, archived])
  const pick = slug => { setBoard(slug); setOpenId(null); try { localStorage.setItem('keryx.board', slug) } catch {} }
  if (!data) return <div><h2>Board</h2><div className="small">loading board…</div></div>
  if (data.board === null) return (
    <div>
      <h2>Board</h2>
      <div className="small">Hermes has no kanban board{data.boards?.length ? ' by that name' : ''}. One appears at <code>kanban.db</code> in the data directory the first time <code>hermes kanban</code> creates a task.</div>
      {data.boards?.length > 0 && <div className="small" style={{ marginTop: 6 }}>boards: {data.boards.map(b => <a key={b.slug} href="#" onClick={e => { e.preventDefault(); pick(b.slug) }}>{b.name} </a>)}</div>}
    </div>
  )
  const c = data.counts || {}
  const open = data.total - (c.done || 0)
  return (
    <div>
      <h2>Board <span className="small" style={{ fontWeight: 400 }}>· {data.board_name}</span></h2>
      <div className="row">
        {data.boards.length > 1 && <select value={data.board} onChange={e => pick(e.target.value)} title="which board to show">
          {data.boards.map(b => <option key={b.slug} value={b.slug}>{b.name}{b.current ? ' (current)' : ''}{b.archived ? ' (archived)' : ''}</option>)}
        </select>}
        <label className="small"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> show archived{c.archived ? ` (${c.archived})` : ''}</label>
        {links?.home && <a className="small" href={links.home + '/kanban'} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>manage in the Hermes dashboard ↗</a>}
      </div>
      <div className="small">{open} open · {c.running || 0} running · {c.review || 0} in review · {c.done || 0} done
        {data.attention?.length ? <span className="err"> · {data.attention.length} need{data.attention.length === 1 ? 's' : ''} attention</span> : null}</div>
      {data.attention?.length > 0 && <div className="small err" style={{ margin: '4px 0' }}>
        {data.attention.map(a => <div key={a.id + a.why}>⚠ <a href="#" onClick={e => { e.preventDefault(); setOpenId(a.id) }}>{a.title}</a>: {a.why}</div>)}
      </div>}
      {data.lanes.map(l => (
        <Section key={l.key} id={`kb-${l.key}`} title={<><span className="glyph">{l.glyph}</span> {l.label}</>} summary={`${l.tasks.length}`}
                 level={l.key === 'running' ? 'ok' : l.key === 'blocked' && l.tasks.length ? 'err' : ''}>
          {!l.tasks.length && <div className="small lane-empty">empty</div>}
          {l.tasks.map(t => <Card key={t.id} t={t} open={openId === t.id} toggle={() => setOpenId(openId === t.id ? null : t.id)} board={data.board} onSelect={onSelect} />)}
        </Section>
      ))}
      <div className="small" style={{ marginTop: 8 }}>lanes follow Hermes' workflow: triage → todo → scheduled → ready → running → blocked / review → done. Keryx only reads the board; use <code>hermes kanban</code> or the dashboard to move cards.</div>
    </div>
  )
}

function Card({ t, open, toggle, board, onSelect }) {
  const tone = t.stale ? 'failed' : t.status === 'running' ? 'running' : t.status === 'blocked' ? 'failed' : t.status === 'done' ? 'done' : t.status === 'review' ? 'waiting' : 'paused'
  return (
    <div className={`task kcard ${open ? 'open' : ''} ${t.stale ? 'stale' : ''}`} onClick={toggle} title={open ? 'collapse' : 'open the card'}>
      <div className="t">
        <b>{t.title}</b>
        {t.priority ? <span className="tag" title="priority">P{t.priority}</span> : null}
        <span className={`tag ${tone}`}>{t.stale ? 'worker silent' : t.status}</span>
      </div>
      <div className="small">
        {t.assignee ? <>@{t.assignee} · </> : null}
        {t.status === 'running' ? <>started {ago(t.started_at)}{t.heartbeat ? ` · heartbeat ${ago(t.heartbeat)}` : ''}</>
          : t.status === 'done' ? <>done {ago(t.completed_at)}</> : <>created {ago(t.created_at)}</>}
        {t.failures ? <span className="err"> · {t.failures} failure{t.failures === 1 ? '' : 's'} in a row</span> : null}
        {t.block_kind ? <span className="warn"> · {t.block_kind.replace(/_/g, ' ')}</span> : null}
        {t.comments ? ` · ${t.comments} comment${t.comments === 1 ? '' : 's'}` : ''}
        {t.parents?.length ? ` · after ${t.parents.join(', ')}` : ''}
      </div>
      {!open && t.body && <div className="small body">{t.body}</div>}
      {open && <Detail id={t.id} board={board} onSelect={onSelect} />}
    </div>
  )
}

/** The card in full, fetched on open: body, result, workspace, the worker session, comments, runs, events. */
function Detail({ id, board, onSelect }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    let dead = false
    getJSON(`/api/kanban/${encodeURIComponent(id)}?board=${encodeURIComponent(board || '')}`).then(x => { if (!dead) setD(x) }).catch(() => {})
    return () => { dead = true }
  }, [id, board])
  if (!d) return <div className="small">loading…</div>
  if (d.error) return <div className="small err">{d.error}</div>
  const t = d.task
  const stop = e => e.stopPropagation()
  return (
    <div className="kdetail" onClick={stop}>
      {t.body && <><div className="k">task</div><div className="txt">{t.body}</div></>}
      <table><tbody>
        {t.session_id && <tr><td>session</td><td><a href="#" onClick={e => { e.preventDefault(); onSelect(`session:${t.session_id}`) }}>{t.session_id.slice(0, 12)}…</a> <span className="small">(the worker's conversation)</span></td></tr>}
        {t.assignee && <tr><td>assignee</td><td>{t.assignee}{t.model ? <span className="small"> · {t.model}</span> : null}</td></tr>}
        {(t.workspace_path || t.branch) && <tr><td>workspace</td><td>{t.workspace_kind}{t.workspace_path ? ` · ${t.workspace_path}` : ''}{t.branch ? <span className="small"> · ⎇ {t.branch}</span> : null}</td></tr>}
        {t.skills?.length > 0 && <tr><td>skills</td><td>{t.skills.join(', ')}</td></tr>}
        {t.project && <tr><td>project</td><td>{t.project}</td></tr>}
        <tr><td>created</td><td>{fmtT(t.created_at)}{t.created_by ? ` by ${t.created_by}` : ''}</td></tr>
        {t.started_at && <tr><td>started</td><td>{fmtT(t.started_at)}</td></tr>}
        {t.completed_at && <tr><td>completed</td><td>{fmtT(t.completed_at)}</td></tr>}
        {t.children?.length > 0 && <tr><td>unblocks</td><td>{t.children.join(', ')}</td></tr>}
        {t.last_error && <tr><td>last error</td><td className="err">{t.last_error}</td></tr>}
        <tr><td>id</td><td>{t.id}</td></tr>
      </tbody></table>
      {t.result && <><div className="k">result</div><div className="txt">{t.result}</div></>}
      {d.comments.length > 0 && <><div className="k">comments · {d.comments.length}</div>
        {d.comments.map(c => <div key={c.id} className="kcomment"><b>{c.author}</b> <span className="small">{ago(c.created_at)}</span><div className="txt">{c.body}</div></div>)}</>}
      {d.runs.length > 0 && <><div className="k">runs · {d.runs.length}</div>
        {d.runs.map(r => <div key={r.id} className="small krun">
          <span className={`tag ${r.status === 'running' ? 'running' : r.outcome === 'completed' || r.status === 'completed' ? 'done' : 'failed'}`}>{r.outcome || r.status}</span>
          {' '}{r.profile ? `@${r.profile} · ` : ''}{fmtT(r.started_at)}{r.duration != null ? ` · ${dur(r.duration)}` : ''}{r.step ? ` · ${r.step}` : ''}
          {r.summary ? <div className="txt">{r.summary}</div> : null}{r.error ? <div className="err">{r.error}</div> : null}
        </div>)}</>}
      {d.events.length > 0 && <><div className="k">timeline · {d.events.length}</div>
        <div className="kevents">{d.events.map(e => <div key={e.id} className="small"><span className="when">{fmtT(e.created_at)}</span> <b>{e.kind.replace(/_/g, ' ')}</b>{e.detail ? <span> {e.detail}</span> : null}</div>)}</div></>}
      {d.attachments > 0 && <div className="small">{d.attachments} attachment{d.attachments === 1 ? '' : 's'} (not shown)</div>}
    </div>
  )
}
