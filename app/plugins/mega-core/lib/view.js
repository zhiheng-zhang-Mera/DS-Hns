/**
 * The Mega view model (`updateplan/pluginize.md` §4.2-§4.4).
 *
 * The orb, its panel and the Mega settings page all show the same thing, and "the same thing" is this
 * object: the orb's hover lines, the lines its panel lists, and the eleven fields of §4.4, all derived from
 * **one** input — the governance snapshot DS-Hns already answers with (`app/extensions/mega/control-center.cjs`
 * behind `app/core/governance-bridge.cjs`). There is no second computation of governance anywhere in the
 * plugin: the numbers in the orb cannot disagree with the numbers the Control Center shows, because they are
 * the same numbers.
 *
 * Two decisions in here are worth naming, because both are about not lying to the user:
 *
 *   1. **"Unavailable" is a status, not an error page.** DS-Hns is a separate process; when it is not
 *      running the bridge has nothing to answer, and the honest thing to draw is a grey orb that says so —
 *      with the reason — rather than an orb that hides, or one that invents "Healthy". `available: false` is
 *      therefore the first branch of everything below.
 *   2. **Pending human work is read, never assumed.** §7's Human Gate is a later phase; until DS-Hns
 *      publishes `pending` in its snapshot the number is absent and the orb reports zero — which is true,
 *      because with no gate nothing can be waiting. When the gate lands it publishes the count and this file
 *      reads it without a change (see `PENDING_KEY`).
 */

/**
 * The actions governance will accept (`app/core/governance-bridge.cjs`'s closed set).
 *
 * It is duplicated here on purpose: the browser half must be able to say what it *may* ask for without a
 * round trip, and the two lists are checked against each other by `tests/unit/mega-core-view.test.js`, so a
 * divergence is a failing test rather than a button that silently does nothing.
 */
export const MEGA_ACTIONS = Object.freeze(['check', 'retry', 'reset-fallback', 'repair', 'disable', 'enable'])

/** The snapshot key §7's Human Gate will publish. Absent today; read, never required. */
export const PENDING_KEY = 'pending'

/** Deliberately dot-free so a float can never grow a fractional part from arithmetic on it. */
const DEFAULT_SIZE = 40

/** One field of §4.4: the two labels the plan writes side by side, a value, and the tone that makes it visible. */
function field(id, cn, en, value, tone = null) {
  return { id, cn, en, value: value === undefined || value === null || value === '' ? '—' : String(value), tone }
}

/** A line the panel can list: a tone and one sentence. */
function line(tone, text) {
  return { tone, text }
}

function moduleTone(state) {
  if (state === 'HEALTHY') return 'ok'
  if (state === 'DISABLED') return null
  if (state === 'FAILED') return 'bad'
  return 'warn'
}

function pluginTone(state) {
  if (state === 'installed') return 'ok'
  if (state === 'incompatible' || state === 'failed') return 'bad'
  return 'warn'
}

/** `check` is the cheapest useful action, and it is what is offered when nothing is wrong. */
function recoveryActions(modules, plugins, { healthy }) {
  const offered = new Set()
  for (const module of modules) {
    if (module.state === 'HEALTHY') continue
    for (const action of module.actions || []) offered.add(action)
  }
  for (const plugin of plugins) {
    if (plugin.state === 'installed') continue
    for (const action of plugin.actions || []) offered.add(action)
  }
  if (!offered.size) return healthy ? ['check'] : []
  // Ordered by the closed set, so the sentence reads the same way every time rather than in insertion order.
  return MEGA_ACTIONS.filter((action) => offered.has(action))
}

/**
 * Build the one object both surfaces render.
 *
 * @param {object} input
 * @param {object} [input.plugin]     `{ id, version }` of this plugin, from its own package
 * @param {object} [input.bridge]     the discovery answer: `{ available, host, port }` or `{ available: false, reason }`
 * @param {object} [input.governance] the Control Center snapshot, or null when the bridge did not answer
 * @param {Function} [input.now]      the clock, injected so a test can pin `at`
 */
