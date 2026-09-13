'use strict'

/**
 * The plugin store installer: stage, then enable.
 *
 * Installing a plugin means putting somebody else's code on this machine and then running it,
 * so this module splits that into two deliberate steps and refuses to blur them:
 *
 *   1. **stage**  — clone the repository into `data/plugins/store/<id>/`, read its manifest,
 *                   and check it with the platform's own validator. Code is on disk and
 *                   nothing has run.
 *   2. **enable** — record the plugin as enabled, after re-reading the manifest from disk, and
 *                   let the plugin host mount it on its next build. This is the step that
 *                   executes code, and it is the one the user has to ask for.
 *
 * Everything the user needs afterwards is recorded: where it came from, which version, when,
 * and whether it was enabled — which is what makes "reinstall the one I removed last week" a
 * button rather than a search.
 *
 * It is also honest about what it cannot do. The clone is a real `git clone --depth 1` (the
 * product already depends on git and this is the only download path that needs no archive
 * library), it is bounded by a timeout, a failed stage never leaves a half-populated plugin
 * directory behind, and an enable whose manifest no longer validates is refused *again* —
 * because the files on disk are not the ones that were verified.
 *
 * The queue exists for the store's one-by-one install experience: candidates are added to it
 * and installed sequentially, like a phone's app list, rather than all at once.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { validateManifest, PLUGIN_API_VERSION } = require('../../../core/contracts/plugin.cjs')

const MANIFEST_FILE = 'dshns-plugin.json'
const DEFAULT_MAIN = 'index.cjs'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_HISTORY = 50
const STATE_VERSION = 1

const INSTALL_REASONS = Object.freeze({
  BAD_REPO: 'STORE_BAD_REPO',
  BAD_MANIFEST: 'STORE_BAD_MANIFEST',
  CLONE_FAILED: 'STORE_CLONE_FAILED',
  ALREADY_STAGED: 'STORE_ALREADY_STAGED',
  NOT_STAGED: 'STORE_NOT_STAGED',
  MISSING_FILES: 'STORE_MISSING_FILES',
  STATE_UNREADABLE: 'STORE_STATE_UNREADABLE'
})

/** `owner/name`, and nothing else: a store source is a GitHub repository. */
function normalizeRepo(value) {
  const text = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(text)) return null
  return text
}

