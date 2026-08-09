import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

interface Point {
  x: number
  y: number
}

type Stroke = Point[]

interface Props {
  /** Strokes reset when this changes, so each problem starts on clean paper. */
  resetKey: string
}

const INK = '#16233b'
const LINE_WIDTH = 2.4

/**
 * A drawing surface for working a problem out without paper.
 *
 * Strokes are kept as point lists rather than being flattened into the canvas,
 * so undo is a real operation and a resize can redraw at the new size instead of
 * stretching a bitmap. Nothing is persisted: this is scratch paper, and the
 * measurement that matters is the answer and the time, not the workings.
 */
export function ScratchPad({ resetKey }: Props): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const currentRef = useRef<Stroke | null>(null)
  const activePointerRef = useRef<number | null>(null)
  /**
   * Once a stylus is seen, touch input is ignored for the rest of the problem.
   * On a tablet the palm lands before the pen does, and without this every
   * digit gets a smear through it.
   */
  const penSeenRef = useRef(false)
  const [isEmpty, setIsEmpty] = useState(true)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const ratio = window.devicePixelRatio || 1
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio)
    ctx.strokeStyle = INK
    ctx.lineWidth = LINE_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const stroke of strokesRef.current) {
      if (stroke.length === 0) continue
      ctx.beginPath()
      const first = stroke[0] as Point
      if (stroke.length === 1) {
        // A tap should leave a dot, not nothing.
        ctx.arc(first.x, first.y, LINE_WIDTH / 2, 0, Math.PI * 2)
        ctx.fillStyle = INK
        ctx.fill()
        continue
      }
      ctx.moveTo(first.x, first.y)
      // Draw through midpoints so the line curves instead of showing corners.
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

  useEffect(() => {
    strokesRef.current = []
    currentRef.current = null
    penSeenRef.current = false
    setIsEmpty(true)
    redraw()
  }, [resetKey, redraw])

  const positionOf = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const shouldIgnore = (event: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (event.pointerType === 'pen') {
      penSeenRef.current = true
      return false
    }
    return penSeenRef.current && event.pointerType === 'touch'
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (shouldIgnore(event)) return
    if (activePointerRef.current !== null) return
    activePointerRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    currentRef.current = [positionOf(event)]
    strokesRef.current.push(currentRef.current)
    setIsEmpty(false)
    redraw()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (activePointerRef.current !== event.pointerId || !currentRef.current) return
    currentRef.current.push(positionOf(event))
    redraw()
  }

  const endStroke = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (activePointerRef.current !== event.pointerId) return
    activePointerRef.current = null
    currentRef.current = null
  }

  const undo = (): void => {
    strokesRef.current.pop()
    setIsEmpty(strokesRef.current.length === 0)
    redraw()
  }

  const clear = (): void => {
    strokesRef.current = []
    setIsEmpty(true)
    redraw()
  }

  return (
    <div className="scratch">
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
        <button type="button" className="btn btn-ghost" onClick={undo} disabled={isEmpty}>
          undo
        </button>
        <button type="button" className="btn btn-ghost" onClick={clear} disabled={isEmpty}>
          clear
        </button>
      </div>
    </div>
  )
}
