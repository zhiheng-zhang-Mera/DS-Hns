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

/**
 * Decode PNG bytes back into a canvas.
 *
 * The runtime never needs this — the renderer paints whatever bytes it is given —
 * but the *validator* does: "the asset is a real 512x768 image with a transparent
 * background and actual content" cannot be asserted from a return value, only from
 * the decoded pixels. A second, independent implementation of the format (this
 * decoder vs. the encoder above) is deliberate: a bug in one must not be able to
 * make the other report success.
 *
 * Supported: 8-bit greyscale / RGB / palette / greyscale+alpha / RGBA, all five
 * scanline filters, non-interlaced. Everything else throws, and the caller treats
 * a throw as "this is not a usable theme asset".
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width: number, height: number, data: Buffer}}
 */
function decodePng(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (data.length < 8 + 25 || !data.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG (bad signature)')
  }
  let offset = 8
  let header = null
  const idat = []
  let palette = null
  let transparency = null
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('ascii')
    const body = data.subarray(offset + 8, offset + 8 + length)
    if (offset + 12 + length > data.length) throw new Error(`truncated PNG chunk ${type}`)
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12]
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(body)
    } else if (type === 'tRNS') {
      transparency = Buffer.from(body)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (!header) throw new Error('PNG has no IHDR chunk')
  if (header.depth !== 8) throw new Error(`unsupported PNG bit depth ${header.depth}`)
  if (header.interlace !== 0) throw new Error('interlaced PNG is not supported')
  if (!idat.length) throw new Error('PNG has no IDAT data')

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByType[header.colorType]
  if (!channels) throw new Error(`unsupported PNG colour type ${header.colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  if (raw.length < (stride + 1) * header.height) throw new Error('PNG pixel data is truncated')

  const out = Buffer.alloc(header.width * header.height * 4)
  const previous = Buffer.alloc(stride)
  const current = Buffer.alloc(stride)
  for (let y = 0; y < header.height; y += 1) {
    const filterType = raw[y * (stride + 1)]
    raw.copy(current, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let index = 0; index < stride; index += 1) {
      const x = current[index]
      const a = index >= channels ? current[index - channels] : 0
      const b = previous[index]
      const c = index >= channels ? previous[index - channels] : 0
      let value
      switch (filterType) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const predictor = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
          value = x + predictor
          break
        }
        default: throw new Error(`unsupported PNG filter type ${filterType}`)
      }
      current[index] = value & 0xff
    }
    for (let px = 0; px < header.width; px += 1) {
      const source = px * channels
      const target = (y * header.width + px) * 4
      switch (header.colorType) {
        case 0:
          out[target] = current[source]
          out[target + 1] = current[source]
          out[target + 2] = current[source]
          out[target + 3] = 255
          break
        case 2:
          out[target] = current[source]
          out[target + 1] = current[source + 1]
          out[target + 2] = current[source + 2]
          out[target + 3] = 255
          break
        case 3: {
          const index = current[source]
          if (!palette || palette.length < (index + 1) * 3) throw new Error('PNG palette index out of range')
          out[target] = palette[index * 3]
          out[target + 1] = palette[index * 3 + 1]
          out[target + 2] = palette[index * 3 + 2]
          out[target + 3] = transparency && index < transparency.length ? transparency[index] : 255
          break
        }
        case 4:
          out[target] = current[source]
          out[target + 1] = current[source]
          out[target + 2] = current[source]
          out[target + 3] = current[source + 1]
          break
        default:
          out[target] = current[source]
          out[target + 1] = current[source + 1]
          out[target + 2] = current[source + 2]
          out[target + 3] = current[source + 3]
      }
    }
    current.copy(previous)
  }
  return { width: header.width, height: header.height, data: out, colorType: header.colorType }
}

/** Read only the header of a PNG buffer. Never throws for a non-PNG; returns null. */
function readPngHeader(buffer) {
  try {
    const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    if (data.length < 24 || !data.subarray(0, 8).equals(SIGNATURE)) return null
    if (data.subarray(12, 16).toString('ascii') !== 'IHDR') return null
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
      depth: data[24],
      colorType: data[25],
      interlace: data[28]
    }
  } catch {
    return null
  }
}

module.exports = {
  SIGNATURE,
  crc32,
  encodePng,
  decodePng,
  readPngHeader,
  createCanvas,
  blendPixel,
  fill,
  canvasToPng,
  canvasToDataUri
}
