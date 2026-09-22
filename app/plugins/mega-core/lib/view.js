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

function optionalHostUnavailable(service) {
  const reason = String(service?.health?.reason || '')
  return service?.id === 'dshns.computer-use' && /no host runtime (?:was )?attached/i.test(reason)
}

/**
 * The state one of the two built-in services is in, as a word a person reads.
 *
 * Derived from the four separate facts rather than from one flag, and in the order that matters:
 * *not in the runtime* is worse than *disabled*, which is worse than *enabled but not loaded*, which
 * is worse than a loaded plugin whose own health is unhappy. A plugin that is merely switched off is
 * reported as off and not as broken — the requirement's whole point is that a user may turn the
 * monitor off without the product being unwell.
 */
function serviceState(service) {
  if (service.ok !== true) return 'NOT IN THE RUNTIME'
  if (service.enabled !== true) return 'DISABLED'
  if (service.loaded !== true) return 'ENABLED'
  if (optionalHostUnavailable(service)) return 'UNAVAILABLE'
  const status = service.health && service.health.status
  if (status === 'degraded') return 'DEGRADED'
  if (status === 'unknown') return 'UNKNOWN'
  if (service.healthy === false) return 'UNHEALTHY'
  return 'LOADED'
}

/** A service's tone. `null` is quiet: switched off is a decision, not a fault. */
function serviceTone(service) {
  if (service.ok !== true) return 'bad'
  if (service.enabled !== true) return null
  const status = service.health && service.health.status
  if (status === 'degraded' || status === 'unknown' || service.healthy === false) return 'warn'
  return 'ok'
}

/**
 * One service, as the page draws it.
 *
 * Every field is the service record's own, and the plugin-specific halves (`health` for the monitor,
 * `restart` for the supervisor) are carried through verbatim: the page renders them, it does not
 * interpret them. That is what keeps this file from knowing what a "pressure" or a "restart budget"
 * is — a page that computed either would be a second answer to a question two plugins already own.
 *
 * `permissions` and the health plugin's `held`/`maintenance` half are carried too: they are computed by
 * the host and the monitor, and a surface that dropped them left a user unable to see why work was being
 * held, or what a plugin is allowed to do.
 */
function serviceView(service, vocabulary = SERVICE_ACTIONS) {
  const diagnostics = service.diagnostics || {}
  return {
    id: service.id,
    name: service.name,
    version: service.version,
    state: serviceState(service),
    tone: serviceTone(service),
    installed: service.installed === true,
    enabled: service.enabled === true,
    loaded: service.loaded === true,
    healthy: service.healthy,
    /** An optional GUI host may be absent while the runtime core remains healthy. */
    coreImpact: !optionalHostUnavailable(service),
    health: service.health || null,
    heartbeat: service.heartbeat || null,
    lastError: service.lastError || null,
    capabilities: service.capabilities || { provides: [], requires: [] },
    /** What the plugin is allowed to do, as the host's own record states it (`null` when it declared none). */
    permissions: service.permissions || null,
    fallback: service.fallback || null,
    adapter: service.adapter || null,
    /** The monitor's own report, when this is the monitor. */
    pressure: diagnostics.report && diagnostics.report.latest ? diagnostics.report.latest.pressure : null,
    trend: diagnostics.trend || null,
    state5: diagnostics.state || null,
    explanation: diagnostics.explanation || null,
    providers: diagnostics.providers || null,
    /** Why work is being held, when the monitor is holding any: the reason a user needs to read. */
    held: diagnostics.explanation && diagnostics.explanation.held ? diagnostics.explanation.held : (diagnostics.lastOutcome && diagnostics.lastOutcome.held ? diagnostics.lastOutcome.held : null),
    maintenance: diagnostics.maintenance || null,
    restart: diagnostics.report === undefined && diagnostics.budget ? {
      supervisorState: diagnostics.state || null,
      heartbeat: diagnostics.heartbeat ? diagnostics.heartbeat.verdict : null,
      budget: diagnostics.budget || null,
      lastError: diagnostics.lastError || null,
      companion: diagnostics.companion || null,
      safeMode: diagnostics.health ? diagnostics.health.safeMode === true : false,
      lastRestartReason: (diagnostics.requests || []).slice().reverse().find((entry) => entry.type === 'restart-requested' || entry.type === 'restart-delegated') || null
    } : null,
    /** The actions the official page may offer, from the closed action vocabulary. */
    actions: serviceActions(service, vocabulary)
  }
}

