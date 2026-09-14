'use strict'

/**
 * The Bundled Plugin Manager (`updateplan/startup2.md` §19-§23).
 *
 * DS-Hns ships two community plugins as part of the experience — `dsh-wallpaper-engine` for the
 * advanced desktop, and `@dsh-market/plugin` for the store — while staying honest about what they
 * are: optional community plugins, not part of the Core, and not something the shell re-implements.
 * This module is the one place that knows:
 *
 *   * **which plugins are bundled**, and at which reference (§20, §21);
 *   * **whether each is installed, compatible and healthy** (§23);
 *   * **what to do about it** — install the pinned reference, leave a healthy one alone, respect a
 *     user's decision to disable it, or report a version that cannot be used rather than overwriting
 *     it (§23's table, and §22's rule that nothing chases `latest`).
 *
 * Three rules it is built around, each one a mistake this project has already made elsewhere:
 *
 *   1. **`latest` is not a version.** §22: a boot never asks a remote what the newest thing is. The
 *      manifest carries a reference — a tag or a commit — and that is what is installed. "Newest"
 *      would make yesterday's tested product different from today's untested one without anyone
 *      deciding that.
 *   2. **An untested pin is not installed.** §21 calls the field `TESTED_VERSION` for a reason: a
 *      reference nobody has run is *declared* here and reported as `untested`, never installed
 *      automatically. The manifest tells the truth about that, so the next release task is a real
 *      task rather than a silent upgrade.
 *   3. **The user's decision outranks the release.** §23: a plugin the user disabled stays disabled —
 *      not reinstalled, not "repaired", not enabled again by a boot that thinks it knows better.
 *
 * The manager is a *policy* over an injected installer and registry: it never clones, never writes a
 * plugin directory and never reads a package manifest itself. That is what makes the whole table of
 * outcomes testable without a network — and it keeps the working parts of the store
 * (`mega/store/installer.cjs`) as the only thing that touches the disk.
 */

/**
 * The bundled set, as a release manifest (§21).
 *
 * The references are real and resolved: `dsh-wallpaper-engine` at its `v0.7.1` tag, and
 * `@dsh-market/plugin` at the commit that repository's `master` points at — the market publishes no
 * tags, so a commit *is* its version, and pinning the commit is exactly what §22 asks for.
 *
 * `tested: false` on both is the honest half: the references exist, and nobody has run them inside
 * DS-Hns yet. The manager will not install an untested reference, so the next step is a live test and
 * a one-line flip — not a silent adoption.
 */
const BUNDLED_MANIFEST = Object.freeze({
  version: 'startup2',
  plugins: Object.freeze([
    Object.freeze({
      id: 'dsh-wallpaper-engine',
      role: 'appearance',
      repo: 'elysia395/dsh-wallpaper-engine',
      ref: 'v0.7.1',
      commit: '4de97fc88905077fac879c6bf493aed3575c3b9e',
      tested: false,
      required: false
    }),
    Object.freeze({
      id: '@dsh-market/plugin',
      role: 'plugin-store',
      repo: '2BingLing/dsh-market',
      ref: '2c34728e7e0e478774e91282d6ec1723fe4b9037',
      commit: '2c34728e7e0e478774e91282d6ec1723fe4b9037',
      tested: false,
      required: false
    })
  ])
})

/** Where a bundled plugin's fallback leads, per §18: what the product does without it. */
const BUNDLED_FALLBACK = Object.freeze({
  appearance: { id: 'simple-wallpaper', label: 'the built-in simple wallpaper' },
  'plugin-store': { id: 'store-hidden', label: 'the store entry stays hidden' }
})

/** §23: what the manager decided about one plugin. */
const BUNDLED_STATE = Object.freeze({
  MISSING: 'missing',
  UNTESTED: 'untested',
  INSTALLED: 'installed',
  OUTDATED: 'outdated',
  AHEAD_OF_PIN: 'ahead-of-pin',
  INCOMPATIBLE: 'incompatible',
  USER_DISABLED: 'user-disabled',
  FAILED: 'failed'
})

function sameReference(installed, entry) {
  if (!installed) return false
  const version = String(installed.version || installed.commit || '')
  if (!version) return false
  return version === entry.ref || version === entry.commit
}

