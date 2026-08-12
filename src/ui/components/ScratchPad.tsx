import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

interface Point {
  x: number
  y: number
}

type Stroke = Point[]
type Tool = 'pen' | 'eraser'

const INK = '#16233b'
const LINE_WIDTH = 2.4
/** Generous, because erasing with a fingertip needs to feel forgiving. */
const ERASER_RADIUS = 18

interface Props {
  /** Strokes reset when this changes, so each problem starts on clean paper. */
  resetKey: string
  expanded: boolean
  onToggle(): void
  /**
   * Filled with a function that renders the current working out as a PNG, so a
   * wrong answer can be reviewed alongside how it was worked out.
   */
  captureRef?: { current: (() => string | null) | null }
}

/**
 * Somewhere to work a problem out, folded away until it is wanted.
 *
 * It sits between the answer box and the keypad rather than replacing them:
 * there is one screen, and opening the pad never takes the keypad away.
 *
 * Strokes are kept as point lists rather than being flattened into the canvas,
 * so erasing is a real operation and a resize redraws at the new size instead
 * of stretching a bitmap. Nothing is persisted - this is paper.
 */
export function ScratchPad({ resetKey, expanded, onToggle, captureRef }: Props): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const currentRef = useRef<Stroke | null>(null)
  const activePointerRef = useRef<number | null>(null)
  /**
   * Once a stylus is seen, touch is ignored for the rest of the problem. On a
   * tablet the palm lands before the pen does, and without this every digit
   * gets a smear through it.
   */
  const penSeenRef = useRef(false)
  const [isEmpty, setIsEmpty] = useState(true)
  const [tool, setTool] = useState<Tool>('pen')
  const toolRef = useRef<Tool>('pen')
  toolRef.current = tool

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const ratio = window.devicePixelRatio || 1
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio)
    ctx.strokeStyle = INK
    ctx.fillStyle = INK
    ctx.lineWidth = LINE_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue
      const first = stroke[0] as Point
      if (stroke.length === 1) {
        ctx.beginPath()
        ctx.arc(first.x, first.y, LINE_WIDTH / 2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      // Curve through midpoints so the line is smooth rather than faceted.
      for (let i = 1; i < stroke.length - 1; i++) {
        const a = stroke[i] as Point
        const b = stroke[i + 1] as Point
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
      const last = stroke[stroke.length - 1] as Point
      ctx.lineTo(last.x, last.y)
      ctx.stroke()
    }
  }, [])

  const resize = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(rect.width * ratio))
    canvas.height = Math.max(1, Math.round(rect.height * ratio))
    redraw()
  }, [redraw])

  useEffect(() => {
    resize()
    const observer = new ResizeObserver(resize)
    if (canvasRef.current) observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [resize])

  // ResizeObserver does not reliably fire when an element is revealed, so
  // expanding has to trigger the redraw itself or the pad comes back blank.
  useEffect(() => {
    if (expanded) resize()
  }, [expanded, resize])

  useEffect(() => {
    strokesRef.current = []
    currentRef.current = null
    penSeenRef.current = false
    setIsEmpty(true)
    setTool('pen')
    redraw()
  }, [resetKey, redraw])

  const positionOf = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  /** Removes whole strokes the eraser passes over. */
  const eraseAt = (point: Point): void => {
    const before = strokesRef.current.length
    strokesRef.current = strokesRef.current.filter(
      (stroke) => !stroke.some((p) => Math.hypot(p.x - point.x, p.y - point.y) <= ERASER_RADIUS),
    )
    if (strokesRef.current.length !== before) {
      setIsEmpty(strokesRef.current.length === 0)
      redraw()
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.pointerType === 'pen') penSeenRef.current = true
    else if (penSeenRef.current && event.pointerType === 'touch') return
    if (activePointerRef.current !== null) return
    activePointerRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)

    if (toolRef.current === 'eraser') {
      currentRef.current = null
      eraseAt(positionOf(event))
      return
    }
    currentRef.current = [positionOf(event)]
    strokesRef.current.push(currentRef.current)
    setIsEmpty(false)
    redraw()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (activePointerRef.current !== event.pointerId) return
    if (toolRef.current === 'eraser') {
      eraseAt(positionOf(event))
      return
    }
    if (!currentRef.current) return
    currentRef.current.push(positionOf(event))
    redraw()
  }

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (activePointerRef.current !== event.pointerId) return
    activePointerRef.current = null
    currentRef.current = null
  }

  const clear = (): void => {
    strokesRef.current = []
    setIsEmpty(true)
    redraw()
  }

  /**
   * Renders the working out, cropped to what was actually written and scaled
   * down. A full-canvas screenshot would be mostly blank and several times the
   * size for no extra information.
   */
  const capture = useCallback((): string | null => {
    const strokes = strokesRef.current.filter((s) => s.length > 0)
    if (strokes.length === 0) return null

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const stroke of strokes) {
      for (const pt of stroke) {
        minX = Math.min(minX, pt.x)
        minY = Math.min(minY, pt.y)
        maxX = Math.max(maxX, pt.x)
        maxY = Math.max(maxY, pt.y)
      }
    }
    const pad = 12
    const width = Math.max(1, maxX - minX + pad * 2)
    const height = Math.max(1, maxY - minY + pad * 2)
    const scale = Math.min(1, 640 / width)

    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(width * scale))
    out.height = Math.max(1, Math.round(height * scale))
    const ctx = out.getContext('2d')
    if (!ctx) return null

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.scale(scale, scale)
    ctx.translate(pad - minX, pad - minY)
    ctx.strokeStyle = INK
    ctx.fillStyle = INK
    ctx.lineWidth = LINE_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const stroke of strokes) {
      const first = stroke[0] as Point
      if (stroke.length === 1) {
        ctx.beginPath()
        ctx.arc(first.x, first.y, LINE_WIDTH / 2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      ctx.beginPath()
      ctx.moveTo(first.x, first.y)
      for (let i = 1; i < stroke.length - 1; i++) {
        const a = stroke[i] as Point
        const b = stroke[i + 1] as Point
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2)
      }
      const last = stroke[stroke.length - 1] as Point
      ctx.lineTo(last.x, last.y)
      ctx.stroke()
    }
    return out.toDataURL('image/png')
  }, [])

  if (captureRef) captureRef.current = capture

  return (
    <div className={`scratch${expanded ? ' expanded' : ''}`}>
      <button type="button" className="btn btn-ghost scratch-toggle" onClick={onToggle}>
        {expanded ? '▾' : '▸'} scratch pad
      </button>

      {/* Kept mounted when folded so the working out is still there on return. */}
      <div className={expanded ? 'scratch-body' : 'scratch-body hidden'}>
        <canvas
          ref={canvasRef}
          className="scratch-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
        />
        <div className="scratch-tools">
          <button
            type="button"
            className={`btn${tool === 'pen' ? ' tool-active' : ''}`}
            onClick={() => setTool('pen')}
            aria-pressed={tool === 'pen'}
          >
            ✏️ write
          </button>
          <button
            type="button"
            className={`btn${tool === 'eraser' ? ' tool-active' : ''}`}
            onClick={() => setTool('eraser')}
            aria-pressed={tool === 'eraser'}
          >
            🧽 erase
          </button>
          {/* "clear pad", not "clear": the keypad has its own clear key and
              two identical labels on one screen is a trap. */}
          <button type="button" className="btn" onClick={clear} disabled={isEmpty}>
            clear pad
          </button>
        </div>
      </div>
    </div>
  )
}
