'use strict'
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * Official harness alignment (Mega "拓展状态" module).
 *
 * The main harness is the official `@deepseek-ai/dsh` package installed under
 * `app\node_modules`. Aligning with the official latest version therefore means
 * exactly three things, and nothing else:
 *
 *   1. read the installed version and the official registry dist-tag,
 *   2. pin `app\package.json` to that version and run npm install (a separate
 *      detached runner does this after this process has exited, so Windows file
 *      locks can never break the install),
 *   3. relaunch DS-Harness so the shell boots the new harness.
 *
 * Everything here is read-only bookkeeping plus one detached spawn. The module
 * never mutates `node_modules` itself, never touches the official renderer and
 * never throws into the dock: every failure becomes a described status.
 */

const PACKAGE_NAME = '@deepseek-ai/dsh'
const DEFAULT_DIST_TAG = 'latest'
const REGISTRY_HOST = 'registry.npmjs.org'
const REGISTRY_PATH = '/@deepseek-ai%2fdsh'
const CHECK_TIMEOUT_MS = 12_000
const MAX_ERROR_LENGTH = 400

/** Registry documents are large; the abbreviated install metadata is not. */
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json'

const UPDATE_STATUSES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  CURRENT: 'current',
  OUTDATED: 'outdated',
  UPDATING: 'updating',
  FAILED: 'failed'
})

function truncate(value, limit = MAX_ERROR_LENGTH) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Strict semver parsing for the subset the registry actually publishes
 * (`1.2.3`, `1.2.3-rc.1`, optional build metadata). Anything else is treated as
 * "unknown", never as "newer", so a malformed tag can not trigger an update.
 */
function parseVersion(value) {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right))
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** semver ordering: -1 | 0 | 1. Unparseable input compares as equal. */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i])
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0
  // A release outranks any prerelease of the same core version.
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const order = comparePrereleaseIdentifier(x, y)
    if (order) return order
  }
  return 0
}

