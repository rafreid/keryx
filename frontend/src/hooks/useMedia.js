import { useEffect, useState } from 'react'

/** True while the media query matches (re-evaluated on resize / rotation). */
export function useMedia(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [on, setOn] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const h = e => setOn(e.matches)
    mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h)
    setOn(mq.matches)
    return () => (mq.removeEventListener ? mq.removeEventListener('change', h) : mq.removeListener(h))
  }, [query])
  return on
}

/** The phone breakpoint shared by App and the stylesheet. */
export const NARROW = '(max-width: 800px)'
