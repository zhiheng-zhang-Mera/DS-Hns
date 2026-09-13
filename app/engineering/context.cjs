'use strict'

/**
 * Engineering Runtime: the three context layers of one episode.
 *
 * A 24-hour episode cannot carry its history, and it must not try: a transcript
 * grows without bound while a working context does not, and "what am I doing
 * right now" is a different question from "what has happened so far". This module
 * keeps the three answers apart so each one can be bounded on its own terms.
 *
 *  1. **Live context** holds only what the current step needs — phase, goal,
 *     current plan step, current file, current action, current error. It is
 *     *replaced*, never accumulated: a stale `currentFile` is worse than none.
 *  2. **Recent evidence** is a set of separate bounded rings (observations,
 *     verifications, repair decisions, process milestones, plan steps, changed
 *     files, blockers). The newest entry is what the next step acts on; the older
 *     ones exist so a repeat or a stall can be recognised, not so the episode can
 *     be replayed.
 *  3. **The episode summary** is generated on demand from the two layers above and
 *     capped at `summaryBudgetBytes`. A "summary" that grows with the episode is
 *     not a summary, it is the log again.
 *
 * The invariant this module protects is **flat memory**: after the first
 * `ringSize` entries one more step adds nothing to the retained size. Every list
 * here is therefore a ring (push, then drop past capacity), every string is
 * clipped before it is stored, and nothing at all is remembered across episodes —
 * a new episode builds a new context, and dropping the context drops its state.
 *
 * Byte accounting is approximate and deliberate: `bytes()` reports what the
 * bounded layers retain so a caller can watch the ceiling approach instead of
 * discovering it as an out-of-memory kill. The phase here is a plain string: the
 * legality of a phase belongs to the episode state machine, not to the context.
 */

/** Default ring capacities. Separate rings, because their useful memories differ. */
const DEFAULT_EVIDENCE_RING = 20
const DEFAULT_VERIFICATION_RING = 20
const DEFAULT_DECISION_RING = 10
const DEFAULT_PROCESS_RING = 20
const DEFAULT_STEP_RING = 50
const DEFAULT_FILE_RING = 100
const DEFAULT_BLOCKER_RING = 20

/** How many entries of each ring one `snapshot()` may expose. */
const DEFAULT_TAIL = 10

/** The default summary ceiling, in bytes. */
const DEFAULT_SUMMARY_BUDGET_BYTES = 4096

/** The only fields the live layer accepts: everything else is noise per step. */
const LIVE_KEYS = Object.freeze(['phase', 'goal', 'planStep', 'currentFile', 'currentAction', 'currentError'])

/** How many plan steps a summary keeps as "the last few". */
const SUMMARY_LAST_STEPS = 5

const LIVE_LIMIT = 500
const EVIDENCE_SUMMARY_LIMIT = 400
const EVIDENCE_ITEM_LIMIT = 200
const EVIDENCE_ITEMS = 5
const DECISION_FIELD_LIMIT = 500
const STEP_LIMIT = 200
const SUMMARY_ITEM_LIMIT = 200

/** Decision results that mean "this settled something": they complete a step. */
const RESOLVED_RESULTS = Object.freeze(['ok', 'success', 'applied', 'resolved', 'recovered', 'verified', 'completed', 'done'])

/** Process milestones that mean "this process finished". */
const COMPLETION_MILESTONES = Object.freeze(['completed', 'complete', 'finished', 'exited', 'settled', 'done', 'closed'])

/** Process milestones that mean "this process was started": they plan a step. */
const START_MILESTONES = Object.freeze(['started', 'starting', 'spawned', 'pending', 'queued'])