/**
 * @param {object}   options
 * @param {Function} [options.installed]      () => [{ id, version, dir }] — the store's own record
 * @param {Function} [options.userEnabled]    (id) => boolean|null — `null`/undefined means "no opinion"
 * @param {Function} [options.install]        async (entry) => ({ ok, version, reason }) — the store installer
 * @param {Function} [options.uninstall]      async (id) => ({ ok, reason }) — for repair
 * @param {Function} [options.compatibility]  (entry, installed) => ({ ok, reason })
 * @param {object}   [options.protection]     the MEGA protection layer, when there is one
 * @param {Function} [options.log]
 * @param {object}   [options.manifest]       test seam; defaults to the shipped manifest
 */
function createBundledPlugins({
  installed = () => [],
  userEnabled = () => null,
  install = null,
  uninstall = null,
  compatibility = () => ({ ok: true }),
  protection = null,
  log = () => {},
  manifest = BUNDLED_MANIFEST
} = {}) {
  const entries = Array.isArray(manifest.plugins) ? manifest.plugins.slice() : []
  const results = new Map()

  function installedById() {
    const map = new Map()
    for (const record of installed() || []) {
      if (record && record.id) map.set(record.id, record)
    }
    return map
  }

  function entryById(id) {
    return entries.find((entry) => entry.id === id) || null
  }

  /**
   * Decide what this plugin's situation is, without changing anything.
   *
   * The order matters and it is the plan's §23 table: the user's own answer first, then presence, then
   * whether the reference was ever tested, then compatibility, then version drift.
   */
  function assess(id) {
    const entry = entryById(id)
    if (!entry) return { id, known: false, state: BUNDLED_STATE.MISSING, reason: 'not a bundled plugin' }
    const record = installedById().get(id) || null
    const enabled = userEnabled(id)
    if (enabled === false) {
      return { id, known: true, role: entry.role, present: Boolean(record), installedVersion: record?.version || null, expected: entry.ref, state: BUNDLED_STATE.USER_DISABLED, reason: 'the user disabled it; that outranks this manifest' }
    }
    if (!record) {
      return {
        id,
        known: true,
        role: entry.role,
        present: false,
        installedVersion: null,
        expected: entry.ref,
        state: entry.tested ? BUNDLED_STATE.MISSING : BUNDLED_STATE.UNTESTED,
        reason: entry.tested ? null : `pinned at ${entry.ref}, but nobody has tested it inside DS-Hns yet`
      }
    }
    const compatible = compatibility(entry, record) || { ok: true }
    if (compatible.ok === false) {
      return { id, known: true, role: entry.role, present: true, installedVersion: record.version || null, expected: entry.ref, state: BUNDLED_STATE.INCOMPATIBLE, reason: compatible.reason || 'the installed version is not compatible' }
    }
    if (sameReference(record, entry)) {
      return { id, known: true, role: entry.role, present: true, installedVersion: record.version || null, expected: entry.ref, state: BUNDLED_STATE.INSTALLED, reason: null }
    }
    // A version the manifest does not know about is *reported*, never replaced: the user may have
    // installed it deliberately, and §22 forbids chasing versions in either direction.
    return {
      id,
      known: true,
      role: entry.role,
      present: true,
      installedVersion: record.version || null,
      expected: entry.ref,
      state: BUNDLED_STATE.AHEAD_OF_PIN,
      reason: `installed ${record.version || 'unknown'} does not match the bundled ${entry.ref}; it is left alone`
    }
  }

  function describe() {
    return {
      manifest: { version: manifest.version, plugins: entries.map((entry) => ({ id: entry.id, role: entry.role, ref: entry.ref, tested: entry.tested, required: entry.required })) },
      plugins: entries.map((entry) => assess(entry.id)),
      states: Object.fromEntries(entries.map((entry) => [entry.id, assess(entry.id).state]))
    }
  }

  /**
   * Bring the bundled set to the state the release decided (§23).
   *
   * `install` here is the store's installer, injected. Nothing is installed unless the manifest says
   * the reference was tested, and a user-disabled plugin is never touched.
   */
  async function ensure() {
    const applied = []
    for (const entry of entries) {
      const assessed = assess(entry.id)
      if (assessed.state === BUNDLED_STATE.USER_DISABLED || assessed.state === BUNDLED_STATE.UNTESTED || assessed.state === BUNDLED_STATE.INSTALLED || assessed.state === BUNDLED_STATE.AHEAD_OF_PIN) {
        applied.push({ id: entry.id, action: 'none', state: assessed.state, reason: assessed.reason })
        continue
      }
      if (assessed.state === BUNDLED_STATE.INCOMPATIBLE) {
        applied.push({ id: entry.id, action: 'report', state: assessed.state, reason: assessed.reason })
        continue
      }
      if (typeof install !== 'function') {
        const failed = { id: entry.id, action: 'install', state: BUNDLED_STATE.FAILED, reason: 'no installer is available' }
        results.set(entry.id, failed)
        applied.push(failed)
        continue
      }
      const outcome = await install({ id: entry.id, repo: entry.repo, ref: entry.ref, commit: entry.commit, role: entry.role })
      const record = { id: entry.id, action: 'install', state: outcome?.ok === false ? BUNDLED_STATE.FAILED : BUNDLED_STATE.INSTALLED, reason: outcome?.reason || null, version: outcome?.version || null }
      results.set(entry.id, record)
      applied.push(record)
      log(`[bundled] ${entry.id}: ${record.state}${record.reason ? ` — ${record.reason}` : ''}`)
    }
    return applied
  }

  /**
   * Repair one plugin (§19 "必要时修复", §47): remove what is there and install the pinned reference
   * again. This is the *only* path that replaces an installed plugin, and it is never automatic.
   */
  async function repair(id) {
    const entry = entryById(id)
    if (!entry) return { id, ok: false, reason: 'not a bundled plugin' }
    if (entry.tested !== true) return { id, ok: false, reason: `nothing to repair against: ${entry.ref} has not been tested inside DS-Hns yet` }
    if (typeof install !== 'function') return { id, ok: false, reason: 'no installer is available' }
    if (typeof uninstall === 'function') {
      const removed = await uninstall(id)
      if (removed?.ok === false) return { id, ok: false, reason: removed.reason || 'the old copy could not be removed' }
    }
    const outcome = await install({ id, repo: entry.repo, ref: entry.ref, commit: entry.commit, role: entry.role })
    return { id, ok: outcome?.ok !== false, version: outcome?.version || null, reason: outcome?.reason || null }
  }

  /**
   * Register the bundled plugins as protected modules, so their failure is a degradation the MEGA
   * panel can show (§18) instead of something the boot has to survive.
   */
  function registerProtected() {
    if (!protection || typeof protection.register !== 'function') return []
    const registered = []
    for (const entry of entries) {
      const fallback = BUNDLED_FALLBACK[entry.role] || null
      protection.register({
        id: `bundled:${entry.id}`,
        optional: true,
        version: entry.ref,
        start: async () => {
          const assessed = assess(entry.id)
          if (assessed.state === BUNDLED_STATE.USER_DISABLED) return 'disabled by the user'
          if (assessed.state === BUNDLED_STATE.UNTESTED) {
            // Not an error: the plugin is declared and unpinned. Reporting it as degraded would put a
            // permanent fault in the panel for a decision this release has not made yet.
            return `declared, untested (${entry.ref})`
          }
          if (assessed.state === BUNDLED_STATE.MISSING) {
            const applied = await ensure()
            const outcome = applied.find((item) => item.id === entry.id)
            if (outcome?.state === BUNDLED_STATE.FAILED) throw new Error(outcome.reason || 'install failed')
          }
          return assessed.state
        },
        fallback: fallback ? [{ id: fallback.id, run: () => fallback.label }] : []
      })
      registered.push(entry.id)
    }
    return registered
  }

  return {
    BUNDLED_MANIFEST,
    BUNDLED_STATE,
    manifest: () => ({ version: manifest.version, plugins: entries.map((entry) => ({ ...entry })) }),
    assess,
    describe,
    ensure,
    repair,
    registerProtected,
    results: () => [...results.values()]
  }
}

module.exports = {
  createBundledPlugins,
  BUNDLED_MANIFEST,
  BUNDLED_STATE,
  BUNDLED_FALLBACK
}
