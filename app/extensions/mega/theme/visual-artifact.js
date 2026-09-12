'use strict'

/**
 * Visual artifact ground truth.
 *
 * "The snapshot has a screenshot" must mean a real, decodable image, not a truthy
 * flag. A 0-byte buffer, a text error page saved as .png, or a 0x0 capture all
 * used to satisfy a `visual === true` check, which is exactly the kind of false
 * green the acceptance run has to reject.
 *
 * Everything here is pure: buffers in, verdicts out. No filesystem, no Electron.
 */
const png = require('./png')

const PNG_SIGNATURE = png.SIGNATURE
const PNG_HEADER_BYTES = 24

/**
 * A capture smaller than this is not a rendered UI. That is a *dimension*
 * verdict, not a byte one: a screenshot compresses, and a legitimate clean dock
 * capture is a few kilobytes. What must never pass is an empty buffer, a 0x0
 * capture or a text error page, and those all fail the signature/IHDR checks.
 */
const MIN_USEFUL_EDGE = 64
/** Floor for "this file contains an image at all". */
const MIN_USEFUL_BYTES = 256
/**
 * PNG cannot compress a real UI below roughly 0.5% of its pixel count (the
 * encoder in this repo reaches 0.65% on noise). Something far below that is a
 * near-blank image, which is a capture defect rather than a small screenshot.
 */
const MIN_BYTES_PER_PIXEL = 0.002
/**
 * The acceptance floor from the engineering spec: a real dock screenshot is
 * tens of kilobytes, so 5 KB is a safe "not an empty file" guard for a file read
 * from disk.
 */
const ACCEPTANCE_MIN_BYTES = 5 * 1024

function hasPngSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) return false
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/**
 * Read the IHDR chunk: width and height live at bytes 16-23 of a real PNG.
 * Returns null for anything that is not a well-formed PNG header.
 */
function readPngSize(buffer) {
  if (!hasPngSignature(buffer) || buffer.length < PNG_HEADER_BYTES) return null
  const type = buffer.subarray(12, 16).toString('ascii')
  if (type !== 'IHDR') return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}

/**
 * Full verdict for one captured page.
 *
 * @param {Buffer|null} buffer
 * @param {object} [options]
 * @param {number} [options.minBytes]         absolute floor (default 256)
 * @param {number} [options.minEdge]          minimum width/height (default 64)
 * @param {number} [options.bytesPerPixel]    density floor (default 0.002)
 * @param {boolean} [options.acceptance]      also apply the 5 KB spec floor
 */
function inspectCapture(buffer, {
  minBytes = MIN_USEFUL_BYTES,
  minEdge = MIN_USEFUL_EDGE,
  bytesPerPixel = MIN_BYTES_PER_PIXEL,
  acceptance = false
} = {}) {
  const problems = []
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, bytes: 0, width: 0, height: 0, density: 0, problems: ['no image buffer was produced'] }
  }
  if (!hasPngSignature(buffer)) problems.push('the buffer is not a PNG')
  const size = readPngSize(buffer)
  if (!size) problems.push('the PNG header is missing or malformed')
  if (size && (size.width < minEdge || size.height < minEdge)) {
    problems.push(`the capture is too narrow or too short to be a UI: ${size.width}x${size.height} (minimum ${minEdge}px)`)
  }
  if (buffer.length < minBytes) {
    problems.push(`the image is only ${buffer.length} bytes (minimum ${minBytes})`)
  }
  if (acceptance && buffer.length < ACCEPTANCE_MIN_BYTES) {
    problems.push(`the image is only ${buffer.length} bytes (acceptance minimum ${ACCEPTANCE_MIN_BYTES})`)
  }
  const pixels = size ? size.width * size.height : 0
  const density = pixels ? buffer.length / pixels : 0
  if (pixels && density < bytesPerPixel) {
    problems.push(`the image is nearly blank: ${buffer.length} bytes for ${pixels} pixels (${density.toFixed(5)} bytes/px)`)
  }
  return {
    ok: problems.length === 0,
    bytes: buffer.length,
    width: size ? size.width : 0,
    height: size ? size.height : 0,
    density: Number(density.toFixed(5)),
    problems
  }
}

/**
 * Validate a set of captured pages, e.g. `{ 'dock-main': <Buffer> }`.
 * `pages` with no entry at all are reported as missing, which is what makes an
 * empty capture distinguishable from an unrequested page.
 */
function inspectCaptures(screenshots = {}, { pages = null, ...options } = {}) {
  const names = pages && pages.length ? pages : Object.keys(screenshots || {})
  const entries = {}
  const failures = []
  for (const name of names) {
    const buffer = screenshots ? screenshots[name] : null
    const verdict = inspectCapture(buffer || null, options)
    entries[name] = verdict
    if (!verdict.ok) failures.push({ page: name, problems: verdict.problems })
  }
  return {
    ok: failures.length === 0 && names.length > 0,
    captured: names.filter((name) => entries[name] && entries[name].ok).length,
    requested: names.length,
    entries,
    failures
  }
}

module.exports = {
  PNG_SIGNATURE,
  MIN_USEFUL_BYTES,
  MIN_USEFUL_EDGE,
  MIN_BYTES_PER_PIXEL,
  ACCEPTANCE_MIN_BYTES,
  hasPngSignature,
  readPngSize,
  inspectCapture,
  inspectCaptures
}
