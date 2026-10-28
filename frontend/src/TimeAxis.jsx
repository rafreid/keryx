import React from 'react'
import { timeTicks } from './layout.js'

/**
 * Clickable time axis. Each label selects the band between that tick and the next
 * (e.g. "−1d" = sessions started between 1 and 2 days ago; "now" = the most recent step).
 * Clicking the selected label again clears the filter.
 */
export default function TimeAxis({ windowSec, band, setBand }) {
  const ticks = timeTicks(windowSec)
  const bands = ticks.map((t, i) => ({ from: t.frac, to: ticks[i + 1]?.frac ?? 1, label: t.label, next: ticks[i + 1]?.label }))
  const isSel = b => band && band.from === b.from && band.to === b.to
  return (
    <div className="timeaxis" title="click a label to show only sessions that started in that span">
      <div className="ta-title">started</div>
      {bands.map((b, i) => (
        <button key={i} className={`ta-tick ${isSel(b) ? 'on' : ''}`} onClick={() => setBand(isSel(b) ? null : b)}
                title={b.next ? `started between ${b.label} and ${b.next}` : `started before ${b.label}`}>
          <span className="ta-mark" />{b.label}
        </button>
      ))}
      {band && <button className="ta-clear" onClick={() => setBand(null)}>show all</button>}
    </div>
  )
}
