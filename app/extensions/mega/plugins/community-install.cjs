'use strict'

/**
 * The optional community plugins, installed by the **one-click installer** rather than by a boot.
 *
 * DS-Hns offers two community plugins as part of the experience — the plugin market
 * (`@dsh-market/plugin`, repository `2BingLing/dsh-market`) and the wallpaper engine
 * (`dsh-plugin-wallpaper-engine`, repository `elysia395/dsh-wallpaper-engine`) — and neither may be a
 * hard dependency of the product. This module is what the installer asks before it can offer them,
 * and what it calls after the user has answered.
 *
 * ## What it does *not* implement
 *
 * Nothing about how a plugin is installed. Both plugins are DeepSeek Harness *client* plugins, whose
 * only installation channel is the Harness' own CLI (`dsh plugin --profile <name> add <pkg>@<ref>`),
 * and that channel already exists: `installBundled()` in `./index.cjs` owns the channel dispatch and
 * the two-step store path, and `docs/pluginize.md` records the manual install it was written from.
 * A second installer here — a `git clone` into a directory — would be exactly the bypass this
 * product must not have: the plugin would be on disk, the profile would not know it, the Harness
 * would not compose it, and the panel would report a plugin that is not running.
 *
 * So this module is a *caller*: it reads the release manifest for the pinned reference, hands the
 * entry to `installBundled()`, and then asks the **adapter layer** whether the installed package
 * really is the community bundle the release pinned. The last step is the one that keeps an install
 * honest without inventing a second install path:
 *
 * ```
 *   installer ──► release manifest (pin) ──► installBundled ──► dsh plugin CLI ──► profile
 *                                                    │                                │
 *                                                    └──► adapter framework ◄── installed package
 *                                                          (dshns.harness-profile)
 * ```
 *
 * ## Failure isolation, stated as a return value
 *
 * Every function here answers with a value and never throws. A missing Node, a failed CLI, a refused
 * artifact and a package that is not installed at all are all `{ ok: false, reason }`. The caller (the
 * PowerShell installer) warns, records the reason, and carries on — a community plugin that cannot be
 * installed never fails DS-Hns' own installation, and never silently disappears either.
 */

const fs = require('node:fs')
const path = require('node:path')

const { BUNDLED_MANIFEST, installBundled } = require('./index.cjs')

/** The two entries this installer offers, in the order it asks about them. */
const COMMUNITY_PLUGIN_IDS = Object.freeze(['dsh-wallpaper-engine', '@dsh-market/plugin'])

/** The installer's own fault codes, so a caller can branch without parsing a message. */
const COMMUNITY_FAULT_CODES = Object.freeze({
  UNKNOWN_PLUGIN: 'COMMUNITY_UNKNOWN_PLUGIN',
  CONFLICT: 'COMMUNITY_CONFLICTING_PARAMETERS',
  ALREADY_INSTALLED: 'COMMUNITY_ALREADY_INSTALLED',
  ALREADY_DECLINED: 'COMMUNITY_ALREADY_DECLINED',
  PROFILE_UNREADABLE: 'COMMUNITY_PROFILE_UNREADABLE',
  UNREADABLE: 'COMMUNITY_UNREADABLE',
  NOT_INSTALLED: 'COMMUNITY_NOT_INSTALLED',
  ADAPTER_REFUSED: 'COMMUNITY_ADAPTER_REFUSED',
  NO_CLI: 'COMMUNITY_NO_HARNESS_CLI'
})

function fault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

/** Read a JSON file, or `null`: half of the files this module reads are optional. */
function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** One entry from the shipped release manifest, by id, or `null`. */
function communityEntry(id, manifest = BUNDLED_MANIFEST) {
  const entries = Array.isArray(manifest && manifest.plugins) ? manifest.plugins : []
  return entries.find((entry) => entry.id === String(id)) || null
}

/** The two entries this installer offers, in asking order, with their pinned references. */
function communityEntries(manifest = BUNDLED_MANIFEST) {
  return COMMUNITY_PLUGIN_IDS.map((id) => communityEntry(id, manifest)).filter(Boolean)
}

