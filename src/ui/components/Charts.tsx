import { useMemo, type ReactNode } from 'react'

export interface Point {
  label: string
  value: number
}

interface TrendProps {
  points: Point[]
  /** Fixed upper bound, e.g. 100 for percentages. Omit to scale to the data. */
  max?: number
  min?: number
  color?: string
  unit?: string
  height?: number
}

/**
 * Small line chart. Hand-rolled SVG rather than a charting library: the shapes
 * needed here are trivial and an offline-first bundle should not carry 100kB
 * of chart engine for two line plots.
 */
export function TrendChart({
  points,
  max,
  min = 0,
  color = 'var(--accent)',
  unit = '',
  height = 140,
}: TrendProps): ReactNode {
  const width = 320
  const padX = 6
  const padY = 10

  const geometry = useMemo(() => {
    if (points.length === 0) return null
    const values = points.map((p) => p.value)
    const hi = max ?? (Math.max(...values) * 1.15 || 1)
    const lo = min
    const span = hi - lo || 1
    // A single day would collapse to a dot in the corner, which reads as a
    // rendering bug. Draw it as a flat line across the full width instead.
    const plotted = points.length === 1 ? [points[0] as Point, points[0] as Point] : points
    const stepX = (width - padX * 2) / (plotted.length - 1)
    const coords = plotted.map((p, i) => ({
      x: padX + i * stepX,
      y: padY + (1 - (p.value - lo) / span) * (height - padY * 2),
      point: p,
    }))
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    const area = `${line.join(' ')} L${(coords[coords.length - 1] as { x: number }).x.toFixed(1)},${height - padY} L${(coords[0] as { x: number }).x.toFixed(1)},${height - padY} Z`
    return { coords, path: line.join(' '), area, hi, lo }
  }, [points, max, min, height])

  if (!geometry) {
    return (
      <p className="faint center" style={{ padding: '24px 0' }}>
        Not enough data yet.
      </p>
    )
  }

  const last = points[points.length - 1] as Point

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
        role="img"
        aria-label={`Trend, latest ${last.value}${unit}`}
      >
        <defs>
          <linearGradient id={`fill-${color.replace(/\W/g, '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geometry.area} fill={`url(#fill-${color.replace(/\W/g, '')})`} />
        <path
          d={geometry.path}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {geometry.coords.map((c, i) => (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={i === geometry.coords.length - 1 ? 4 : 2.5}
            fill={color}
          />
        ))}
      </svg>
      <div className="row-between faint">
        <span>{points[0]?.label}</span>
        <span>
          latest: <strong>{formatValue(last.value)}{unit}</strong>
        </span>
        <span>{last.label}</span>
      </div>
    </div>
  )
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

interface MasteryBarProps {
  label: string
  score: number
  detail: string
  rated: boolean
}

export function MasteryBar({ label, score, detail, rated }: MasteryBarProps): ReactNode {
  // An unrated skill draws no bar at all. Showing a filled bar next to a "—"
  // would read as a score, when the honest statement is "not enough data".
  const clamped = rated ? Math.max(0, Math.min(125, score)) : 0
  const color = !rated
    ? 'var(--ink-faint)'
    : score >= 85
      ? 'var(--good)'
      : score >= 55
        ? 'var(--warn)'
        : 'var(--bad)'
  return (
    <div className="bar-row">
      <div>
        <div className="bar-label">
          <span>{label}</span>
          <span className="muted">{detail}</span>
        </div>
        <div className="bar-track">
          <div
            className="bar-fill"
            style={{ width: `${(clamped / 125) * 100}%`, background: color }}
          />
        </div>
      </div>
      <div className="bar-value" style={{ color }}>
        {rated ? Math.round(score) : '—'}
      </div>
    </div>
  )
}
