#!/usr/bin/env node
'use strict'

/**
 * Install state: what was installed, from what, and whether it still holds.
 *
 * The installer used to have no memory. Every run re-derived everything it could
 * and, in `Standard`, ran the *entire* 147-file unit suite -- so a second install
 * of an unchanged checkout cost exactly as much as the first, and the cost was
 * dominated by work that could not have changed. This module is the memory that
 * was missing, and `install.ps1` is its only caller.
 *
 * It answers one question: **for each unit of work, is the recorded result still
 * valid?** A unit is valid when everything it depended on is unchanged:
 *
 *   dependencies   app/package.json, app/package-lock.json, the resolved Node
 *                  build, the expected dsh/Electron versions, and the fact that
 *                  the installed trees and binaries are actually present
 *   profile plugin the plugin's declared spec (its own path) plus its installed
 *                  half files -- the same test `install-profile-plugin.ps1` makes
 *   optional       the user's recorded decision, so a decline is not re-asked
 *   toolchain      the installer's own revision, so changing the installer
 *                  invalidates the parts of the state the change could affect
 *
 * Two rules keep this honest:
 *
 *   1. **A fingerprint never overrides a missing file.** If `node_modules` is
 *      gone, the fingerprint says so, because the existence checks are part of
 *      the computation rather than a separate concern.
 *   2. **An unknown key is invalid.** A checkout from an older revision, a
 *      hand-edited state file, or a truncated write all read as "reinstall",
 *      which is the safe direction: the failure mode of an over-eager reuse is a
 *      broken installation, and the failure mode of an over-eager reinstall is
 *      only time.
 *
 * The state file lives under `DSH_HOME/state/` -- with the instance's own data,
 * not the repository -- so two checkouts sharing a machine keep separate state and
 * a second instance cannot mark the first one's dependencies as valid.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const STATE_VERSION = 2

/** The installer revision. Bump when a change invalidates previously-installed state. */
const INSTALLER_REVISION = 3

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** A stable hash of a file's bytes, or '' when it cannot be read. */
function hashFile(file) {
  try {
    const buffer = fs.readFileSync(file)
    return crypto.createHash('sha256').update(buffer).digest('hex')
  } catch {
    return ''
  }
}

function packageVersion(file) {
  const value = readJson(file)
  return value ? String(value.version || '') : ''
}

/**
 * Everything the dependency layer depends on.
 *
 * The lockfile hash is the entry that was missing before: `npm ci` consumes
 * `package-lock.json` but nothing ever compared it, so changing the lock in a way
 * that left `@deepseek-ai/dsh` and `electron` at the same versions was invisible.
 */
function computeDependencyFingerprint({ root, nodeVersion, electronExe }) {
  const appDir = path.join(root, 'app')
  const manifest = path.join(appDir, 'package.json')
  const lock = path.join(appDir, 'package-lock.json')
  const dshPkg = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const dshBin = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const electronInstall = path.join(appDir, 'node_modules', 'electron', 'install.js')
  const expectedDsh = (() => {
    const value = readJson(manifest)
    return value ? String(value.dependencies?.['@deepseek-ai/dsh'] || '').replace(/^[\^~]/, '') : ''
  })()
  const expectedElectron = (() => {
    const value = readJson(manifest)
    return value ? String(value.devDependencies?.electron || '').replace(/^[\^~]/, '') : ''
  })()
  const installedDsh = packageVersion(dshPkg)
  const installedElectron = packageVersion(path.join(appDir, 'node_modules', 'electron', 'package.json'))
  return {
    manifestHash: hashFile(manifest),
    lockHash: hashFile(lock),
    nodeVersion: String(nodeVersion || ''),
    expectedDsh,
    expectedElectron,
    installedDsh,
    installedElectron,
    /** Presence checks are part of the fingerprint, never a separate concern. */
    present: {
      dshBin: fs.existsSync(dshBin),
      electronInstall: fs.existsSync(electronInstall),
      electronBinary: Boolean(electronExe) && fs.existsSync(electronExe)
    },
    valid:
      Boolean(installedDsh) &&
      installedDsh === expectedDsh &&
      fs.existsSync(dshBin) &&
      Boolean(installedElectron) &&
      installedElectron === expectedElectron &&
      fs.existsSync(electronInstall) &&
      Boolean(electronExe) &&
      fs.existsSync(electronExe)
  }
}

/**
 * The shipped profile plugin's fingerprint.
 *
 * This mirrors `install-profile-plugin.ps1`'s own reuse test rather than
 * replacing it: the PowerShell script stays the thing that installs, and this only
 * records what it found so the *next* run can skip calling it at all. The spec is a
 * pure function of the checkout path, so moving a checkout invalidates it -- which
 * is correct, because the profile's `file:` dependency really does point at the old
 * path.
 */
