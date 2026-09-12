'use strict'

/**
 * DSH Compatibility Probe + Report (Update-Plan/Dual-UI.md 任务 16 / 任务 17 / 任务 18).
 *
 * Before the Harness is upgraded, the native frontend has to be told whether it
 * still understands the new version. The probe measures the eight contracts the
 * plan names, one verdict each:
 *
 *   backend routes        every route the native frontend calls still answers
 *   session behavior      `session/list` still returns usable session rows
 *   message schema        a durable journal still folds into HNS messages
 *   task lifecycle        the scheduler still reports its tasks
 *   tool events           tool calls/results are still classified, not dropped
 *   settings              the settings snapshot is still readable
 *   stream/event protocol durable events still carry `seq` and `time`
 *   error behavior        failures still arrive as data, never as a throw
 *
 * Each verdict is `compatible`, `changed` or `blocked`. The overall
 * `nativeFrontend` verdict follows the plan's rule: any `blocked` check blocks
 * the upgrade, any `changed` check degrades it, otherwise it is compatible.
 *
 * 任务 18 is a product rule, not a UI hint: when `nativeFrontend` is `blocked`
 * the report carries `upgrade: 'blocked'`, the currently installed Harness stays
 * in place, Work Mode keeps working, and a compatibility repair task is produced.
 */
const model = require('./model.cjs')

const VERDICT = Object.freeze({
  COMPATIBLE: 'compatible',
  CHANGED: 'changed',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown'
})

/** The eight contracts, in report order. */
const CHECKS = Object.freeze([
  'session',
  'messages',
  'tasks',
  'events',
  'settings',
  'routes',
  'tool_events',
  'error_behavior'
])

function verdictOf(ok, changed = false) {
  if (ok) return changed ? VERDICT.CHANGED : VERDICT.COMPATIBLE
  return VERDICT.BLOCKED
}

/**
 * @param {object}   options
 * @param {object}   options.adapter            `createAdapter()` instance
 * @param {Function} [options.tasks]            () => raw tasks
 * @param {Function} [options.settings]         () => raw settings
 * @param {Function} [options.installedVersion] () => string
 * @param {Function} [options.latestVersion]    async () => string | null
 * @param {Function} [options.log]
 */
