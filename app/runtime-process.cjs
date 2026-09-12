'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/**
 * Runtime ownership records.
 *
 * The shell owns more than one managed child now:
 *   harness     -> runtime/dsh-process.json          (the managed DSH web server)
 *   sub-worker  -> runtime/sub-worker-process.json   (the optional executor)
 *
 * The harness record keeps its original path AND its original field names
 * (`version`, `root`, `dshEntry`, `childPid`, `parentPid`, `startedAt`) so an
 * older build, a script, or a human reading the file still understands it. The
 * generic `type` field is additive, and `migrateOwnership` normalizes records
 * written by earlier versions.
 */

const OWNERSHIP_TYPES = Object.freeze({
  harness: 'dsh-process.json',
  'sub-worker': 'sub-worker-process.json'
})

function normalizeType(type) {
  const value = String(type || 'harness')
  return Object.prototype.hasOwnProperty.call(OWNERSHIP_TYPES, value) ? value : 'harness'
}

function ownershipPathFor(root, type = 'harness') {
  return path.join(root, 'runtime', OWNERSHIP_TYPES[normalizeType(type)])
}

/** Legacy signature: the harness ownership file. */
function ownershipPath(root) {
  return ownershipPathFor(root, 'harness')
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Read one ownership record by type.
 * `readOwnership(root)` keeps its legacy meaning (the harness record).
 */
function readOwnershipByType(root, type = 'harness') {
  return readJson(ownershipPathFor(root, type))
}

function readOwnership(root) {
  return readOwnershipByType(root, 'harness')
}

/** Every ownership record currently on disk. */
function readAllOwnership(root) {
  const result = {}
  for (const type of Object.keys(OWNERSHIP_TYPES)) result[type] = readOwnershipByType(root, type)
  return result
}

/**
 * Write an ownership record.
 *
 * Legacy call:   writeOwnership({ root, dshEntry, childPid, parentPid })
 * Generalized:   writeOwnership({ root, type, pid, entry, parentPid, ...extra })
 * Both `childPid` and `pid` are accepted; `childPid` is always written so old
 * readers keep working.
 */
function writeOwnership({
  root,
  type = 'harness',
  dshEntry,
  entry,
  childPid,
  pid,
  parentPid = process.pid,
  ...extra
} = {}) {
  const childPidValue = Number(childPid ?? pid)
  if (!Number.isInteger(childPidValue) || childPidValue <= 0) return null
  const kind = normalizeType(type)
  const resolvedEntry = entry || dshEntry || null
  const record = {
    version: 1,
    type: kind,
    root: path.resolve(root),
    // `dshEntry` is retained for the harness record and reused for the worker's
    // runtime entry, so one reader shape covers both.
    dshEntry: resolvedEntry ? path.resolve(String(resolvedEntry)) : null,
    entry: resolvedEntry ? path.resolve(String(resolvedEntry)) : null,
    childPid: childPidValue,
    parentPid: Number(parentPid) || process.pid,
    startedAt: new Date().toISOString()
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && key !== 'root') record[key] = value
  }
  try {
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
    fs.writeFileSync(ownershipPathFor(root, kind), JSON.stringify(record, null, 2), 'utf8')
    return record
  } catch {
    return null
  }
}

/**
 * Remove an ownership record. Passing `childPid` makes the removal conditional:
 * a record owned by a different child is left alone.
 */
