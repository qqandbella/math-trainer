/**
 * Generates the PWA icon set with no image dependencies.
 *
 * Rasterises a small vector scene into an RGBA buffer and encodes a PNG by
 * hand (Node's zlib does the compression). Keeping this in-repo means the
 * icons are reproducible and reviewable rather than opaque binaries.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const INK = [27, 42, 74, 255]
const ACCENT = [47, 107, 255, 255]
const WHITE = [255, 255, 255, 255]

function createCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) }
}

function blend(canvas, x, y, [r, g, b, a], coverage) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return
  const alpha = (a / 255) * coverage
  if (alpha <= 0) return
  const i = (y * canvas.size + x) * 4
  const dstA = canvas.data[i + 3] / 255
  const outA = alpha + dstA * (1 - alpha)
  for (let c = 0; c < 3; c++) {
    const src = [r, g, b][c]
    const dst = canvas.data[i + c]
    canvas.data[i + c] = outA === 0 ? 0 : Math.round((src * alpha + dst * dstA * (1 - alpha)) / outA)
  }
  canvas.data[i + 3] = Math.round(outA * 255)
}

/** Supersampled fill: `sdf` returns signed distance, negative meaning inside. */
function fill(canvas, color, sdf) {
  const SS = 3
  for (let y = 0; y < canvas.size; y++) {
    for (let x = 0; x < canvas.size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          if (sdf(px, py) <= 0) hits++
        }
      }
      if (hits > 0) blend(canvas, x, y, color, hits / (SS * SS))
    }
  }
}

const roundedRect = (cx, cy, w, h, r) => (x, y) => {
  const dx = Math.abs(x - cx) - w / 2 + r
  const dy = Math.abs(y - cy) - h / 2 + r
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - r
}

const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r

const segment = (x1, y1, x2, y2, thickness) => (x, y) => {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = x - x1
  const wy = y - y1
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
  return Math.hypot(wx - t * vx, wy - t * vy) - thickness / 2
}

const union =
  (...sdfs) =>
  (x, y) =>
    Math.min(...sdfs.map((f) => f(x, y)))

/**
 * The four operators in a 2x2 grid: instantly readable at 48px and says
 * "arithmetic" rather than "generic education app".
 */
function drawScene(canvas, inset) {
  const S = canvas.size
  const pad = S * inset
  const box = S - pad * 2

  fill(canvas, INK, roundedRect(S / 2, S / 2, box, box, box * 0.235))

  const q = box / 4
  const bar = box * 0.052
  const arm = box * 0.155
  const centres = [
    [pad + q, pad + q],
    [pad + q * 3, pad + q],
    [pad + q, pad + q * 3],
    [pad + q * 3, pad + q * 3],
  ]

  // plus
  const [px, py] = centres[0]
  fill(canvas, WHITE, union(
    roundedRect(px, py, arm * 2, bar, bar / 2),
    roundedRect(px, py, bar, arm * 2, bar / 2),
  ))

  // minus
  const [mx, my] = centres[1]
  fill(canvas, ACCENT, roundedRect(mx, my, arm * 2, bar, bar / 2))

  // times
  const [tx, ty] = centres[2]
  const d = arm * 0.72
  fill(canvas, ACCENT, union(
    segment(tx - d, ty - d, tx + d, ty + d, bar),
    segment(tx - d, ty + d, tx + d, ty - d, bar),
  ))

  // divide
  const [dx, dy] = centres[3]
  const dot = bar * 0.86
  fill(canvas, WHITE, union(
    roundedRect(dx, dy, arm * 2, bar, bar / 2),
    circle(dx, dy - arm * 0.78, dot),
    circle(dx, dy + arm * 0.78, dot),
  ))
}

function encodePng(canvas) {
  const { size, data } = canvas
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter type: none
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed) >>> 0)
    return Buffer.concat([len, typed, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let crc = -1
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc ^ -1
}

function write(name, size, inset) {
  const canvas = createCanvas(size)
  drawScene(canvas, inset)
  writeFileSync(join(OUT_DIR, name), encodePng(canvas))
  console.log(`wrote public/${name} (${size}x${size})`)
}

// Maskable icons get extra padding so platform-applied masks cannot clip the glyphs.
write('icon-192.png', 192, 0.04)
write('icon-512.png', 512, 0.04)
write('icon-512-maskable.png', 512, 0.16)
write('apple-touch-icon.png', 180, 0.0)

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1b2a4a"/>
  <g fill="#fff">
    <rect x="9" y="15.2" width="15" height="3.6" rx="1.8"/>
    <rect x="14.7" y="9.5" width="3.6" height="15" rx="1.8"/>
    <rect x="40" y="45.2" width="15" height="3.6" rx="1.8"/>
    <circle cx="47.5" cy="39" r="2.6"/><circle cx="47.5" cy="55" r="2.6"/>
  </g>
  <g fill="#2f6bff">
    <rect x="40" y="15.2" width="15" height="3.6" rx="1.8"/>
    <rect x="10.4" y="45.2" width="15" height="3.6" rx="1.8" transform="rotate(45 17.9 47)"/>
    <rect x="10.4" y="45.2" width="15" height="3.6" rx="1.8" transform="rotate(-45 17.9 47)"/>
  </g>
</svg>
`
writeFileSync(join(OUT_DIR, 'favicon.svg'), favicon)
console.log('wrote public/favicon.svg')
