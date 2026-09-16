'use strict'

/**
 * The appearance providers (`updateplan/startup2.md` §43-§44; `startup.md` §6-§7).
 *
 * The plan draws one line and this module is it: DS-Hns keeps a **simple** wallpaper of its own (an image per
 * backdrop, its position, brightness and darkening) and stops maintaining an advanced one, because
 * `dsh-wallpaper-engine` does that better and is somebody else's job to keep working. The user chooses between
 * three experiences:
 *
 *   * **Official** — the official UI as it is: no picture over it, the glass only. This is the baseline the plan
 *     insists on (§3.1 of the v1 plan: the official UI must always be complete without any appearance layer).
 *   * **Simple** — the built-in wallpaper, which is the product's own implementation.
 *   * **Wallpaper Engine** — the community plugin, delegated to the bundled plugin manager.
 *
 * Two rules the plan states as requirements, both of which are visible in the shape of `select()`:
 *
 *   1. **The community plugin is never installed automatically** (§44). Choosing a provider whose plugin is
 *      missing does not fetch anything: it refuses, says what is missing, keeps the user where they were, and
 *      offers the two things a person can actually decide — stay on the official interface, or go look at the
 *      plugin. Anything else would be a product that quietly installs a third party's code because a menu was
 *      clicked.
 *   2. **Every provider has somewhere to fall back to** (§18): the community provider falls back to the simple
 *      wallpaper and then to the official interface, and the answer says which one is carrying it.
 *
 * The module is pure: it decides and reports, and the `apply` hooks it is handed are what touch the layers.
 */

/** The three providers, in the order the settings page shows them (§43). */
const APPEARANCE_PROVIDERS = Object.freeze({
  official: Object.freeze({
    id: 'official',
    label: '官方 · Official',
    note: 'the official interface as it is: no picture over it, the glass only',
    fallback: null,
    requires: null
  }),
  simple: Object.freeze({
    id: 'simple',
    label: '简单壁纸 · Simple wallpaper',
    note: 'the built-in wallpaper: an image per backdrop with its own fit, opacity, blur and scrim',
    fallback: 'official',
    requires: null
  }),
  community: Object.freeze({
    id: 'community',
    label: 'Wallpaper Engine · Wallpaper Engine',
    note: 'the community plugin renders the desktop; DS-Hns does not reimplement it',
    fallback: 'simple',
    /** §20/§21: the bundled plugin this provider is delegated to. */
    requires: 'dsh-wallpaper-engine'
  })
})

const APPEARANCE_PROVIDER_IDS = Object.freeze(Object.keys(APPEARANCE_PROVIDERS))

/**
 * Whether a provider can be used right now, and why not.
 *
 * `bundled` is the bundled plugin manager's report; a provider with no `requires` is always available, which is
 * what keeps Official — the baseline — usable whatever has happened to a plugin.
 */
function availability(provider, bundled = null) {
  if (!provider.requires) return { available: true, reason: null }
  const plugin = (bundled?.plugins || []).find((entry) => entry.id === provider.requires) || null
  if (!plugin) {
    return {
      available: false,
      reason: `${provider.requires} is not part of this build`,
      actions: ['keep-official', 'open-store']
    }
  }
  if (plugin.state === 'installed') return { available: true, reason: null, version: plugin.installedVersion || plugin.expected || null }
  return {
    available: false,
    reason: plugin.state === 'user-disabled'
      ? `${provider.requires} is installed but switched off by the user`
      : plugin.reason || `${provider.requires} is not installed (${plugin.state})`,
    actions: ['keep-official', 'open-store']
  }
}

/**
 * @param {object}   options
 * @param {object}   [options.apply]  `{ official, simple, community }` — what each provider does to the layers
 * @param {Function} [options.bundled] () => the bundled plugin manager's report
 * @param {Function} [options.log]
 */
function createAppearanceProviders({ apply = {}, bundled = null, log = () => {} } = {}) {
  function bundledReport() {
    if (typeof bundled !== 'function') return null
    try {
      return bundled()
    } catch (error) {
      log(`the bundled plugin report is unavailable: ${error?.message || error}`)
      return null
    }
  }

  /** What the settings page shows: the three providers, whether each is usable, and the current one. */
  function describe(current = 'simple') {
    const report = bundledReport()
    return {
      ok: true,
      active: APPEARANCE_PROVIDER_IDS.includes(current) ? current : 'simple',
      providers: APPEARANCE_PROVIDER_IDS.map((id) => {
        const provider = APPEARANCE_PROVIDERS[id]
        const state = availability(provider, report)
        return {
          id,
          label: provider.label,
          note: provider.note,
          requires: provider.requires,
          fallback: provider.fallback,
          available: state.available,
          reason: state.reason || null,
          version: state.version || null,
          actions: state.available ? [] : state.actions || []
        }
      }),
      /** §44: never install a third party's code because a menu was clicked. */
      installsAutomatically: false
    }
  }

  /**
   * Choose a provider.
   *
   * An unavailable provider is refused *with its fallback named*, and the refusal carries the two decisions the
   * user actually has; the layers are only touched when the provider is usable.
   */
  async function select(id, { current = 'simple' } = {}) {
    const provider = APPEARANCE_PROVIDERS[String(id || '').toLowerCase()]
    if (!provider) return { ok: false, provider: id, reason: `"${id}" is not an appearance provider; expected ${APPEARANCE_PROVIDER_IDS.join(', ')}` }
    const state = availability(provider, bundledReport())
    if (!state.available) {
      return {
        ok: false,
        provider: provider.id,
        reason: state.reason,
        /** Where the user stays: their current provider, and the provider's own fallback. */
        kept: current,
        fallback: provider.fallback,
        actions: state.actions || [],
        installed: false
      }
    }
    const hook = apply[provider.id]
    let applied = null
    if (typeof hook === 'function') {
      try {
        applied = await hook()
      } catch (error) {
        log(`the ${provider.id} appearance provider failed to apply: ${error?.message || error}`)
        return { ok: false, provider: provider.id, reason: String(error?.message || error), fallback: provider.fallback }
      }
    }
    log(`appearance provider: ${provider.id}`)
    return { ok: true, provider: provider.id, fallback: provider.fallback, applied }
  }

  return {
    APPEARANCE_PROVIDERS,
    APPEARANCE_PROVIDER_IDS,
    describe,
    select,
    availability: (id, report = bundledReport()) => {
      const provider = APPEARANCE_PROVIDERS[String(id || '').toLowerCase()]
      return provider ? availability(provider, report) : { available: false, reason: `"${id}" is not a provider` }
    }
  }
}

module.exports = {
  createAppearanceProviders,
  APPEARANCE_PROVIDERS,
  APPEARANCE_PROVIDER_IDS,
  availability
}
