import { useEffect, useRef, useState } from 'react'
import { STALL_AFTER } from './conn.js'

/**
 * Live bundle {graph, now, status, cost, tasks} via SSE, with polling fallback.
 *
 * `conn` is one of: connecting, live, stalled (the stream went quiet), polling (SSE failed, fetching
 * every 10 s), offline (the fetches fail too), auth (401: a token is needed). `seenAt` is the last
 * moment anything arrived from the backend, data or ping; `downSince` is when it stopped answering.
 * A watchdog, not only the socket's own error event, drives the degraded states: a dead host or a
 * stopped container often leaves the socket looking open.
 */
export function useLive(hours, enabled) {
  const [data, setData] = useState(null)
  const [conn, setConn] = useState('connecting')
  const [seenAt, setSeenAt] = useState(0)
  const [downSince, setDownSince] = useState(null)
  const seen = useRef(0)
  useEffect(() => {
    if (!enabled) return
    let es = null, poll = null, retry = null, closed = false
    const touch = () => { seen.current = Date.now(); setSeenAt(seen.current); setDownSince(null) }
    const degrade = why => {                  // the stream failed or went quiet: poll until it comes back
      setConn(why)
      if (es) { es.close(); es = null }
      if (closed || poll) return
      const tick = () => fetchBundle(hours)
        .then(d => { if (closed) return; setData(d); setConn('polling'); touch() })
        .catch(e => {
          if (closed) return
          if (e instanceof AuthError) { setConn('auth'); clearInterval(poll); clearTimeout(retry); return }   // the token form reloads the page
          setConn('offline'); setDownSince(s => s || Date.now())
        })
      tick(); poll = setInterval(tick, 10000)
      retry = setTimeout(() => { if (!closed) { clearInterval(poll); poll = null; start() } }, 60000)   // retry SSE
    }
    const start = () => {
      es = new EventSource(`/api/stream?hours=${hours}`)
      es.addEventListener('update', e => { setData(JSON.parse(e.data)); setConn('live'); touch() })
      es.addEventListener('ping', touch)
      es.onopen = () => { setConn('live'); touch() }
      es.onerror = () => degrade('polling')
    }
    seen.current = Date.now()
    start()
    const watchdog = setInterval(() => { if (es && Date.now() - seen.current > STALL_AFTER) degrade('stalled') }, 5000)
    return () => { closed = true; es && es.close(); poll && clearInterval(poll); retry && clearTimeout(retry); clearInterval(watchdog) }
  }, [hours, enabled])
  return { data, conn, seenAt, downSince }
}

export class AuthError extends Error {}

/** fetch + JSON; a 401 (KERYX_TOKEN is set and the browser has no cookie yet) becomes an AuthError. */
export async function getJSON(url, opts) {
  const r = await fetch(url, opts)
  if (r.status === 401) throw new AuthError('token required')
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
  return r.json()
}

export async function fetchBundle(hours) {
  const [graph, now, status, cost, tasks] = await Promise.all(
    [`/api/graph?hours=${hours}`, '/api/now', '/api/status', `/api/cost?hours=${hours}`, '/api/tasks'].map(u => getJSON(u)))
  return { graph, now, status, cost, tasks }
}

export const fetchGraphAt = (hours, at) => getJSON(`/api/graph?hours=${hours}&at=${at}`)

/** Try a token against the backend; on success the server sets the keryx_token cookie and we reload. */
export async function submitToken(token) {
  const r = await fetch(`/api/now?token=${encodeURIComponent(token.trim())}`)
  if (r.status === 401) return false
  location.reload()
  return true
}

/** Debounced value. */
export function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  const t = useRef()
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(() => setV(value), ms); return () => clearTimeout(t.current) }, [value, ms])
  return v
}