/** A positive integer option, or the fallback. */
function positive(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** The approximate retained size of one value. */
function byteLength(value) {
  if (value === undefined || value === null) return 0
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

/** Clip a value to `limit` characters without touching its internal whitespace. */
function clip(value, limit) {
  if (value === undefined || value === null) return ''
  const source = typeof value === 'string' ? value : String(value)
  return source.length > limit ? source.slice(0, limit) : source
}

/** Clip a value to a single line of at most `limit` characters. */
function text(value, limit) {
  return clip(value, limit * 2).replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** The printable form of a plan step, whether it arrives as a string or an object. */
function stepText(step) {
  if (step !== null && typeof step === 'object') {
    return text(step.summary || step.description || step.title || step.name || step.label || step.id || '', STEP_LIMIT)
  }
  return text(step, STEP_LIMIT)
}

/** The printable form of a blocker. */
function blockerText(blocker) {
  if (blocker !== null && typeof blocker === 'object') {
    return text(blocker.reason || blocker.summary || blocker.key || '', SUMMARY_ITEM_LIMIT)
  }
  return text(blocker, SUMMARY_ITEM_LIMIT)
}

/**
 * A bounded ring: `push` then drop past capacity.
 *
 * The costs are kept beside the items rather than on them so that a caller can
 * read an entry without finding bookkeeping fields inside it, and so that
 * `bytes()` never has to re-serialize the whole ring.
 */
function createRing(capacity) {
  const items = []
  const costs = []
  return {
    get capacity() {
      return capacity
    },
    get size() {
      return items.length
    },
    push(entry) {
      items.push(entry)
      costs.push(byteLength(entry))
      while (items.length > capacity) {
        items.splice(0, items.length - capacity)
        costs.splice(0, costs.length - capacity)
      }
      return entry
    },
    /** Drop the oldest entry and return it, or null when the ring is empty. */
    shift() {
      if (!items.length) return null
      const dropped = items.splice(0, 1)[0]
      costs.splice(0, 1)
      return dropped
    },
    /** Keep only the entries the predicate accepts. */
    filter(predicate) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (predicate(items[index])) continue
        items.splice(index, 1)
        costs.splice(index, 1)
      }
      return items.length
    },
    items() {
      return items.slice()
    },
    /** The newest `count` entries; `count` at or below zero means none. */
    tail(count) {
      if (!Number.isInteger(count) || count <= 0) return []
      return items.slice(-count)
    },
    bytes() {
      let total = 0
      for (const cost of costs) total += cost
      return total
    }
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.ringSize] sets every ring when the per-ring options are absent
 * @param {number} [options.evidenceRingSize]
 * @param {number} [options.verificationRingSize]
 * @param {number} [options.decisionRingSize]
 * @param {number} [options.processRingSize]
 * @param {number} [options.stepRingSize]
 * @param {number} [options.fileRingSize]
 * @param {number} [options.blockerRingSize]
 * @param {number} [options.tailSize] how many entries one snapshot exposes
 * @param {number} [options.summaryBudgetBytes]
 */
function createEpisodeContext(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const shared = positive(options.ringSize, null)
  const limits = Object.freeze({
    evidence: positive(options.evidenceRingSize, shared || DEFAULT_EVIDENCE_RING),
    verification: positive(options.verificationRingSize, shared || DEFAULT_VERIFICATION_RING),
    decisions: positive(options.decisionRingSize, shared || DEFAULT_DECISION_RING),
    process: positive(options.processRingSize, shared || DEFAULT_PROCESS_RING),
    steps: positive(options.stepRingSize, shared || DEFAULT_STEP_RING),
    files: positive(options.fileRingSize, shared || DEFAULT_FILE_RING),
    blockers: positive(options.blockerRingSize, shared || DEFAULT_BLOCKER_RING),
    tail: positive(options.tailSize, DEFAULT_TAIL)
  })
  const summaryBudgetBytes = positive(options.summaryBudgetBytes, DEFAULT_SUMMARY_BUDGET_BYTES)
  const liveBudgetBytes = byteLength(limits) + 256

  /** Layer 1: the current step, and nothing else. */
  const live = {}

  /** Layer 2: the bounded evidence rings. */
  const evidence = createRing(limits.evidence)
  const verifications = createRing(limits.verification)
  const decisions = createRing(limits.decisions)
  const processes = createRing(limits.process)
  const completed = createRing(limits.steps)
  const pending = createRing(limits.steps)
  const filesChanged = createRing(limits.files)
  const blockers = createRing(limits.blockers)

  /** Paths currently inside the changed-file ring, so dedupe cannot leak memory. */
  const knownFiles = new Set()
  /** Plan steps completed in total: a counter, because a counter cannot grow. */
  let completedStepCount = 0
  /**
   * Monotonic event totals. They are the honest answer to "how many times did
   * this happen?" after the rings have started dropping entries, and being plain
   * numbers they cost the same after one step as after ten thousand.
   */
  const totals = { evidence: 0, verifications: 0, passed: 0, failed: 0, decisions: 0, processMilestones: 0 }

  function noteStep(step, extra = {}) {
    const label = stepText(step)
    if (!label) return null
    pending.filter((entry) => entry.label !== label)
    completedStepCount += 1
    return completed.push({ at: now(), label, ...extra })
  }

  function planStep(step) {
    const label = stepText(step)
    if (!label) return null
    if (pending.items().some((entry) => entry.label === label)) return null
    return pending.push({ at: now(), label })
  }

  function addBlocker(key, reason) {
    const name = text(key, 120)
    if (!name) return null
    blockers.filter((entry) => entry.key !== name)
    return blockers.push({ at: now(), key: name, reason: text(reason, SUMMARY_ITEM_LIMIT) })
  }

  function clearBlocker(key) {
    const name = text(key, 120)
    if (!name) return 0
    return blockers.filter((entry) => entry.key !== name)
  }

  function noteFile(file) {
    const name = text(file, SUMMARY_ITEM_LIMIT)
    if (!name || knownFiles.has(name)) return null
    knownFiles.add(name)
    const entry = filesChanged.push(name)
    while (filesChanged.size > limits.files) {
      knownFiles.delete(filesChanged.shift())
    }
    return entry
  }

  /**
   * The verification roll-up both `snapshot()` and `summary()` read.
   *
   * `total`, `passed` and `failed` are the episode's monotonic totals — a count
   * that shrank when a ring turned over would be a lie. `ok` is decided by the
   * *latest* run of each operation still retained, because a blocker is cleared by
   * the next passing run and the two views have to agree; operations whose whole
   * history has scrolled out of the bounded ring are forgotten, which is the
   * price of flat memory and is paid knowingly.
   */
  function verificationStatus() {
    const all = verifications.items()
    const latest = new Map()
    for (const entry of all) latest.set(entry.operation, entry)
    const failing = [...latest.values()].filter((entry) => entry.ok !== true).length
    return {
      ok: totals.verifications === 0 ? null : failing === 0,
      total: totals.verifications,
      passed: totals.passed,
      failed: totals.failed,
      retained: verifications.size,
      last: all.length ? all[all.length - 1] : null,
      recent: verifications.tail(Math.min(5, limits.tail))
    }
  }

  /**
   * Set (or replace) the live fields. Only the six live keys are accepted: a step
   * that wants to remember anything else has to record it as evidence.
   */
  function setLive(input = {}) {
    for (const key of LIVE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue
      const value = input[key]
      if (value === undefined || value === null || value === '') {
        delete live[key]
        continue
      }
      live[key] = key === 'phase' ? text(value, 40) : (key === 'planStep' ? stepText(value) : clip(value, LIVE_LIMIT))
    }
    return { ...live }
  }

  /** Remove live fields by name; everything else stays. */
  function clearLive(keys = LIVE_KEYS) {
    const list = Array.isArray(keys) ? keys : [keys]
    for (const key of list) {
      if (LIVE_KEYS.includes(key)) delete live[key]
    }
    return { ...live }
  }

  /**
   * Record one bounded observation.
   *
   * `kind` is free vocabulary except for four control values: a planned step, a
   * completed step, a blocker and a cleared blocker. Everything else is evidence,
   * and evidence is what `bytes` accounts for.
   */
  function observe(input = {}) {
    const kind = text(input.kind, 80) || 'observation'
    const summary = text(input.summary, EVIDENCE_SUMMARY_LIMIT)
    const file = input.file === undefined || input.file === null ? null : text(input.file, SUMMARY_ITEM_LIMIT)
    if (file) noteFile(file)
    if (kind === 'step-planned' || kind === 'plan-step-planned') planStep(input.step === undefined ? summary : input.step)
    if (kind === 'step-completed' || kind === 'plan-step-completed') noteStep(input.step === undefined ? summary : input.step, { kind })
    if (kind === 'blocker') addBlocker(input.key === undefined ? summary : input.key, summary)
    if (kind === 'blocker-cleared') clearBlocker(input.key === undefined ? summary : input.key)
    const rawEvidence = input.evidence
    const items = Array.isArray(rawEvidence)
      ? rawEvidence.slice(0, EVIDENCE_ITEMS).map((item) => clip(item, EVIDENCE_ITEM_LIMIT))
      : (rawEvidence === undefined || rawEvidence === null ? [] : [clip(rawEvidence, EVIDENCE_ITEM_LIMIT)])
    totals.evidence += 1
    return evidence.push({
      at: now(),
      kind,
      summary,
      evidence: items,
      bytes: Number.isFinite(input.bytes) ? Math.max(0, Math.round(input.bytes)) : 0
    })
  }

  /**
   * Record one repair or recovery decision.
   *
   * A failed decision becomes a blocker under its kind, so "what is in the way"
   * is readable from the bounded layers alone; a resolved one completes the plan
   * step it names.
   */
  function recordDecision(input = {}) {
    const kind = text(input.kind, 80) || 'decision'
    const result = text(input.result, 40) || 'unknown'
    totals.decisions += 1
    const entry = decisions.push({ at: now(), kind, detail: clip(input.detail, DECISION_FIELD_LIMIT), result })
    if (RESOLVED_RESULTS.includes(result.toLowerCase())) {
      if (input.step !== undefined && input.step !== null) noteStep(input.step, { kind, result })
    } else if (result !== 'open' && result !== 'pending') {
      addBlocker(`decision:${kind}`, `${kind} ended ${result}`)
    }
    return entry
  }

  /** Record one process milestone: a started process plans a step, a finished one completes it. */
  function recordProcess(input = {}) {
    const milestone = text(input.milestone, 40) || 'unknown'
    totals.processMilestones += 1
    const entry = processes.push({
      at: now(),
      id: text(input.id, 80) || null,
      command: clip(input.command, DECISION_FIELD_LIMIT),
      milestone
    })
    const marker = milestone.toLowerCase()
    if (COMPLETION_MILESTONES.includes(marker) && input.step !== undefined && input.step !== null) {
      noteStep(input.step, { kind: 'process', process: entry.id })
    }
    if (START_MILESTONES.includes(marker) && input.step !== undefined && input.step !== null) planStep(input.step)
    return entry
  }

  /**
   * Record one verification.
   *
   * The latest verification per operation decides whether that operation is a
   * blocker: a passing run clears the blocker a failing one raised. That makes the
   * blocker list a *current* view rather than a history.
   */
  function recordVerification(input = {}) {
    const operation = text(input.operation, 80) || 'unknown'
    const ok = input.ok === true
    totals.verifications += 1
    if (ok) totals.passed += 1
    else totals.failed += 1
    const entry = verifications.push({
      at: now(),
      operation,
      command: clip(input.command, DECISION_FIELD_LIMIT),
      ok,
      summary: text(input.summary, 300),
      exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null,
      durationMs: Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : null
    })
    const key = `verification:${operation}`
    if (entry.ok) {
      clearBlocker(key)
      if (input.step !== undefined && input.step !== null) noteStep(input.step, { kind: 'verification', operation })
    } else {
      addBlocker(key, `${operation} failed${entry.exitCode === null ? '' : ` with exit code ${entry.exitCode}`}`)
    }
    return entry
  }

  /** What `summarize` needs, from this context's own bounded layers. */
  function inventory() {
    return {
      goal: live.goal || null,
      phase: live.phase || null,
      completedSteps: completed.items(),
      completedStepCount,
      pendingSteps: pending.items(),
      blockers: blockers.items(),
      changedFiles: filesChanged.items(),
      verification: verificationStatus(),
      processMilestones: processes.items(),
      decisions: decisions.items()
    }
  }

  /** Build the uncapped summary from an inventory, whoever produced it. */
  function buildSummary(data) {
    const completedSteps = Array.isArray(data.completedSteps) ? data.completedSteps : []
    const pendingSteps = Array.isArray(data.pendingSteps) ? data.pendingSteps : []
    const files = Array.isArray(data.changedFiles) ? data.changedFiles : (Array.isArray(data.filesChanged) ? data.filesChanged : [])
    const blockerList = Array.isArray(data.blockers) ? data.blockers : []
    const verification = data.verification !== null && typeof data.verification === 'object' ? data.verification : {}
    const last = verification.last !== null && typeof verification.last === 'object' ? verification.last : null
    const total = Number.isInteger(verification.total) ? verification.total : (Array.isArray(data.verifications) ? data.verifications.length : 0)
    const failed = Number.isInteger(verification.failed) ? verification.failed : 0
    const passed = Number.isInteger(verification.passed) ? verification.passed : Math.max(0, total - failed)
    return {
      goal: text(data.goal, LIVE_LIMIT) || null,
      phase: text(data.phase, 40) || null,
      completed: {
        steps: Number.isInteger(data.completedStepCount) ? data.completedStepCount : completedSteps.length,
        lastSteps: completedSteps.slice(-SUMMARY_LAST_STEPS).map(stepText).filter(Boolean),
        verifications: total,
        decisions: Array.isArray(data.decisions) ? data.decisions.length : 0,
        processMilestones: Array.isArray(data.processMilestones) ? data.processMilestones.length : 0
      },
      blockers: blockerList.map(blockerText).filter(Boolean),
      filesChanged: files.map((file) => text(file, SUMMARY_ITEM_LIMIT)).filter(Boolean),
      verification: {
        ok: verification.ok === true ? true : (verification.ok === false ? false : null),
        total,
        passed,
        failed,
        last: last
          ? {
            operation: text(last.operation, 80) || null,
            ok: last.ok === true,
            exitCode: Number.isInteger(last.exitCode) ? last.exitCode : null,
            summary: text(last.summary, 160)
          }
          : null
      },
      remaining: pendingSteps.map(stepText).filter(Boolean)
    }
  }

  /**
   * Cap a summary at the byte budget, dropping the least load-bearing detail
   * first and reporting `truncated: true` when anything had to go. The result
   * always carries `bytes` and `budget` so a caller can see the ceiling was real.
   */
  function capSummary(summary) {
    const result = {
      goal: summary.goal,
      phase: summary.phase,
      completed: { ...summary.completed, lastSteps: summary.completed.lastSteps.slice() },
      blockers: summary.blockers.slice(),
      filesChanged: summary.filesChanged.slice(),
      verification: { ...summary.verification, last: summary.verification.last ? { ...summary.verification.last } : null },
      remaining: summary.remaining.slice(),
      truncated: false
    }
    // The slack covers the `bytes` field that is added after the last measurement.
    const within = () => byteLength(result) <= summaryBudgetBytes - 32
    if (!within()) {
      result.truncated = true
      const shrinkers = [
        () => { result.remaining = result.remaining.slice(0, 3) },
        () => { result.filesChanged = result.filesChanged.slice(0, 3) },
        () => { result.blockers = result.blockers.slice(0, 3) },
        () => { result.completed.lastSteps = result.completed.lastSteps.slice(0, 3) },
        () => { result.remaining = []; result.filesChanged = []; result.blockers = []; result.completed.lastSteps = [] },
        () => {
          result.goal = clip(result.goal, 160)
          if (result.verification.last) result.verification.last.summary = clip(result.verification.last.summary, 60)
        },
        () => {
          result.goal = clip(result.goal, 60)
          if (result.verification.last) result.verification.last.summary = ''
        },
        () => { result.verification.last = null },
        () => { result.goal = null }
      ]
      for (const shrink of shrinkers) {
        if (within()) break
        shrink()
      }
      if (!within()) {
        // Everything left is a count or a name; below this the summary would stop
        // being a summary, so this is where the cutting stops being polite.
        result.goal = clip(result.goal, 40)
        result.remaining = []
        result.filesChanged = []
        result.blockers = []
        result.completed.lastSteps = []
        result.verification.last = null
      }
    }
    result.bytes = byteLength(result)
    result.budget = summaryBudgetBytes
    return result
  }

  /** The bounded object a caller or a summary may read. Never the whole rings. */
  function snapshot() {
    const tail = limits.tail
    return {
      at: now(),
      live: { ...live },
      evidence: evidence.tail(tail),
      verification: verificationStatus(),
      decisions: decisions.tail(tail),
      processMilestones: processes.tail(tail),
      pendingSteps: pending.tail(tail),
      completedSteps: completed.tail(tail),
      blockers: blockers.tail(tail),
      filesChanged: filesChanged.tail(tail),
      counts: {
        evidence: evidence.size,
        verifications: verifications.size,
        decisions: decisions.size,
        processMilestones: processes.size,
        pendingSteps: pending.size,
        completedSteps: completed.size,
        blockers: blockers.size,
        filesChanged: filesChanged.size
      },
      totals: {
        evidence: totals.evidence,
        verifications: totals.verifications,
        decisions: totals.decisions,
        processMilestones: totals.processMilestones,
        completedSteps: completedStepCount
      },
      bytes: bytes(),
      limits: { ...limits, summaryBudgetBytes }
    }
  }

  /** The approximate retained size of every bounded layer, plus the live fields. */
  function bytes() {
    let total = byteLength(live) + liveBudgetBytes
    total += evidence.bytes()
    total += verifications.bytes()
    total += decisions.bytes()
    total += processes.bytes()
    total += completed.bytes()
    total += pending.bytes()
    total += filesChanged.bytes()
    total += blockers.bytes()
    return total
  }

  return {
    setLive,
    clearLive,
    observe,
    recordDecision,
    recordProcess,
    recordVerification,
    inventory,
    summarize(source = null) {
      const data = source !== null && typeof source === 'object' ? source : inventory()
      return capSummary(buildSummary(data))
    },
    snapshot,
    bytes,
    limits
  }
}

module.exports = {
  createEpisodeContext,
  LIVE_KEYS,
  DEFAULT_EVIDENCE_RING,
  DEFAULT_VERIFICATION_RING,
  DEFAULT_DECISION_RING,
  DEFAULT_PROCESS_RING,
  DEFAULT_STEP_RING,
  DEFAULT_FILE_RING,
  DEFAULT_BLOCKER_RING,
  DEFAULT_TAIL,
  DEFAULT_SUMMARY_BUDGET_BYTES
}
