'use strict'

/**
 * The startup states, and the one rule that keeps them honest:
 *
 * > "the application is usable" must not be bound to "every enhancement has finished rendering".
 *
 * This implements `updateplan/startup.md` §3.3 / §12 / §24 for this product, and its whole point is
 * that **INTERACTIVE is startup complete**:
 *
 *   BOOTING       the process, the window and the core resources are being prepared
 *   CORE_READY    the base frame is on screen (here: the official Harness UI)
 *   INTERACTIVE   the user can type, read and work — **this is what "started" means**
 *   ENHANCED      wallpaper, Mega and the optional layers have caught up behind it
 *
 * Everything before INTERACTIVE is on the critical path and has to be argued for. Everything after it
 * is deferred work: it goes through `defer()`, which cannot reject, cannot delay the user, and reports
 * its own failure without taking anything else with it.
 *
 * What that buys, in the words of the failure it removes: the boot used to wait for the Harness, then
 * for the extension host, then for the dock's renderer *before the window was ever shown* — so a slow
 * optional module was indistinguishable from a product that had not started. Now the window is on
 * screen with a skeleton as soon as this process can paint one, the official UI replaces it when it
 * is ready, and the rest arrives behind it.
 *
 * Every phase is timed and logged in one shape, so a slow boot can be read rather than guessed:
 *
 *   [BOOT] window-created     112ms
 *   [BOOT] shell-ready        168ms
 *   [BOOT] harness-ready      2410ms
 *   [BOOT] core-ready         2562ms
 *   [BOOT] interactive        2563ms
 *   [BOOT] extensions-ready   3901ms   background
 *   [BOOT] dock-ready         4120ms   background
 *
 * The budgets are the plan's targets (§24). They are *recorded*, not enforced: a boot that misses one
 * is still a working boot, and a late phase must not become a failure. The number worth watching is
 * `ownOverhead()` — the time from the Harness answering to the user being able to work, which is the
 * part of the wall clock this product owns rather than the Harness' own boot.
 */

/** The four states, in the order they happen. */
const STARTUP_STATE = Object.freeze({
  BOOTING: 'BOOTING',
  CORE_READY: 'CORE_READY',
  INTERACTIVE: 'INTERACTIVE',
  ENHANCED: 'ENHANCED'
})

/**
 * The phases this product marks, in order, with what each one means.
 *
 * `critical: true` marks the phases before INTERACTIVE — the ones allowed to delay the user.
 * Everything else is deferred work that has no business on that path, and the log says so.
 */
const STARTUP_PHASES = Object.freeze([
  { id: 'window-created', state: STARTUP_STATE.BOOTING, critical: true, label: 'the native window exists' },
  { id: 'shell-ready', state: STARTUP_STATE.BOOTING, critical: true, label: 'our own skeleton page is on screen' },
  { id: 'harness-ready', state: STARTUP_STATE.BOOTING, critical: true, label: 'the official Harness answered with a URL' },
  { id: 'core-ready', state: STARTUP_STATE.CORE_READY, critical: true, label: 'the official UI is the window page' },
  { id: 'interactive', state: STARTUP_STATE.INTERACTIVE, critical: true, label: 'the user can type and work' },
  { id: 'workspace-restored', state: STARTUP_STATE.INTERACTIVE, critical: false, label: 'the last workspace and session are back' },
  { id: 'extensions-ready', state: STARTUP_STATE.INTERACTIVE, critical: false, label: 'the Mega extension host is up' },
  { id: 'dock-ready', state: STARTUP_STATE.INTERACTIVE, critical: false, label: 'the Mega dock is attached' },
  { id: 'official-surfaces-ready', state: STARTUP_STATE.INTERACTIVE, critical: false, label: 'the layer above the official page exists' },
  { id: 'wallpaper-ready', state: STARTUP_STATE.INTERACTIVE, critical: false, label: "the user's backdrop is drawn" },
  { id: 'appearance-ready', state: STARTUP_STATE.INTERACTIVE, critical: false, label: 'the appearance layer is in force' },
  { id: 'enhanced', state: STARTUP_STATE.ENHANCED, critical: false, label: 'every deferred enhancement has settled' }
])

/** The plan's targets, in milliseconds from the window being created. */
const STARTUP_BUDGETS = Object.freeze({
  'window-created': 200,
  'shell-ready': 800,
  'core-ready': 800,
  interactive: 1500
})

/** The order of the states, so a phase can never move the boot backwards. */
const STATE_ORDER = Object.freeze([
  STARTUP_STATE.BOOTING,
  STARTUP_STATE.CORE_READY,
  STARTUP_STATE.INTERACTIVE,
  STARTUP_STATE.ENHANCED
])

function phaseById(id) {
  return STARTUP_PHASES.find((phase) => phase.id === id) || null
}

