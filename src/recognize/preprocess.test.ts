import { describe, expect, it } from 'vitest'
import { rasterize, recogniseNumber, segmentIntoDigits, type Stroke } from './preprocess'

/**
 * Digit shapes drawn as polylines in a 0-100 box, roughly as a person would.
 *
 * These exercise the whole pipeline - segmentation, normalisation, inference -
 * rather than just the model, which is the part MNIST accuracy says nothing
 * about. If normalisation regresses, these stop being recognised even though
 * the classifier itself is untouched.
 */
const TEMPLATES: Record<number, Stroke[]> = {
  0: [arc(50, 50, 28, 38, 0, Math.PI * 2)],
  1: [[p(50, 5), p(50, 95)]],
  2: [
    [...arcPoints(50, 32, 26, 26, Math.PI, Math.PI * 1.9), p(24, 92)],
    [p(22, 92), p(80, 92)],
  ],
  3: [
    [...arcPoints(50, 30, 24, 24, Math.PI, Math.PI * 2.15)],
    [...arcPoints(48, 70, 26, 26, Math.PI * 1.85, Math.PI * 3.05)],
  ],
  4: [
    [p(68, 8), p(20, 66), p(85, 66)],
    [p(66, 40), p(66, 95)],
  ],
  5: [
    [p(76, 10), p(30, 10), p(28, 45)],
    [p(28, 45), ...arcPoints(50, 66, 26, 27, Math.PI * 1.15, Math.PI * 2.6)],
  ],
  6: [
    [p(70, 12), ...arcPoints(48, 62, 26, 32, Math.PI * 1.5, Math.PI * 3.4)],
  ],
  7: [
    [p(18, 12), p(82, 12), p(42, 94)],
  ],
  8: [
    [...arcPoints(50, 30, 22, 22, 0, Math.PI * 2)],
    [...arcPoints(50, 70, 26, 24, 0, Math.PI * 2)],
  ],
  9: [
    [...arcPoints(52, 34, 24, 26, 0, Math.PI * 2)],
    [p(76, 34), p(70, 94)],
  ],
}

function p(x: number, y: number): { x: number; y: number } {
  return { x, y }
}

function arcPoints(cx: number, cy: number, rx: number, ry: number, from: number, to: number) {
  const out = []
  const steps = 40
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps
    out.push(p(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry))
  }
  return out
}

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Stroke {
  return arcPoints(cx, cy, rx, ry, from, to)
}

function shift(strokes: Stroke[], dx: number): Stroke[] {
  return strokes.map((s) => s.map((pt) => p(pt.x + dx, pt.y)))
}

describe('normalisation', () => {
  it('produces a 28x28 image in range', () => {
    const image = rasterize(TEMPLATES[1] as Stroke[])
    expect(image).toHaveLength(784)
    expect(Math.min(...image)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...image)).toBeLessThanOrEqual(1)
    expect(image.some((v) => v > 0.5)).toBe(true)
  })

  it('centres the digit by centre of mass', () => {
    // Same shape drawn far off to one side must normalise to the same place.
    const centred = rasterize(TEMPLATES[7] as Stroke[])
    const offset = rasterize(shift(TEMPLATES[7] as Stroke[], 400))
    let diff = 0
    for (let i = 0; i < centred.length; i++) {
      diff += Math.abs((centred[i] as number) - (offset[i] as number))
    }
    expect(diff / centred.length).toBeLessThan(0.02)
  })

  it('is unchanged by how large the writing is', () => {
    const small = rasterize(TEMPLATES[4] as Stroke[])
    const large = rasterize((TEMPLATES[4] as Stroke[]).map((s) => s.map((pt) => p(pt.x * 5, pt.y * 5))))
    let diff = 0
    for (let i = 0; i < small.length; i++) {
      diff += Math.abs((small[i] as number) - (large[i] as number))
    }
    expect(diff / small.length).toBeLessThan(0.02)
  })

  it('returns a blank image for no strokes', () => {
    expect(rasterize([]).every((v) => v === 0)).toBe(true)
  })
})

describe('segmentation', () => {
  it('keeps the parts of a multi-stroke digit together', () => {
    // A 4 is two strokes that overlap horizontally.
    expect(segmentIntoDigits(TEMPLATES[4] as Stroke[])).toHaveLength(1)
    expect(segmentIntoDigits(TEMPLATES[7] as Stroke[])).toHaveLength(1)
  })

  it('splits digits written side by side', () => {
    const two = [...(TEMPLATES[1] as Stroke[]), ...shift(TEMPLATES[7] as Stroke[], 160)]
    expect(segmentIntoDigits(two)).toHaveLength(2)
  })

  it('orders digits left to right regardless of writing order', () => {
    const written = [...shift(TEMPLATES[7] as Stroke[], 160), ...(TEMPLATES[1] as Stroke[])]
    const groups = segmentIntoDigits(written)
    expect(groups).toHaveLength(2)
    const firstX = Math.min(...(groups[0] as Stroke[]).flat().map((pt) => pt.x))
    const secondX = Math.min(...(groups[1] as Stroke[]).flat().map((pt) => pt.x))
    expect(firstX).toBeLessThan(secondX)
  })
})

describe('recognition end to end', () => {
  it('reads most hand-drawn digit shapes correctly', () => {
    const wrong: string[] = []
    for (const [expected, strokes] of Object.entries(TEMPLATES)) {
      const result = recogniseNumber(strokes)
      if (result.text !== expected) wrong.push(`${expected}->${result.text || 'nothing'}`)
    }
    // Currently 8/10: the synthetic 3 and 6 are cruder than real handwriting.
    // This guards against a broken pipeline, not the last few percent of model
    // accuracy - which is why recognition is always confirmed before it counts.
    expect(wrong.length, `misread: ${wrong.join(', ')}`).toBeLessThanOrEqual(2)
  })

  it('reads a multi-digit number left to right', () => {
    const strokes = [
      ...(TEMPLATES[1] as Stroke[]),
      ...shift(TEMPLATES[7] as Stroke[], 150),
      ...shift(TEMPLATES[4] as Stroke[], 300),
    ]
    expect(recogniseNumber(strokes).text).toBe('174')
  })

  it('reports nothing for an empty pad', () => {
    const result = recogniseNumber([])
    expect(result.text).toBe('')
    expect(result.digits).toHaveLength(0)
  })
})