/**
 * Where the Harness profile the product boots lives.
 *
 * `dshHome` is honoured whenever it is a string — including `''`, which is how a caller says "this
 * is a checkout-relative install" rather than falling back to the *test process's* `DSH_HOME`. That
 * distinction matters: this module runs both inside the product (where `DSH_HOME` is the answer) and
 * inside tests and the installer's own command line (where the caller names the home explicitly, and
 * an inherited environment variable would silently redirect every read and write to another profile).
 */
function profileDir({ root, profile = 'web', dshHome } = {}) {
  const home = typeof dshHome === 'string' && dshHome ? dshHome : (process.env.DSH_HOME || path.join(root || '.', 'data'))
  return path.join(home, 'profiles', String(profile || 'web'))
}

/**
 * The version a profile's `package.json` records for one package, or `null`.
 *
 * The Harness' CLI writes a dependency the way `pnpm add` does, so the recorded value is the
 * *requested* reference (`0.4.7`, `v0.7.1`) and not necessarily the resolved one. It is compared the
 * way the bundled manager compares a pin (`sameReference` in `./index.cjs`), which is what lets the
 * wallpaper engine's tag (`v0.7.1`) and npm's version (`0.7.1`) count as the same reference.
 */
function declaredVersion(dir, packageName) {
  const parsed = readJson(path.join(dir, 'package.json'))
  const dependencies = parsed && parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : null
  if (!dependencies || !Object.prototype.hasOwnProperty.call(dependencies, packageName)) return null
  return String(dependencies[packageName])
}

/**
 * The directory an installed package occupies inside a profile's `node_modules`.
 *
 * pnpm nests a dependency's own subtree one level down when it has to
 * (`node_modules/<dep>/node_modules/<package>`), so both layouts are checked, nearest first — the
 * same order Node's own resolver walks.
 */
