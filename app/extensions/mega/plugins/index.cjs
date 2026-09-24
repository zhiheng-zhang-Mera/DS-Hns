'use strict'

const fs = require('node:fs')
const path = require('node:path')

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
 * The bundled set, as a release manifest (§21) — **with the channel each entry actually belongs to.**
 *
 * The first version of this manifest assumed both plugins were DS-Hns plugins that our own store could stage.
 * Reading the two repositories says otherwise, and the difference is not cosmetic:
 *
 *   * **`dsh-plugin-wallpaper-engine`** (repository `elysia395/dsh-wallpaper-engine`, pinned at the `v0.7.1`
 *     tag): its `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml` and
 *     `dsh.client.platform: "web"` with `inject: ["@deepseek-ai/dsh-client-runtime"]`. It is a **Harness client
 *     plugin** — it patches a Harness *profile* and runs inside the official web GUI. It cannot be a
 *     `dshns.plugin/v1` plugin: it has no `dshns-plugin.json`, it does not run in this product's plugin host,
 *     and "our store" is the wrong installation channel for it. The Harness ships the right one itself:
 *     `dsh plugin --profile <name> add <package>` (which forwards to pnpm inside the profile directory).
 *   * **`@dsh-market/plugin`** (repository `2BingLing/dsh-market`, published version 0.4.7): the first pass
 *     read that repository's *root* `package.json` — `dsh-market` 0.1.0, `private: true`, a workspace root —
 *     and wrongly concluded the plan's name did not exist. It does: `@dsh-market/plugin` is published on npm
 *     (0.4.7 as of this manifest), its manifest declares the same
 *     `dsh.bundle.patch: ./cordis.patch.yml` + `dsh.client.platform: "web"` as the wallpaper engine, and the
 *     project's own README gives its installation command as
 *     `npx @deepseek-ai/dsh plugin --profile web add @dsh-market/plugin`. So it belongs to the **same channel**:
 *     a Harness client plugin, installed by the Harness' CLI, pinned to a published version.
 *
 * **`tested` is now true on both, and it was earned by a real machine run rather than by the pin being tidy**:
 * both plugins were installed into the product's own profile, the application was restarted with them loaded,
 * and the manual UI review found the official Harness interface normal — which is the failure mode a broken
 * client plugin would have shown as (a client plugin rewrites the official page from inside). The wallpaper
 * plugin drew its own background, the market's entry appeared, and the governance bridge answered on loopback.
 * What that review does *not* claim is §23's failure rows one by one — disabled, crash, bad config, network
 * loss, version mismatch, rollback — they are the protection layer's and this manager's own policy paths, and
 * they are covered where they live (`mega-protection.test.js`, `bundled-plugins.test.js`,
 * `appearance-providers.test.js`). `docs/pluginize.md` records the split in full.
 *
 * **`channelVerified`** is the third, narrower thing, and it was earned rather than assumed: the command the
 * `harness-profile` channel builds was run for real, in a throwaway `DSH_HOME` with its own profile —
 * `dsh plugin --profile hns-verify add @dsh-market/plugin@0.4.7` and the same for
 * `dsh-plugin-wallpaper-engine@0.7.1` — and both landed in that profile's `package.json` at exactly those
 * versions. So: the command shape, the package names and the version pins are verified; what is *not* is the
 * plugins' runtime behaviour inside this product, which is what `tested` means and why it is still false.
 */
