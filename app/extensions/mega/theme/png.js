'use strict'

/**
 * Minimal, dependency-free PNG writer.
 *
 * The theme builder must be able to compile a self-contained theme package on
 * any machine that can run DS-Harness. `sharp` is available inside the app's
 * node_modules, but a native module is exactly the kind of optional dependency
 * that must never be able to fail a theme build, so PNG encoding is done here
 * with the standard library only (zlib + CRC32).
 *
 * Supported subset: 8-bit truecolour RGB / RGBA, no interlacing, filter 0.
 */
const zlib = require('node:zlib')

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    c = CRC_TABLE[(c ^ buffer[index]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/**
 * Encode a raw pixel buffer as PNG.
 *
 * @param {object} options
 * @param {number} options.width
 * @param {number} options.height
 * @param {Buffer|Uint8Array} options.data  RGB (3 bytes/px) or RGBA (4 bytes/px)
 * @param {number} [options.channels=4]
 */
function encodePng({ width, height, data, channels = 4 }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`invalid PNG width: ${width}`)
  if (!Number.isInteger(height) || height <= 0) throw new Error(`invalid PNG height: ${height}`)
  if (channels !== 3 && channels !== 4) throw new Error(`invalid PNG channel count: ${channels}`)
  const expected = width * height * channels
  if (data.length < expected) throw new Error(`pixel buffer too small: have ${data.length}, need ${expected}`)

  const colorType = channels === 4 ? 6 : 2
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(data.buffer || data, data.byteOffset || 0, data.length)
      .copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Create an empty RGBA canvas. */
function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) }
}

/** Blend one pixel with `alpha` over whatever is already there. */
function blendPixel(canvas, x, y, { r, g, b }, alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return
  if (alpha <= 0) return
  const a = Math.min(1, alpha)
  const offset = (y * canvas.width + x) * 4
  const data = canvas.data
  const dstA = data[offset + 3] / 255
  const outA = a + dstA * (1 - a)
  if (outA <= 0) return
  data[offset] = Math.round((r * a + data[offset] * dstA * (1 - a)) / outA)
  data[offset + 1] = Math.round((g * a + data[offset + 1] * dstA * (1 - a)) / outA)
  data[offset + 2] = Math.round((b * a + data[offset + 2] * dstA * (1 - a)) / outA)
  data[offset + 3] = Math.round(outA * 255)
}

/** Fill the whole canvas with an opaque colour. */
function fill(canvas, { r, g, b }, alpha = 1) {
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) blendPixel(canvas, x, y, { r, g, b }, alpha)
  }
}

/** Encode a canvas to PNG bytes. */
function canvasToPng(canvas) {
  return encodePng({ width: canvas.width, height: canvas.height, data: canvas.data, channels: 4 })
}

/** Encode a canvas as an inline CSS data URI. */
function canvasToDataUri(canvas) {
  return `data:image/png;base64,${canvasToPng(canvas).toString('base64')}`
}

module.exports = {
  SIGNATURE,
  crc32,
  encodePng,
  createCanvas,
  blendPixel,
  fill,
  canvasToPng,
  canvasToDataUri
}
