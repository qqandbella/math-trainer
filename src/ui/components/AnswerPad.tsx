import { useCallback, useEffect, useReducer, useRef, type ReactNode } from 'react'
import type { Problem } from '../../core/types'

interface Props {
  problem: Problem
  onSubmit(answer: number, remainder: number | null): void
  onSkip?: (() => void) | undefined
}

const MAX_DIGITS = 12

/**
 * Answer entry for one problem. Division-with-remainder needs two fields, so
 * the pad tracks which one is active; everything else is a single box.
 *
 * Physical keys are wired alongside the on-screen pad because the same build
 * runs on a laptop, where typing is far faster than tapping.
 */
export function AnswerPad({ problem, onSubmit, onSkip }: Props): ReactNode {
  const needsRemainder = problem.remainder !== undefined

  /**
   * Refs, not state, are the source of truth for what has been typed.
   *
   * A keydown handler that closed over state would read a stale value whenever
   * two keys land in the same frame - the last digit and Enter, say - and
   * submit a truncated answer that then grades as wrong. Refs update
   * synchronously, so Enter always sees every digit that preceded it.
   */
  const primaryRef = useRef('')
  const remainderRef = useRef('')
  const fieldRef = useRef<'primary' | 'remainder'>('primary')
  const [, repaint] = useReducer((n: number) => n + 1, 0)

  const primary = primaryRef.current
  const remainder = remainderRef.current
  const field = fieldRef.current

  useEffect(() => {
    primaryRef.current = ''
    remainderRef.current = ''
    fieldRef.current = 'primary'
    repaint()
  }, [problem.id])

  const canSubmit = primary.length > 0 && (!needsRemainder || remainder.length > 0)

  const setField = useCallback((next: 'primary' | 'remainder') => {
    fieldRef.current = next
    repaint()
  }, [])

  const pressDigit = useCallback((digit: string) => {
    const ref = fieldRef.current === 'primary' ? primaryRef : remainderRef
    if (ref.current.length >= MAX_DIGITS) return
    ref.current += digit
    repaint()
  }, [])

  const pressBackspace = useCallback(() => {
    const ref = fieldRef.current === 'primary' ? primaryRef : remainderRef
    ref.current = ref.current.slice(0, -1)
    repaint()
  }, [])

  const clear = useCallback(() => {
    primaryRef.current = ''
    remainderRef.current = ''
    fieldRef.current = 'primary'
    repaint()
  }, [])

  const pressEnter = useCallback(() => {
    const typed = primaryRef.current
    const typedRemainder = remainderRef.current
    // On a remainder problem, the first Enter moves to the remainder box
    // rather than submitting a half-finished answer.
    if (needsRemainder && fieldRef.current === 'primary' && typedRemainder.length === 0) {
      if (typed.length > 0) setField('remainder')
      return
    }
    if (typed.length === 0 || (needsRemainder && typedRemainder.length === 0)) return
    onSubmit(Number(typed), needsRemainder ? Number(typedRemainder) : null)
  }, [needsRemainder, onSubmit, setField])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key >= '0' && event.key <= '9') {
        pressDigit(event.key)
      } else if (event.key === 'Backspace') {
        pressBackspace()
      } else if (event.key === 'Enter') {
        pressEnter()
      } else if (event.key === 'Tab' && needsRemainder) {
        setField(fieldRef.current === 'primary' ? 'remainder' : 'primary')
      } else if (event.key === 'Escape' && onSkip) {
        onSkip()
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pressDigit, pressBackspace, pressEnter, needsRemainder, onSkip])

  return (
    <>
      <div>
        {needsRemainder && (
          <div className="answer-label">quotient and remainder</div>
        )}
        <div className="answer-line">
          <button
            type="button"
            className={`answer-box${field === 'primary' ? ' active' : ''}`}
            onClick={() => setField('primary')}
          >
            {primary || <span className="placeholder">?</span>}
          </button>
          {needsRemainder && (
            <>
              <span className="muted">r</span>
              <button
                type="button"
                className={`answer-box small${field === 'remainder' ? ' active' : ''}`}
                onClick={() => setField('remainder')}
              >
                {remainder || <span className="placeholder">?</span>}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="keypad">
        {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((digit) => (
          <button key={digit} type="button" className="key" onClick={() => pressDigit(digit)}>
            {digit}
          </button>
        ))}
        <button type="button" className="key util" onClick={pressBackspace}>
          ⌫
        </button>
        <button type="button" className="key" onClick={() => pressDigit('0')}>
          0
        </button>
        {onSkip ? (
          <button type="button" className="key util" onClick={onSkip}>
            skip
          </button>
        ) : (
          <button
            type="button"
            className="key util"
            onClick={clear}
          >
            clear
          </button>
        )}
        <button
          type="button"
          className="key enter wide"
          onClick={pressEnter}
          disabled={!canSubmit && !(needsRemainder && field === 'primary')}
        >
          {needsRemainder && field === 'primary' && remainder.length === 0
            ? 'next →'
            : 'enter'}
        </button>
        {needsRemainder && (
          <button
            type="button"
            className="key util"
            onClick={() => setField(field === 'primary' ? 'remainder' : 'primary')}
          >
            ⇄
          </button>
        )}
      </div>
    </>
  )
}
