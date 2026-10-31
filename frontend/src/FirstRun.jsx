import React from 'react'
import Shape from './Shapes.jsx'
import { STATUS, TYPE } from './util.js'

/**
 * Shown once, over the graph, until dismissed: what the picture means and where the data comes from.
 * The ? button in the header brings it back.
 */
export default function FirstRun({ onClose, onLegend }) {
  return (
    <div className="firstrun" role="dialog" aria-label="how to read Keryx">
      <h2>How to read this</h2>
      <p><b>Shape</b> says what a thing is, <b>colour</b> says how it is doing, <b>position</b> says when it started: Hermes in the middle, the platforms it talks on around it, each conversation in its platform's wedge, fresh work near the centre (2D) or on top (3D).</p>
      <div className="fr-row">
        {['hub', 'source', 'session', 'subagent', 'tool', 'model', 'cron'].map(k => <span key={k}><Shape type={k} color={k === 'hub' ? 'var(--text)' : TYPE[k].color} />{k}</span>)}
      </div>
      <div className="fr-row">
        {Object.entries(STATUS).map(([k, v]) => <span key={k}><Shape type="session" color={v.color} />{v.label}</span>)}
      </div>
      <p>Everything comes from the Hermes data directory, read-only: its database, cron store, logs and state files. Keryx never writes to Hermes and never calls a model.</p>
      <p>Click a node or a card for its details and trace. The <b>Overview</b> tab lists what needs a look; the <b>Sessions</b> tab searches conversations (<kbd>⌘K</kbd>).</p>
      <div className="row">
        <button className="on" onClick={onClose} autoFocus>got it</button>
        <button onClick={() => { onLegend(); onClose() }}>show the full legend</button>
      </div>
    </div>
  )
}