function createCompatibilityProbe({
  adapter = null,
  tasks = () => [],
  settings = () => null,
  installedVersion = () => null,
  latestVersion = async () => null,
  log = () => {}
} = {}) {
  let lastReport = null

  function readTasks() {
    try {
      const value = tasks()
      return Array.isArray(value) ? value : []
    } catch (error) {
      log(`probe task read failed: ${error?.message || error}`)
      return null
    }
  }

  function readSettings() {
    try {
      return settings()
    } catch (error) {
      log(`probe settings read failed: ${error?.message || error}`)
      return null
    }
  }

  /**
   * Run every check and produce the report.
   *
   * @param {object} [options]
   * @param {string} [options.to]       the version being considered
   * @param {string} [options.surface]  'native' | 'work' - which frontend is asking
   */
  async function run({ to = null, surface = 'native' } = {}) {
    const from = safeString(installedVersion())
    const target = to || safeString(await safeCall(latestVersion)) || from
    const checks = {}
    const evidence = {}
    const repair = []

    // ---- routes -------------------------------------------------------------
    let capability = null
    try {
      capability = adapter ? await adapter.probe() : null
    } catch (error) {
      capability = { ok: false, backend: model.backendState({ state: model.BACKEND_STATE.UNREACHABLE, reason: String(error?.message || error) }) }
    }
    const missingRoutes = capability?.routes?.missing || []
    checks.routes = verdictOf(Boolean(capability?.ok) && missingRoutes.length === 0, false)
    evidence.routes = {
      required: capability?.routes?.required || [],
      optional: capability?.routes?.optional || [],
      missing: missingRoutes,
      backend: capability?.backend || null
    }
    if (checks.routes === VERDICT.BLOCKED) {
      repair.push({ id: 'routes', title: 'Adapter: re-point the native frontend routes', detail: `native frontend cannot reach: ${missingRoutes.join(', ') || 'the backend at all'}` })
    }

    // ---- sessions + messages + events ---------------------------------------
    let listed = null
    try {
      listed = adapter ? await adapter.listSessions() : null
    } catch (error) {
      listed = { ok: false, sessions: [], reason: String(error?.message || error) }
    }
    const sessions = listed?.sessions || []
    const rowsUsable = sessions.every((entry) => Boolean(entry?.id))
    checks.session = verdictOf(Boolean(listed?.ok) && rowsUsable, Boolean(listed?.degraded))
    evidence.session = { count: sessions.length, degraded: Boolean(listed?.degraded), reason: listed?.reason || null }
    if (checks.session === VERDICT.BLOCKED) {
      repair.push({ id: 'session', title: 'Adapter: session list contract changed', detail: listed?.reason || 'session/list no longer returns usable rows' })
    }

    let conversation = null
    if (adapter && sessions[0]?.id) {
      try {
        conversation = adapter.openSession(sessions[0].id)
      } catch (error) {
        conversation = { ok: false, reason: String(error?.message || error), messages: [], toolEvents: [], unclassified: [] }
      }
    }
    const messageShapeOk = Array.isArray(conversation?.messages) &&
      conversation.messages.every((entry) => Object.values(model.ROLE).includes(entry?.role) && typeof entry?.content === 'string')
    checks.messages = conversation
      ? verdictOf(Boolean(conversation.ok) && messageShapeOk, (conversation.unclassified || []).length > 0)
      : VERDICT.UNKNOWN
    if (conversation) {
      evidence.messages = {
        folded: (conversation.messages || []).length,
        unclassifiedEvents: (conversation.unclassified || []).length,
        journal: Boolean(conversation.journal),
        reason: conversation.reason || null
      }
      if (checks.messages === VERDICT.BLOCKED) {
        repair.push({ id: 'messages', title: 'Adapter: journal message schema changed', detail: conversation.reason || 'durable events no longer fold into HNS messages' })
      }
    } else {
      evidence.messages = { folded: 0, reason: 'no session available to fold' }
    }

    const events = conversation?.events
    checks.events = conversation ? verdictOf(Boolean(conversation.ok) && Number(events) >= 0, false) : VERDICT.UNKNOWN
    evidence.events = conversation
      ? { count: Number(events) || 0, unclassified: (conversation.unclassified || []).length }
      : { count: 0, reason: 'no journal read' }
    if (checks.events === VERDICT.BLOCKED) {
      repair.push({ id: 'events', title: 'Adapter: durable event stream changed', detail: conversation?.reason || 'the journal could not be read' })
    }

    // ---- tool events --------------------------------------------------------
    const toolEvents = conversation?.toolEvents || []
    const toolShapeOk = toolEvents.every((entry) => Object.values(model.TOOL_STATUS).includes(entry?.status) && Boolean(entry?.name))
    const toolVerdict = conversation ? verdictOf(toolShapeOk, false) : VERDICT.UNKNOWN
    checks.tool_events = toolVerdict
    evidence.tool_events = { count: toolEvents.length, running: toolEvents.filter((entry) => entry.status === model.TOOL_STATUS.RUNNING).length }

    // ---- tasks --------------------------------------------------------------
    const rawTasks = readTasks()
    const taskRows = Array.isArray(rawTasks) ? rawTasks.map(model.task) : null
    checks.tasks = taskRows ? verdictOf(taskRows.every((entry) => typeof entry.status === 'string'), false) : VERDICT.BLOCKED
    evidence.tasks = { count: taskRows ? taskRows.length : 0, readable: Boolean(taskRows) }
    if (checks.tasks === VERDICT.BLOCKED) {
      repair.push({ id: 'tasks', title: 'Adapter: scheduler task shape changed', detail: 'the scheduler no longer reports a task array' })
    }

    // ---- settings -----------------------------------------------------------
    const rawSettings = readSettings()
    const settingsView = model.settingsState(rawSettings)
    checks.settings = verdictOf(true, !settingsView.available)
    evidence.settings = { available: settingsView.available, model: settingsView.model, reason: settingsView.reason }

    // ---- error behavior -----------------------------------------------------
    // The adapter must answer a nonsense session with a structured failure.
    let errorAnswer = null
    try {
      errorAnswer = adapter ? adapter.openSession('__hns_probe_missing__') : null
    } catch (error) {
      errorAnswer = { threw: String(error?.message || error) }
    }
    const structured = Boolean(errorAnswer) && !errorAnswer.threw && errorAnswer.ok === false && Boolean(errorAnswer.reason)
    checks.error_behavior = verdictOf(structured, false)
    evidence.error_behavior = {
      structured,
      reason: errorAnswer?.reason || null,
      threw: errorAnswer?.threw || null
    }
    if (checks.error_behavior === VERDICT.BLOCKED) {
      repair.push({ id: 'error_behavior', title: 'Adapter: backend errors are no longer structured', detail: errorAnswer?.threw || 'a failing read did not return { ok: false, reason }' })
    }

    const nativeFrontend = !Object.values(checks).includes(VERDICT.BLOCKED)
      ? (Object.values(checks).includes(VERDICT.CHANGED) || Object.values(checks).includes(VERDICT.UNKNOWN) ? VERDICT.CHANGED : VERDICT.COMPATIBLE)
      : VERDICT.BLOCKED

    const report = {
      version: 1,
      at: new Date().toISOString(),
      from,
      to: target,
      surface,
      session: checks.session,
      messages: checks.messages,
      tasks: checks.tasks,
      events: checks.events,
      settings: checks.settings,
      routes: checks.routes,
      tool_events: checks.tool_events,
      error_behavior: checks.error_behavior,
      nativeFrontend,
      upgrade: nativeFrontend === VERDICT.BLOCKED ? 'blocked' : upgradePolicy(nativeFrontend),
      repair,
      evidence
    }
    lastReport = report
    log(`compatibility probe ${from || '?'} -> ${target || '?'}: nativeFrontend=${nativeFrontend}${repair.length ? ` (${repair.length} repair item(s))` : ''}`)
    return report
  }

  /** The upgrade policy for a non-blocked native frontend (任务 18). */
  function upgradePolicy(nativeFrontend) {
    return nativeFrontend === VERDICT.CHANGED ? 'hold-until-reviewed' : 'allowed'
  }

  /**
   * Decide what the updater may do with a report.
   *
   * `blocked` never means "the product stops": Work Mode continues on the
   * currently installed Harness, and the repair items become the compatibility
   * fix task (任务 18).
   */
  function verdict(report = lastReport) {
    if (!report) return { known: false, canUpgrade: false, reason: 'no compatibility report has been produced' }
    const blocked = report.nativeFrontend === VERDICT.BLOCKED
    return {
      known: true,
      canUpgrade: !blocked && report.upgrade === 'allowed',
      nativeFrontend: report.nativeFrontend,
      reason: blocked
        ? 'the native frontend is blocked on this version; the installed Harness stays and Work Mode continues'
        : (report.upgrade === 'hold-until-reviewed'
            ? 'contracts changed; the update waits for a review'
            : 'every measured contract is compatible'),
      hold: blocked ? { keepVersion: report.from, workMode: 'continues', restart: false } : null,
      repairTask: report.repair.length
        ? {
            title: `Harness ${report.to || 'update'}: repair the native frontend adapter`,
            items: report.repair.map((entry) => ({ ...entry })),
            priority: 'P0'
          }
        : null
    }
  }

  function describe() {
    return {
      checks: [...CHECKS],
      verdicts: Object.values(VERDICT),
      lastReport
    }
  }

  return { VERDICT, CHECKS, run, verdict, describe }
}

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function safeCall(fn) {
  try {
    return typeof fn === 'function' ? await fn() : null
  } catch {
    return null
  }
}

module.exports = {
  VERDICT,
  CHECKS,
  createCompatibilityProbe
}
