import { useEffect } from 'react'

/**
 * Camera pose accessor for the navigation history, plus the fly-back on history restore.
 *
 * 3D: position + orbit target. 2D: centre + zoom. A pose is tagged with the view so one from the
 * other projection is ignored rather than misapplied. On back/forward the entry brings its own pose,
 * so the fan-out must not re-frame the selection; `camTarget` tells it to face the pose we fly to.
 */
export function useCameraPose({ fgRef, camRef, view, restore, selected, framedFor, camTarget }) {
  useEffect(() => {
    if (!camRef) return
    camRef.current = {
      get: () => {
        const fg = fgRef.current
        if (!fg) return null
        if (view === '3d') {
          const p = fg.camera()?.position, t = fg.controls()?.target
          return p ? { view, x: p.x, y: p.y, z: p.z, tx: t?.x || 0, ty: t?.y || 0, tz: t?.z || 0 } : null
        }
        const c = fg.centerAt(); return c ? { view, x: c.x, y: c.y, k: fg.zoom() } : null
      },
      set: (pose, ms = 700) => {
        const fg = fgRef.current
        if (!fg || !pose || pose.view !== view) return
        if (view === '3d') fg.cameraPosition({ x: pose.x, y: pose.y, z: pose.z }, { x: pose.tx, y: pose.ty, z: pose.tz }, ms)
        else { fg.centerAt(pose.x, pose.y, ms); fg.zoom(pose.k, ms) }
      },
    }
  }, [view, camRef, fgRef])

  useEffect(() => {
    if (!restore) return
    if (selected) framedFor.current.add(selected)
    if (restore.pose && restore.pose.view === view) {
      camTarget.current = restore.pose
      camRef?.current?.set(restore.pose, 700)
      const t = setTimeout(() => { camTarget.current = null }, 750)
      return () => clearTimeout(t)
    }
  }, [restore])  // eslint-disable-line react-hooks/exhaustive-deps
}