const BUNDLED_MANIFEST = Object.freeze({
  version: 'target-standby',
  plugins: Object.freeze([
    /**
     * The two **built-in** plugins this product ships in its own repository.
     *
     * They are entries here for the same reason the two community ones are: this manifest is the one
     * place that says *what this release carries, at which reference, through which channel*, and the
     * installer, the manager and the panel all read it. What makes them built-in is not a field — it
     * is where they live (`app/plugins/<name>`, shipped in the checkout) and that their `required` is
     * true: the installation signs them into the profile unconditionally, in its own step before any
     * optional plugin is mentioned, and a plugin a user may turn down is a different kind of thing.
     *
     * The channel is `harness-profile` because that is *how the Harness' own CLI installs a `file:`
     * spec* — `dsh plugin --profile web add file:<in-repo path>` — and it is the channel that puts
     * them in the official UI's plugin inventory. `inRepo: true` records the other half: the code is
     * in this repository, mounted by `app/plugin-host.cjs` through `NativeHnsAdapter`, so a runtime
     * update is a `git pull` and never a re-fetch.
     */
    Object.freeze({
      id: 'dshns.health-scheduler',
      role: 'health',
      repo: null,
      channel: 'harness-profile',
      package: 'dsh-health-scheduler',
      /** The directory under `app/plugins/`, for the installer and for the reader. */
      directory: 'health-scheduler',
      inRepo: true,
      ref: '2.0.1',
      commit: null,
      channelVerified: true,
      tested: true,
      required: true
    }),
    Object.freeze({
      id: 'dshns.restart-supervisor',
      role: 'restart',
      repo: null,
      channel: 'harness-profile',
      package: 'dsh-restart-supervisor',
      directory: 'restart-supervisor',
      inRepo: true,
      ref: '1.0.1',
      commit: null,
      channelVerified: true,
      tested: true,
      required: true
    }),
    Object.freeze({
      id: 'dsh-wallpaper-engine',
      role: 'appearance',
      repo: 'elysia395/dsh-wallpaper-engine',
      /** Where it belongs: a Harness *profile* plugin, installed by the Harness' own CLI (see above). */
      channel: 'harness-profile',
      package: 'dsh-plugin-wallpaper-engine',
      ref: 'v0.7.1',
      commit: '4de97fc88905077fac879c6bf493aed3575c3b9e',
      /** The install command was run for real in a throwaway profile, and then in the product's own (above). */
      channelVerified: true,
      /** The manual UI review ran this inside the product: the official UI stayed normal with it loaded. */
      tested: true,
      required: false
    }),
    Object.freeze({
      id: '@dsh-market/plugin',
      role: 'plugin-store',
      repo: '2BingLing/dsh-market',
      /** The same channel as the wallpaper engine: a Harness client plugin, pinned to a published version. */
      channel: 'harness-profile',
      package: '@dsh-market/plugin',
      ref: '0.4.7',
      commit: '2c34728e7e0e478774e91282d6ec1723fe4b9037',
      channelVerified: true,
      tested: true,
      required: false
    })
  ])
})

/** The installation channels a bundled entry can name. */
const BUNDLED_CHANNELS = Object.freeze(['harness-profile', 'dshns-store', 'unresolved'])

/** The roles that mean "this product ships it in its own repository". */
const BUILT_IN_ROLES = Object.freeze(['health', 'restart'])

/**
 * The built-in plugins, as the *installer* sees them.
 *
 * `scripts\install-bundled-plugins.ps1` is a PowerShell program and cannot read a frozen object out
 * of a CommonJS file, so it reads `bundled-plugins.json` instead — and the two are kept in step by
 * `tests/unit/restart-supervisor-authority.test.js`, which asserts that every built-in entry in this
 * manifest appears in the file with the same id, directory and reference. A second list that could
 * drift silently would be worse than no list, so the drift is a failing test rather than a hope.
 */
function builtInEntries(manifest = BUNDLED_MANIFEST) {
  return (Array.isArray(manifest && manifest.plugins) ? manifest.plugins : []).filter((entry) => entry.inRepo === true || BUILT_IN_ROLES.includes(entry.role))
}

/**
 * The **community** entries: the plugins this product offers and does not ship.
 *
 * The complement of `builtInEntries`, and it exists for the same reason: the manifest is one list, and
 * every reader that used to iterate "the plugins" now has to say which half it means. The installer's
 * optional step, the pins-and-channels policy and the panel's community roster all read this one.
 */
