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

/**
 * The dashboard's countdown row.
 *
 * DS-Hns publishes the row with the instant the window changes (`nextChangeIso`), not with a number of seconds:
 * the subtraction belongs where the view is built, so a panel opened three minutes after the snapshot shows
 * three minutes less rather than a stale figure. The two halves agree on this id by string, which is exactly
 * what `tests/unit/mega-core-view.test.js` checks.
 */
export const COUNTDOWN_ROW = 'price:until-off-peak'

/** Deliberately dot-free so a float can never grow a fractional part from arithmetic on it. */
const DEFAULT_SIZE = 40

/**
 * The countdown, re-derived here rather than read out of the snapshot.
 *
 * `controlCenter()` computes `secondsLeft` once, when the snapshot is taken; a panel opened three minutes later
 * would otherwise show the number from three minutes ago. The instant (`iso`) and the status it changes *to*
 * are facts that do not go stale, so those are what the snapshot carries and this is where the subtraction
 * happens — with the snapshot's own timestamp as the other end, so a view never mixes two clocks.
 */
function countdownText(iso, nowMs) {
  const target = Date.parse(String(iso || ''))
  if (!Number.isFinite(target)) return '—'
  const whole = Math.max(0, Math.floor((target - nowMs) / 1000))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * One row of the dashboard, kept in the snapshot's own vocabulary (a bilingual label, a value, a tone) so a
 * surface renders it with the same code it renders a §4.4 field with.
 */
function dashboardRow(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return null
  const value = entry.id === COUNTDOWN_ROW && entry.nextChangeIso
    ? countdownText(entry.nextChangeIso, nowMs)
    : entry.value
  return {
    id: entry.id || null,
    cn: entry.cn || '',
    en: entry.en || '',
    value: value === undefined || value === null || value === '' ? '—' : String(value),
    tone: entry.tone || null
  }
}

/**
 * The dashboard: the old expanded dock's live summary — the price window and its countdown, the account
 * balance, the queue and the parallelism — read out of the governance snapshot's `dashboard` block.
 *
 * It is carried through, not recomputed: the numbers are the Control Center's, so the ball and the dock cannot
 * disagree about how many tasks are queued. An absent block is reported with a reason instead of as a wall of
 * `—` that would look like a measurement.
 *
 * @param {object|null} source `controlCenter().dashboard`
 * @param {number} nowMs       the instant the view was built
 */
function buildDashboard(source, nowMs) {
  const price = (source?.lines || []).find((entry) => entry.id === 'price') || null
  const balance = (source?.lines || []).find((entry) => entry.id === 'balance') || null
  const subWorker = (source?.lines || []).find((entry) => entry.id === 'sub-worker') || null
  const list = (entry) => (entry?.rows || []).map((item) => dashboardRow(item, nowMs)).filter(Boolean)

  return {
    ok: Boolean(source),
    reason: source ? null : 'DS-Hns did not publish a dashboard block in its snapshot',
    /**
     * The three groups, in the order the old dock's cards read: what the window costs, what is left to spend,
     * what the optional worker is doing. With no source the list is **empty** rather than three empty groups:
     * a group heading over no rows is a panel that looks measured and says nothing, and the reason above is
     * the honest answer to "why is there nothing here".
     */
    lines: source
      ? [
          { id: 'price', cn: price?.cn || '价格', en: price?.en || 'Price', rows: list(price) },
          { id: 'balance', cn: balance?.cn || '账户', en: balance?.en || 'Account', rows: list(balance) },
          { id: 'sub-worker', cn: subWorker?.cn || '子工作器', en: subWorker?.en || 'Sub-worker', rows: list(subWorker) }
        ]
      : [],
    /** The queue, as the old dock's task card counted it. */
    execution: list({ rows: source?.execution || [] }),
    /** Parallelism and the machine it was computed from. */
    parallelism: list({ rows: source?.parallelism || [] }),
    /**
     * The dashboard's own actions — today exactly one: `refresh-balance`, the read that makes the account
     * newer. It is a dashboard action rather than a member of `MEGA_ACTIONS` because it is the only thing here
     * that *reads* instead of acting on a module, and because it names no id: the closed set above is about the
     * protection layer and the plugin set, and widening it would widen what a plugin may ask governance to do.
     *
     * The list is carried through from the snapshot (`control-center.cjs` decides when a read could change the
     * answer); with no snapshot there is nothing to refresh, so there is no button.
     */
    actions: source && Array.isArray(source.actions)
      ? source.actions
        .filter((entry) => entry && typeof entry === 'object' && entry.id)
        .map((entry) => ({ id: String(entry.id), cn: entry.cn || '', en: entry.en || '', reason: entry.reason || null }))
      : [],
    /**
     * The queue, as **tasks** rather than as a count.
     *
     * A surface can do nothing with "已挂起 1": it cannot say what is waiting, let the user fix a sentence or a time,
     * or move one task in front of another. So the ids and the fields travel with the count, and the two operations
     * a surface may offer are the scheduler's own (`editTask`, `reorderTask`) — this block says what exists, never
     * what may be done to it.
     *
     * The instant is carried as `startAtIso` and the *number of seconds* is not: the same reason the countdown row
     * carries an instant, and it matters more here, because a task's remaining time is the thing the user is
     * deciding about.
     */
    queue: source && source.queue && typeof source.queue === 'object'
      ? {
          ok: source.queue.ok !== false,
          reason: source.queue.reason || null,
          headline: source.queue.headline || null,
          counts: {
            pending: Number(source.queue.counts?.pending || 0),
            suspended: Number(source.queue.counts?.suspended || 0),
            running: Number(source.queue.counts?.running || 0),
            total: Number(source.queue.counts?.total || 0)
          },
          tasks: (Array.isArray(source.queue.tasks) ? source.queue.tasks : [])
            .filter((task) => task && task.id)
            .map((task) => ({
              id: String(task.id),
              prompt: String(task.prompt || ''),
              status: String(task.status || ''),
              reason: task.reason || null,
              startAtIso: task.startAtIso || null,
              startAtText: clockText(task.startAtIso),
              allowPeak: task.allowPeak === true,
              deliveryMode: task.deliveryMode || null,
              rank: Number(task.rank) || null
            }))
        }
      : { ok: false, reason: 'DS-Hns did not publish a queue in its dashboard', headline: null, counts: { pending: 0, suspended: 0, running: 0, total: 0 }, tasks: [] }
  }
}

/** One instant as the wall clock a person reads (`09:41`), in the zone the machine is in. */
function clockText(iso) {
  const at = new Date(String(iso || ''))
  if (!Number.isFinite(at.getTime())) return null
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

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
  const atMs = Date.parse(at)
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
      // No snapshot means no numbers: the dashboard says why rather than drawing a queue of zero (§4.2's rule,
      // applied to the live summary: an empty dashboard and an unreachable one are different pictures).
      dashboard: buildDashboard(null, atMs),
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
    /**
     * The live summary, next to — never instead of — the governance fields above. The ball draws this, the
     * Settings page draws the fields; both are this one object, so the two surfaces cannot show two opinions of
     * what the queue is doing.
     */
    dashboard: buildDashboard(governance.dashboard || null, Number.isFinite(atMs) ? atMs : Date.now()),
    version: { plugin: version, schema: bridge?.schema ?? null },
    at
  }
}

/** The orb's own size, shared with the host store's clamp so a stored position is inside the same box. */
export const ORB_SIZE = DEFAULT_SIZE
