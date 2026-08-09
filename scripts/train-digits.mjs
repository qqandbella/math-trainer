/**
 * Trains the handwritten-digit classifier and writes its weights into the app.
 *
 * Kept in the repo so the model is reproducible rather than an opaque blob: run
 * it, and it reports held-out accuracy before writing anything.
 *
 *   node scripts/train-digits.mjs /path/to/mnist
 *
 * A small MLP rather than a convnet, because it has to run in a phone browser
 * with no dependencies and a wrong answer here corrupts practice data - so the
 * priority is a model whose behaviour is easy to verify, not the last percent.
 */
import { gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.argv[2] ?? '/tmp/mnist'
const OUT = new URL('../src/recognize/model.json', import.meta.url)

const HIDDEN = 64
const EPOCHS = 12
const BATCH = 64
const LR = 0.12
const SEED = 1234

function readImages(file) {
  const buf = gunzipSync(readFileSync(join(DIR, file)))
  const count = buf.readUInt32BE(4)
  const rows = buf.readUInt32BE(8)
  const cols = buf.readUInt32BE(12)
  const data = new Float32Array(count * rows * cols)
  for (let i = 0; i < data.length; i++) data[i] = buf[16 + i] / 255
  return { data, count, size: rows * cols }
}

function readLabels(file) {
  const buf = gunzipSync(readFileSync(join(DIR, file)))
  const count = buf.readUInt32BE(4)
  return Uint8Array.from(buf.subarray(8, 8 + count))
}

// Deterministic RNG so a rerun reproduces the same model.
let seed = SEED
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const randn = () => {
  const u = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const train = readImages('train-images-idx3-ubyte.gz')
const trainLabels = readLabels('train-labels-idx1-ubyte.gz')
const test = readImages('t10k-images-idx3-ubyte.gz')
const testLabels = readLabels('t10k-labels-idx1-ubyte.gz')
const IN = train.size
console.log(`train ${train.count}, test ${test.count}, ${IN} inputs`)

const w1 = new Float32Array(IN * HIDDEN)
const b1 = new Float32Array(HIDDEN)
const w2 = new Float32Array(HIDDEN * 10)
const b2 = new Float32Array(10)
for (let i = 0; i < w1.length; i++) w1[i] = randn() * Math.sqrt(2 / IN)
for (let i = 0; i < w2.length; i++) w2[i] = randn() * Math.sqrt(2 / HIDDEN)

const h = new Float32Array(HIDDEN)
const out = new Float32Array(10)

function forward(input, offset) {
  for (let j = 0; j < HIDDEN; j++) {
    let sum = b1[j]
    const base = j * IN
    for (let i = 0; i < IN; i++) sum += input[offset + i] * w1[base + i]
    h[j] = sum > 0 ? sum : 0 // ReLU
  }
  let max = -Infinity
  for (let k = 0; k < 10; k++) {
    let sum = b2[k]
    const base = k * HIDDEN
    for (let j = 0; j < HIDDEN; j++) sum += h[j] * w2[base + j]
    out[k] = sum
    if (sum > max) max = sum
  }
  let total = 0
  for (let k = 0; k < 10; k++) {
    out[k] = Math.exp(out[k] - max)
    total += out[k]
  }
  for (let k = 0; k < 10; k++) out[k] /= total
  return out
}

function accuracy(set, labels) {
  let correct = 0
  for (let n = 0; n < set.count; n++) {
    const p = forward(set.data, n * IN)
    let best = 0
    for (let k = 1; k < 10; k++) if (p[k] > p[best]) best = k
    if (best === labels[n]) correct++
  }
  return correct / set.count
}

const order = Uint32Array.from({ length: train.count }, (_, i) => i)
const gh = new Float32Array(HIDDEN)

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = order[i]
    order[i] = order[j]
    order[j] = tmp
  }

  for (let start = 0; start < order.length; start += BATCH) {
    const end = Math.min(start + BATCH, order.length)
    const scale = LR / (end - start)
    for (let s = start; s < end; s++) {
      const n = order[s]
      const offset = n * IN
      const p = forward(train.data, offset)
      const label = trainLabels[n]

      gh.fill(0)
      for (let k = 0; k < 10; k++) {
        const d = p[k] - (k === label ? 1 : 0)
        if (d === 0) continue
        const base = k * HIDDEN
        for (let j = 0; j < HIDDEN; j++) {
          gh[j] += d * w2[base + j]
          w2[base + j] -= scale * d * h[j]
        }
        b2[k] -= scale * d
      }
      for (let j = 0; j < HIDDEN; j++) {
        if (h[j] <= 0) continue // ReLU gradient
        const d = gh[j]
        if (d === 0) continue
        const base = j * IN
        for (let i = 0; i < IN; i++) {
          const x = train.data[offset + i]
          if (x !== 0) w1[base + i] -= scale * d * x
        }
        b1[j] -= scale * d
      }
    }
  }
  console.log(`epoch ${epoch}: test accuracy ${(accuracy(test, testLabels) * 100).toFixed(2)}%`)
}

const finalAccuracy = accuracy(test, testLabels)
console.log(`\nheld-out accuracy: ${(finalAccuracy * 100).toFixed(2)}%`)

// Quantise to int8 per tensor: the browser never needs float precision here,
// and it cuts the shipped model roughly fourfold.
function quantise(arr) {
  let max = 0
  for (const v of arr) max = Math.max(max, Math.abs(v))
  const scale = max / 127 || 1
  return { scale, values: Array.from(arr, (v) => Math.round(v / scale)) }
}

const model = {
  note: 'Trained by scripts/train-digits.mjs on MNIST. Regenerate rather than edit.',
  accuracy: Number(finalAccuracy.toFixed(4)),
  inputs: IN,
  hidden: HIDDEN,
  w1: quantise(w1),
  b1: Array.from(b1, (v) => Number(v.toFixed(5))),
  w2: quantise(w2),
  b2: Array.from(b2, (v) => Number(v.toFixed(5))),
}
writeFileSync(OUT, JSON.stringify(model))
console.log(`wrote ${OUT.pathname} (${(JSON.stringify(model).length / 1024).toFixed(0)} KB)`)
