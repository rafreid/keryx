import { useEffect, useRef, useState } from 'react'
import { playSound } from './sounds.js'

/**
 * Turns consecutive live bundles into events worth telling the user about
 * (the "turn completed / waiting for user" notifications AionUi sends from its sidebar):
 *   - a session finished its turn and now waits for you
 *   - a session failed or was orphaned by a restart
 *   - a top-level session started
 *   - a delegation finished or failed
 *   - a cron job failed or missed its trigger
 *   - the error log turned red
 * Always shows in-app toasts; sends desktop notifications too when `desktop` is on and permission was granted,
 * and plays a short synthesised sound per event when `sound` is on (the worst level in the batch).
 */
export function useNotifications(data, desktop, sound = false) {
  const prev = useRef(null)
  const [toasts, setToasts] = useState([])
  useEffect(() => {
    if (!data?.graph) return
    const cur = snapshot(data)
    const was = prev.current
    prev.current = cur
    if (!was) return                                    // first load: nothing to compare against
    const events = diffEvents(was, cur)
    if (!events.length) return
    const stamped = events.map((e, i) => ({ ...e, id: `${Date.now()}-${i}` }))
    setToasts(t => [...t, ...stamped].slice(-6))
    if (desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const e of stamped) {
        try { new Notification(`Keryx · ${e.title}`, { body: e.body || '', tag: e.id, silent: e.level === 'info' || sound }) } catch {}
      }
    }
    if (sound) playSound(worstLevel(stamped.map(e => e.level)))
  }, [data, desktop, sound])
  useEffect(() => {                                     // toasts fade after 9 s
    if (!toasts.length) return
    const t = setTimeout(() => setToasts(ts => ts.slice(1)), 9000)
    return () => clearTimeout(t)
  }, [toasts])
  const dismiss = id => setToasts(ts => ts.filter(t => t.id !== id))
  return { toasts, dismiss }
}

const LEVEL_RANK = { err: 3, warn: 2, ok: 1, info: 0 }
/** The level that should sound when several events arrive together. */
export const worstLevel = levels => levels.reduce((w, l) => ((LEVEL_RANK[l] ?? 0) > (LEVEL_RANK[w] ?? 0) ? l : w), 'info')

/** Events worth telling the user about, from two consecutive snapshots. Pure: unit-tested. */
export function diffEvents(was, cur) {
  const events = []
  for (const [id, s] of Object.entries(cur.sessions)) {
    const old = was.sessions[id]
    if (!old) {
      if (s.status === 'running' && !s.sub) events.push({ level: 'info', title: 'Session started', body: s.label, node: id })
      continue
    }
    if (old.status === s.status) continue
    if (s.status === 'waiting') events.push({ level: 'ok', title: s.sub ? 'Subagent replied' : 'Hermes replied — waiting for you', body: s.label, node: id })
    else if (s.status === 'failed') events.push({ level: 'err', title: 'Session ended with tool errors', body: s.label, node: id })
    else if (s.status === 'orphaned') events.push({ level: 'err', title: 'Session orphaned by a restart', body: s.label, node: id })
    else if (s.status === 'stale' && old.status === 'running') events.push({ level: 'warn', title: 'Session went quiet', body: s.label, node: id })
    else if (s.status === 'ended' && !s.sub) events.push({ level: 'info', title: 'Session ended', body: s.label, node: id })
  }
  for (const [id, d] of Object.entries(cur.delegations)) {
    const old = was.delegations[id]
    if (old && old.state !== d.state) {
      if (d.state === 'completed') events.push({ level: 'ok', title: 'Delegation completed', body: d.goal, node: d.parent && `session:${d.parent}` })
      else if (/fail|error/.test(d.state)) events.push({ level: 'err', title: 'Delegation failed', body: d.goal, node: d.parent && `session:${d.parent}` })
    }
  }
  for (const [id, j] of Object.entries(cur.jobs)) {
    const old = was.jobs[id]
    if (old && old.state !== j.state && (j.state === 'error' || j.state === 'missed'))
      events.push({ level: 'err', title: j.state === 'missed' ? 'Cron job missed its trigger' : 'Cron job failed', body: j.name, node: `cron:${id}` })
  }
  if (cur.errors === 'red' && was.errors !== 'red') events.push({ level: 'err', title: 'Errors piling up', body: cur.errorsDetail })
  return events
}

export function snapshot(data) {
  const sessions = {}
  for (const n of data.graph?.nodes || []) if (n.type === 'session' || n.type === 'subagent') sessions[n.id] = { status: n.status, label: n.label, sub: n.type === 'subagent' }
  const delegations = {}
  for (const d of data.tasks?.delegations || []) delegations[d.id] = { state: d.state, goal: d.goal, parent: d.parent }
  const jobs = {}
  for (const j of data.tasks?.jobs || []) jobs[j.id] = { state: j.state, name: j.name }
  const errs = (data.status?.checks || []).find(c => c.name === 'errors')
  return { sessions, delegations, jobs, errors: errs?.level, errorsDetail: errs?.detail }
}

export async function requestDesktopPermission() {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  return (await Notification.requestPermission()) === 'granted'
}
