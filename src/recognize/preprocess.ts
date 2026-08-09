import { classify, type Prediction } from './infer'

export interface Point {
  x: number
  y: number
}

export type Stroke = Point[]

/**
 * Turns handwriting into the exact shape MNIST was trained on.
 *
 * This matters more than the model does. MNIST digits are size-normalised to a
 * 20x20 box, centred by centre of mass inside 28x28, and anti-aliased. Feeding
 * a raw canvas crop instead produces confident nonsense, so the same
 * normalisation is reproduced here rather than approximated.
 *
 * Rasterising is done by hand rather than with a canvas so the whole pipeline is
 * deterministic and testable outside a browser.
 */

const SIZE = 28
const BOX = 20
const SUPERSAMPLE = 3
const STROKE_RADIUS = 1.15 // in 28x28 units, matching MNIST pen weight

function bounds(strokes: readonly Stroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const stroke of strokes) {
    for (const p of stroke) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY }
}

/**
 * Groups strokes into digits by horizontal overlap.
 *
 * Digits are written side by side, while the parts of one digit (the bar of a 4,
 * the crossbar of a 7) sit above or below each other. Overlap in x is therefore
 * a reliable separator and needs no timing information.
 */
export function segmentIntoDigits(strokes: readonly Stroke[]): Stroke[][] {
  const withBounds = strokes
    .map((stroke) => ({ stroke, box: bounds([stroke]) }))
    .filter((entry): entry is { stroke: Stroke; box: NonNullable<ReturnType<typeof bounds>> } =>
      entry.box !== null,
    )
    .sort((a, b) => a.box.minX - b.box.minX)

  const groups: { strokes: Stroke[]; minX: number; maxX: number }[] = []
  for (const { stroke, box } of withBounds) {
    const last = groups[groups.length - 1]
    // A small tolerance keeps a slightly detached mark with its digit without
    // swallowing the next one.
    const gap = last ? box.minX - last.maxX : Infinity
    const width = last ? last.maxX - last.minX : 0
    if (last && gap < Math.max(6, width * 0.35)) {
      last.strokes.push(stroke)
      last.maxX = Math.max(last.maxX, box.maxX)
      last.minX = Math.min(last.minX, box.minX)
    } else {
      groups.push({ strokes: [stroke], minX: box.minX, maxX: box.maxX })
    }
  }
  return groups.map((g) => g.strokes)
}

/** Renders one digit's strokes as a 28x28 MNIST-style image. */
export function rasterize(strokes: readonly Stroke[]): Float32Array {
  const box = bounds(strokes)
  const image = new Float32Array(SIZE * SIZE)
  if (!box) return image

  const width = Math.max(box.maxX - box.minX, 1e-6)
  const height = Math.max(box.maxY - box.minY, 1e-6)
  // Preserve aspect ratio: a squashed 1 stops looking like a 1.
  const scale = BOX / Math.max(width, height)
  const offsetX = (SIZE - width * scale) / 2 - box.minX * scale
  const offsetY = (SIZE - height * scale) / 2 - box.minY * scale

  const hi = SIZE * SUPERSAMPLE
  const buffer = new Uint8Array(hi * hi)
  const radius = STROKE_RADIUS * SUPERSAMPLE

  const stamp = (cx: number, cy: number): void => {
    const x0 = Math.max(0, Math.floor(cx - radius))
    const x1 = Math.min(hi - 1, Math.ceil(cx + radius))
    const y0 = Math.max(0, Math.floor(cy - radius))
    const y1 = Math.min(hi - 1, Math.ceil(cy + radius))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy <= radius * radius) buffer[y * hi + x] = 1
      }
    }
  }

  for (const stroke of strokes) {
    if (stroke.length === 1) {
      const p = stroke[0] as Point
      stamp((p.x * scale + offsetX) * SUPERSAMPLE, (p.y * scale + offsetY) * SUPERSAMPLE)
      continue
    }
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1] as Point
      const b = stroke[i] as Point
      const ax = (a.x * scale + offsetX) * SUPERSAMPLE
      const ay = (a.y * scale + offsetY) * SUPERSAMPLE
      const bx = (b.x * scale + offsetX) * SUPERSAMPLE
      const by = (b.y * scale + offsetY) * SUPERSAMPLE
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)))
      for (let s = 0; s <= steps; s++) {
        stamp(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps)
      }
    }
  }

  // Downsample: the averaging is what produces MNIST's soft edges.
  const area = SUPERSAMPLE * SUPERSAMPLE
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let sum = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const row = (y * SUPERSAMPLE + sy) * hi + x * SUPERSAMPLE
        for (let sx = 0; sx < SUPERSAMPLE; sx++) sum += buffer[row + sx] as number
      }
      image[y * SIZE + x] = sum / area
    }
  }

  return centreByMass(image)
}

/** MNIST centres each digit by centre of mass, not by bounding box. */
function centreByMass(image: Float32Array): Float32Array {
  let total = 0
  let sumX = 0
  let sumY = 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = image[y * SIZE + x] as number
      if (v === 0) continue
      total += v
      sumX += x * v
      sumY += y * v
    }
  }
  if (total === 0) return image

  const shiftX = Math.round(SIZE / 2 - sumX / total)
  const shiftY = Math.round(SIZE / 2 - sumY / total)
  if (shiftX === 0 && shiftY === 0) return image

  const shifted = new Float32Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) {
    const ty = y + shiftY
    if (ty < 0 || ty >= SIZE) continue
    for (let x = 0; x < SIZE; x++) {
      const tx = x + shiftX
      if (tx < 0 || tx >= SIZE) continue
      shifted[ty * SIZE + tx] = image[y * SIZE + x] as number
    }
  }
  return shifted
}

export interface RecognisedDigit extends Prediction {
  strokes: Stroke[]
}

export interface RecognisedNumber {
  /** Digits joined left to right, e.g. "16965". Empty when nothing was written. */
  text: string
  digits: RecognisedDigit[]
  /** Confidence of the least certain digit - the one most likely to be wrong. */
  weakest: number
}

export function recogniseNumber(strokes: readonly Stroke[]): RecognisedNumber {
  const groups = segmentIntoDigits(strokes)
  const digits = groups.map((group) => ({
    ...classify(rasterize(group)),
    strokes: group,
  }))
  return {
    text: digits.map((d) => String(d.digit)).join(''),
    digits,
    weakest: digits.length === 0 ? 0 : Math.min(...digits.map((d) => d.confidence)),
  }
}
