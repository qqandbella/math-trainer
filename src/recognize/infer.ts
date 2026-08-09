import modelJson from './model.json'

interface Quantised {
  scale: number
  values: number[]
}

interface ModelFile {
  accuracy: number
  inputs: number
  hidden: number
  w1: Quantised
  b1: number[]
  w2: Quantised
  b2: number[]
}

const model = modelJson as ModelFile

function dequantise(q: Quantised): Float32Array {
  const out = new Float32Array(q.values.length)
  for (let i = 0; i < q.values.length; i++) out[i] = (q.values[i] as number) * q.scale
  return out
}

const W1 = dequantise(model.w1)
const B1 = Float32Array.from(model.b1)
const W2 = dequantise(model.w2)
const B2 = Float32Array.from(model.b2)
const IN = model.inputs
const HIDDEN = model.hidden

export const MODEL_ACCURACY = model.accuracy

export interface Prediction {
  digit: number
  /** Softmax probability of the winning digit, 0-1. */
  confidence: number
}

/** Runs the classifier over one 28x28 image with values in [0,1]. */
export function classify(pixels: Float32Array): Prediction {
  if (pixels.length !== IN) {
    throw new Error(`expected ${IN} pixels, received ${pixels.length}`)
  }
  const h = new Float32Array(HIDDEN)
  for (let j = 0; j < HIDDEN; j++) {
    let sum = B1[j] as number
    const base = j * IN
    for (let i = 0; i < IN; i++) sum += (pixels[i] as number) * (W1[base + i] as number)
    h[j] = sum > 0 ? sum : 0
  }

  const out = new Float32Array(10)
  let max = -Infinity
  for (let k = 0; k < 10; k++) {
    let sum = B2[k] as number
    const base = k * HIDDEN
    for (let j = 0; j < HIDDEN; j++) sum += (h[j] as number) * (W2[base + j] as number)
    out[k] = sum
    if (sum > max) max = sum
  }

  let total = 0
  for (let k = 0; k < 10; k++) {
    out[k] = Math.exp((out[k] as number) - max)
    total += out[k] as number
  }

  let best = 0
  for (let k = 1; k < 10; k++) if ((out[k] as number) > (out[best] as number)) best = k
  return { digit: best, confidence: (out[best] as number) / total }
}
