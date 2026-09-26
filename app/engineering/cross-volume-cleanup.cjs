'use strict'

/** Ownership-scoped cleanup for episode scratch outside the durable work volume. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const OWNER_MARKER = '.dshns-episode-owner.json'
const PURPOSE_CLASSES = new Set(['clone', 'copy', 'unpack', 'build', 'cache', 'test', 'log', 'download', 'tool-scratch', 'other'])
const CLEANUP_STATES = new Set(['ACTIVE', 'DELETE_PENDING', 'DELETED', 'CLEANUP_BLOCKED'])
const MAX_ENTRIES = 1000

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizedPath(value) {
  return path.resolve(String(value || ''))
}

function volumeOf(value) {
  const parsed = path.parse(normalizedPath(value))
  return process.platform === 'win32' ? parsed.root.toLowerCase() : parsed.root
}

function samePath(left, right) {
  const a = normalizedPath(left)
  const b = normalizedPath(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function resultError(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason || code), ...extra }
}

function isReparse(stat) {
  return Boolean(stat && (stat.isSymbolicLink() || (Number.isInteger(stat.attributes) && (stat.attributes & 0x400) !== 0)))
}

function assertNoReparseAncestors(target) {
  const absolute = normalizedPath(target)
  const root = path.parse(absolute).root
  if (!root) throw Object.assign(new Error('path has no canonical volume root'), { code: 'TEMP_PATH_INVALID' })
  let cursor = root
  const rest = absolute.slice(root.length).split(path.sep).filter(Boolean)
  for (const part of rest) {
    cursor = path.join(cursor, part)
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (error && error.code === 'ENOENT') break
      throw error
    }
    if (isReparse(stat)) throw Object.assign(new Error(`reparse boundary refused: ${cursor}`), { code: 'TEMP_PATH_REPARSE_BOUNDARY' })
  }
}

function canonicalExistingPath(target) {
  const absolute = normalizedPath(target)
  assertNoReparseAncestors(absolute)
  if (!fs.existsSync(absolute)) return absolute
  const real = fs.realpathSync.native ? fs.realpathSync.native(absolute) : fs.realpathSync(absolute)
  if (!samePath(absolute, real)) throw Object.assign(new Error('path does not resolve to its canonical spelling'), { code: 'TEMP_PATH_NONCANONICAL' })
  return real
}

function isWithin(root, candidate) {
  if (samePath(root, candidate)) return true
  const relative = path.relative(normalizedPath(root), normalizedPath(candidate))
  return Boolean(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function inspectOwnedTree(root, rootEntry, registryEntries, episodeId, workRootIdentity) {
  const rootPath = normalizedPath(root)
  const allowedFiles = new Set([path.join(rootPath, OWNER_MARKER)])
  const allowedDirectories = new Set([rootPath])
  for (const entry of registryEntries) {
    if (entry.cleanupState === 'DELETED' || samePath(entry.path, rootPath) || !isWithin(rootPath, entry.path)) continue
    let cursor = path.dirname(entry.path)
    while (isWithin(rootPath, cursor)) {
      allowedDirectories.add(normalizedPath(cursor))
      if (samePath(cursor, rootPath)) break
      cursor = path.dirname(cursor)
    }
    if (entry.type === 'file') {
      allowedFiles.add(normalizedPath(entry.path))
    } else if (entry.type === 'directory') {
      allowedDirectories.add(normalizedPath(entry.path))
      allowedFiles.add(normalizedPath(entry.markerPath))
      const stat = fs.lstatSync(entry.path)
      if (!stat.isDirectory() || isReparse(stat)) throw Object.assign(new Error(`registered nested directory is not a plain directory: ${entry.path}`), { code: 'TEMP_ENTRY_TYPE_MISMATCH' })
      const markerStat = fs.lstatSync(entry.markerPath)
      if (!markerStat.isFile() || isReparse(markerStat)) throw Object.assign(new Error(`registered nested ownership marker is not a plain file: ${entry.markerPath}`), { code: 'TEMP_MARKER_MISMATCH' })
      const marker = JSON.parse(fs.readFileSync(entry.markerPath, 'utf8'))
      if (marker.version !== 1 || marker.episodeId !== episodeId || marker.workRootIdentity !== workRootIdentity) {
        throw Object.assign(new Error(`registered nested ownership marker does not match: ${entry.markerPath}`), { code: 'TEMP_MARKER_MISMATCH' })
      }
    }
  }

  const stack = [rootPath]
  while (stack.length) {
    const current = stack.pop()
    const stat = fs.lstatSync(current)
    if (isReparse(stat)) throw Object.assign(new Error(`reparse boundary refused: ${current}`), { code: 'TEMP_PATH_REPARSE_BOUNDARY' })
    if (!stat.isDirectory()) continue
    for (const name of fs.readdirSync(current)) {
      const child = path.join(current, name)
      const childStat = fs.lstatSync(child)
      if (isReparse(childStat)) throw Object.assign(new Error(`reparse boundary refused: ${child}`), { code: 'TEMP_PATH_REPARSE_BOUNDARY' })
      if (childStat.isDirectory()) {
        if (!allowedDirectories.has(normalizedPath(child))) {
          throw Object.assign(new Error(`unregistered directory inside task scratch: ${child}`), { code: 'TEMP_UNREGISTERED_CHILD' })
        }
        stack.push(child)
      } else if (!childStat.isFile() || !allowedFiles.has(normalizedPath(child))) {
        throw Object.assign(new Error(`unregistered file inside task scratch: ${child}`), { code: 'TEMP_UNREGISTERED_CHILD' })
      }
    }
  }
}

function validateRestoredEntry(entry, episodeId, workRoot, workRootIdentity) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.episodeId !== episodeId ||
    typeof entry.path !== 'string' || !path.isAbsolute(entry.path) ||
    typeof entry.canonicalPath !== 'string' || !samePath(entry.path, entry.canonicalPath) ||
    !['file', 'directory'].includes(entry.type) || !PURPOSE_CLASSES.has(entry.purposeClass) ||
    entry.createdByEpisode !== true || !Number.isFinite(entry.registeredAt) || !CLEANUP_STATES.has(entry.cleanupState)) {
    return resultError('CROSS_VOLUME_REGISTRY_INVALID', 'a restored scratch registration is incomplete or unsupported')
  }
  if (entry.workRootIdentity !== workRootIdentity || !samePath(entry.workRoot, workRoot)) {
    return resultError('CROSS_VOLUME_REGISTRY_INVALID', 'a restored scratch registration belongs to a different work root')
  }
  if (volumeOf(entry.path) === volumeOf(workRoot)) {
    return resultError('TEMP_PATH_NOT_OFF_VOLUME', 'registered scratch must be outside the selected work volume')
  }
  if (entry.type === 'directory' && entry.markerPath !== path.join(normalizedPath(entry.path), OWNER_MARKER)) {
    return resultError('CROSS_VOLUME_REGISTRY_INVALID', 'a directory registration has an unexpected owner-marker path')
  }
  if (entry.type === 'file' && !/^sha256:[a-f0-9]{64}$/.test(entry.contentDigest || '')) {
    return resultError('CROSS_VOLUME_REGISTRY_INVALID', 'a file registration must include its creation content digest')
  }
  return { ok: true }
}

/**
 * `onChange(entries)` must synchronously persist the snapshot on the work volume.
 * A failed persistence write prevents creation/deletion, so an off-volume effect
 * is never performed without durable ownership/debt state.
 */
