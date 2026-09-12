'use strict'

/**
 * Minimal, dependency-free tar reader.
 *
 * Installing a skill from GitHub means downloading a repository archive
 * (`codeload.github.com/.../tar.gz`). The repository has no tar package and the
 * runtime must not be allowed to require one at theme/skill time, so the small
 * subset needed here — ustar/pax headers, regular files and directories — is
 * read directly.
 *
 * Safety is the point of this module, not convenience:
 *   - every entry path is normalized and refused if it escapes the destination;
 *   - absolute paths and `..` segments are rejected outright;
 *   - symlinks, hardlinks and device nodes are never materialized;
 *   - total extracted bytes and entry count are capped.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const BLOCK_SIZE = 512
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 4096

/** Read the NUL-terminated string field at `offset`. */
function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim()
}

/** Read a NUL/space-terminated octal field. */
function readOctal(buffer, offset, length) {
  const text = readString(buffer, offset, length).replace(/\0/g, '').trim()
  if (!text) return 0
  const value = parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/** Is this a valid 512-byte tar header block? */
function isHeaderBlock(block) {
  if (block.length < BLOCK_SIZE) return false
  // The ustar magic lives at offset 257; ancient tars omit it but still carry a
  // checksum, which is verified in `readChecksum`.
  return readChecksum(block) !== null
}

function readChecksum(block) {
  const stored = readOctal(block, 148, 8)
  if (!stored) return null
  let sum = 0
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    // The checksum field itself is treated as spaces.
    sum += index >= 148 && index < 156 ? 32 : block[index]
  }
  return sum === stored ? stored : null
}

/** A header that is entirely zeroes marks the end of the archive. */
function isZeroBlock(block) {
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    if (block[index] !== 0) return false
  }
  return true
}

const TYPE_FILE = new Set(['0', '\0', '', '7'])
const TYPE_DIRECTORY = new Set(['5'])
const TYPE_PAX = new Set(['x', 'g'])
const TYPE_LONG_NAME = new Set(['L'])
const TYPE_UNSUPPORTED = new Set(['1', '2', '3', '4', '6'])

/**
 * Decompress a gzip buffer, tolerating an already-uncompressed tar.
 */
function maybeGunzip(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return zlib.gunzipSync(buffer)
  }
  return buffer
}

/** Normalize an archive entry path; returns null when it must be refused. */
function safeRelativePath(raw) {
  let text = String(raw || '').replace(/\\/g, '/')
  // Strip a leading `./` and the archive's own top-level directory marker later.
  text = text.replace(/^\.\//, '')
  if (!text) return null
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null
  const segments = []
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  if (!segments.length) return null
  return segments.join('/')
}

/**
 * Iterate the entries of a tar buffer.
 *
 * @param {Buffer} buffer
 * @param {{maxEntries?: number}} [options]
 * @returns {Array<{path: string, type: string, mode: number, size: number, data: Buffer|null, linkName: string|null}>}
 */
function readEntries(buffer, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = []
  let offset = 0
  let longName = null
  let paxPath = null

  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break
    if (!isHeaderBlock(header)) {
      throw new Error(`unsupported tar structure at byte ${offset}`)
    }
    const typeFlag = String.fromCharCode(header[156]) || '0'
    const size = readOctal(header, 124, 12)
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size
    if (size < 0 || dataEnd > buffer.length) throw new Error('truncated tar entry')
    const data = buffer.subarray(dataStart, dataEnd)

    if (TYPE_LONG_NAME.has(typeFlag)) {
      longName = data.subarray(0, Math.max(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0))).toString('utf8')
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
      continue
    }
    if (TYPE_PAX.has(typeFlag)) {
      const parsed = parsePax(data.toString('utf8'))
      if (parsed.path) paxPath = parsed.path
      offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
      continue
    }

    const rawName = paxPath || longName || readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const fullName = prefix ? `${prefix}/${rawName}` : rawName
    longName = null
    paxPath = null

    const normalized = safeRelativePath(fullName)
    if (normalized) {
      entries.push({
        path: normalized,
        type: TYPE_DIRECTORY.has(typeFlag) ? 'directory' : TYPE_FILE.has(typeFlag) ? 'file' : TYPE_UNSUPPORTED.has(typeFlag) ? 'unsupported' : 'other',
        mode: readOctal(header, 100, 8) & 0o777,
        size,
        data: dataStart < dataEnd ? Buffer.from(data) : Buffer.alloc(0),
        linkName: readString(header, 157, 100) || null
      })
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (entries.length > maxEntries) throw new Error(`tar archive exceeds ${maxEntries} entries`)
  }
  return entries
}

/** Parse a pax extended header record set. */
function parsePax(text) {
  const out = {}
  for (const line of String(text).split('\n')) {
    const match = line.match(/^(\d+) ([^=]+)=(.*)$/)
    if (match) out[match[2]] = match[3]
  }
  return { path: out.path || null, linkpath: out.linkpath || null }
}

/**
 * Extract selected entries from a gzipped tar buffer.
 *
 * @param {object} options
 * @param {Buffer} options.buffer      the downloaded archive
 * @param {string} options.destDir     extraction root
 * @param {(entryPath: string) => boolean} [options.select]  which entries to keep
 * @param {number} [options.stripComponents=0]  leading path components to drop
 * @param {number} [options.maxBytes]
 */
function extractTar({ buffer, destDir, select = null, stripComponents = 0, maxBytes = DEFAULT_MAX_BYTES }) {
  const tar = maybeGunzip(buffer)
  const entries = readEntries(tar)
  const written = []
  const skipped = []
  let total = 0

  const root = path.resolve(destDir)
  fs.mkdirSync(root, { recursive: true })

  for (const entry of entries) {
    const segments = entry.path.split('/')
    const relative = segments.slice(stripComponents).join('/')
    if (!relative) continue
    if (entry.type === 'unsupported') {
      skipped.push({ path: entry.path, reason: 'unsupported entry type (link or device)' })
      continue
    }
    if (select && !select(relative, entry)) continue
    const target = path.resolve(root, relative)
    // Second line of defence: the resolved path must stay inside the destination.
    if (target !== root && !target.startsWith(root + path.sep)) {
      skipped.push({ path: entry.path, reason: 'path escapes the extraction root' })
      continue
    }
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    total += entry.size
    if (total > maxBytes) throw new Error(`archive exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data, { mode: entry.mode || 0o644 })
    written.push(relative)
  }

  return { entries: entries.length, written, skipped, bytes: total }
}

/** List an archive's entry paths without writing anything (used for planning). */
function listEntries(buffer) {
  return readEntries(maybeGunzip(buffer)).map((entry) => ({ path: entry.path, type: entry.type, size: entry.size }))
}

module.exports = {
  BLOCK_SIZE,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  readString,
  readOctal,
  readChecksum,
  safeRelativePath,
  maybeGunzip,
  readEntries,
  parsePax,
  extractTar,
  listEntries
}