export function buildMegaView({ plugin = {}, bridge = null, governance = null, now = () => new Date().toISOString() } = {}) {
  const pluginId = plugin.id || 'dsh-plugin-mega-core'
  const version = plugin.version || null
  const at = now()
  const bridgeOk = Boolean(bridge?.available)

  // Unavailable first: everything below assumes a snapshot, and a missing one is not "zero faults".
  if (!governance || governance.ok === false) {
    const reason = governance?.reason || bridge?.reason || 'DS-Hns has not answered yet'
    return {
      ok: true,
      available: false,
      reason,
      status: { tone: 'unknown', label: 'Unavailable', attention: 0, active: 0, total: 0, pending: 0, failing: 0 },
      hover: ['DS-Hns', 'Unavailable', 'governance is not reachable', '—'],
      lines: [line('warn', reason)],
      actions: [],
      fields: [
        field('health', '插件健康', 'Plugin health', 'unavailable', 'warn'),
        field('version', '版本', 'Version', version ? `${pluginId} ${version}` : pluginId),
        field('capabilities', '能力', 'Capabilities', '—', 'warn'),
        field('pending', '待人工', 'Pending human dependency', '—', 'warn'),
        field('bridge', '治理通道', 'Governance bridge', reason, 'warn')
      ],
      modules: [],
      plugins: [],
      capabilities: [],
      version: { plugin: version, schema: bridge?.schema ?? null },
      at
    }
  }

  const modules = Array.isArray(governance.modules) ? governance.modules : []
  const plugins = Array.isArray(governance.plugins) ? governance.plugins : []
  const degraded = Number(governance.degraded || 0)
  const failed = Number(governance.failed || 0)
  const failing = Number(governance.failing || 0)
  const pending = Math.max(0, Number(governance[PENDING_KEY] || 0))

  const healthyModules = modules.filter((module) => module.state === 'HEALTHY')
  const installed = plugins.filter((entry) => entry.state === 'installed')
  const total = modules.length + plugins.length
  const active = healthyModules.length + installed.length
  const attention = failed + degraded + pending
  const tone = failed ? 'bad' : (degraded || pending) ? 'warn' : 'ok'
  const label = failed ? 'Failed' : degraded ? 'Degraded' : 'Healthy'

  /**
   * §4.2's expanded list: what is wrong first, then what is fine.
   *
   * Both halves matter. A list of only faults is a list that looks identical whether nothing is running or
   * everything is broken; the positive lines are what make "empty" mean "checked, and fine".
   */
  const lines = []
  for (const module of modules) {
    if (module.state === 'HEALTHY' || module.state === 'DISABLED') continue
    lines.push(line(moduleTone(module.state), `${module.state === 'FAILED' ? '✖' : '⚠'} ${module.id} ${String(module.state).toLowerCase()}${module.lastError ? ` — ${module.lastError}` : ''}`))
  }
  for (const entry of plugins) {
    if (entry.state === 'installed') continue
    lines.push(line(pluginTone(entry.state), `${entry.state === 'failed' || entry.state === 'incompatible' ? '✖' : '⚠'} ${entry.id} ${entry.state || 'unknown'}${entry.reason ? ` — ${entry.reason}` : ''}`))
  }
  if (pending > 0) lines.push(line('warn', `⏸ ${pending} task(s) waiting for human`))
  if (!lines.length) lines.push(line('ok', `✓ ${modules.length} plugin module(s) healthy`))
  // The two positive lines are stated whatever the faults are: they are facts about *other* things, and a list
  // that dropped them whenever a module degraded would read as if nothing had been checked at all.
  lines.push(line('ok', `✓ ${installed.length} of ${plugins.length} bundled plugin(s) installed`))
  if (!failing) lines.push(line('ok', '✓ no blocked or retrying tasks'))

  const capabilities = MEGA_ACTIONS.slice()
  const retries = modules.reduce((sum, module) => sum + Number(module.retries || 0), 0)
  const retrying = modules.filter((module) => Number(module.retries || 0) > 0)
  const fellBack = modules.filter((module) => module.fallback)
  const errored = modules.filter((module) => module.lastError)
  const incompatible = plugins.filter((entry) => entry.state === 'incompatible' || entry.state === 'failed')

  const fields = [
    field('health', '插件健康', 'Plugin health', `${healthyModules.length}/${modules.length} module(s) healthy · ${installed.length}/${plugins.length} plugin(s) installed`, tone),
    // §4.4's "Dependencies": for a bundled plugin that is its channel and the pin it was installed from.
    field('dependencies', '依赖', 'Dependencies', plugins.map((entry) => `${entry.id}: ${entry.state || 'unknown'}${entry.installedVersion ? ` @${entry.installedVersion}` : ''}${entry.channel ? ` (${entry.channel}${entry.channelVerified ? ' · verified' : ''}${entry.tested ? ' · tested' : ' · untested'})` : ''}`).join('; ')),
    field('version', '版本', 'Version', `${pluginId} ${version || 'unknown'} · DS-Hns snapshot schema ${bridge?.schema ?? '—'}`),
    field('capabilities', '能力', 'Capabilities', `${capabilities.length} action(s): ${capabilities.join(', ')}`),
    field('retries', '重试', 'Retries', `${retries} across ${retrying.length} module(s)`, retries ? 'warn' : null),
    field('fallback', '回退', 'Fallback', fellBack.map((module) => `${module.id} → ${module.fallback}`).join('; ')),
    field('lastError', '最近错误', 'Last error', errored.map((module) => `${module.id}: ${module.lastError}`).join('; '), errored.length ? 'warn' : 'ok'),
    field('pending', '待人工', 'Pending human dependency', pending, pending ? 'warn' : null),
    field('recovery', '恢复动作', 'Recovery action', recoveryActions(modules, plugins, { healthy: !degraded && !failed }).join(', ')),
    field('compatibility', '兼容性', 'Compatibility', incompatible.length ? `incompatible: ${incompatible.map((entry) => entry.id).join(', ')}` : 'compatible', incompatible.length ? 'bad' : 'ok'),
    field('pin', '版本钉', 'Update pin', plugins.map((entry) => `${entry.id} @ ${entry.expected || '—'}`).join('; '))
  ]

  return {
    ok: true,
    available: true,
    reason: null,
    status: { tone, label, attention, active, total, pending, failing },
    /**
     * §4.2's hover, in the order the plan writes it: who this is, whether it is well, how much is running,
     * and whether anyone is waiting. Four short lines beat one long sentence on a tooltip.
     */
    hover: [
      'DS-Hns',
      label,
      `${active} of ${total} plugin(s) active`,
      `${pending} pending`
    ],
    lines,
    actions: recoveryActions(modules, plugins, { healthy: !degraded && !failed }),
    fields,
    modules,
    plugins,
    capabilities,
    version: { plugin: version, schema: bridge?.schema ?? null },
    at
  }
}

/** The orb's own size, shared with the host store's clamp so a stored position is inside the same box. */
export const ORB_SIZE = DEFAULT_SIZE
