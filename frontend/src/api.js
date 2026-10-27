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
          const tick = () => fetchBundle(hours).then(d => { setData(d); setConn('polling') }).catch(() => setConn('offline'))
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

export async function fetchBundle(hours) {
  const [graph, now, status, cost] = await Promise.all(
    [`/api/graph?hours=${hours}`, '/api/now', '/api/status', `/api/cost?hours=${hours}`].map(u => fetch(u).then(r => r.json())))
  return { graph, now, status, cost }
}

export const fetchGraphAt = (hours, at) => fetch(`/api/graph?hours=${hours}&at=${at}`).then(r => r.json())

/** Debounced value. */
export function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  const t = useRef()
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(() => setV(value), ms); return () => clearTimeout(t.current) }, [value, ms])
  return v
}
