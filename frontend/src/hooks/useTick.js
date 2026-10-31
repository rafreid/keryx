import { createContext, useContext, useEffect, useRef, useState } from 'react'

/**
 * One clock for every side-panel fetch. The live bundle already arrives over SSE whenever Hermes'
 * data changes, so the components that used to poll on their own timers now refetch when that
 * bundle changes (the `tick`), with a slow fallback so a stalled stream still catches up.
 */
export const TickContext = createContext(0)
export const useTick = () => useContext(TickContext)

/** Run `load` now, whenever `deps` or the live tick change, and at most every `fallbackMs` otherwise. */
export function useRefetch(load, deps, fallbackMs = 60000) {
  const tick = useTick()
  const fn = useRef(load); fn.current = load
  useEffect(() => {
    let dead = false
    const run = () => fn.current(() => dead)
    run()
    const t = fallbackMs ? setInterval(run, fallbackMs) : null
    return () => { dead = true; if (t) clearInterval(t) }
  }, [...deps, tick])   // eslint-disable-line react-hooks/exhaustive-deps
}

/** A value that re-renders every `ms`, for "updated 12 s ago" style labels. */
export function useClock(ms = 5000) {
  const [, setN] = useState(0)
  useEffect(() => { const t = setInterval(() => setN(n => n + 1), ms); return () => clearInterval(t) }, [ms])
  return Date.now() / 1000
}