/** A directory name that cannot escape the store directory. */
function directoryNameFor(id) {
  return String(id).replace(/[^a-z0-9._-]/gi, '_')
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * @param {object} options
 * @param {string} options.root the repository root (state lives under `data/plugins`)
 * @param {Function} [options.clone] `(url, dir, { branch, timeoutMs }) => { ok, reason }`
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 * @param {string} [options.storeDir]
 * @param {string} [options.stateFile]
 * @param {string} [options.historyFile]
 */
function createStoreInstaller(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()))
  const base = path.join(root, 'data', 'plugins')
  const storeDir = path.resolve(options.storeDir || path.join(base, 'store'))
  const stateFile = path.resolve(options.stateFile || path.join(base, 'installed.json'))
  const historyFile = path.resolve(options.historyFile || path.join(base, 'history.json'))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const maxHistory = Number.isInteger(options.maxHistory) ? options.maxHistory : DEFAULT_MAX_HISTORY
  const clone = typeof options.clone === 'function' ? options.clone : defaultClone
  /**
   * The manifest probe: `({ repo, branch }) => { installable, verified, reason }`, or absent.
   *
   * It is injected rather than implemented here because the network belongs to the store, which
   * already knows how to talk to GitHub, spend a rate limit and read a manifest. An installer
   * with no probe simply clones and verifies, which is what it always did.
   */
  const probe = typeof options.probe === 'function' ? options.probe : null

  let state = null
  let history = null
  let queue = []
  let nextQueueId = 1

  function loadState() {
    if (state) return state
    const raw = readJson(stateFile, { version: STATE_VERSION, plugins: [] })
    state = {
      version: STATE_VERSION,
      plugins: Array.isArray(raw.plugins) ? raw.plugins.filter((entry) => entry && entry.id && entry.dir) : []
    }
    return state
  }

  function loadHistory() {
    if (history) return history
    const raw = readJson(historyFile, { version: STATE_VERSION, entries: [] })
    history = { version: STATE_VERSION, entries: Array.isArray(raw.entries) ? raw.entries : [] }
    return history
  }

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  function remember(entry) {
    const store = loadHistory()
    store.entries.unshift({ at: now(), ...entry })
    if (store.entries.length > maxHistory) store.entries.splice(maxHistory)
    try {
      writeJson(historyFile, store)
    } catch (error) {
      log(`install history could not be written: ${error?.message || error}`)
    }
    return entry
  }

  function entryFor(id) {
    return loadState().plugins.find((entry) => entry.id === String(id)) || null
  }

  /** Read and validate a staged plugin's manifest from disk. */
  function inspectDirectory(dir) {
    const manifestPath = path.join(dir, MANIFEST_FILE)
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, code: INSTALL_REASONS.BAD_MANIFEST, reason: `the repository has no ${MANIFEST_FILE}` }
    }
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      return { ok: false, code: INSTALL_REASONS.BAD_MANIFEST, reason: `${MANIFEST_FILE} is not valid JSON: ${error?.message || error}` }
    }
    const manifest = parsed && typeof parsed.manifest === 'object' ? parsed.manifest : parsed
    const validated = validateManifest(manifest)
    if (!validated.ok) return { ok: false, code: INSTALL_REASONS.BAD_MANIFEST, reason: `the manifest is invalid: ${validated.errors.join('; ')}` }
    const main = String(manifest.main || DEFAULT_MAIN)
    if (/[\\/]\.\.|[\\/]|^\/|\0/.test(main) || !/\.(cjs|js|mjs)$/.test(main)) {
      return { ok: false, code: INSTALL_REASONS.BAD_MANIFEST, reason: `the manifest's main "${main}" must be a module file inside the plugin directory` }
    }
    if (!fs.existsSync(path.join(dir, main))) {
      return { ok: false, code: INSTALL_REASONS.MISSING_FILES, reason: `the plugin's entry point ${main} is missing` }
    }
    return { ok: true, manifest, main }
  }

  /**
   * Ask whether a repository carries a manifest *before* downloading it.
   *
   * A real repository was the reason this exists: the store's first live target is a 933 MB
   * monorepo whose plugins are for a different host entirely, and cloning it to discover that
   * its root has no `dshns-plugin.json` costs a gigabyte of disk and half a minute to learn one
   * fact that a single HTTP request already knows. The pre-flight is that request.
   *
   * It can only ever *refuse*, never accept: a verdict is acted on when the probe verified it
   * against a known branch (`verified === true`). Anything else — a rate limit, a resolved
   * branch that could not be found, a probe that is not wired at all — returns null and the
   * clone decides, because a wrong refusal about somebody's repository is worse than a slow
   * install.
   *
   * @param {object} input `{ repo, branch }`
   */
  async function preflight(input = {}) {
    const repo = normalizeRepo(input.repo)
    if (!repo) return { ok: false, code: INSTALL_REASONS.BAD_REPO, reason: `"${input.repo || ''}" is not a GitHub repository (owner/name)` }
    if (typeof probe !== 'function') return { ok: true, repo, verdict: null, note: 'no manifest probe is wired, so the clone verifies the manifest' }
    let verdict = null
    try {
      verdict = await probe({ repo, branch: String(input.branch || '').trim() || null })
    } catch (error) {
      log(`the manifest pre-flight for ${repo} failed: ${error?.message || error}`)
      return { ok: true, repo, verdict: null, note: `the manifest could not be checked in advance (${error?.message || error}), so the clone verifies it` }
    }
    if (verdict && verdict.installable === false && verdict.verified === true) {
      return {
        ok: false,
        code: INSTALL_REASONS.BAD_MANIFEST,
        reason: `${repo} has no ${MANIFEST_FILE} at ${verdict.branch || String(input.branch || '').trim() || 'its default branch'}: it is not a DS-Hns plugin (${PLUGIN_API_VERSION}), so nothing was downloaded`,
        checked: verdict
      }
    }
    return { ok: true, repo, verdict: verdict && typeof verdict === 'object' ? verdict : null }
  }

  /**
   * Stage one repository: put its code on disk and verify it. Nothing runs.
   *
   * @param {object} input `{ repo, branch, replace, verdict }` — `verdict` is a pre-flight
   *   answer from `preflight`, which lets a caller that already asked GitHub skip the clone
   *   by passing it in; a refusal here happens *before* anything is downloaded.
   */
  function stage(input = {}) {
    const repo = normalizeRepo(input.repo)
    if (!repo) return { ok: false, code: INSTALL_REASONS.BAD_REPO, reason: `"${input.repo || ''}" is not a GitHub repository (owner/name)` }
    const branch = String(input.branch || '').trim() || null
    const id = directoryNameFor(repo)
    const dir = path.join(storeDir, id)

    // The pre-flight refusal, before the disk is touched: an installed repository that is not a
    // plugin is refused in one request instead of one download.
    const verdict = input.verdict && typeof input.verdict === 'object' ? input.verdict : null
    if (verdict && verdict.installable === false && verdict.verified === true) {
      const refused = {
        ok: false,
        code: INSTALL_REASONS.BAD_MANIFEST,
        reason: `${repo} has no ${MANIFEST_FILE} at ${verdict.branch || branch || 'its default branch'}: it is not a DS-Hns plugin (${PLUGIN_API_VERSION}), so nothing was downloaded`,
        checked: verdict
      }
      remember({ action: 'stage', repo, branch, id, ok: false, reason: refused.reason })
      log(`refused ${repo} before cloning: ${refused.reason}`)
      return refused
    }

    if (fs.existsSync(dir)) {
      if (input.replace !== true) {
        const existing = entryFor(loadState().plugins.find((entry) => entry.dir === dir)?.id || '')
        return { ok: false, code: INSTALL_REASONS.ALREADY_STAGED, reason: `${repo} is already staged`, entry: existing }
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        return { ok: false, code: INSTALL_REASONS.CLONE_FAILED, reason: `the previous copy could not be removed: ${error?.message || error}` }
      }
    }

    fs.mkdirSync(storeDir, { recursive: true })
    const cloned = clone(`https://github.com/${repo}.git`, dir, { branch, timeoutMs: input.timeoutMs || DEFAULT_TIMEOUT_MS })
    if (!cloned || cloned.ok !== true) {
      // A half-populated directory is worse than none: the next attempt must not "already
      // exist", and nothing should be verifiable from a partial clone.
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
      const failed = { ok: false, code: INSTALL_REASONS.CLONE_FAILED, reason: (cloned && cloned.reason) || 'git clone failed' }
      remember({ action: 'stage', repo, branch, id, ok: false, reason: failed.reason })
      return failed
    }

    const inspected = inspectDirectory(dir)
    if (!inspected.ok) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
      remember({ action: 'stage', repo, branch, id, ok: false, reason: inspected.reason })
      return inspected
    }

    // The clone's `.git` is not part of a plugin: keeping it would make the staged copy a
    // working tree of somebody else's repository, with its own hooks and remotes.
    try {
      fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true })
    } catch {}

    const entry = {
      id: inspected.manifest.id,
      dir,
      repo,
      branch: branch || 'default',
      version: String(inspected.manifest.version),
      main: inspected.main,
      name: inspected.manifest.name || inspected.manifest.id,
      provides: Array.isArray(inspected.manifest.provides) ? inspected.manifest.provides.slice() : [],
      faultLevel: inspected.manifest.fault_level || null,
      stagedAt: now(),
      enabled: false,
      enabledAt: null
    }
    const store = loadState()
    const existingIndex = store.plugins.findIndex((candidate) => candidate.id === entry.id || candidate.dir === entry.dir)
    if (existingIndex === -1) store.plugins.push(entry)
    else store.plugins[existingIndex] = { ...store.plugins[existingIndex], ...entry }
    writeJson(stateFile, store)
    remember({ action: 'stage', repo, branch: entry.branch, id: entry.id, version: entry.version, ok: true })
    log(`staged ${entry.id} v${entry.version} from ${repo} (nothing has run)`)
    return { ok: true, staged: true, entry: entryFor(entry.id) }
  }

  /**
   * Enable a staged plugin.
   *
   * The manifest is re-read here rather than trusted from staging: the files on disk are what
   * the host will import, and a manifest that changed since the check is not the manifest that
   * was checked.
   */
  function enable(input = {}) {
    const entry = entryFor(input.id)
    if (!entry) return { ok: false, code: INSTALL_REASONS.NOT_STAGED, reason: `${input.id || ''} is not staged` }
    if (!fs.existsSync(entry.dir)) {
      return { ok: false, code: INSTALL_REASONS.MISSING_FILES, reason: `${entry.id}'s directory is gone; stage it again` }
    }
    const inspected = inspectDirectory(entry.dir)
    if (!inspected.ok) return inspected
    if (inspected.manifest.id !== entry.id) {
      return { ok: false, code: INSTALL_REASONS.BAD_MANIFEST, reason: `the staged manifest now declares ${inspected.manifest.id}, not ${entry.id}` }
    }
    entry.enabled = true
    entry.enabledAt = now()
    entry.version = String(inspected.manifest.version)
    entry.main = inspected.main
    writeJson(stateFile, loadState())
    remember({ action: 'enable', repo: entry.repo, id: entry.id, version: entry.version, ok: true })
    log(`enabled ${entry.id} v${entry.version}; the plugin host mounts it on its next build`)
    return { ok: true, entry }
  }

  function disable(input = {}) {
    const entry = entryFor(input.id)
    if (!entry) return { ok: false, code: INSTALL_REASONS.NOT_STAGED, reason: `${input.id || ''} is not staged` }
    entry.enabled = false
    entry.enabledAt = null
    writeJson(stateFile, loadState())
    remember({ action: 'disable', repo: entry.repo, id: entry.id, ok: true })
    return { ok: true, entry }
  }

  /** Remove a plugin: gone from disk and from the state, kept in the history. */
  function remove(input = {}) {
    const entry = entryFor(input.id)
    if (!entry) return { ok: false, code: INSTALL_REASONS.NOT_STAGED, reason: `${input.id || ''} is not staged` }
    const store = loadState()
    store.plugins = store.plugins.filter((candidate) => candidate.id !== entry.id)
    writeJson(stateFile, store)
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true })
    } catch (error) {
      log(`the staged copy of ${entry.id} could not be removed: ${error?.message || error}`)
    }
    remember({ action: 'remove', repo: entry.repo, id: entry.id, version: entry.version, ok: true })
    return { ok: true, removed: entry.id }
  }

  /** Everything the manager lists: staged, enabled, and whether the files are still there. */
  function list() {
    return loadState().plugins.map((entry) => ({
      ...entry,
      present: fs.existsSync(entry.dir),
      // A plugin whose files vanished is reported rather than silently enabled.
      state: !fs.existsSync(entry.dir) ? 'missing' : entry.enabled ? 'enabled' : 'staged'
    }))
  }

  /**
   * The queue behind the one-by-one install experience.
   *
   * Adding a candidate does not install it: the store lists what the user picked, installs
   * them sequentially when asked, and reports each item's outcome, which is what makes it read
   * like an app store rather than like a batch script.
   */
  function enqueue(input = {}) {
    const repo = normalizeRepo(input.repo || input.id)
    if (!repo) return { ok: false, code: INSTALL_REASONS.BAD_REPO, reason: `"${input.repo || input.id || ''}" is not a GitHub repository (owner/name)` }
    const item = { queueId: `q${nextQueueId}`, repo, branch: String(input.branch || '').trim() || null, status: 'queued', reason: null, id: null, at: now() }
    nextQueueId += 1
    queue.push(item)
    return { ok: true, item, queue: queue.slice() }
  }

  /** Install the queued candidates one after another. */
  async function runQueue(input = {}) {
    const results = []
    for (const item of queue) {
      if (item.status === 'staged') {
        results.push({ ...item })
        continue
      }
      item.status = 'staging'
      // One request per candidate before one download per candidate: a queued repository that
      // is not a plugin fails here, in the list, without costing a clone.
      const checked = input.preflight === false ? { ok: true, verdict: null } : await preflight({ repo: item.repo, branch: item.branch })
      if (checked.ok === false) {
        item.status = 'failed'
        item.reason = checked.reason || null
        item.id = null
        item.version = null
        results.push({ ...item })
        continue
      }
      const staged = stage({ repo: item.repo, branch: item.branch, replace: input.replace === true, verdict: checked.verdict })
      item.status = staged.ok ? 'staged' : 'failed'
      item.reason = staged.reason || null
      item.id = staged.ok ? staged.entry.id : null
      item.version = staged.ok ? staged.entry.version : null
      results.push({ ...item })
    }
    const stagedCount = queue.filter((item) => item.status === 'staged').length
    return {
      ok: results.every((item) => item.status !== 'failed'),
      results,
      queue: queue.slice(),
      staged: stagedCount,
      note: 'staged, not enabled: enabling is the step that runs the plugin and it stays manual'
    }
  }

  function clearQueue() {
    queue = []
    return { ok: true }
  }

  /** Reinstall from the history: stage again, and enable if it was enabled before. */
  function reinstall(input = {}) {
    const id = String(input.id || '')
    const store = loadHistory()
    const previous = store.entries.find((entry) => entry.id === id && entry.action === 'stage' && entry.ok !== false)
    const staged = stage({ repo: (previous && previous.repo) || input.repo, branch: (previous && previous.branch) || input.branch, replace: true })
    if (!staged.ok) return staged
    const wasEnabled = (input.enabled === true) || (input.enabled === undefined && (previous ? true : false))
    if (!wasEnabled) return { ...staged, enabled: false }
    const enabled = enable({ id: staged.entry.id })
    return { ...staged, enabled: enabled.ok === true, enableReason: enabled.reason || null }
  }

  return {
    MANIFEST_FILE,
    storeDir,
    stateFile,
    historyFile,
    stage,
    preflight,
    enable,
    disable,
    remove,
    list,
    entry: entryFor,
    enqueue,
    runQueue,
    clearQueue,
    queue: () => queue.slice(),
    reinstall,
    history: () => loadHistory().entries.slice(),
    describe: () => ({
      storeDir,
      stateFile,
      apiVersion: PLUGIN_API_VERSION,
      staged: list().filter((entry) => entry.state === 'staged').length,
      enabled: list().filter((entry) => entry.state === 'enabled').length,
      history: loadHistory().entries.length,
      note: 'Staging puts the plugin on disk; enabling is the step that lets the host run it.'
    })
  }
}

/** `git clone --depth 1`, bounded, into a directory that must not exist yet. */
function defaultClone(url, dir, options = {}) {
  const args = ['clone', '--depth', '1']
  if (options.branch) args.push('--branch', String(options.branch))
  args.push(url, dir)
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.error) return { ok: false, reason: `git could not run: ${result.error.message}` }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).pop() || `git exited ${result.status}`
    return { ok: false, reason: detail }
  }
  return { ok: true }
}

module.exports = {
  createStoreInstaller,
  normalizeRepo,
  directoryNameFor,
  defaultClone,
  MANIFEST_FILE,
  DEFAULT_MAIN,
  STATE_VERSION,
  INSTALL_REASONS
}
