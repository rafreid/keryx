import { useCallback, useEffect, useRef } from 'react'
import SpriteText from 'three-spritetext'
import * as THREE from 'three'
import { LAYOUT, timeTicks, recencyY, recencyR } from '../layout.js'
import { palette, withAlpha } from '../util.js'

/**
 * The session-start time axis.
 * 3D: faint horizontal rings at nice intervals around the session ring, a spine with tick labels on
 * the left, and a translucent band between the two selected rings. Rebuilt when the window, band,
 * spacing or view changes. 2D: concentric rings drawn under the graph by `paintRings`.
 */
export function useTimeAxis3d(fgRef, view, windowSec, band, spread, theme) {
  const axisRef = useRef(null)
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || view !== '3d') return
    const t = setTimeout(() => {
      const scene = fg.scene?.()
      if (!scene) return
      if (axisRef.current) scene.remove(axisRef.current)
      const g = new THREE.Group()
      const R = LAYOUT.sessionRadius + 22
      const axisX = -(LAYOUT.sessionRadius + 48)
      const ticks = timeTicks(windowSec)
      const pal = palette()
      const lineMat = new THREE.LineBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.16 })
      const axisMat = new THREE.LineBasicMaterial({ color: pal.muted, transparent: true, opacity: 0.5 })
      // vertical spine
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(axisX, recencyY(0), 0), new THREE.Vector3(axisX, recencyY(1), 0)]), axisMat))
      const hiMat = new THREE.LineBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.7 })
      for (const tk of ticks) {
        const y = recencyY(tk.frac)
        const pts = []
        for (let i = 0; i <= 72; i++) { const a = (2 * Math.PI * i) / 72; pts.push(new THREE.Vector3(Math.cos(a) * R, y, Math.sin(a) * R)) }
        const edge = band && (Math.abs(tk.frac - band.from) < 1e-6 || Math.abs(tk.frac - band.to) < 1e-6)
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), edge ? hiMat : lineMat))
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(axisX - 4, y, 0), new THREE.Vector3(axisX + 4, y, 0)]), axisMat))
        const label = new SpriteText(tk.label, 4.6, tk.frac === 0 ? pal.text : pal.muted)
        label.position.set(axisX - 12, y, 0)
        g.add(label)
      }
      const title = new SpriteText('session start ↓', 4.2, pal.accent)
      title.position.set(axisX, recencyY(0) + 10, 0)
      g.add(title)
      if (band) {   // translucent band between the two selected rings
        const y0 = recencyY(band.from), y1 = recencyY(Math.min(1, band.to))
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, Math.abs(y0 - y1), 72, 1, true),
          new THREE.MeshBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }))
        cyl.position.y = (y0 + y1) / 2
        g.add(cyl)
      }
      scene.add(g)
      axisRef.current = g
    }, 80)
    return () => clearTimeout(t)
  }, [view, windowSec, band, spread, fgRef, theme])
}

/** 2D: concentric start-time rings, recent sessions inside, drawn under the graph. */
export function useRings2d(view, windowSec, band, theme) {
  return useCallback((ctx, scale) => {
    if (view !== '2d') return
    const pal = palette()
    if (band) {
      const r0 = recencyR(band.from), r1 = recencyR(Math.min(1, band.to))
      ctx.beginPath(); ctx.arc(0, 0, r1, 0, 2 * Math.PI); ctx.arc(0, 0, r0, 0, 2 * Math.PI, true)
      ctx.fillStyle = withAlpha(pal.accent, 0.07); ctx.fill()
    }
    for (const tk of timeTicks(windowSec)) {
      const r = recencyR(tk.frac)
      ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI)
      ctx.lineWidth = 0.8 / scale; ctx.strokeStyle = withAlpha(pal.accent, 0.16); ctx.stroke()
      ctx.font = `${Math.max(3, 9 / scale)}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      ctx.fillStyle = withAlpha(tk.frac === 0 ? pal.text : pal.muted, 0.85)
      ctx.fillText(tk.frac === 0 ? 'started now' : `started ${tk.label}`, r * 0.707 + 2 / scale, -r * 0.707 - 2 / scale)
    }
  }, [view, windowSec, band, theme])
}
