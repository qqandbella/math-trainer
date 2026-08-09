import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

interface Point {
  x: number
  y: number
}

type Stroke = Point[]

const INK = '#16233b'
const LINE_WIDTH = 2.4
/** Generous, because erasing with a fingertip needs to feel forgiving. */
const ERASER_RADIUS = 18

/**
 * One drawing surface: strokes, undo, clear, and redraw on resize.
 *
 * Strokes are kept as point lists rather than being flattened into the canvas,
 * so undo is a real operation and a resize redraws at the new size instead of
 * stretching a bitmap.
 */
type Tool = 'pen' | 'eraser'

function useDrawSurface(
  resetKey: string,
  visible: boolean,
  onChange?: () => void,
  toolRef?: { current: Tool },
) {
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
        // A tap should leave a dot, not nothing.
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

  // ResizeObserver does not reliably fire on a display change, so becoming
  // visible must trigger the redraw itself or the surface comes back blank and
  // the work looks lost.
  useEffect(() => {
    if (visible) resize()
  }, [visible, resize])

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

  /** Removes whole strokes the eraser passes over. */
  const eraseAt = (point: Point): void => {
    const before = strokesRef.current.length
    strokesRef.current = strokesRef.current.filter(
      (stroke) =>
        !stroke.some((p) => Math.hypot(p.x - point.x, p.y - point.y) <= ERASER_RADIUS),
    )
    if (strokesRef.current.length !== before) {
      setIsEmpty(strokesRef.current.length === 0)
      onChange?.()
      redraw()
    }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.pointerType === 'pen') penSeenRef.current = true
    else if (penSeenRef.current && event.pointerType === 'touch') return
    if (activePointerRef.current !== null) return
    activePointerRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)

    if (toolRef?.current === 'eraser') {
      currentRef.current = null
      eraseAt(positionOf(event))
      return
    }
    currentRef.current = [positionOf(event)]
    strokesRef.current.push(currentRef.current)
    setIsEmpty(false)
    onChange?.()
    redraw()
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (activePointerRef.current !== event.pointerId) return
    if (toolRef?.current === 'eraser') {
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

  return {
    canvasRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endStroke,
      onPointerCancel: endStroke,
      onPointerLeave: endStroke,
    },
    isEmpty,
    clear: (): void => {
      strokesRef.current = []
      setIsEmpty(true)
      onChange?.()
      redraw()
    },
    snapshot: (): Stroke[] => strokesRef.current.map((stroke) => stroke.slice()),
  }
}

interface Props {
  /** Both surfaces reset when this changes, so each problem starts clean. */
  resetKey: string
  /** Asked to read the answer strip. Receives a copy of those strokes only. */
  onRead?: ((strokes: Stroke[]) => void) | undefined
  /** The reading awaiting confirmation, shown on the submit button. */
  pending?: string | null
  /** Confirms the reading. Submission happens here, without leaving the pad. */
  onSubmitPending?: (() => void) | undefined
  /** The answer writing changed, so any pending reading is stale. */
  onAnswerChanged?: (() => void) | undefined
  /** Switch to the keypad. Recognition is good, not perfect - typing must stay one tap away. */
  onUseKeypad?: (() => void) | undefined
  /**
   * Whether the pad is on screen. It stays mounted when hidden so the working
   * out survives a trip to the keypad.
   */
  visible?: boolean
}

/**
 * Working space and answer space, deliberately separate.
 *
 * Recognition reads only the answer strip. Reading the whole pad would try to
 * interpret every carry and partial product as part of the answer - wrong, and
 * impossible for the learner to correct.
 */
export function ScratchPad({
  resetKey,
  onRead,
  pending,
  onSubmitPending,
  onAnswerChanged,
  onUseKeypad,
  visible = true,
}: Props): ReactNode {
  const [tool, setTool] = useState<Tool>('pen')
  const toolRef = useRef<Tool>('pen')
  toolRef.current = tool
  const working = useDrawSurface(`${resetKey}-work`, visible, undefined, toolRef)
  const answer = useDrawSurface(`${resetKey}-answer`, visible, onAnswerChanged)

  // A stale eraser on the next problem would be a surprise.
  useEffect(() => {
    setTool('pen')
  }, [resetKey])

  return (
    <div className="scratch">
      <div className="scratch-work">
        <canvas ref={working.canvasRef} className="scratch-canvas" {...working.handlers} />
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
          <button type="button" className="btn" onClick={working.clear} disabled={working.isEmpty}>
            clear
          </button>
        </div>
      </div>

      <div className="answer-strip">
        <div className="answer-strip-label">write your answer</div>
        <canvas ref={answer.canvasRef} className="answer-canvas" {...answer.handlers} />
        <div className="scratch-tools">
          <button type="button" className="btn" onClick={answer.clear} disabled={answer.isEmpty}>
            reset
          </button>
          {pending == null ? (
            onRead && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={answer.isEmpty}
                onClick={() => onRead(answer.snapshot())}
              >
                read
              </button>
            )
          ) : (
            // Confirm and submit without leaving the pad: switching to the
            // keypad to press one more button defeats the point of writing.
            <button type="button" className="btn btn-primary" onClick={onSubmitPending}>
              submit {pending}
            </button>
          )}
          {onUseKeypad && (
            <button
              type="button"
              className="btn keypad-escape"
              onClick={onUseKeypad}
              aria-label="use the keypad instead"
            >
              ⌨
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