/**
 * What the official page may ask of one service.
 *
 * The vocabulary comes from the **host** (`governance.serviceActions`, published from
 * `app/core/contracts/service-actions.cjs`), so the page draws the buttons the host will execute. The
 * built-in list below is the fallback for a bridge old enough not to publish one, and it is deliberately
 * the same closed set — a page that offered an action the bridge refuses is a page whose buttons only
 * print refusals.
 */
const SERVICE_ACTIONS = Object.freeze([
  { id: 'check', label: '刷新健康 · Refresh health', dangerous: false },
  { id: 'enable', label: '启用 · Enable', dangerous: false },
  { id: 'disable', label: '停用 · Disable', dangerous: false },
  { id: 'restart-plugin', label: '重启插件 · Restart plugin', dangerous: true },
  { id: 'manual-restart', label: '手动重启应用 · Manual app restart', dangerous: true },
  { id: 'reset-budget', label: '重置重启预算 · Reset restart budget', dangerous: true },
  { id: 'diagnostics', label: '查看诊断 · View diagnostics', dangerous: false }
])

/** The host's own list, when it published one. */
function actionVocabulary(governance) {
  const published = Array.isArray(governance && governance.serviceActions) ? governance.serviceActions : null
  if (!published || !published.length) return SERVICE_ACTIONS
  return published.map((entry) => ({
    id: String(entry.id),
    label: entry.cn && entry.en ? `${entry.cn} · ${entry.en}` : String(entry.id),
    dangerous: entry.dangerous === true
  }))
}

