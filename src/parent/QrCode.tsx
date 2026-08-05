import { useMemo, type ReactNode } from 'react'
import qrcode from 'qrcode-generator'

interface Props {
  value: string
  /** Rendered size in CSS pixels. */
  size?: number
  /** Quiet-zone width in modules. The spec requires at least 4. */
  margin?: number
}

/**
 * Renders a QR code as inline SVG.
 *
 * SVG rather than canvas so it stays crisp at any size and on any pixel
 * density - it has to survive being photographed off a screen by a phone.
 */
export function QrCode({ value, size = 208, margin = 4 }: Props): ReactNode {
  const path = useMemo(() => {
    // Type 0 auto-sizes; 'M' tolerates ~15% damage, plenty for a screen scan.
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()
    const count = qr.getModuleCount()
    const parts: string[] = []
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) parts.push(`M${col + margin},${row + margin}h1v1h-1z`)
      }
    }
    return { d: parts.join(''), extent: count + margin * 2 }
  }, [value, margin])

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${path.extent} ${path.extent}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for authenticator setup"
      style={{ display: 'block', borderRadius: 10 }}
    >
      <rect width={path.extent} height={path.extent} fill="#fff" />
      <path d={path.d} fill="#16233b" />
    </svg>
  )
}