function isNewer(candidate, current) {
  if (!parseVersion(candidate) || !parseVersion(current)) return false
  return compareVersions(candidate, current) > 0
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readInstalledVersion(appDir) {
  const pkg = readJsonFile(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

function readPinnedVersion(appDir) {
  const manifest = readJsonFile(path.join(appDir, 'package.json'))
  const pinned = manifest?.dependencies?.[PACKAGE_NAME]
  return typeof pinned === 'string' ? pinned : null
}

function readDistTag(document, tag) {
  const tags = document?.['dist-tags']
  const value = tags && typeof tags === 'object' ? tags[tag] : null
  return typeof value === 'string' && parseVersion(value) ? value : null
}

/** Locate the npm CLI that ships with the bundled portable Node runtime. */
function resolveNpmCli(nodeExe, root) {
  const candidates = []
  if (nodeExe) candidates.push(path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  try {
    for (const entry of fs.readdirSync(path.join(root, 'runtime'), { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(root, 'runtime', entry.name, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
  } catch {
    // No bundled runtime directory: fall through to "npm unavailable".
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // A single unreadable candidate must not hide a later valid one.
    }
  }
  return null
}

/** One HTTPS GET against the npm registry; resolves, never rejects. */
function fetchRegistryDocument({ timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let request
    try {
      request = https.get({
        host: REGISTRY_HOST,
        path: REGISTRY_PATH,
        headers: { accept: REGISTRY_ACCEPT, 'user-agent': 'ds-hns-mega-updater' },
        timeout: timeoutMs
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish({ ok: false, error: `registry responded with HTTP ${response.statusCode}` })
          return
        }
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          try {
            finish({ ok: true, document: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          } catch (error) {
            finish({ ok: false, error: `registry payload was not JSON: ${error?.message || error}` })
          }
        })
        response.on('error', (error) => finish({ ok: false, error: String(error?.message || error) }))
      })
    } catch (error) {
      finish({ ok: false, error: String(error?.message || error) })
      return
    }
    request.on('timeout', () => {
      request.destroy()
      finish({ ok: false, error: `registry request timed out after ${timeoutMs} ms` })
    })
    request.on('error', (error) => finish({ ok: false, error: String(error?.message || error) }))
  })
}

class HarnessUpdater {
  constructor({
    root,
    appDir = path.join(root, 'app'),
    nodeExe = '',
    stateDir = path.join(root, 'data', 'state'),
    log = () => {},
    runnerPath = path.join(__dirname, 'update-runner.js'),
    fetchRegistryDocument: fetch = fetchRegistryDocument,
    spawnProcess = spawn,
    now = () => Date.now()
  } = {}) {
    this.root = root
    this.appDir = appDir
    this.nodeExe = nodeExe
    this.stateDir = stateDir
    this.markerPath = path.join(stateDir, 'mega-update.json')
    this.logPath = path.join(root, 'logs', 'mega-update.log')
    this.log = log
    this.runnerPath = runnerPath
    this.fetchRegistryDocument = fetch
    this.spawnProcess = spawnProcess
    this.now = now

    this.status = UPDATE_STATUSES.IDLE
    this.tag = DEFAULT_DIST_TAG
    this.latestVersion = null
    this.checkedAt = null
    this.error = null
    this.npmCli = null
    this.checking = false
  }

  /** Installed first, pinned second: the pin alone can lag behind reality. */
  currentVersion() {
    return readInstalledVersion(this.appDir) || readPinnedVersion(this.appDir)
  }

  readMarker() {
    return readJsonFile(this.markerPath)
  }

  writeMarker(payload) {
    try {
      fs.mkdirSync(path.dirname(this.markerPath), { recursive: true })
      fs.writeFileSync(this.markerPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      this.log(`update marker write failed: ${error?.message || error}`)
      return false
    }
  }

  /**
   * A marker written by an earlier process is a report; a marker written by
   * THIS process describes work currently in flight and is not a result yet.
   */
  lastUpdate() {
    const marker = this.readMarker()
    if (!marker || typeof marker !== 'object') return null
    if (marker.pid === process.pid) return null
    const status = marker.status === 'updating' ? 'interrupted' : marker.status
    const rollback = marker.rollback && typeof marker.rollback === 'object'
      ? {
          ok: Boolean(marker.rollback.ok),
          code: marker.rollback.code || null,
          restoredVersion: marker.rollback.restoredVersion || null,
          installedVersion: marker.rollback.installedVersion ?? null,
          message: marker.rollback.message || null
        }
      : null
    return {
      ...marker,
      status,
      rollback,
      // The one outcome the user must not miss: the update failed *and* the
      // previous version could not be restored, so the installation may be
      // inconsistent until the next successful install.
      rollbackFailed: status === 'failed_rollback_failed',
      rolledBack: status === 'failed_rolled_back' && Boolean(rollback?.ok)
    }
  }

  describe() {
    const current = this.currentVersion()
    const latest = this.latestVersion
    const updateAvailable = Boolean(latest && current && isNewer(latest, current))
    const status = this.status === UPDATE_STATUSES.OUTDATED && !updateAvailable
      ? UPDATE_STATUSES.CURRENT
      : this.status
    return {
      status,
      packageName: PACKAGE_NAME,
      tag: this.tag,
      currentVersion: current,
      pinnedVersion: readPinnedVersion(this.appDir),
      latestVersion: latest,
      updateAvailable,
      checkedAt: this.checkedAt,
      npmAvailable: Boolean(this.npmCli),
      nodeExe: this.nodeExe || null,
      error: this.error,
      lastUpdate: this.lastUpdate()
    }
  }

  /** Read the official dist-tag and compare it with what is installed. */
  async check({ tag = DEFAULT_DIST_TAG } = {}) {
    if (this.checking) return this.describe()
    this.checking = true
    this.tag = tag
    this.status = UPDATE_STATUSES.CHECKING
    this.error = null
    try {
      const result = await this.fetchRegistryDocument()
      if (!result?.ok) {
        this.error = { code: 'REGISTRY_UNAVAILABLE', message: truncate(result?.error || 'registry unavailable') }
        this.status = UPDATE_STATUSES.FAILED
        return this.describe()
      }
      const version = readDistTag(result.document, tag)
      if (!version) {
        this.error = { code: 'TAG_MISSING', message: `官方未发布 dist-tag "${tag}"` }
        this.status = UPDATE_STATUSES.FAILED
        return this.describe()
      }
      // Warm the npm path here so the dock can disable the button before the
      // user clicks it, instead of failing in the detached runner.
      this.npmCli = this.npmCli || resolveNpmCli(this.nodeExe, this.root)
      this.latestVersion = version
      this.checkedAt = this.now()
      this.status = this.describe().updateAvailable ? UPDATE_STATUSES.OUTDATED : UPDATE_STATUSES.CURRENT
      this.log(`harness update check: installed=${this.currentVersion()} official/${tag}=${version}`)
      return this.describe()
    } finally {
      this.checking = false
    }
  }

  /**
   * Hand the update to the detached runner and return immediately: the caller
   * (the dock) is expected to quit the app right after, because npm can only
   * replace the harness while the harness is not running.
   */
  apply({ tag = DEFAULT_DIST_TAG } = {}) {
    const npmCli = this.npmCli || resolveNpmCli(this.nodeExe, this.root)
    this.npmCli = npmCli
    if (!this.nodeExe) {
      return { started: false, reason: 'NODE_UNAVAILABLE', message: '未找到 Node 运行时，无法更新主 harness。' }
    }
    if (!npmCli) {
      return { started: false, reason: 'NPM_UNAVAILABLE', message: '未找到 npm CLI，无法更新主 harness。' }
    }
    const target = this.latestVersion
    if (!target) {
      return { started: false, reason: 'NO_TARGET', message: '请先检查更新，确认官方最新版本。' }
    }
    const from = this.currentVersion()
    if (!from || !isNewer(target, from)) {
      return { started: false, reason: 'ALREADY_CURRENT', message: `当前已是 ${from || '最新'}，无需更新。` }
    }

    const marker = {
      status: 'updating',
      phase: 'spawning',
      from,
      to: target,
      tag,
      npmCli,
      pid: process.pid,
      startedAt: this.now(),
      finishedAt: null,
      error: null
    }
    this.writeMarker(marker)
    this.status = UPDATE_STATUSES.UPDATING

    const args = [
      this.runnerPath,
      '--root', this.root,
      '--app', this.appDir,
      '--node', this.nodeExe,
      '--npm-cli', npmCli,
      '--target', target,
      '--tag', tag,
      '--parent-pid', String(process.pid)
    ]
    try {
      const child = this.spawnProcess(this.nodeExe, args, {
        cwd: this.root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, DSH_ROOT: this.root }
      })
      child.unref?.()
      this.log(`harness update started: ${from} -> ${target} (runner pid ${child.pid})`)
      return { started: true, from, to: target, tag, runnerPid: child.pid || null }
    } catch (error) {
      const message = truncate(error?.message || error)
      this.status = UPDATE_STATUSES.FAILED
      this.error = { code: 'RUNNER_SPAWN_FAILED', message }
      this.writeMarker({ ...marker, status: 'failed', phase: 'spawning', error: { code: 'RUNNER_SPAWN_FAILED', message }, finishedAt: this.now() })
      return { started: false, reason: 'RUNNER_SPAWN_FAILED', message }
    }
  }
}

module.exports = {
  HarnessUpdater,
  UPDATE_STATUSES,
  PACKAGE_NAME,
  DEFAULT_DIST_TAG,
  parseVersion,
  compareVersions,
  isNewer,
  readDistTag,
  readInstalledVersion,
  readPinnedVersion,
  resolveNpmCli,
  fetchRegistryDocument
}
