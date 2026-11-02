import React from 'react'
import { connInfo } from './conn.js'
import { useClock } from './hooks/useTick.js'

/**
 * The one place that says whether the picture is current: a thin strip under the header with
 * three states (live / reconnecting / unreachable) plus "paused". Always present on a desktop so
 * the eye learns where to look; on a phone only the non-green states take the room.
 */
export default function ConnStrip({ conn, live, seenAt, dataAt, downSince }) {
  const now = useClock(1000) * 1000
  const i = connInfo({ conn, live, seenAt, dataAt, downSince, now })
  return (
    <div className={`connstrip ${i.level}`} role="status" aria-live="polite">
      <span className={`dot ${i.level}`} aria-hidden="true" />
      <b>{i.text}</b>
      {i.detail && <span className="detail">· {i.detail}</span>}
    </div>
  )
}