function createCrossVolumeTempRegistry(input = {}) {
  const episodeId = String(input.episodeId || '')
  const workRoot = normalizedPath(input.workRoot)
  const onChange = typeof input.onChange === 'function' ? input.onChange : () => {}
  const now = typeof input.now === 'function' ? input.now : Date.now
  const maxRetries = Number.isInteger(input.maxRetries) ? Math.max(0, Math.min(input.maxRetries, 5)) : 2
  const workRootIdentity = `sha256:${hash(process.platform === 'win32' ? workRoot.toLowerCase() : workRoot)}`
  let entries = []
  let initializationError = null

  if (!episodeId || episodeId.length > 512 || !path.isAbsolute(workRoot)) {
    initializationError = resultError('CROSS_VOLUME_REGISTRY_INVALID', 'episodeId and an absolute workRoot are required')
  } else {
    try {
      const workStat = fs.lstatSync(workRoot)
      if (isReparse(workStat) || !workStat.isDirectory()) throw Object.assign(new Error('the selected work root must be an existing non-reparse directory'), { code: 'WORK_ROOT_INVALID' })
      const canonicalWorkRoot = canonicalExistingPath(workRoot)
      if (!samePath(canonicalWorkRoot, workRoot)) throw Object.assign(new Error('the selected work root is not canonical'), { code: 'WORK_ROOT_INVALID' })
      const restored = Array.isArray(input.entries) ? input.entries : []
      if (restored.length > MAX_ENTRIES) throw Object.assign(new Error('too many cross-volume registrations'), { code: 'CROSS_VOLUME_REGISTRY_INVALID' })
      for (const entry of restored) {
        const checked = validateRestoredEntry(entry, episodeId, workRoot, workRootIdentity)
        if (!checked.ok) throw Object.assign(new Error(checked.reason), { code: checked.code })
      }
      entries = clone(restored)
    } catch (error) {
      initializationError = resultError(error.code || 'WORK_ROOT_INVALID', error.message)
    }
  }

  function snapshot() {
    return clone(entries)
  }

  function persist(nextEntries) {
    const previous = entries
    entries = nextEntries
    try {
      onChange(snapshot())
      return { ok: true }
    } catch (error) {
      entries = previous
      return resultError('CLEANUP_DEBT_PERSIST_FAILED', error && error.message ? error.message : error)
    }
  }

  function validateNewTarget(target) {
    if (initializationError) return initializationError
    if (typeof target !== 'string' || !path.isAbsolute(target)) return resultError('TEMP_PATH_INVALID', 'a canonical absolute temporary path is required')
    const absolute = normalizedPath(target)
    if (volumeOf(absolute) === volumeOf(workRoot)) return resultError('TEMP_PATH_NOT_OFF_VOLUME', 'task scratch on the selected work volume is not cross-volume cleanup material')
    try {
      assertNoReparseAncestors(path.dirname(absolute))
      const parent = canonicalExistingPath(path.dirname(absolute))
      if (!samePath(parent, path.dirname(absolute)) || !fs.statSync(parent).isDirectory()) {
        return resultError('TEMP_PATH_INVALID', 'the temporary path parent must be an existing canonical directory')
      }
      if (fs.existsSync(absolute)) return resultError('TEMP_PATH_ALREADY_EXISTS', 'refusing to claim a pre-existing path')
      return { ok: true, path: absolute }
    } catch (error) {
      return resultError(error.code || 'TEMP_PATH_INVALID', error.message)
    }
  }

  function addEntry(entry) {
    if (entries.length >= MAX_ENTRIES) return resultError('CROSS_VOLUME_REGISTRY_LIMIT', 'the episode scratch registry reached its entry limit')
    const next = [...entries, entry]
    const saved = persist(next)
    return saved.ok ? { ok: true, entry: clone(entry) } : saved
  }

  function createTaskDirectory(options = {}) {
    const checked = validateNewTarget(options.path)
    if (!checked.ok) return checked
    if (!PURPOSE_CLASSES.has(options.purposeClass)) return resultError('TEMP_PURPOSE_INVALID', 'purposeClass is not in the supported cleanup taxonomy')
    const target = checked.path
    const entry = {
      path: target,
      canonicalPath: target,
      episodeId,
      workRoot,
      workRootIdentity,
      type: 'directory',
      purposeClass: options.purposeClass,
      createdByEpisode: true,
      registeredAt: now(),
      cleanupState: 'ACTIVE',
      markerPath: path.join(target, OWNER_MARKER)
    }
    const registered = addEntry(entry)
    if (!registered.ok) return registered
    try {
      fs.mkdirSync(target, { recursive: false })
      fs.writeFileSync(entry.markerPath, `${JSON.stringify({ version: 1, episodeId, workRootIdentity })}\n`, { encoding: 'utf8', flag: 'wx' })
      return { ok: true, entry: clone(entry) }
    } catch (error) {
      return resultError('TEMP_CREATE_FAILED', error.message, { entry: clone(entry) })
    }
  }

  function createRegisteredFile(options = {}) {
    const checked = validateNewTarget(options.path)
    if (!checked.ok) return checked
    if (!PURPOSE_CLASSES.has(options.purposeClass)) return resultError('TEMP_PURPOSE_INVALID', 'purposeClass is not in the supported cleanup taxonomy')
    const bytes = Buffer.isBuffer(options.content) ? Buffer.from(options.content) : Buffer.from(String(options.content === undefined ? '' : options.content), 'utf8')
    const entry = {
      path: checked.path,
      canonicalPath: checked.path,
      episodeId,
      workRoot,
      workRootIdentity,
      type: 'file',
      purposeClass: options.purposeClass,
      createdByEpisode: true,
      registeredAt: now(),
      cleanupState: 'ACTIVE',
      contentDigest: `sha256:${hash(bytes)}`
    }
    const registered = addEntry(entry)
    if (!registered.ok) return registered
    try {
      const descriptor = fs.openSync(entry.path, 'wx')
      try { fs.writeFileSync(descriptor, bytes) } finally { fs.closeSync(descriptor) }
      return { ok: true, entry: clone(entry) }
    } catch (error) {
      return resultError('TEMP_CREATE_FAILED', error.message, { entry: clone(entry) })
    }
  }

  function verifyDirectory(entry) {
    const candidate = canonicalExistingPath(entry.path)
    if (!samePath(candidate, entry.path)) throw Object.assign(new Error('registered directory no longer has its canonical path'), { code: 'TEMP_PATH_NONCANONICAL' })
    const stat = fs.lstatSync(candidate)
    if (!stat.isDirectory() || isReparse(stat)) throw Object.assign(new Error('registered directory is not a plain directory'), { code: 'TEMP_ENTRY_TYPE_MISMATCH' })
    const markerStat = fs.lstatSync(entry.markerPath)
    if (!markerStat.isFile() || isReparse(markerStat)) throw Object.assign(new Error('the ownership marker is not a plain file'), { code: 'TEMP_MARKER_MISMATCH' })
    const marker = JSON.parse(fs.readFileSync(entry.markerPath, 'utf8'))
    if (marker.version !== 1 || marker.episodeId !== episodeId || marker.workRootIdentity !== workRootIdentity) {
      throw Object.assign(new Error('the ownership marker does not match the durable episode/work-root registry'), { code: 'TEMP_MARKER_MISMATCH' })
    }
    inspectOwnedTree(candidate, entry, entries, episodeId, workRootIdentity)
    return candidate
  }

  function verifyFile(entry) {
    const candidate = canonicalExistingPath(entry.path)
    if (!samePath(candidate, entry.path)) throw Object.assign(new Error('registered file no longer has its canonical path'), { code: 'TEMP_PATH_NONCANONICAL' })
    const stat = fs.lstatSync(candidate)
    if (!stat.isFile() || isReparse(stat)) throw Object.assign(new Error('registered file is not a plain file'), { code: 'TEMP_ENTRY_TYPE_MISMATCH' })
    const digest = `sha256:${hash(fs.readFileSync(candidate))}`
    if (digest !== entry.contentDigest) throw Object.assign(new Error('registered file content no longer matches the episode-created fingerprint'), { code: 'TEMP_FILE_CONTENT_MISMATCH' })
    return candidate
  }

  function cleanupTerminal(options = {}) {
    if (initializationError) return initializationError
    if (options.terminal !== true) return { ok: true, skipped: true, reason: 'episode is not terminal', deleted: [], residuals: [] }
    const deleted = []
    const residuals = []
    for (let index = 0; index < entries.length; index += 1) {
      const current = entries[index]
      if (current.cleanupState === 'DELETED') continue
      const pending = { ...current, cleanupState: 'DELETE_PENDING' }
      const pendingEntries = entries.slice()
      pendingEntries[index] = pending
      const persisted = persist(pendingEntries)
      if (!persisted.ok) {
        residuals.push({ path: current.path, code: persisted.code, reason: persisted.reason })
        continue
      }

      let failure = null
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          // Re-check every ancestor after intent is durable and immediately before deletion.
          assertNoReparseAncestors(current.path)
          if (current.type === 'directory') {
            if (fs.existsSync(current.path)) fs.rmSync(verifyDirectory(current), { recursive: true, force: false, maxRetries: 0 })
          } else if (current.type === 'file') {
            if (fs.existsSync(current.path)) fs.unlinkSync(verifyFile(current))
          } else {
            throw Object.assign(new Error('unsupported registered entry type'), { code: 'CROSS_VOLUME_REGISTRY_INVALID' })
          }
          if (fs.existsSync(current.path)) throw Object.assign(new Error('registered path remains after deletion'), { code: 'CLEANUP_RESIDUAL' })
          failure = null
          break
        } catch (error) {
          failure = error
          if (error && ['TEMP_MARKER_MISMATCH', 'TEMP_PATH_REPARSE_BOUNDARY', 'TEMP_PATH_NONCANONICAL', 'TEMP_ENTRY_TYPE_MISMATCH', 'TEMP_FILE_CONTENT_MISMATCH', 'TEMP_UNREGISTERED_CHILD', 'CROSS_VOLUME_REGISTRY_INVALID'].includes(error.code)) break
        }
      }

      const final = failure
        ? { ...pending, cleanupState: 'CLEANUP_BLOCKED', cleanupError: String(failure.code || 'CLEANUP_BLOCKED'), cleanupReason: String(failure.message || failure) }
        : { ...pending, cleanupState: 'DELETED', cleanupError: null, cleanupReason: null }
      const finalEntries = entries.slice()
      finalEntries[index] = final
      const finalPersisted = persist(finalEntries)
      if (!finalPersisted.ok) {
        residuals.push({ path: current.path, code: finalPersisted.code, reason: finalPersisted.reason })
      } else if (failure) {
        residuals.push({ path: current.path, code: final.cleanupError, reason: final.cleanupReason })
      } else {
        deleted.push(current.path)
      }
    }

    // Rescan all still-owned registrations; a state write alone is not cleanup proof.
    for (const entry of entries) {
      if (entry.cleanupState === 'DELETED') {
        if (fs.existsSync(entry.path)) residuals.push({ path: entry.path, code: 'CLEANUP_RESIDUAL', reason: 'a registered path reappeared after cleanup' })
      } else if (!residuals.some((residual) => samePath(residual.path, entry.path))) {
        residuals.push({ path: entry.path, code: entry.cleanupError || 'CLEANUP_BLOCKED', reason: entry.cleanupReason || 'registered cleanup debt remains' })
      }
    }
    return { ok: residuals.length === 0, skipped: false, reason: options.reason || null, deleted, residuals, entries: snapshot() }
  }

  return {
    episodeId,
    workRoot,
    workRootIdentity,
    initializationError,
    list: snapshot,
    createTaskDirectory,
    createRegisteredFile,
    cleanupTerminal,
    retryCleanupDebt() {
      return cleanupTerminal({ terminal: true, reason: 'cleanup_debt_retry' })
    }
  }
}

module.exports = { createCrossVolumeTempRegistry, OWNER_MARKER, PURPOSE_CLASSES, CLEANUP_STATES }
