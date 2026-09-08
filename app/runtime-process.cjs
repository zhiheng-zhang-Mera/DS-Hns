'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function ownershipPath(root) {
  return path.join(root, 'runtime', 'dsh-process.json')
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

function readOwnership(root) {
  try {
    return JSON.parse(fs.readFileSync(ownershipPath(root), 'utf8'))
  } catch {
    return null
  }
}

function writeOwnership({ root, dshEntry, childPid, parentPid = process.pid }) {
  if (!Number.isInteger(childPid) || childPid <= 0) return
  try {
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
    fs.writeFileSync(ownershipPath(root), JSON.stringify({
      version: 1,
      root: path.resolve(root),
      dshEntry: path.resolve(dshEntry),
      childPid,
      parentPid,
      startedAt: new Date().toISOString()
    }, null, 2), 'utf8')
  } catch {}
}

function clearOwnership({ root, childPid } = {}) {
  if (!root) return
  const file = ownershipPath(root)
  try {
    if (childPid !== undefined) {
      const owned = readOwnership(root)
      if (owned && Number(owned.childPid) !== Number(childPid)) return
    }
    fs.rmSync(file, { force: true })
  } catch {}
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

function killTree(pid) {
  if (!processExists(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000
    })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

async function recoverOwnedStale({ root, dshEntry, log = () => {} }) {
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

module.exports = {
  ownershipPath,
  readOwnership,
  writeOwnership,
  clearOwnership,
  recoverOwnedStale,
  isExpectedDshProcess
}
