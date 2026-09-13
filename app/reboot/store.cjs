'use strict'

/**
 * The restart plans, on disk.
 *
 * Two files, because they answer two different questions and one of them has to survive a reboot of
 * the machine:
 *
 *   `data/state/reboot-plans.json`    what the user scheduled. Read by the dashboard, the panel and
 *                                     the ticker; a plan lives here until it fires.
 *   `data/state/reboot-resume.json`   what has to happen *after* the machine comes back: the parked
 *                                     target and what to continue. Written immediately before the
 *                                     restart is issued, cleared as soon as it is acted on.
 *
 * The split matters. A plan that has fired must not be forgotten if the process dies during the
 * shutdown, and the intent must not be forgotten if the plan file is edited — so the intent is
 * written first and is the only thing that survives the boundary between the two lives of the
 * application.
 *
 * A plan that has fired leaves the list: "before execution it sits on the dashboard, after
 * execution it is gone". What it did is kept in a bounded history, which is diagnostics rather than
 * state — the dashboard never draws it.
 */

const fs = require('node:fs')
const path = require('node:path')

const { PLAN_STATES, describePlan } = require('./plan.cjs')

const STATE_VERSION = 1
const HISTORY_LIMIT = 20

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Atomic enough for state: a crash mid-write must not leave a half-written plan list that the
  // ticker then reads as "no plans".
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temporary, file)
}

/**
 * @param {object} [options]
 * @param {string} [options.root] the repository root
 * @param {string} [options.file] an explicit plans file
 * @param {string} [options.intentFile] an explicit resume-intent file
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 */
function createRebootStore(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()))
  const file = path.resolve(String(options.file || path.join(root, 'data', 'state', 'reboot-plans.json')))
  const intentFile = path.resolve(String(options.intentFile || path.join(root, 'data', 'state', 'reboot-resume.json')))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}

  let cache = null

  function load() {
    if (cache) return cache
    const raw = readJson(file, { version: STATE_VERSION, plans: [], history: [] })
    cache = {
      version: STATE_VERSION,
      plans: Array.isArray(raw.plans) ? raw.plans.filter((plan) => plan && plan.id && plan.dueAt) : [],
      history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : []
    }
    return cache
  }

  function save() {
    writeJson(file, load())
    return load()
  }

  /** The plans still waiting, oldest first, as the dashboard and the ticker see them. */
  function list() {
    return load().plans.slice()
  }

  function find(id) {
    const key = String(id || '')
    return load().plans.find((plan) => plan.id === key) || null
  }

  function add(plan) {
    if (!plan || !plan.id) return { ok: false, reason: 'a plan without an id cannot be stored' }
    const store = load()
    if (store.plans.some((candidate) => candidate.id === plan.id)) {
      return { ok: false, reason: `${plan.id} is already scheduled` }
    }
    store.plans.push(plan)
    save()
    log(`reboot plan ${plan.id} scheduled for ${new Date(plan.dueAt).toISOString()}`)
    return { ok: true, plan }
  }

  function replace(plan) {
    const store = load()
    const index = store.plans.findIndex((candidate) => candidate.id === plan.id)
    if (index === -1) return { ok: false, reason: `${plan.id} is not scheduled` }
    store.plans[index] = plan
    save()
    return { ok: true, plan }
  }

  function remove(id) {
    const store = load()
    const index = store.plans.findIndex((plan) => plan.id === String(id))
    if (index === -1) return { ok: false, reason: `${id} is not scheduled` }
    const [removed] = store.plans.splice(index, 1)
    store.history.push({ ...removed, state: PLAN_STATES.CANCELLED, stateChangedAt: now() })
    store.history = store.history.slice(-HISTORY_LIMIT)
    save()
    log(`reboot plan ${removed.id} removed before it fired`)
    return { ok: true, plan: removed }
  }

  /** Record a state change without removing the plan: a plan that is waiting is still a plan. */
  function setState(id, state, detail = null) {
    const store = load()
    const plan = store.plans.find((candidate) => candidate.id === String(id))
    if (!plan) return { ok: false, reason: `${id} is not scheduled` }
    plan.state = state
    plan.detail = detail === undefined ? null : detail
    plan.stateChangedAt = now()
    if (state === PLAN_STATES.EXECUTING) plan.firedAt = now()
    save()
    return { ok: true, plan }
  }

  /**
   * A plan that has run leaves the list.
   *
   * The application coming back after a restart is the signal: at that point the plan has done what
   * it was going to do, and it is moved to the history. This is what "it disappears after it has
   * run" means in storage rather than in a view.
   */
  function complete(id, outcome = {}) {
    const store = load()
    const index = store.plans.findIndex((plan) => plan.id === String(id))
    if (index === -1) return { ok: false, reason: `${id} is not scheduled` }
    const [plan] = store.plans.splice(index, 1)
    store.history.push({ ...plan, state: outcome.state || PLAN_STATES.DONE, detail: outcome.detail || null, completedAt: now(), outcome: outcome.outcome || null })
    store.history = store.history.slice(-HISTORY_LIMIT)
    save()
    log(`reboot plan ${plan.id} finished: ${outcome.detail || outcome.state || 'done'}`)
    return { ok: true, plan }
  }

  /** The intent that spans the restart: written before, acted on after. */
  function intent() {
    const raw = readJson(intentFile, null)
    if (!raw || typeof raw !== 'object') return null
    if (raw.version !== STATE_VERSION || !raw.intent) return null
    return raw.intent
  }

  function setIntent(value) {
    writeJson(intentFile, { version: STATE_VERSION, intent: { ...value, writtenAt: now() } })
    log(`reboot intent written for plan ${value && value.planId ? value.planId : 'unknown'}`)
    return intent()
  }

  function clearIntent() {
    try {
      fs.rmSync(intentFile, { force: true })
    } catch (error) {
      log(`the reboot intent could not be cleared: ${error && error.message ? error.message : error}`)
      return false
    }
    return true
  }

  function history() {
    return load().history.slice(-HISTORY_LIMIT)
  }

  return {
    file,
    intentFile,
    list,
    find,
    add,
    replace,
    remove,
    setState,
    complete,
    intent,
    setIntent,
    clearIntent,
    history,
    /** Everything the UI needs, in one answer. */
    describe() {
      const at = now()
      const plans = list()
      return {
        plans: plans.map((plan) => describePlan(plan, at)),
        waiting: plans.filter((plan) => plan.state === PLAN_STATES.WAITING_BOUNDARY).length,
        executing: plans.filter((plan) => plan.state === PLAN_STATES.EXECUTING).length,
        resumeIntent: intent(),
        history: history().slice(-5).map((entry) => ({
          id: entry.id,
          state: entry.state,
          at: entry.completedAt || entry.stateChangedAt || null,
          detail: entry.detail || null
        }))
      }
    },
    /** Test and teardown helper: forget the cached read. */
    reload() {
      cache = null
      return load()
    }
  }
}

module.exports = { createRebootStore, STATE_VERSION, HISTORY_LIMIT }
