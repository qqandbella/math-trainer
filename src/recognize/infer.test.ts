import { gunzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify, MODEL_ACCURACY } from './infer'

/**
 * Checks the shipped model against held-out MNIST.
 *
 * The point is not to re-measure the model - training already reported that -
 * but to prove the browser inference path and the int8 quantisation reproduce
 * it. A quantisation or indexing bug would be invisible in the app and would
 * quietly mis-grade answers.
 *
 * Skipped when the dataset is absent, so a clone without it still runs green.
 */
const MNIST_DIR = process.env.MNIST_DIR ?? '/tmp/mnist'
const hasDataset = existsSync(join(MNIST_DIR, 't10k-images-idx3-ubyte.gz'))

describe.skipIf(!hasDataset)('digit classifier', () => {
  const images = gunzipSync(readFileSync(join(MNIST_DIR, 't10k-images-idx3-ubyte.gz')))
  const labels = gunzipSync(readFileSync(join(MNIST_DIR, 't10k-labels-idx1-ubyte.gz')))
  const count = images.readUInt32BE(4)

  const imageAt = (n: number): Float32Array => {
    const pixels = new Float32Array(784)
    for (let i = 0; i < 784; i++) pixels[i] = (images[16 + n * 784 + i] as number) / 255
    return pixels
  }

  it('reproduces the trained accuracy after quantisation', () => {
    let correct = 0
    for (let n = 0; n < count; n++) {
      if (classify(imageAt(n)).digit === labels[8 + n]) correct++
    }
    const accuracy = correct / count
    // Within half a point of what training reported; a real bug moves it far more.
    expect(accuracy).toBeGreaterThan(MODEL_ACCURACY - 0.005)
  })

  it('is confident when it is right and less so when it is wrong', () => {
    let confidentCorrect = 0
    let confidentTotal = 0
    for (let n = 0; n < 2000; n++) {
      const prediction = classify(imageAt(n))
      if (prediction.confidence > 0.9) {
        confidentTotal++
        if (prediction.digit === labels[8 + n]) confidentCorrect++
      }
    }
    // High-confidence predictions must be markedly more reliable than average,
    // otherwise the confidence threshold in the UI is meaningless.
    expect(confidentCorrect / confidentTotal).toBeGreaterThan(0.99)
  })
})