function communityEntries(manifest = BUNDLED_MANIFEST) {
  const builtIn = new Set(builtInEntries(manifest).map((entry) => entry.id))
  return (Array.isArray(manifest && manifest.plugins) ? manifest.plugins : []).filter((entry) => !builtIn.has(entry.id))
}

/** Where a bundled plugin's fallback leads, per §18: what the product does without it. */
const BUNDLED_FALLBACK = Object.freeze({
  appearance: { id: 'simple-wallpaper', label: 'the built-in simple wallpaper' },
  'plugin-store': { id: 'store-hidden', label: 'the store entry stays hidden' },
  /**
   * The two built-in plugins have no fallback, and saying so is the honest row.
   *
   * Without the restart supervisor there is no restart authority at all: a request is reported
   * unavailable and the monitor keeps watching. Without the health scheduler nothing samples the
   * machine. Neither is replaced by something simpler, because "restart anyway" and "guess the
   * pressure" are not fallbacks — they are the failures these plugins exist to prevent.
   */
  health: { id: 'health-off', label: 'no health sampling and no maintenance decision' },
  restart: { id: 'restart-unavailable', label: 'no restart can be requested or executed' }
})

/** §23: what the manager decided about one plugin. */
const BUNDLED_STATE = Object.freeze({
  MISSING: 'missing',
  /** Declared, but with no installation channel: there is a decision to make, not an install to run. */
  UNRESOLVED: 'unresolved',
  UNTESTED: 'untested',
  INSTALLED: 'installed',
  OUTDATED: 'outdated',
  AHEAD_OF_PIN: 'ahead-of-pin',
  INCOMPATIBLE: 'incompatible',
  USER_DISABLED: 'user-disabled',
  FAILED: 'failed'
})

/** A pin and an installed version are the same reference when their version text is the same, with or without
 * a leading `v`: the manifest pins the wallpaper engine's *tag* (`v0.7.1`) and npm records the *version*
 * (`0.7.1`), and a manager that called those different would report a correctly installed plugin as unknown. */
function normalizeReference(value) {
  return String(value || '').trim().replace(/^v(?=\d)/i, '')
}

/**
 * Whether two references name the same version.
 *
 * Both sides are normalised before they are compared, and that is the half that was missing: the rule is
 * symmetric — `v0.7.1` written for `0.7.1` and `0.7.1` written for `v0.7.1` are one reference, whichever
 * side the `v` happens to be on. The Harness' own CLI records the *published version* (`0.7.1`) in the
 * profile's `dependencies` while the release manifest pins the repository's *tag* (`v0.7.1`), so a
 * one-sided comparison reported a correctly installed plugin as "ahead of pin" whenever the tag carried
 * the `v` and the recorded version did not.
 */
function sameVersionReference(left, right) {
  const a = normalizeReference(left)
  const b = normalizeReference(right)
  return Boolean(a) && a === b
}

function sameReference(installed, entry) {
  if (!installed) return false
  const version = String(installed.version || installed.commit || '')
  if (!version) return false
  return version === entry.ref
    || version === entry.commit
    || sameVersionReference(version, entry.ref)
}

/**
 * Return the version that is actually installed in a Harness profile.
 *
 * Published dependencies carry their version in the declaration. A local
 * `file:` dependency carries only a checkout path there, so comparing that
 * path with a release pin produces a false drift warning. For that shape the
 * materialised package is the authority and its own package.json supplies the
 * version. If it is missing or unreadable we retain the declaration so the
 * caller reports the mismatch instead of inventing a successful install.
 */
function resolveProfileDependencyVersion(profileDir, packageName, declared) {
  const declaration = String(declared || '').replace(/^[\^~]/, '')
  if (!/^file:/i.test(declaration)) return declaration
  try {
    const manifest = path.join(profileDir, 'node_modules', ...String(packageName || '').split('/'), 'package.json')
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    const version = String(parsed?.version || '').trim()
    return version || declaration
  } catch {
    return declaration
  }
}

