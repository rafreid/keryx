import React from 'react'
import { connInfo } from './conn.js'
import { useClock } from './hooks/useTick.js'
import { tz } from './util.js'

/**
 * The one place that says whether the picture is current: a thin strip under the header with
 * three states (live / reconnecting / unreachable) plus "paused". Always present on a desktop so
 * the eye learns where to look; on a phone only the non-green states take the room. Only the state
 * word is a live region: the "checked Ns ago" counter would otherwise be read out every second.
 */
export default function ConnStrip({ conn, live, seenAt, dataAt, downSince }) {
  const now = useClock(1000) * 1000
  const i = connInfo({ conn, live, seenAt, dataAt, downSince, now })
  return (
    <div className={`connstrip ${i.level}`}>
      <span className={`dot ${i.level}`} aria-hidden="true" />
      <span role="status" aria-live="polite"><b>{i.text}</b></span>
      {i.detail && <span className="detail">· {i.detail}</span>}
      <span className="tz" title="times are shown in this browser's zone; analytics days are counted in UTC">{tz()}</span>
    </div>
  )
}
