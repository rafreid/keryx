import { useEffect, useRef, useState } from 'react'

/** Live bundle {graph, now, status, cost} via SSE, with polling fallback. */
export function useLive(hours, enabled) {
  const [data, setData] = useState(null)
  const [conn, setConn] = useState('connecting')
  useEffect(() => {
    if (!enabled) return
    let es, poll, closed = false
    const start = () => {
      es = new EventSource(`/api/stream?hours=${hours}`)
      es.addEventListener('update', e => { setData(JSON.parse(e.data)); setConn('live') })
      es.onopen = () => setConn('live')
      es.onerror = () => {
        setConn('polling'); es.close()
        if (!closed && !poll) {
          const tick = () => fetchBundle(hours).then(d => { setData(d); setConn('polling') })
            .catch(e => setConn(e instanceof AuthError ? 'auth' : 'offline'))
          tick(); poll = setInterval(tick, 10000)
          setTimeout(() => { if (!closed) { clearInterval(poll); poll = null; start() } }, 60000) // retry SSE
        }
      }
    }
    start()
    return () => { closed = true; es && es.close(); poll && clearInterval(poll) }
  }, [hours, enabled])
  return { data, conn }
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
