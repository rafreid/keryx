import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Navigation history for the graph.
 *
 * Every selection (from the graph, a now-card, a side-panel link or a toast) becomes a browser
 * history entry that remembers three things: what was selected, which side-panel tab was open,
 * and where the camera was just before the move. Going back restores all three, so the picture
 * returns to exactly where you were looking. Because it rides on the browser's own history,
 * Alt+← / ⌘[ / trackpad swipe already work, and the URL hash (#session:abc) makes any selection
 * a link you can share or scan from the QR popover.
 *
 * Camera poses are stamped lazily: when you *leave* an entry, its pose is recorded. That is the
 * only moment the pose is known to be "what the user was looking at" for that entry.
 */
export function useNavHistory({ tab, setTab, camRef, labelOf }) {
  const [selected, setSelected] = useState(() => readHash())
  const entries = useRef([])              // [{seq, id, label, tab, cam}]
  const idxRef = useRef(0)
  const seq = useRef(0)
  const [trail, setTrail] = useState([])  // render copy of entries
  const [idx, setIdx] = useState(0)
  const [restore, setRestore] = useState(null)   // {pose, n}: tells GraphView to fly back
  const tabRef = useRef(tab); tabRef.current = tab
  const labelRef = useRef(labelOf); labelRef.current = labelOf

  const publish = () => { setTrail([...entries.current]); setIdx(idxRef.current) }
  const stamp = () => {                   // record the camera pose for the entry we are leaving
    const cur = entries.current[idxRef.current]
    if (cur) { const pose = camRef.current?.get?.(); if (pose) cur.cam = pose }
  }
  const nameOf = id => (id ? labelRef.current(id) : tabRef.current)

  // first entry: whatever the URL hash says (deep link) or nothing selected
  useEffect(() => {
    const id = readHash()
    entries.current = [{ seq: 0, id, label: nameOf(id), tab: tabRef.current, cam: null }]
    history.replaceState({ keryx: 0 }, '', urlFor(id))
    publish()
    const onPop = e => {
      const s = e.state?.keryx
      const i = entries.current.findIndex(en => en.seq === s)
      if (i < 0) {                        // a hash change we did not make (typed by hand, or a link to this page): adopt it as a new stop
        const hid = readHash()
        stamp()
        const en = { seq: ++seq.current, id: hid, label: nameOf(hid), tab: tabRef.current, cam: null }
        entries.current = entries.current.slice(0, idxRef.current + 1).concat(en)
        idxRef.current = entries.current.length - 1
        history.replaceState({ keryx: en.seq }, '', urlFor(hid))
        setSelected(hid); publish(); return
      }
      stamp()
      idxRef.current = i
      const en = entries.current[i]
      setSelected(en.id); setTab(en.tab)
      setRestore({ pose: en.cam, n: ++seq.current })
      publish()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // labels can arrive after the entry (graph still loading, or a deep link): refresh them
  useEffect(() => {
    let changed = false
    for (const en of entries.current) { const l = nameOf(en.id); if (l !== en.label) { en.label = l; changed = true } }
    if (changed) publish()
  })

  /** Select something (or null to close the panel). Pushes a history entry unless it is a no-op. */
  const navigate = useCallback((id, opts = {}) => {
    const cur = entries.current[idxRef.current]
    if (cur && cur.id === id && !opts.tab) return
    stamp()
    if (opts.tab) setTab(opts.tab)
    const en = { seq: ++seq.current, id, label: id ? labelRef.current(id) : (opts.tab || tabRef.current), tab: opts.tab || tabRef.current, cam: null }
    entries.current = entries.current.slice(0, idxRef.current + 1).concat(en)
    idxRef.current = entries.current.length - 1
    history.pushState({ keryx: en.seq }, '', urlFor(id))
    setSelected(id)
    publish()
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // guarded so a keyboard shortcut can never walk off the end of our stack (and out of the page)
  const go = useCallback(delta => {
    const to = idxRef.current + delta
    if (delta && to >= 0 && to < entries.current.length) history.go(delta)
  }, [])
  const back = useCallback(() => go(-1), [go])
  const forward = useCallback(() => go(1), [go])
  return { selected, navigate, back, forward, go, trail, idx, restore }
}

const readHash = () => { const h = location.hash.slice(1); return h ? decodeURIComponent(h) : null }
const urlFor = id => location.pathname + location.search + (id ? '#' + encodeURIComponent(id) : '')