function computeProfileFingerprint({ dshHome, profile = 'web', pluginName = 'dsh-plugin-mega-core', pluginDir }) {
  const profileDir = path.join(dshHome, 'profiles', profile)
  const manifest = path.join(profileDir, 'package.json')
  const declared = (() => {
    const value = readJson(manifest)
    const deps = value?.dependencies
    return deps && Object.prototype.hasOwnProperty.call(deps, pluginName) ? String(deps[pluginName]).trim() : ''
  })()
  const installedDir = path.join(profileDir, 'node_modules', pluginName)
  const clientHalf = path.join(installedDir, 'lib', 'client.js')
  const serverHalf = path.join(installedDir, 'lib', 'index.js')
  const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const expectedSpec = pluginDir ? `file:${normalize(pluginDir)}` : ''
  return {
    profile,
    pluginName,
    declared,
    expectedSpec,
    specMatches: Boolean(declared) && normalize(declared) === expectedSpec,
    installed: fs.existsSync(clientHalf) && fs.existsSync(serverHalf),
    valid: Boolean(declared) && normalize(declared) === expectedSpec && fs.existsSync(clientHalf) && fs.existsSync(serverHalf)
  }
}

/** One optional community plugin's recorded decision and installation state. */
function computeOptionalFingerprint({ root, dshHome, profile = 'web' }) {
  const stateFile = path.join(dshHome, 'state', 'optional-plugins.json')
  const value = readJson(stateFile)
  const entries = value && typeof value === 'object' && value.plugins && typeof value.plugins === 'object' ? value.plugins : value
  const decisions = {}
  if (entries && typeof entries === 'object') {
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue
      decisions[id] = { state: String(entry.state || ''), spec: entry.spec ? String(entry.spec) : null, at: entry.at || entry.recordedAt || null }
    }
  }
  try {
    const community = require('../app/extensions/mega/plugins/community-install.cjs')
    const { BUNDLED_MANIFEST } = require('../app/extensions/mega/plugins/index.cjs')
    for (const entry of community.communityEntries(BUNDLED_MANIFEST)) {
      const reconciled = community.reconcileOptionalPluginState({ root, dshHome, profile, id: entry.id, manifest: BUNDLED_MANIFEST })
      decisions[entry.id] = {
        ...(decisions[entry.id] || {}),
        state: reconciled.state,
        version: reconciled.version || null,
        provenance: reconciled.provenance,
        transientState: reconciled.transientState || null
      }
    }
  } catch (error) {
    return { stateFile, decisions, present: fs.existsSync(stateFile), reconciliationError: String(error?.message || error) }
  }
  return { stateFile, decisions, present: fs.existsSync(stateFile) }
}

function stateFilePath(dshHome) {
  return path.join(dshHome, 'state', 'install-state.json')
}

function readState(dshHome) {
  const value = readJson(stateFilePath(dshHome))
  if (!value || value.version !== STATE_VERSION) return null
  return value
}

/** Compare two records as JSON with sorted keys, so field order cannot fake a change. */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

/**
 * Decide what can be reused.
 *
 * Every answer carries the reason it was reached, because "we reinstalled" is
 * useless in a log without "because the lockfile hash changed".
 */
function decideReuse({ previous, current }) {
  const decisions = {}
  const previousDeps = previous?.dependencies || null
  const currentDeps = current.dependencies
  if (!previous) {
    decisions.dependencies = { reuse: false, reason: 'no previous install state' }
  } else if (!previousDeps) {
    decisions.dependencies = { reuse: false, reason: 'the previous state has no dependency record' }
  } else if (!currentDeps.valid) {
    decisions.dependencies = { reuse: false, reason: 'the installed tree is incomplete or version-mismatched' }
  } else if (previousDeps.lockHash !== currentDeps.lockHash) {
    decisions.dependencies = { reuse: false, reason: 'app/package-lock.json changed' }
  } else if (previousDeps.manifestHash !== currentDeps.manifestHash) {
    decisions.dependencies = { reuse: false, reason: 'app/package.json changed' }
  } else if (previousDeps.nodeVersion !== currentDeps.nodeVersion) {
    decisions.dependencies = { reuse: false, reason: `the Node build changed (${previousDeps.nodeVersion} -> ${currentDeps.nodeVersion})` }
  } else if (previousDeps.expectedDsh !== currentDeps.expectedDsh || previousDeps.expectedElectron !== currentDeps.expectedElectron) {
    decisions.dependencies = { reuse: false, reason: 'a required package version changed' }
  } else {
    decisions.dependencies = { reuse: true, reason: 'lockfile, manifest, Node and installed versions are unchanged' }
  }

  const previousProfile = previous?.profile || null
  const profile = current.profile
  if (!profile.valid) {
    decisions.profile = { reuse: false, reason: 'the profile does not hold this checkout version of the plugin' }
  } else if (!previousProfile || !previousProfile.valid) {
    decisions.profile = { reuse: false, reason: 'the previous state did not record a valid profile plugin' }
  } else if (previousProfile.declared !== profile.declared) {
    decisions.profile = { reuse: false, reason: 'the profile\'s declared plugin spec changed' }
  } else {
    decisions.profile = { reuse: true, reason: 'the profile already holds this checkout\'s plugin' }
  }

  const installerChanged = (previous?.installerRevision ?? null) !== INSTALLER_REVISION
  // The installer's own revision is *reported*, not used to force dependency work:
  // a new installer step can change what runs without invalidating node_modules.
  decisions.installerRevision = {
    changed: installerChanged,
    previous: previous?.installerRevision ?? null,
    current: INSTALLER_REVISION,
    reason: installerChanged ? 'the installer was updated' : 'the installer revision is unchanged'
  }
  return decisions
}