function resolvePackageDir(modulesDir, packageName) {
  const parts = String(packageName).split('/')
  const candidates = [
    path.join(modulesDir, ...parts),
    // The pnpm-nested layout: any direct dependency's own subtree.
    ...(fs.existsSync(modulesDir)
      ? fs.readdirSync(modulesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.bin' && !entry.name.startsWith('@'))
        .map((entry) => path.join(modulesDir, entry.name, 'node_modules', ...parts))
      : [])
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  return candidates[0]
}

/** Whether a package is really installed: declared by the profile *and* present with a manifest. */
function readInstalled(input = {}) {
  const dir = input.profileDir || profileDir(input)
  const packageName = String(input.packageName || '')
  if (!packageName) return fault(COMMUNITY_FAULT_CODES.UNKNOWN_PLUGIN, 'a package name is required')
  const declared = declaredVersion(dir, packageName)
  if (declared === null) {
    return { ok: true, installed: false, declared: null, packageDir: null, version: null, reason: `the profile does not declare ${packageName}` }
  }
  const packageDir = input.packageDir || resolvePackageDir(path.join(dir, 'node_modules'), packageName)
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    return {
      ok: true,
      installed: false,
      declared,
      packageDir,
      version: null,
      reason: `the profile declares ${packageName} (${declared}) but no installed copy is there`
    }
  }
  const manifest = readJson(path.join(packageDir, 'package.json'))
  return {
    ok: true,
    installed: true,
    declared,
    packageDir,
    version: manifest && manifest.version ? String(manifest.version) : null,
    reason: null
  }
}

/**
 * What the installer asks before it offers anything: the two entries, whether each is already there,
 * and whether the machine can install at all.
 *
 * Deliberately does no work beyond reading the profile's manifest and the installed packages, so the
 * planning call is safe to run before the user has answered anything.
 */
function describeCommunity({ root, profile = 'web', dshHome = null, manifest = BUNDLED_MANIFEST } = {}) {
  const entries = communityEntries(manifest).map((entry) => {
    const installed = readInstalled({ root, profile, dshHome, packageName: entry.package })
    return {
      id: entry.id,
      role: entry.role,
      repo: entry.repo,
      package: entry.package,
      ref: entry.ref,
      channel: entry.channel || 'dshns-store',
      /** The reference to request, exactly as the Harness CLI takes it. */
      spec: `${entry.package}@${entry.ref}`,
      installed: installed.ok === true && installed.installed === true,
      installedVersion: installed.ok === true ? installed.version : null,
      declared: installed.ok === true ? installed.declared : null,
      packageDir: installed.ok === true ? installed.packageDir : null,
      note: installed.ok === true ? installed.reason : installed.reason
    }
  })
  return { ok: true, profile, profileDir: profileDir({ root, profile, dshHome }), plugins: entries }
}

/**
 * Install one community plugin through the release manifest's own channel.
 *
 * The two parameters that decide the work are the two the caller owns: `profile` (which Harness
 * profile is being installed into) and `harnessAdd` (the CLI invocation). Everything else — the pin,
 * the channel, the two-step store path, the read-back — is `installBundled`'s, and it is reused
 * rather than re-done here.
 *
 * @param {object}   id        the bundled entry id (`dsh-wallpaper-engine`, `@dsh-market/plugin`)
 * @param {object}   [options]
 * @param {object}   [options.merger]      the optional-plugin merger, for opt-out precedence
 * @param {Function} [options.harnessAdd]  `({ profile, package }) => { ok, reason }`
 * @param {object}   [options.store]       `{ stage, enable }`, for a `dshns-store` entry
 * @param {Function} [options.verify]      the adapter-layer compatibility check for the channel
 */
async function installCommunityPlugin(id, options = {}) {
  const entry = communityEntry(id, options.manifest || BUNDLED_MANIFEST)
  if (!entry) return fault(COMMUNITY_FAULT_CODES.UNKNOWN_PLUGIN, `${id} is not one of the optional community plugins`)
  if (typeof options.harnessAdd !== 'function' && (entry.channel || 'dshns-store') === 'harness-profile') {
    return fault(COMMUNITY_FAULT_CODES.NO_CLI, `no Harness plugin CLI was provided, so ${entry.package} cannot be installed`)
  }

  // The user's earlier answer outranks this request: a plugin they turned down while installing is
  // not installed by a second pass that never asked again. The decision file is the record of that
  // answer, and it is read rather than remembered in this process.
  if (isDeclined(options.root, entry.id)) {
    return fault(COMMUNITY_FAULT_CODES.ALREADY_DECLINED, `${entry.id} was declined during this installation`, { id: entry.id })
  }

  // Reuse-first. A profile that already carries the package is reported and left alone: reinstalling
  // it would be a network round trip and a version change nobody asked for.
  const installed = readInstalled({ root: options.root, profile: options.profile, dshHome: options.dshHome, packageName: entry.package })
  if (installed.ok !== true) {
    return fault(COMMUNITY_FAULT_CODES.PROFILE_UNREADABLE, installed.reason || `the profile could not be read for ${entry.package}`, { id: entry.id })
  }
  if (installed.installed === true && options.replace !== true) {
    // Reuse-first does **not** mean unverified. A package that is already in the profile still has to
    // be recognised by the adapter layer before the summary may call it installed -- otherwise "it was
    // already there" would be the one path that skips the compatibility check, and a package somebody
    // dropped into `node_modules` by hand would be reported as a working plugin.
    let checked = null
    if (typeof options.verify === 'function') {
      try {
        checked = await options.verify({ id: entry.id, channel: entry.channel, profile: options.profile, packageName: entry.package, ref: entry.ref })
      } catch (error) {
        return fault(COMMUNITY_FAULT_CODES.ADAPTER_REFUSED, `the installed copy could not be verified: ${String(error && error.message ? error.message : error)}`, { id: entry.id })
      }
      if (checked && checked.ok === false) {
        return fault(checked.code || COMMUNITY_FAULT_CODES.ADAPTER_REFUSED, checked.reason || 'the installed copy was refused by the adapter layer', { id: entry.id, verify: checked })
      }
    }
    return {
      ok: true,
      id: entry.id,
      channel: entry.channel || 'dshns-store',
      profile: options.profile || 'web',
      spec: `${entry.package}@${entry.ref}`,
      version: installed.version,
      alreadyInstalled: true,
      verify: checked || null,
      message: `${entry.package} is already in the profile at ${installed.version || installed.declared}`
    }
  }

  const outcome = await installBundled(entry, {
    profile: options.profile || 'web',
    harnessAdd: options.harnessAdd || null,
    store: options.store || null,
    verify: options.verify || null
  })
  // The reference is part of the answer whichever path produced it: a caller reporting what it
  // installed should not have to re-derive the spec from the manifest it passed in.
  return { id: entry.id, spec: `${entry.package}@${entry.ref}`, ...outcome }
}

/**
 * The explicit parameters, validated before any of them is acted on.
 *
 * The conflicts are errors rather than silent overrides, because both directions of "I said install
 * the market and skip the optional plugins" are a person saying two different things, and a tool that
 * picks one of them for them has decided something they did not.
 */
function resolveSelection({ installMarket, installWallpaper, skipOptional } = {}) {
  const market = installMarket === true
  const wallpaper = installWallpaper === true
  const skip = skipOptional === true
  if (skip && (market || wallpaper)) {
    const named = [market ? '-InstallMarket' : null, wallpaper ? '-InstallWallpaper' : null].filter(Boolean).join(' and ')
    return fault(
      COMMUNITY_FAULT_CODES.CONFLICT,
      `${named} cannot be combined with -SkipOptionalPlugins: one says install an optional community plugin and the other says do not`
    )
  }
  return {
    ok: true,
    market,
    wallpaper,
    skip,
    /** True when nothing was named, which is the case a person has to be asked about. */
    unanswered: !market && !wallpaper && !skip
  }
}

/**
 * The outcome for one plugin that was never offered, with the reason it was not.
 *
 * A summary that shows `SKIPPED` for "we could not read the profile" would be the comfortable answer
 * and the wrong one, so the reason travels with the state.
 */
function skipped(id, reason) {
  return { id, ok: true, skipped: true, state: 'skipped', reason: String(reason) }
}

/**
 * Install the plugins the invocation selected, one at a time, isolating every failure.
 *
 * `pending` is the list of entry ids to install; `blocked` is a function answering the reason an entry
 * was never offered (`null` when it was). The two are separate because "the user said no" and "the
 * user said nothing and there was nobody to ask" are different lines in the summary.
 */
async function installSelected(pending = [], { install, blocked = () => null, log = () => {} } = {}) {
  const results = []
  for (const id of pending) {
    const why = blocked(id)
    if (why) {
      results.push(skipped(id, why))
      continue
    }
    let outcome = null
    try {
      outcome = await install(id)
    } catch (error) {
      outcome = fault(COMMUNITY_FAULT_CODES.ADAPTER_REFUSED, String(error && error.message ? error.message : error), { id })
    }
    const record = {
      id,
      ok: outcome && outcome.ok === true,
      state: outcome && outcome.ok === true ? (outcome.alreadyInstalled ? 'already-installed' : 'installed') : 'failed',
      reason: outcome && outcome.ok === true ? outcome.message || null : (outcome && outcome.reason) || 'the install returned no outcome',
      version: outcome && outcome.ok === true ? outcome.version || null : null,
      channel: outcome && outcome.channel ? outcome.channel : null,
      spec: outcome && outcome.spec ? outcome.spec : null,
      verify: outcome && outcome.verify ? outcome.verify : null
    }
    log(`[community] ${id}: ${record.state}${record.reason ? ` - ${record.reason}` : ''}`)
    results.push(record)
  }
  return results
}

/** Where one plugin's outcome is written down: `data/state/optional-plugins.json`. */
function optionalPluginsFile(root) {
  return path.join(root || '.', 'data', 'state', 'optional-plugins.json')
}

/**
 * The merged view of the two answers: the plugin's own record and this installation's opt-out.
 *
 * Read-only, and tolerant of a missing or malformed file: an unusable decision file must not stop an
 * installation. A malformed file is ignored rather than repaired, because guessing what a person meant
 * is worse than asking them again.
 */
function readOptionalPlugins(root) {
  const parsed = readJson(optionalPluginsFile(root))
  const plugins = parsed && parsed.plugins && typeof parsed.plugins === 'object' && !Array.isArray(parsed.plugins) ? parsed.plugins : {}
  return { version: 'optional-plugins/1', at: parsed ? parsed.at || null : null, plugins: { ...plugins } }
}

/**
 * Record one plugin's outcome, merging with what is already written.
 *
 * A decline is remembered as firmly as an install: the boot-time pass (`bundled().ensure()`) must not
 * re-install a plugin the user turned down at installation time, and the only way to know that is to
 * have written it down.
 */
function recordOptionalPlugin(root, entry = {}) {
  const id = String(entry.id || '')
  if (!id) return fault(COMMUNITY_FAULT_CODES.UNKNOWN_PLUGIN, 'a plugin id is required to record an outcome')
  const file = optionalPluginsFile(root)
  const state = readOptionalPlugins(root)
  const state$ = String(entry.state || '')
  state.plugins[id] = {
    id,
    state: state$,
    at: new Date().toISOString(),
    spec: entry.spec ? String(entry.spec) : null,
    profile: entry.profile ? String(entry.profile) : null,
    version: entry.version ? String(entry.version) : null,
    reason: entry.reason ? String(entry.reason) : null
  }
  state.at = state.plugins[id].at
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return { ok: true, id, state: state$, file }
  } catch (error) {
    return fault(COMMUNITY_FAULT_CODES.UNREADABLE, `the optional-plugin state could not be written: ${error && error.message ? error.message : error}`, { id, file })
  }
}

