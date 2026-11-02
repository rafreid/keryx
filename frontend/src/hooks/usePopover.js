import { useEffect, useRef, useState } from 'react'

/**
 * Open state for a popover or sheet that closes the way people expect: on Escape, on a click
 * outside, and when keyboard focus leaves it. Escape hands focus back to the first button inside
 * the wrapper (the trigger). Put `ref` on an element that wraps both the trigger and the popover.
 */
export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const outside = e => ref.current && !ref.current.contains(e.target)
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); ref.current?.querySelector('button')?.focus() } }
    const onDown = e => { if (outside(e)) setOpen(false) }
    const onFocus = e => { if (outside(e)) setOpen(false) }
    document.addEventListener('keydown', onKey, true)       // capture: beats the app-wide Escape that clears the selection
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])
  return [open, setOpen, ref]
}
