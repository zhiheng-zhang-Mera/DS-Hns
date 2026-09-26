'use strict'

/**
 * DS-Hns Engineering Runtime: the shell-side host.
 *
 * The engineering supervisor is a long-running object that mutates a repository,
 * so the shell owns exactly one of them and exactly one *active episode* at a
 * time: two episodes in the same workspace would be two writers racing over the
 * same files. This module is the only place that state lives, and it exists so
 * `desktop-main.cjs` stays an entry point rather than a supervisor.
 *
 * Three properties matter for the dock that drives it:
 *
 *  1. **Starting an episode does not block the shell.** `run` returns as soon as
 *     the episode has been accepted; progress is read from `status()`. Awaiting a
 *     24-hour episode inside an IPC handler would make the renderer unable to ask
 *     anything — including to cancel.
 *  2. **Cancellation is cooperative and bounded.** The supervisor checks for it at
 *     every step boundary, so a cancel never interrupts a half-finished mutation;
 *     the episode tears down its owned processes and reports where it got to.
 *  3. **Nothing crosses the seam that should not.** No command, path, git policy
 *     or contract field is decided by the renderer; the host validates the few
 *     inputs it needs (a workspace path, a goal, a deadline) and passes the rest
 *     through to the supervisor's own contract handling.
 */

const fs = require('node:fs')
const path = require('node:path')

const { EPISODE_PHASES } = require('./engineering/episode.cjs')

/** The longest episode the UI may start without an explicit contract. */
const MAX_UI_DEADLINE_MS = 24 * 60 * 60 * 1000
/** The shortest, so a stray "1" does not produce an episode that does nothing. */
const MIN_UI_DEADLINE_MS = 30_000

/**
 * @param {object} options
 * @param {Function} [options.log] `(line) => void`
 * @param {Function} [options.now]
 * @param {string} [options.checkpointRoot] where episodes keep their checkpoints
 * @param {Function} [options.available] `() => boolean`, whether the subsystem is enabled
 * @param {Function} [options.reason] `() => string`, why it is not
 * @param {object} [options.policy] the git policy (`{ allowCommit, allowPush, allowMerge }`)
 * @param {object} [options.defaults] the shipped engineering block from `config/app.json`
 */