/** Assemble the full state for this run. */
function computeState({ root, dshHome, profile, pluginName, pluginDir, nodeVersion, electronExe, previous }) {
  const dependencies = computeDependencyFingerprint({ root, nodeVersion, electronExe })
  const profileState = computeProfileFingerprint({ dshHome, profile, pluginName, pluginDir })
  const optional = computeOptionalFingerprint({ root, dshHome, profile })
  const decisions = decideReuse({ previous, current: { dependencies, profile: profileState, optional } })
  return {
    version: STATE_VERSION,
    installerRevision: INSTALLER_REVISION,
    updatedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: String(nodeVersion || ''),
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
      logicalCores: (os.cpus() || []).length
    },
    dependencies,
    profile: profileState,
    optional,
    decisions
  }
}

function writeState(dshHome, state) {
  const file = stateFilePath(dshHome)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(temporary, file)
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: String(error?.message || error) }
  }
}

function parseArgv(argv) {
  // The positional list is initialised here because `--flag value` pairs consume
  // two tokens; without it `args._` was always undefined and the subcommand fell
  // back to `describe`, so `write` silently described instead of writing.
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const equals = token.indexOf('=')
    if (equals > 0) {
      args[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function main(argv) {
  const args = parseArgv(argv)
  const command = String(args._[0] || 'describe')
  const root = path.resolve(String(args.root || path.join(__dirname, '..')))
  const dshHome = path.resolve(String(args['dsh-home'] || path.join(root, 'data')))
  const previous = readState(dshHome)

  if (command === 'read' || command === 'previous') {
    process.stdout.write(`${JSON.stringify(previous)}\n`)
    return 0
  }

  /**
   * Classify a simulated host and report the policy it produces.
   *
   * The installer's `-HostProfileFixture` uses this so a low-capacity acceptance
   * runs the *real* classification and budget arithmetic over a described host,
   * rather than a second implementation that could disagree with the measured one.
   */
  if (command === 'host-profile') {
    const { loadProfileFixture } = require(path.join(root, 'app', 'runtime', 'host-capability.cjs'))
    const fixture = path.resolve(String(args.fixture || ''))
    try {
      process.stdout.write(`${JSON.stringify(loadProfileFixture(fixture))}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`the host profile fixture could not be read: ${error?.message || error}\n`)
      return 1
    }
  }

  const state = computeState({
    root,
    dshHome,
    profile: String(args.profile || 'web'),
    pluginName: String(args['plugin-name'] || 'dsh-plugin-mega-core'),
    pluginDir: args['plugin-dir'] ? path.resolve(String(args['plugin-dir'])) : path.join(root, 'app', 'plugins', 'mega-core'),
    nodeVersion: String(args['node-version'] || process.version),
    electronExe: args['electron-exe'] ? String(args['electron-exe']) : path.join(root, 'app', 'node_modules', 'electron', 'dist', 'electron.exe'),
    previous
  })

  if (command === 'write') {
    const result = writeState(dshHome, state)
    process.stdout.write(`${JSON.stringify({ ...state, write: result })}\n`)
    return result.ok ? 0 : 1
  }

  process.stdout.write(`${JSON.stringify(state)}\n`)
  return 0
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = {
  STATE_VERSION,
  INSTALLER_REVISION,
  stateFilePath,
  computeDependencyFingerprint,
  computeProfileFingerprint,
  computeOptionalFingerprint,
  computeState,
  decideReuse,
  readState,
  writeState,
  stable
}