function clearOwnership({ root, type = 'harness', childPid } = {}) {
  if (!root) return false
  const kind = normalizeType(type)
  const file = ownershipPathFor(root, kind)
  try {
    if (childPid !== undefined) {
      const owned = readOwnershipByType(root, kind)
      const ownedPid = Number(owned?.childPid ?? owned?.pid)
      if (owned && ownedPid !== Number(childPid)) return false
    }
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Normalize ownership records written by an older build. The legacy harness
 * format is already accepted, so this only rewrites when fields are missing or
 * the file used an older shape, and it reports exactly what it changed.
 */
function migrateOwnership({ root, log = () => {} } = {}) {
  const migrated = []
  for (const type of Object.keys(OWNERSHIP_TYPES)) {
    const file = ownershipPathFor(root, type)
    if (!fs.existsSync(file)) continue
    const owned = readJson(file)
    if (!owned) {
      fs.rmSync(file, { force: true })
      migrated.push({ type, action: 'dropped-unreadable' })
      continue
    }
    const childPid = Number(owned.childPid ?? owned.pid)
    if (!Number.isInteger(childPid) || childPid <= 0) {
      fs.rmSync(file, { force: true })
      migrated.push({ type, action: 'dropped-pidless' })
      continue
    }
    const needsRewrite = owned.version !== 1 || owned.type !== type || Number(owned.childPid) !== childPid
    if (!needsRewrite) continue
    const rewritten = writeOwnership({
      root,
      type,
      entry: owned.entry || owned.dshEntry || null,
      pid: childPid,
      parentPid: Number(owned.parentPid) || 0,
      workerId: owned.workerId
    })
    if (rewritten) migrated.push({ type, action: 'normalized', childPid })
  }
  if (migrated.length) log(`runtime ownership migration: ${JSON.stringify(migrated)}`)
  return migrated
}

function commandLineForPid(pid) {
  if (!processExists(pid)) return ''
  if (process.platform === 'win32') {
    const ps = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`
    const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    return String(result.stdout || '').trim()
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch {
    return ''
  }
}

function isExpectedDshProcess(pid, dshEntry) {
  const commandLine = commandLineForPid(pid)
  if (!commandLine) return false
  const normalized = commandLine.toLowerCase().replaceAll('/', '\\')
  const expected = path.resolve(dshEntry).toLowerCase().replaceAll('/', '\\')
  return normalized.includes(expected) && /(?:^|\s)web(?:\s|$)/i.test(commandLine)
}

/**
 * A worker process is recognized by its runtime entry point, so recovery can
 * never kill an unrelated node process that happens to reuse the PID.
 */
function isExpectedWorkerProcess(pid, entry) {
  const commandLine = commandLineForPid(pid)
  if (!commandLine) return false
  const normalized = commandLine.toLowerCase().replaceAll('/', '\\')
  const expected = path.resolve(entry || path.join('app', 'sub-worker', 'runtime.cjs')).toLowerCase().replaceAll('/', '\\')
  return normalized.includes(expected)
}

function killTree(pid) {
  if (!processExists(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000
    })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
}

async function recoverOwnedStale({ root, dshEntry, log = () => {} }) {
  migrateOwnership({ root, log })
  const owned = readOwnership(root)
  if (!owned) return false

  const expectedRoot = path.resolve(root)
  const expectedEntry = path.resolve(dshEntry)
  if (path.resolve(String(owned.root || '')) !== expectedRoot || path.resolve(String(owned.dshEntry || '')) !== expectedEntry) {
    clearOwnership({ root })
    return false
  }

  const childPid = Number(owned.childPid)
  const parentPid = Number(owned.parentPid)

  // A live parent means another legitimate DS-Harness shell still owns the child.
  // The Electron single-instance lock normally prevents reaching this branch, but
  // preserving the owner here avoids killing an active application.
  if (processExists(parentPid)) {
    log(`runtime ownership still has live parent PID ${parentPid}; leaving child untouched`)
    return false
  }

  if (processExists(childPid) && isExpectedDshProcess(childPid, dshEntry)) {
    log(`recovering orphaned DSH child PID ${childPid}`)
    killTree(childPid)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  clearOwnership({ root })
  return true
}

/**
 * Reclaim an orphaned sub-worker process (plan §25/§28, AC-10). Runs before a
 * new worker is ever started, so "no orphan worker" survives a hard shell kill.
 */
async function recoverStaleWorker({ root, entry, log = () => {} }) {
  migrateOwnership({ root, log })
  const owned = readOwnershipByType(root, 'sub-worker')
  if (!owned) return { recovered: false, reason: 'no record' }

  const childPid = Number(owned.childPid ?? owned.pid)
  const parentPid = Number(owned.parentPid)
  if (processExists(parentPid) && parentPid !== process.pid) {
    log(`sub-worker ownership still has live parent PID ${parentPid}; leaving it untouched`)
    return { recovered: false, reason: 'live parent' }
  }

  let killed = false
  if (processExists(childPid) && isExpectedWorkerProcess(childPid, entry || owned.entry || owned.dshEntry)) {
    log(`recovering orphaned sub-worker PID ${childPid}`)
    killTree(childPid)
    killed = true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  clearOwnership({ root, type: 'sub-worker' })
  return { recovered: true, killed, childPid }
}

module.exports = {
  OWNERSHIP_TYPES,
  ownershipPath,
  ownershipPathFor,
  readOwnership,
  readOwnershipByType,
  readAllOwnership,
  writeOwnership,
  clearOwnership,
  migrateOwnership,
  recoverOwnedStale,
  recoverStaleWorker,
  isExpectedDshProcess,
  isExpectedWorkerProcess,
  killTree,
  processExists,
  commandLineForPid
}
