import React, { useEffect, useState } from 'react'
import { ago } from './util.js'

/**
 * Hermes' memory files, read-only: MEMORY.md (what the agent noted about the environment) and USER.md
 * (what it noted about you), as entries with their character budget. Off unless the server runs with
 * KERYX_SHOW_MEMORY=1, because this is personal data.
 */
export default function Memory() {
  const [data, setData] = useState(null)
  const [which, setWhich] = useState('memory')
  useEffect(() => {
    let dead = false
    const load = () => fetch('/api/memory').then(r => r.json()).then(d => { if (!dead) setData(d) }).catch(() => {})
    load(); const t = setInterval(load, 15000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  if (!data) return <div className="small">loading…</div>
  if (!data.enabled) return (
    <div>
      <h3>Memory</h3>
      <div className="small">Hermes keeps two small files of notes between sessions: <b>MEMORY.md</b> (facts about your environment and conventions) and <b>USER.md</b> (your preferences). They are personal, so Keryx does not show them unless you ask for it.</div>
      <div className="small" style={{ marginTop: 8 }}>To turn the panel on, start Keryx with <code>KERYX_SHOW_MEMORY=1</code> (in <code>docker-compose.yml</code> or the environment of <code>quickstart.sh</code>). Keryx only reads the files; edit them through Hermes or its dashboard.</div>
    </div>
  )
  const f = data.files.find(x => x.target === which) || data.files[0]
  const lvl = f.pct >= 100 ? 'err' : f.pct >= 80 ? 'warn' : 'ok'
  return (
    <div className="memory">
      <div className="tabs sub">
        {data.files.map(x => <button key={x.target} className={x.target === f.target ? 'on' : ''} onClick={() => setWhich(x.target)}>
          {x.file} <span className="small">· {x.entries.length}</span></button>)}
      </div>
      <div className="small">{f.target === 'memory' ? 'what Hermes noted about your environment, conventions and past work' : 'what Hermes noted about you: preferences, style, expectations'}</div>
      {!f.hermes_enabled && <div className="small warn" style={{ marginTop: 4 }}>switched off in Hermes' config ({f.target === 'memory' ? 'memory.memory_enabled' : 'memory.user_profile_enabled'}: false): Hermes neither reads nor writes this file right now.</div>}
      <div className="gauge" style={{ marginTop: 6 }} title={`${f.chars} of ${f.limit} characters (Hermes' ${f.target === 'memory' ? 'memory_char_limit' : 'user_char_limit'})`}>
        <div className="bar"><i className={lvl} style={{ width: `${Math.min(100, f.pct)}%` }} /></div>
        <span className={lvl}>{f.pct.toFixed(0)}%</span> <span className="small">{f.chars} / {f.limit} chars{f.pct > 100 ? ` · over by ${f.chars - f.limit}` : ''}</span>
      </div>
      <div className="small" style={{ margin: '4px 0 8px' }}>{f.exists ? <>updated {ago(f.mtime)} · <span title={f.path}>{f.file}</span></> : 'file not written yet'}{f.error ? <span className="err"> · {f.error}</span> : null}</div>
      {f.entries.length === 0 && f.exists && <div className="small">empty.</div>}
      <ol className="entries">
        {f.entries.map((e, i) => <li key={i} className={e.blocked ? 'blocked' : ''}>
          <span className="n">{i + 1}</span><div className="txt">{e.text}</div>
        </li>)}
      </ol>
      <div className="small" style={{ marginTop: 8 }}>read-only · Hermes separates entries with a <code>§</code> line and blocks entries that look like prompt injection (shown in red).</div>
    </div>
  )
}
