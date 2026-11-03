import React from 'react'

/**
 * Tiny SVG glyphs matching the graph's shape grammar, for legends and cards. Colours go through `style`
 * so a CSS var() works (presentation attributes cannot resolve one). `halo` adds the "active" ring.
 */
export default function Shape({ type, color = 'var(--text)', size = 14, halo = false }) {
  const s = size, c = s / 2, r = s * 0.38
  const common = { width: s, height: s, viewBox: `0 0 ${s} ${s}`, style: { verticalAlign: 'middle', marginRight: 6, overflow: 'visible' } }
  const fill = { style: { fill: color } }
  const ring = halo ? <circle cx={c} cy={c} r={r * 1.55} style={{ fill: 'none', stroke: 'var(--active)', strokeWidth: 1.2 }} /> : null
  switch (type) {
    case 'hub': return <svg {...common}>{ring}<circle cx={c} cy={c} r={r * 0.75} {...fill} /><circle cx={c} cy={c} r={r * 1.2} style={{ fill: 'none', stroke: 'var(--text)', strokeWidth: 1, opacity: .6 }} /></svg>
    case 'source': return <svg {...common}>{ring}<circle cx={c} cy={c} r={r} style={{ fill: 'none', stroke: color, strokeWidth: s * 0.22 }} /></svg>
    case 'subagent': return <svg {...common}>{ring}<polygon points={`${c},${c - r * 1.2} ${c + r},${c} ${c},${c + r * 1.2} ${c - r},${c}`} {...fill} /></svg>
    case 'tool': return <svg {...common}>{ring}<rect x={c - r * 0.85} y={c - r * 0.85} width={r * 1.7} height={r * 1.7} {...fill} /></svg>
    case 'model': return <svg {...common}>{ring}<rect x={c - r * 1.2} y={c - r * 0.8} width={r * 2.4} height={r * 1.6} rx={r * 0.4} {...fill} /></svg>
    case 'cron': return <svg {...common}>{ring}<polygon points={`${c},${c + r * 1.1} ${c + r},${c - r * 0.9} ${c - r},${c - r * 0.9}`} {...fill} /></svg>
    default: return <svg {...common}>{ring}<circle cx={c} cy={c} r={r} {...fill} /></svg>
  }
}