/** Whether a plugin was declined during an installation, from the recorded decisions alone. */
function isDeclined(root, id) {
  const record = readOptionalPlugins(root).plugins[String(id)]
  return Boolean(record) && record.state === 'declined'
}

/**
 * Record an answer, then act on it, and write down what happened.
 *
 * The order is the point: `declined` is recorded *before* anything is installed, so a decision the
 * user made cannot be reversed by a later pass that only knows the release manifest. A user who said
 * no is a decision; a plugin that failed is a fault; and the file keeps them apart.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.id
 * @param {boolean} options.install when false the answer is a decline and nothing else happens
 */
async function applyOptionalChoice({ root, id, install, ...rest } = {}) {
  if (install !== true) {
    const recorded = recordOptionalPlugin(root, { id, state: 'declined', spec: rest.spec || null, profile: rest.profile || null })
    return { id, ok: true, skipped: true, state: 'skipped', reason: 'declined at installation time', recorded: recorded.ok === true }
  }
  const outcome = await installCommunityPlugin(id, { ...rest, root })
  recordOptionalPlugin(root, {
    id,
    state: outcome.ok === true ? (outcome.alreadyInstalled ? 'already-installed' : 'installed') : 'failed',
    spec: outcome.spec || null,
    profile: outcome.profile || rest.profile || null,
    version: outcome.version || null,
    reason: outcome.ok === true ? outcome.message || null : outcome.reason || null
  })
  return outcome
}

module.exports = {
  COMMUNITY_PLUGIN_IDS,
  COMMUNITY_FAULT_CODES,
  communityEntries,
  communityEntry,
  describeCommunity,
  installCommunityPlugin,
  installSelected,
  applyOptionalChoice,
  resolveSelection,
  profileDir,
  readInstalled,
  resolvePackageDir,
  declaredVersion,
  optionalPluginsFile,
  readOptionalPlugins,
  recordOptionalPlugin,
  isDeclined,
  skipped
}
