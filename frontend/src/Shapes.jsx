import React from 'react'

/** Tiny SVG glyphs matching the graph's shape grammar, for legends and cards. */
export default function Shape({ type, color = '#e6edf7', size = 14 }) {
  const s = size, c = s / 2, r = s * 0.38
  const common = { width: s, height: s, viewBox: `0 0 ${s} ${s}`, style: { verticalAlign: 'middle', marginRight: 6 } }
  switch (type) {
    case 'hub': return <svg {...common}><circle cx={c} cy={c} r={r * 0.75} fill={color} /><circle cx={c} cy={c} r={r * 1.2} fill="none" stroke="var(--accent)" strokeWidth="1" opacity=".7" /></svg>
    case 'source': return <svg {...common}><circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={s * 0.22} /></svg>
    case 'subagent': return <svg {...common}><polygon points={`${c},${c - r * 1.2} ${c + r},${c} ${c},${c + r * 1.2} ${c - r},${c}`} fill={color} /></svg>
    case 'tool': return <svg {...common}><rect x={c - r * 0.85} y={c - r * 0.85} width={r * 1.7} height={r * 1.7} fill={color} /></svg>
    case 'model': return <svg {...common}><rect x={c - r * 1.2} y={c - r * 0.8} width={r * 2.4} height={r * 1.6} rx={r * 0.4} fill={color} /></svg>
    case 'cron': return <svg {...common}><polygon points={`${c},${c + r * 1.1} ${c + r},${c - r * 0.9} ${c - r},${c - r * 0.9}`} fill={color} /></svg>
    default: return <svg {...common}><circle cx={c} cy={c} r={r} fill={color} /></svg>
  }
}
