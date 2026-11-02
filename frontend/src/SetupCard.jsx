import React, { useEffect, useState } from 'react'

/**
 * Replaces the graph while the backend has no state.db to read. It names the problem and the two
 * fixes from the README instead of leaving a column of red checks and a stats bar stuck on "loading".
 * The path comes from /api/health, which only tells it to an authorised viewer.
 */
export default function SetupCard({ dirExists }) {
  const [path, setPath] = useState(null)
  useEffect(() => {
    let dead = false
    fetch('/api/health').then(r => r.json()).then(h => { if (!dead && h.data) setPath(h.data) }).catch(() => {})
    return () => { dead = true }
  }, [])
  return (
    <div className="setup" role="region" aria-label="Keryx needs a Hermes data directory">
      <h2><span className="dot red" aria-hidden="true" />No Hermes data found</h2>
      <p>Keryx looked for <code>state.db</code> in {path ? <code>{path}</code> : 'its data directory'} and found {dirExists ? 'no database there' : 'no such directory'}. Hermes writes <code>state.db</code> the first time it runs, so either Hermes has not run yet or Keryx is pointed at the wrong place.</p>
      <div className="fixes">
        <div>
          <b>Docker</b>
          <p>Point <code>HERMES_HOME</code> at the Hermes home on the host, then restart:</p>
          <pre>HERMES_HOME=/path/to/.hermes docker compose up -d</pre>
        </div>
        <div>
          <b>Running from source</b>
          <p>Set <code>HERMES_DATA</code> to the Hermes home before starting uvicorn:</p>
          <pre>HERMES_DATA=~/.hermes .venv/bin/uvicorn app:app --port 9120</pre>
        </div>
      </div>
      <p className="small">If the directory is right but Keryx still cannot see it, the container is running as the wrong user: set <code>HERMES_UID</code> and <code>HERMES_GID</code> to the directory owner. Keryx rechecks on its own; this card goes away as soon as <code>state.db</code> appears.</p>
    </div>
  )
}