/**
 * The bundled entry a Harness profile dependency refers to.
 *
 * A profile's `dependencies` are npm **package names** while this manifest keys its entries by **plugin
 * id**, and for the wallpaper engine those are different strings (`dsh-plugin-wallpaper-engine` vs
 * `dsh-wallpaper-engine`). Every reader joining a profile's install to this manifest has to translate
 * between them, so the translation is made once, here, rather than once per reader — a reader that
 * skipped it asked the manager about an id nothing declares and was told, wrongly, that the plugin was
 * missing.
 *
 * @param {string} name the package name recorded in a profile's `dependencies`
 * @param {object} [manifest] the release manifest, defaulting to the shipped one
 * @returns {object|null} the bundled entry, or `null` when the dependency is not a bundled plugin
 */
function entryForPackage(name, manifest = BUNDLED_MANIFEST) {
  const wanted = String(name || '')
  if (!wanted) return null
  const entries = Array.isArray(manifest && manifest.plugins) ? manifest.plugins : []
  return entries.find((entry) => String(entry.package || entry.id) === wanted) || null
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
    // Before presence and before the pin: an entry whose channel is unresolved is not "missing", it is
    // undecided, and saying so is the difference between a task and a defect.
    if (entry.channel === 'unresolved') {
      return {
        id,
        known: true,
        role: entry.role,
        present: Boolean(record),
        installedVersion: record?.version || null,
        expected: entry.ref,
        state: BUNDLED_STATE.UNRESOLVED,
        reason: entry.reason || `${id} has no installation channel yet`
      }
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
      manifest: {
        version: manifest.version,
        plugins: entries.map((entry) => ({
          id: entry.id,
          role: entry.role,
          channel: entry.channel || 'dshns-store',
          package: entry.package || null,
          ref: entry.ref,
          // Two different claims, kept apart on purpose: the channel was exercised for real, the plugin has not
          // been run inside the product yet.
          channelVerified: entry.channelVerified === true,
          tested: entry.tested === true,
          required: entry.required === true
        }))
      },
      /**
       * Each assessment, plus the three facts about how it is meant to be adopted (which channel, whether that
       * channel was exercised, whether it has been run in this product). They live on the entry because the
       * manager is the one place that knows both halves — a panel reading only the assessment would show a
       * declared plugin and an installable one as the same thing.
       */
      plugins: entries.map((entry) => ({
        ...assess(entry.id),
        channel: entry.channel || 'dshns-store',
        channelVerified: entry.channelVerified === true,
        tested: entry.tested === true
      })),
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
      /**
       * A **built-in** plugin is never installed by a boot.
       *
       * `inRepo: true` means the code ships in this repository, so "bundled" is a promise the
       * *installation* keeps: `scripts\install-bundled-plugins.ps1` signs both plugins into the Harness
       * profile before the product is ever started, and the completion summary reports what it found.
       * A boot that reached for a package manager to fetch its own components would be the opposite of
       * that promise — and it would be a boot that can be delayed by a network, which §35 forbids.
       *
       * Being absent is therefore *reported*, and it is reported in the state it really is: a person
       * reads it in the official page and re-runs the installer. Repair stays available and stays
       * explicit: `repair(id)` still installs the pinned copy, because somebody asked for it.
       */
      if (entry.inRepo === true) {
        applied.push({
          id: entry.id,
          action: 'delegated',
          state: assessed.state,
          reason: 'the installation signs the built-in plugins into the Harness profile; a boot never installs its own components'
        })
        continue
      }
      // An entry with no channel is a decision, not an install: it is reported and left exactly where it is.
      if (assessed.state === BUNDLED_STATE.UNRESOLVED) {
        applied.push({ id: entry.id, action: 'report', state: assessed.state, reason: assessed.reason })
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
      // The whole entry is handed over, not a trimmed copy: a built-in plugin's installation spec is
      // built from its own `inRepo`/`directory` fields, and an installer that received only the id
      // would ask the channel for a package that does not exist under that name.
      const outcome = await install({ ...entry })
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
    const outcome = await install({ ...entry })
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

/**
 * Install one bundled entry through **its own channel** (see the manifest's notes).
 *
 * `channel: 'harness-profile'` asks the Harness' CLI (`dsh plugin --profile <p> add <package>@<ref>`), which is
 * the only thing that can install a Harness client plugin — it belongs to a profile, not to this product's
 * plugin host. `channel: 'dshns-store'` is this product's own two-step store (stage, then enable) for plugins
 * that really are `dshns.plugin/v1` plugins. `channel: 'unresolved'` is refused with the reason recorded in the
 * manifest, because there is a decision to make there rather than an install to run.
 *
 * The hooks are injected, so the policy above is testable without a network, a profile, or a store.
 *
 * @param {object}   entry
 * @param {object}   [hooks]
 * @param {Function} [hooks.harnessAdd] `({ profile, package: spec }) => { ok, reason }`
 * @param {object}   [hooks.store]      `{ stage, enable }`
 * @param {string}   [hooks.profile]    the Harness profile to add into
 * @param {Function} [hooks.verify]     `(input) => ({ ok, reason, adapter? })` — the compatibility check for
 *   the channel, run through the adapter layer by the caller. A harness-profile install is a package the
 *   Harness will compose; whether it really is the community bundle the release pinned is a question about
 *   the *installed files*, and it is asked after the CLI succeeded rather than assumed from the exit code.
 *   A refusal is reported as a failure on purpose: an install nobody can recognise is not an install.
 */
async function installBundled(entry = {}, { harnessAdd = null, store = null, profile = 'web', verify = null, root = null } = {}) {
  const channel = String(entry.channel || 'dshns-store')
  /**
   * What the channel is asked to install.
   *
   * A built-in plugin (`inRepo: true`) is a directory in *this* repository, so its spec is an
   * absolute `file:` path — that is the one form the Harness' CLI accepts for a package that is not
   * being fetched from anywhere, and it is the same form `scripts\install-profile-plugin.ps1` uses.
   * Everything else is a published package at a pinned reference.
   *
   * The path is built from the entry's own `directory` field rather than from its id, because the two
   * are different strings on purpose: `dshns.health-scheduler` is the plugin id and
   * `app/plugins/health-scheduler` is where the code is. The repository root is four levels up from
   * this file (`app/extensions/mega/plugins/`), and the path is written with forward slashes because
   * that is what the spec is parsed as.
   */
  const inRepoSpec = entry.inRepo === true && entry.directory
    ? `file:${path.join(root || path.join(__dirname, '..', '..', '..', '..'), 'app', 'plugins', entry.directory).replace(/\\/g, '/')}`
    : null
  const spec = inRepoSpec || (entry.package ? `${entry.package}@${entry.ref}` : null)
  if (channel === 'unresolved') {
    return { ok: false, channel, reason: entry.reason || `${entry.id} has no installation channel yet` }
  }
  if (channel === 'harness-profile') {
    if (typeof harnessAdd !== 'function') return { ok: false, channel, reason: 'no Harness plugin CLI is available' }
    try {
      const outcome = await harnessAdd({ profile, package: spec })
      if (outcome?.ok === false) return { ok: false, channel, reason: outcome.reason || 'the Harness refused the plugin' }
      // The CLI's exit code is the installer, not the proof: the installed package is read back and
      // adapted before the install is called a success.
      if (typeof verify === 'function') {
        let checked = null
        try {
          checked = await verify({ id: entry.id, channel, profile, package: spec, packageName: entry.package, ref: entry.ref })
        } catch (error) {
          return { ok: false, channel, reason: `the installed copy could not be verified: ${String(error?.message || error)}` }
        }
        if (checked && checked.ok === false) {
          return { ok: false, channel, reason: checked.reason || 'the installed copy was refused by the adapter layer', verify: checked }
        }
        return { ok: true, channel, profile, package: spec, version: entry.ref, verify: checked || null }
      }
      return { ok: true, channel, profile, package: spec, version: entry.ref }
    } catch (error) {
      return { ok: false, channel, reason: String(error?.message || error) }
    }
  }
  if (channel !== 'dshns-store') return { ok: false, channel, reason: `"${channel}" is not an installation channel` }
  if (!store || typeof store.stage !== 'function') return { ok: false, channel, reason: 'no store is available' }
  const looksLikeACommit = /^[0-9a-f]{7,40}$/i.test(String(entry.ref || '')) && !/^v?\d+\.\d+/.test(String(entry.ref || ''))
  const staged = looksLikeACommit
    ? store.stage({ source: entry.repo, revision: entry.ref })
    : store.stage({ source: entry.repo, branch: entry.ref })
  if (staged?.ok === false) return { ok: false, channel, reason: staged.reason || 'the store refused to stage it' }
  const id = staged?.entry?.id || entry.id
  if (typeof store.enable === 'function') {
    const enabled = store.enable({ id })
    if (enabled?.ok === false) return { ok: false, channel, staged: true, id, reason: enabled.reason || 'it was staged but not enabled' }
  }
  return { ok: true, channel, id, version: staged?.entry?.version || entry.ref }
}

/**
 * Remove one bundled entry through **its own channel**, the same way `installBundled` installs it.
 *
 * This matters for repair: replacing a Harness client plugin by asking *our* store to remove it would remove
 * nothing (it was never there) and then report success — a repair that silently did nothing is worse than one
 * that fails. `channel: 'unresolved'` refuses here too: there is nothing to remove for an entry that has never
 * had a way to be installed.
 *
 * @param {object}   entry
 * @param {object}   [hooks]
 * @param {Function} [hooks.harnessRemove] `({ profile, package: spec }) => { ok, reason }`
 * @param {object}   [hooks.store]         `{ remove }`
 * @param {string}   [hooks.profile]
 */
async function removeBundled(entry = {}, { harnessRemove = null, store = null, profile = 'web' } = {}) {
  const channel = String(entry.channel || 'dshns-store')
  if (channel === 'unresolved') {
    return { ok: false, channel, reason: entry.reason || `${entry.id} has no installation channel, so there is nothing to remove` }
  }
  if (channel === 'harness-profile') {
    if (typeof harnessRemove !== 'function') return { ok: false, channel, reason: 'no Harness plugin CLI is available' }
    if (!entry.package) return { ok: false, channel, reason: `${entry.id} names no package to remove` }
    try {
      const outcome = await harnessRemove({ profile, package: entry.package })
      if (outcome?.ok === false) return { ok: false, channel, reason: outcome.reason || 'the Harness refused to remove it' }
      return { ok: true, channel, profile, package: entry.package }
    } catch (error) {
      return { ok: false, channel, reason: String(error?.message || error) }
    }
  }
  if (channel !== 'dshns-store') return { ok: false, channel, reason: `"${channel}" is not an installation channel` }
  if (!store || typeof store.remove !== 'function') return { ok: false, channel, reason: 'no store is available' }
  const outcome = await store.remove({ id: entry.id })
  return outcome?.ok === false ? { ok: false, channel, reason: outcome.reason || 'the store refused to remove it' } : { ok: true, channel, id: entry.id }
}

module.exports = {
  createBundledPlugins,
  BUNDLED_MANIFEST,
  BUNDLED_STATE,
  BUNDLED_FALLBACK,
  BUNDLED_CHANNELS,
  BUILT_IN_ROLES,
  builtInEntries,
  communityEntries,
  installBundled,
  removeBundled,
  sameReference,
  sameVersionReference,
  resolveProfileDependencyVersion,
  entryForPackage,
  normalizeReference
}
