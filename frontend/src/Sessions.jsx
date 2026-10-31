import React, { useEffect, useMemo, useState } from 'react'
import Shape from './Shapes.jsx'
import { STATUS, ago, fmtTime, nodeBaseColor } from './util.js'
import { getJSON, useDebounced } from './api.js'
import { GROUPINGS, allTags, displayTitle, groupSessions, hiddenCount, isPinned, tagsOf } from './grouping.js'

const loadSet = k => { try { return new Set(JSON.parse(localStorage.getItem(k) || '[]')) } catch { return new Set() } }
const saveSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])) } catch {} }

/**
 * Session list: pinned and running first, then grouped by platform, time (today / yesterday / this week /
 * earlier) or project (working directory); #tags in titles become chips you can filter by; the search box
 * matches titles and digests, and from three characters on also the conversations themselves (server-side,
 * through Hermes' own full-text index).
 */
export default function Sessions({ graph, selected, onSelect, search }) {
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('keryx.group') || 'platform' } catch { return 'platform' } })
  useEffect(() => { try { localStorage.setItem('keryx.group', mode) } catch {} }, [mode])
  const [pinned, setPinned] = useState(() => loadSet('keryx.pins'))
  const togglePin = id => setPinned(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); saveSet('keryx.pins', n); return n })
  const [tag, setTag] = useState(null)
  const [showHidden, setShowHidden] = useState(() => { try { return localStorage.getItem('keryx.hidden') === '1' } catch { return false } })
  const toggleHidden = () => setShowHidden(v => { try { localStorage.setItem('keryx.hidden', v ? '0' : '1') } catch {} return !v })
  const [open, setOpen] = useState(() => new Set())
  const q = (search || '').trim().toLowerCase()
  const nodes = graph?.nodes || []
  const matched = useMemo(() => nodes.filter(n => (n.type === 'session' || n.type === 'subagent') &&
    (!q || `${n.label} ${n.request || ''} ${n.last_step || ''} ${n.source || ''} ${n.cwd || ''}`.toLowerCase().includes(q))), [nodes, q])
  const groups = useMemo(() => groupSessions(matched, { mode, pinned, tag, hidden: showHidden }), [matched, mode, pinned, tag, showHidden])
  const nHidden = useMemo(() => hiddenCount(nodes), [nodes])
  const tags = useMemo(() => allTags(nodes), [nodes])
  const toggle = k => setOpen(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })

  // conversation search: debounced, only when the query is long enough to mean something
  const dq = useDebounced(q.length >= 3 ? q : '', 300)
  const [content, setContent] = useState(null)
  useEffect(() => {
    if (!dq) { setContent(null); return }
    let dead = false
    getJSON(`/api/search?q=${encodeURIComponent(dq)}&limit=20`).then(d => { if (!dead) setContent(d) }).catch(() => { if (!dead) setContent(null) })
    return () => { dead = true }
  }, [dq])
  const shownIds = new Set(matched.map(n => n.id))
  const contentOnly = (content?.sessions || []).filter(h => !shownIds.has(`session:${h.id}`))

  const Row = ({ n }) => {
    const t = tagsOf(n.label)
    return (
      <div className={`srow ${selected === n.id ? 'sel' : ''}`} onClick={() => onSelect(n.id)}>
        <Shape type={n.type} color={nodeBaseColor(n)} />
        <div className="t">
          <div className="title">{displayTitle(n)}{t.map(x => <a key={x} href="#" className={`tagchip ${tag === x ? 'on' : ''}`} onClick={e => { e.preventDefault(); e.stopPropagation(); setTag(tag === x ? null : x) }}>#{x}</a>)}</div>
          <div className="small">{STATUS[n.status]?.label || n.status} · {ago(n.last)} · {n.tool_calls} calls{n.tool_errors ? <span className="err"> · {n.tool_errors} failed</span> : null}{n.children ? ` · ${n.children} subagents` : ''}{mode !== 'platform' || n.internal ? ` · ${n.source}` : ''}{n.hidden ? <span className="warn"> · hidden in Hermes</span> : null}</div>
        </div>
        {n.pinned
          ? <span className="pin on hermes" title="pinned in Hermes' own session list">★</span>
          : <a href="#" className={`pin ${pinned.has(n.id) ? 'on' : ''}`} title={pinned.has(n.id) ? 'unpin' : 'pin to the top (this browser)'} onClick={e => { e.preventDefault(); e.stopPropagation(); togglePin(n.id) }}>{pinned.has(n.id) ? '★' : '☆'}</a>}
      </div>
    )
  }
  return (
    <div>
      <div className="row">
        <select value={mode} onChange={e => setMode(e.target.value)} title="how to group the list">
          {Object.entries(GROUPINGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {tags.length > 0 && <span className="tags">{tags.slice(0, 8).map(({ tag: x, count }) =>
          <a key={x} href="#" className={`tagchip ${tag === x ? 'on' : ''}`} title={`${count} session${count === 1 ? '' : 's'}`} onClick={e => { e.preventDefault(); setTag(tag === x ? null : x) }}>#{x}</a>)}
          {tag && <a href="#" className="small" onClick={e => { e.preventDefault(); setTag(null) }}>✕ clear</a>}</span>}
        {nHidden > 0 && <label className="small" title="sessions Hermes hides from its own picker: hosted rooms, hidden branches"><input type="checkbox" checked={showHidden} onChange={toggleHidden} /> show hidden ({nHidden})</label>}
      </div>
      {!groups.length && !contentOnly.length && <div className="small">no sessions in this window{q ? ' match the search' : ''}{tag ? ` with #${tag}` : ''}.</div>}
      {groups.map(g => {
        // open by default; search forces open; Hermes' internal sessions start collapsed
        const isOpen = q || g.key === 'running' || g.key === 'pinned' ? true : g.key === 'internal' ? open.has(g.key) : !open.has(g.key)
        return <div key={g.key}>
          <h3 className="acc" onClick={() => toggle(g.key)} title={g.key === 'internal' ? 'sessions Hermes ran for itself: one-shot CLI calls, tool helpers, kanban workers' : ''}>{g.key === 'running' ? <span className="dot green pulse" /> : isOpen ? '▾ ' : '▸ '}{g.label} <span className="small">· {g.rows.length}</span></h3>
          {isOpen && g.rows.map(n => <Row key={n.id} n={n} />)}
        </div>
      })}
      {dq && content && <>
        <h3>in conversations <span className="small">· {content.sessions.length ? `${content.sessions.length} session${content.sessions.length === 1 ? '' : 's'}` : 'no matches'}{content.engine === 'like' ? ' · slow search (no FTS index)' : ''}</span></h3>
        {contentOnly.map(h => <div key={h.id} className={`srow ${selected === `session:${h.id}` ? 'sel' : ''}`} onClick={() => onSelect(`session:${h.id}`)}>
          <Shape type="session" color={nodeBaseColor({ type: 'session', status: h.ended ? 'ended' : 'waiting' })} />
          <div className="t">
            <div className="title">{h.title}</div>
            <div className="small">{h.source} · {ago(h.last)} · {h.hits} match{h.hits === 1 ? '' : 'es'}</div>
            {h.snippets.slice(0, 2).map((sn, i) => <div key={i} className="snip"><span className="small">{sn.role === 'user' ? 'you' : 'hermes'} {fmtTime(sn.ts)}</span> <Snip text={sn.text} /></div>)}
          </div>
        </div>)}
        {content.sessions.length > 0 && !contentOnly.length && <div className="small">all of them are already listed above.</div>}
        {content.sessions.some(h => !nodes.find(n => n.id === `session:${h.id}`)) && <div className="small">sessions outside the current window open in the panel but are not drawn in the graph; widen the window to see them.</div>}
      </>}
      <div className="small" style={{ marginTop: 8 }}>press <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> to search · click a row to select it in the graph · ☆ pins a session to the top · ★ is pinned in Hermes</div>
    </div>
  )
}

/** FTS5 snippet: [match] markers become highlights. */
const Snip = ({ text }) => <span className="small snt">{String(text).split(/(\[[^\]]+\])/).map((part, i) =>
  part.startsWith('[') && part.endsWith(']') ? <mark key={i}>{part.slice(1, -1)}</mark> : part)}</span>
