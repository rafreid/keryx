import { dur, fmtTime } from './util.js'

/** The stream is called stalled after this long without an 'update' or a 'ping' (the backend pings every 15 s). */
export const STALL_AFTER = 30000

/**
 * One honest line about the connection, for the strip under the header. Pure, so it is unit-tested.
 *
 *   conn      'connecting' | 'live' | 'stalled' | 'polling' | 'offline' | 'auth'   (from useLive)
 *   live      false while the user paused updates
 *   seenAt    ms: last time anything arrived from the backend (data or ping)
 *   dataAt    ms: last time the data itself changed (the graph's generated_at)
 *   downSince ms: when the backend stopped answering, or null
 *   now       ms
 *
 * Returns {level: 'green'|'amber'|'red'|'muted', text, detail}.
 */
export function connInfo({ conn, live = true, seenAt = 0, dataAt = 0, downSince = null, now = Date.now() }) {
  const since = t => (t ? dur(Math.max(0, (now - t) / 1000)) + ' ago' : null)
  const from = t => (t ? fmtTime(t / 1000) : null)
  if (!live) return { level: 'muted', text: 'live updates paused', detail: dataAt ? `showing data from ${from(dataAt)}` : '' }
  switch (conn) {
    case 'live':
      return { level: 'green', text: 'live', detail: `checked ${since(seenAt) || 'just now'}${dataAt ? ` · last change ${since(dataAt)}` : ''}` }
    case 'stalled':
    case 'polling':
      return { level: 'amber', text: 'reconnecting…', detail: dataAt ? `showing data from ${from(dataAt)}` : 'nothing loaded yet' }
    case 'offline':
      return { level: 'red', text: `backend unreachable${downSince ? ` since ${from(downSince)}` : ''}`,
               detail: dataAt ? 'showing the last snapshot' : 'nothing loaded yet' }
    case 'auth':
      return { level: 'amber', text: 'locked', detail: 'a token is needed' }
    default:
      return { level: 'amber', text: 'connecting…', detail: '' }
  }
}