function createEngineeringHost(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const available = typeof options.available === 'function' ? options.available : () => true
  const reason = typeof options.reason === 'function' ? options.reason : () => 'the engineering runtime is disabled'
  const checkpointRoot = options.checkpointRoot || null
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : {}
  // The shipped policy is *closed*: a renderer cannot ask for a commit, a push or a
  // merge. Only the config file and an embedding host can open those doors.
  const policy = { allowCommit: false, allowPush: false, allowMerge: false, ...(defaults.git || {}), ...(options.policy || {}) }

  let supervisor = null
  let activePromise = null
  let activeRequest = null
  let lastReport = null
  let cancelled = false
  let startedAt = null

  function enabled() {
    if (!available()) return { ok: false, error: reason(), code: 'ENGINEERING_DISABLED' }
    return null
  }

  /** A bounded, renderer-safe view of the runtime. Never the supervisor itself. */
  function status() {
    const disabled = enabled()
    if (disabled) return { ...disabled, running: false, phase: null, report: lastReport }
    const state = supervisor && activePromise ? supervisor.state() : null
    return {
      ok: true,
      running: Boolean(activePromise),
      phase: supervisor ? supervisor.phase : null,
      episode: supervisor ? supervisor.id : null,
      startedAt,
      request: activeRequest ? { workspace: activeRequest.workspace, goal: activeRequest.goal, deadlineMs: activeRequest.deadlineMs } : null,
      state,
      // The summary is the episode's own bounded one, not a second opinion.
      summary: supervisor && activePromise ? safe(() => supervisor.summarize()) : null,
      report: lastReport,
      phases: Object.values(EPISODE_PHASES)
    }
  }

  function safe(fn) {
    try {
      return fn()
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Describe a directory without starting anything: which project the runtime
   * would detect and which commands it would use. This is what lets the panel show
   * the user what an episode is about to do before it does it.
   */
  function describe(input = {}) {
    const disabled = enabled()
    if (disabled) return disabled
    const workspace = String(input.workspace || '').trim()
    if (!workspace) return { ok: false, error: 'a repository path is required', code: 'WORKSPACE_REQUIRED' }
    try {
      const engineering = require('./engineering/index.cjs')
      const verified = engineering.verifyWorkspace(workspace, {})
      if (!verified.ok) return { ok: false, error: verified.reason, code: 'WORKSPACE_UNAVAILABLE' }
      const project = engineering.detectProject(verified.path)
      const discovered = engineering.discoverCommands({ root: verified.path, project })
      const snapshot = engineering.discover(verified.path, { project })
      return {
        ok: true,
        workspace: verified.path,
        canonical: verified.canonical,
        git: engineering.gitState(verified.path),
        project: { id: project.id, language: project.language, evidence: project.evidence, others: project.others },
        commands: discovered.operations,
        commandSources: discovered.sources,
        instructions: snapshot.instructions.map((entry) => entry.file),
        ci: snapshot.ci,
        manifests: snapshot.evidence.manifests
      }
    } catch (error) {
      log(`engineering describe failed: ${error && error.stack ? error.stack : error}`)
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  /** The checkpoints one episode kept, for a caller that wants to resume. */
  function checkpoints(input = {}) {
    const disabled = enabled()
    if (disabled) return disabled
    const episodeId = String(input.episodeId || '').trim()
    if (!episodeId) return { ok: false, error: 'an episode id is required', code: 'EPISODE_REQUIRED' }
    try {
      const { createCheckpointStore } = require('./engineering/checkpoint.cjs')
      const store = createCheckpointStore({ dir: checkpointRoot || undefined, now })
      return { ok: true, checkpoints: store.list(episodeId) }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Start one episode.
   *
   * The validation here is deliberately about *shape*, not policy: a workspace
   * path, a goal, and a deadline inside the allowed band. Everything else — the
   * commands, the patches, the git policy — is the contract's business, and the
   * supervisor verifies the workspace itself before it touches anything.
   *
   * @returns {{ok:boolean, accepted?:boolean, episode?:string, error?:string}}
   */
  function run(input = {}) {
    const disabled = enabled()
    if (disabled) return disabled
    if (activePromise) {
      return { ok: false, error: 'an episode is already running; cancel it or wait for it to finish', code: 'EPISODE_ACTIVE', episode: supervisor ? supervisor.id : null }
    }
    const workspace = String(input.workspace || '').trim()
    if (!workspace) return { ok: false, error: 'a repository path is required', code: 'WORKSPACE_REQUIRED' }
    const goal = String(input.goal || '').trim()
    if (!goal) return { ok: false, error: 'a goal is required', code: 'GOAL_REQUIRED' }
    const requested = Number(input.deadlineMs)
    const deadlineMs = Number.isFinite(requested)
      ? Math.max(MIN_UI_DEADLINE_MS, Math.min(MAX_UI_DEADLINE_MS, Math.round(requested)))
      : MAX_UI_DEADLINE_MS

    let createEngineeringSupervisor
    try {
      ({ createEngineeringSupervisor } = require('./engineering/supervisor.cjs'))
    } catch (error) {
      return { ok: false, error: `the engineering runtime could not be loaded: ${error && error.message ? error.message : error}`, code: 'ENGINEERING_UNAVAILABLE' }
    }

    cancelled = false
    startedAt = now()
    activeRequest = { workspace, goal, deadlineMs, contract: input.contract && typeof input.contract === 'object' ? input.contract : null }
    try {
      supervisor = createEngineeringSupervisor({
        workspace,
        goal,
        contract: activeRequest.contract || {},
        // The shipped limits and the closed git policy, so an episode's bounds are
        // the deployment's and not the renderer's.
        deadlineMs: Number.isFinite(defaults.deadlineMs) ? Math.min(deadlineMs, Number(defaults.deadlineMs)) : deadlineMs,
        policy,
        checkpointRoot,
        now,
        log: (event) => log(`engineering ${event.type || 'event'}: ${JSON.stringify(event).slice(0, 400)}`),
        // Cooperative cancellation: the supervisor checks this at every step
        // boundary, so a cancel never lands in the middle of a mutation.
        isCancelled: () => cancelled
      })
    } catch (error) {
      supervisor = null
      activeRequest = null
      startedAt = null
      return { ok: false, error: String(error && error.message ? error.message : error), code: 'ENGINEERING_UNAVAILABLE' }
    }

    const episode = supervisor.id
    log(`engineering episode ${episode} accepted for ${workspace}`)
    // Deliberately not awaited: the renderer reads progress from `status()`, and
    // awaiting would make the shell unable to process the cancel that stops it.
    activePromise = Promise.resolve()
      .then(() => supervisor.run())
      .then((report) => {
        lastReport = report
        return report
      })
      .catch((error) => {
        lastReport = {
          episode,
          goal,
          result: 'FAILED',
          error: String(error && error.message ? error.message : error),
          workspace,
          phases: supervisor ? supervisor.machine.history().map((entry) => entry.to) : []
        }
        log(`engineering episode ${episode} threw: ${error && error.stack ? error.stack : error}`)
        return lastReport
      })
      .finally(() => {
        activePromise = null
        activeRequest = null
      })
    return { ok: true, accepted: true, episode, deadlineMs }
  }

  /**
   * Ask the running episode to stop.
   *
   * The flag is the whole mechanism: the episode stops at its next step boundary,
   * disposes what it owns and reports where it got to. Nothing is killed mid-write.
   */
  function cancel(input = {}) {
    const disabled = enabled()
    if (disabled) return disabled
    if (!activePromise || !supervisor) return { ok: true, cancelled: false, reason: 'no episode is running' }
    cancelled = true
    const episode = supervisor.id
    log(`engineering episode ${episode} cancellation requested: ${input.reason || 'cancelled from the panel'}`)
    return { ok: true, cancelled: true, episode, reason: String(input.reason || 'cancelled from the panel') }
  }

  /** Wait for the active episode (used by teardown and by tests). */
  async function settled() {
    if (!activePromise) return lastReport
    return activePromise
  }

  /** Stop everything this host owns. Called on shell teardown. */
  function dispose(reason_ = 'shell teardown') {
    if (supervisor && activePromise) {
      cancelled = true
      log(`engineering host disposing during an active episode (${reason_})`)
    }
    try {
      if (supervisor) supervisor.supervisor.dispose(reason_)
    } catch {
      /* nothing left to stop */
    }
    activePromise = null
    activeRequest = null
    return true
  }

  return {
    ENGINEERING_CHANNELS: ['engineering:status', 'engineering:describe', 'engineering:checkpoints', 'engineering:run', 'engineering:cancel'],
    status,
    describe,
    checkpoints,
    run,
    cancel,
    settled,
    dispose,
    get id() {
      return supervisor ? supervisor.id : null
    },
    get running() {
      return Boolean(activePromise)
    },
    /** The live supervisor, for the shell's own diagnostics only. */
    get supervisor() {
      return supervisor
    }
  }
}

module.exports = { createEngineeringHost, MAX_UI_DEADLINE_MS, MIN_UI_DEADLINE_MS }