/** `1234` → `1.2s`; `438` → `438ms` — the shape the plan asks the boot log to have. */
function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '0ms'
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(1)}s`
}

/**
 * @param {object}   [options]
 * @param {Function} [options.log] one line per phase, already formatted
 * @param {Function} [options.now] test seam for the clock
 */
function createStartupManager({ log = () => {}, now = () => Date.now() } = {}) {
  const startedAt = now()
  const phases = []
  const byId = new Map()
  const deferred = new Map()
  const listeners = []
  let state = STARTUP_STATE.BOOTING

  const stateIndex = (value) => STATE_ORDER.indexOf(value)

  /**
   * Mark one phase.
   *
   * Marking the same phase twice keeps the first answer: a boot report that moves when something is
   * repainted is a report nobody can compare between runs.
   */
  function mark(id, detail = null) {
    if (byId.has(id)) return byId.get(id)
    const phase = phaseById(id)
    const elapsed = now() - startedAt
    const budget = STARTUP_BUDGETS[id] === undefined ? null : STARTUP_BUDGETS[id]
    const entry = {
      id,
      at: elapsed,
      state: phase ? phase.state : state,
      critical: phase ? phase.critical : false,
      label: phase ? phase.label : id,
      detail: detail || null,
      known: Boolean(phase),
      budget,
      overBudget: budget !== null && elapsed > budget
    }
    phases.push(entry)
    byId.set(id, entry)
    if (phase && stateIndex(phase.state) > stateIndex(state)) {
      state = phase.state
      if (state === STARTUP_STATE.INTERACTIVE) {
        for (const listener of listeners.splice(0, listeners.length)) {
          try {
            listener(entry)
          } catch (error) {
            log(`[BOOT] an interactive listener threw: ${error?.message || error}`)
          }
        }
      }
    }
    const suffix = [
      budget !== null ? `budget ${formatDuration(budget)}` : null,
      entry.overBudget ? 'OVER BUDGET' : null,
      entry.known ? null : 'not a known phase',
      entry.critical ? null : 'background'
    ].filter(Boolean).join(' · ')
    log(`[BOOT] ${id.padEnd(24)} ${formatDuration(elapsed).padStart(6)}${suffix ? `   ${suffix}` : ''}`)
    return entry
  }

  /**
   * Run optional work without letting it matter to the user or to anything else.
   *
   * The returned promise never rejects: a deferred task that throws is recorded on its own entry and
   * the boot carries on — which is the plan's requirement (§17, §25, §47) that an optional plugin's
   * failure is a log line rather than a startup failure. `settle()` waits for all of them, which is
   * the seam a test (and `complete()`) needs.
   */
  function defer(id, task) {
    const promise = Promise.resolve()
      .then(() => (typeof task === 'function' ? task() : task))
      .then((value) => {
        mark(id)
        return { id, ok: true, value: value === undefined ? null : value }
      })
      .catch((error) => {
        const message = String(error?.message || error)
        const entry = mark(id)
        entry.failed = true
        entry.reason = message
        log(`[BOOT] ${id.padEnd(24)} failed: ${message} (the boot carries on)`)
        return { id, ok: false, error: message }
      })
    deferred.set(id, promise)
    return promise
  }

  /** Wait for every deferred task that has been handed over. Never rejects. */
  async function settle() {
    const pending = [...deferred.values()]
    if (pending.length) await Promise.allSettled(pending)
    return summary()
  }

  /** Called when the deferred work has settled: this is what ENHANCED means. */
  async function complete() {
    await settle()
    return mark('enhanced')
  }

  /** Follow the boot: the callback runs now if the user can already work, or at INTERACTIVE. */
  function onInteractive(listener) {
    if (typeof listener !== 'function') return false
    if (stateIndex(state) >= stateIndex(STARTUP_STATE.INTERACTIVE)) {
      try {
        listener(byId.get('interactive') || null)
      } catch (error) {
        log(`[BOOT] an interactive listener threw: ${error?.message || error}`)
      }
      return true
    }
    listeners.push(listener)
    return true
  }

  /**
   * How long this product took to turn a ready Harness into a usable window.
   *
   * The Harness' own boot is not ours to optimise; everything after its answer is. This is the number
   * the plan's budget is really about.
   */
  function ownOverhead() {
    const harness = byId.get('harness-ready')
    const interactive = byId.get('interactive')
    if (!harness || !interactive) return null
    return interactive.at - harness.at
  }

  /** The boot as data: what acceptance and the log both read. */
  function summary() {
    return {
      state,
      interactive: stateIndex(state) >= stateIndex(STARTUP_STATE.INTERACTIVE),
      enhanced: state === STARTUP_STATE.ENHANCED,
      elapsed: now() - startedAt,
      phases: phases.map((phase) => ({
        id: phase.id,
        at: phase.at,
        state: phase.state,
        critical: phase.critical,
        overBudget: phase.overBudget,
        failed: Boolean(phase.failed),
        reason: phase.reason || null,
        detail: phase.detail
      })),
      failed: phases.filter((phase) => phase.failed).map((phase) => phase.id),
      overBudget: phases.filter((phase) => phase.overBudget).map((phase) => phase.id),
      unknown: phases.filter((phase) => !phase.known).map((phase) => phase.id),
      ownOverhead: ownOverhead()
    }
  }

  /** The phase table, for documentation and for tests that want the ordering as data. */
  function phaseTable() {
    return STARTUP_PHASES.map((phase) => ({
      ...phase,
      budget: STARTUP_BUDGETS[phase.id] === undefined ? null : STARTUP_BUDGETS[phase.id]
    }))
  }

  return {
    STARTUP_STATE,
    mark,
    defer,
    settle,
    complete,
    onInteractive,
    summary,
    state: () => state,
    phaseTable,
    formatDuration,
    startedAt
  }
}

module.exports = {
  createStartupManager,
  STARTUP_STATE,
  STARTUP_PHASES,
  STARTUP_BUDGETS,
  formatDuration
}