function serviceActions(service, vocabulary = SERVICE_ACTIONS) {
  if (service.ok !== true) return []
  const offered = ['check', 'diagnostics']
  if (service.enabled === true) offered.push('disable', 'restart-plugin')
  else offered.push('enable')
  // The two supervisor-only operations are offered only where the capability exists, because the
  // page must not show a control that the plugin would refuse.
  if (service.id === 'dshns.restart-supervisor') offered.push('manual-restart', 'reset-budget')
  return vocabulary.filter((action) => offered.includes(action.id)).map((action) => `${action.id}${action.dangerous ? ' (confirm)' : ''}`)
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
/**
 * The formal **restart status**, as the official page draws it.
 *
 * It arrives from the plugin host's own read (the supervisor's `restart_status`, which is persisted
 * outside the process), and it is carried into the view as its own object rather than as prose inside
 * a line: "when did this machine last restart, why, did the work continue, and how many attempts have
 * there been" is the question a person asks after an interruption, and the official UI is the surface
 * every user has. An absent report is `null` and the rows say so — never a fabricated "no restarts".
 */
function restartStatusView(status) {
  if (!status || typeof status !== 'object') {
    return {
      available: false,
      phase: 'UNKNOWN',
      inFlight: false,
      reason: null,
      recoveryResult: 'NONE',
      failedRecoveryReason: null,
      historyCount: 0,
      summary: 'no restart status is available',
      rows: []
    }
  }
  const iso = (value) => (Number.isFinite(Number(value)) ? new Date(Number(value)).toISOString() : null)
  const rows = [
    { id: 'restart:phase', cn: '重启状态', en: 'Restart status', value: String(status.phase || 'UNKNOWN'), tone: status.inFlight ? 'warn' : status.phase === 'FAILED' ? 'bad' : null },
    { id: 'restart:reason', cn: '重启原因', en: 'Restart reason', value: status.reason ? `${status.reason.code || 'UNKNOWN'}${status.reason.summary ? ` — ${status.reason.summary}` : ''}${status.reason.requestedBy ? ` (by ${status.reason.requestedBy})` : ''}` : '—' },
    { id: 'restart:requested', cn: '请求时间', en: 'Requested at', value: iso(status.requestedAt) || '—' },
    { id: 'restart:completed', cn: '完成时间', en: 'Completed at', value: iso(status.completedAt) || '—' },
    {
      id: 'restart:recovery',
      cn: '恢复结果',
      en: 'Recovery result',
      value: `${status.recoveryResult || 'NONE'}${status.failedRecoveryReason ? ` — ${status.failedRecoveryReason}` : ''}`,
      tone: status.recoveryResult === 'FULL' ? 'ok' : status.recoveryResult === 'FAILED' ? 'bad' : status.recoveryResult === 'NONE' ? null : 'warn'
    },
    { id: 'restart:history', cn: '重启历史', en: 'Restart history', value: `${status.historyCount || 0} recorded${status.historyLimit ? ` (ring of ${status.historyLimit})` : ''}`, tone: Number(status.historyCount || 0) > 2 ? 'warn' : null }
  ]
  return {
    available: true,
    phase: String(status.phase || 'UNKNOWN'),
    inFlight: status.inFlight === true,
    reason: status.reason || null,
    recoveryResult: status.recoveryResult || 'NONE',
    failedRecoveryReason: status.failedRecoveryReason || null,
    historyCount: Number(status.historyCount || 0),
    history: Array.isArray(status.history) ? status.history.slice(-10) : [],
    summary: status.summary || null,
    rows
  }
}

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
      /** No snapshot means no service report: an empty list, and the page says so. */
      services: [],
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
  /**
   * The two built-in services, as their own list.
   *
   * They arrive from the plugin host's own service record — four separate states, the plugin's health
   * answer, the heartbeat the restart supervisor writes, the capabilities it provides, and its last
   * error — so the official page shows what the panel shows without re-deriving any of it. An absent
   * report is an empty list, and the page says so rather than drawing two rows of dashes.
   */
  const services = Array.isArray(governance.services) ? governance.services : []
  /** The action vocabulary the host published, so the page draws buttons the host will execute. */
  const vocabulary = actionVocabulary(governance)
  /** The formal restart record, from the host's own read: the official page renders this, Mega may too. */
  const restartStatus = restartStatusView(governance.restartStatus)
  /**
   * Which floating ball is the one running.
   *
   * There are two implementations — the official `shell.overlay` slot (this plugin's) and DS-Hns's own
   * system-wide window (`app/extensions/mega/system-orb.cjs`, opt-in) — and exactly one of them may
   * draw, or a user gets two balls holding one state. The host says which: `governance.orb.mode` is
   * `system` when the window is up, and this plugin then draws nothing.
   */
  const orbMode = governance.orb && governance.orb.mode ? String(governance.orb.mode) : 'in-ui'
  const orb = {
    mode: orbMode,
    /** The ball drawn by *this* plugin is suppressed while the host's own window owns it. */
    hideInUi: orbMode === 'system',
    reason: orbMode === 'system' ? 'the system-wide ball is running; the in-UI ball would be a second one' : null
  }
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
  /**
   * A restart the product is *in the middle of*, and a restart whose recovery fell short, are lines on
   * the same list as everything else: both are things a person has to see without opening anything.
   */
  if (restartStatus.available && restartStatus.inFlight) lines.push(line('warn', `⟳ restart in progress (${restartStatus.phase})${restartStatus.reason ? ` — ${restartStatus.reason.code}` : ''}`))
  if (restartStatus.available && !restartStatus.inFlight && restartStatus.recoveryResult && restartStatus.recoveryResult !== 'FULL' && restartStatus.recoveryResult !== 'NONE') {
    lines.push(line(restartStatus.recoveryResult === 'FAILED' ? 'bad' : 'warn', `${restartStatus.recoveryResult === 'FAILED' ? '✖' : '⚠'} last restart recovery ${restartStatus.recoveryResult.toLowerCase()}${restartStatus.failedRecoveryReason ? ` — ${restartStatus.failedRecoveryReason}` : ''}`))
  }
  // The built-in services state their own line whether they are well or not: a scheduler that is
  // disabled and a supervisor that cannot restart are the two facts a person most needs, and both
  // are invisible in a list that only reports faults.
  const offNominalServices = services.filter((service) => {
    const tone = serviceTone(service)
    return tone === 'bad' || tone === 'warn'
  })
  for (const service of offNominalServices) {
    const tone = serviceTone(service)
    const reason = optionalHostUnavailable(service)
      ? 'no host runtime attached; core unaffected'
      : (service.lastError?.reason || service.health?.reason || '')
    lines.push(line(tone, `${tone === 'bad' ? '✖' : '⚠'} ${service.name || service.id} ${String(serviceState(service)).toLowerCase()}${reason ? ` — ${reason}` : ''}`))
  }
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
    /**
     * The two built-in services, as their own list. They are in the view model rather than only in the
     * panel because the official page renders this object: a component whose failure the product is
     * meant to survive has to be visible in the one surface every user has.
     */
    services: services.map((service) => serviceView(service, vocabulary)),
    /**
     * The advanced policy, as the host describes it (key, label, type, range, value in force).
     *
     * It used to reach the snapshot and no surface: 38 dotted keys an operator could not see, let alone
     * change, from the one UI every user has. It is carried here so the official page can draw it, and
     * written back through the host's own validator.
     */
    advanced: Array.isArray(governance.advanced) ? governance.advanced : [],
    /**
     * The formal restart record, in the view rather than only in the panel: the official Settings page
     * is the surface every user has, and "what happened to the restart" must not be reachable only
     * through the enhanced panel.
     */
    restartStatus,
    /**
     * Which ball is the one running, and why this plugin is not drawing one when it is not.
     *
     * The component reads this at render time rather than at mount: a host that switches to the
     * system-wide ball must not require the page to be reloaded before the duplicate disappears.
     */
    orb,
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
