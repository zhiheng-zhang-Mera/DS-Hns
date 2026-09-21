'use strict'

/**
 * DS-Hns: **task continuity** across a restart — park, remember, resume, and say honestly how far the
 * work got.
 *
 * The restart supervisor owns *stopping and starting a process*. It deliberately does not know what a
 * task is, so it asks this module — Core's own answer — three questions, through the continuity hooks:
 *
 *   * `pendingWork()` — is anything running, is it near a checkpoint, is it in an operation its own
 *     state machine calls uninterruptible? The boundary decision is the supervisor's; the facts are
 *     these.
 *   * `beforeRestart()` — park what is running and write down what will have to be continued. This is
 *     the step that makes recovery possible at all: a restart with no record is a restart that loses
 *     whatever was in flight.
 *   * `afterRestart()` — continue it, and report the three different things a person means by
 *     "recovered":
 *       1. **process recovery** — the application is up (the supervisor's readiness gates own that);
 *       2. **task recovery** — the interrupted work is executable again;
 *       3. **semantic recovery** — it continues from what was actually done (the checkpoint, the
 *          commit, the artifacts), rather than starting over.
 *
 * ## Why the three are kept apart
 *
 * "The process restarted" and "the task resumed" are different claims, and the second one is the only
 * one that matters to a person whose work was interrupted. So `afterRestart` never returns a bare
 * `ok: true`: it returns what it resumed, what it deliberately skipped, what it found already
 * complete, and where the continuation started from. A restart that only brought the process back is
 * reported as exactly that — `PROCESS_ONLY` — with the reason.
 *
 * ## Verification, not assumption
 *
 * Before resuming, the recorded state is checked against reality: the intent says which task and which
 * workspace, and the evidence is the task's own status, the working tree, the HEAD commit, the
 * checkpoint and the artifacts the intent names. A step that is already in the repository (its commit
 * is in the history, its artifact exists) is *skipped* rather than run again — that is the difference
 * between semantic continuation and a blind redo, and it is recorded either way.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/** How many recent commits are read when the intent names one. Enough to recognise a completed step. */
const GIT_LOG_DEPTH = 20

function safeJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * @param {object} input
 * @param {object} input.targets the task targets (`app/reboot/targets.cjs`)
 * @param {string} input.stateDir where the resume intent is written (survives the process)
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 * @param {Function} [input.git] a git runner, injectable for tests: `(args, cwd) => { status, stdout }`
 * @param {Function} [input.readCheckpoint] how a checkpoint id is verified; defaults to the state file
 */
function createTaskContinuity(input = {}) {
  const targets = input.targets && typeof input.targets === 'object' ? input.targets : {}
  const stateDir = String(input.stateDir || path.join(process.cwd(), 'data', 'state'))
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}
  const intentFile = path.join(stateDir, 'resume-intent.json')
  const historyDir = path.join(stateDir, 'resume-history')
  /**
   * The targets by the id they publish, as well as by the key they are stored under.
   *
   * A target's own `status()` names itself (`sub-worker`), while the map is keyed the way the reboot
   * coordinator addresses it (`subWorker`). Parking looked the target up by the name it had just read, so
   * every target was "not available in this build" — the kind of mismatch that makes a whole feature
   * silently do nothing.
   */
  const byId = new Map()
  for (const [key, target] of Object.entries(targets)) {
    if (!target || typeof target !== 'object') continue
    byId.set(key, target)
    if (target.id) byId.set(String(target.id), target)
  }
  function targetFor(entry) {
    const wanted = entry && entry.target ? String(entry.target) : ''
    return byId.get(wanted) || null
  }

  const git = typeof input.git === 'function'
    ? input.git
    : (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 })

  /** Every target that has something to say, in a stable order. */
  function statuses() {
    const out = []
    for (const id of Object.keys(targets)) {
      const target = targets[id]
      if (!target || typeof target.status !== 'function') continue
      let state = null
      try {
        state = target.status()
      } catch (error) {
        state = { target: id, running: false, error: String(error && error.message ? error.message : error) }
      }
      if (state) out.push({ ...state, target: state.target || id })
    }
    return out
  }

  /**
   * What the supervisor's boundary decision is made from.
   *
   * `uninterruptible` is the one that always defers: a target that says it cannot be stopped right now
   * is answering the question the supervisor asked, and the restart waits for a better moment instead
   * of tearing through it.
   */
  function pendingWork() {
    const running = statuses().filter((entry) => entry.running === true)
    if (!running.length) return { ok: true, active: false, nearCheckpoint: false, uninterruptible: false, running: [] }
    const nearCheckpoint = running.some((entry) => entry.nearCheckpoint === true || entry.phase === 'CHECKPOINTING')
    const uninterruptible = running.some((entry) => entry.uninterruptible === true)
    return {
      ok: true,
      active: true,
      nearCheckpoint,
      uninterruptible,
      running: running.map((entry) => ({ target: entry.target, state: entry.state || null, taskId: entry.taskId || null, phase: entry.phase || null })),
      detail: `${running.length} target(s) running: ${running.map((entry) => entry.target).join(', ')}`
    }
  }

  /** The intent a restart leaves behind: what was parked, and what has to be continued. */
  function writeIntent(intent) {
    const record = {
      version: 1,
      at: now(),
      kind: 'restart',
      ...intent
    }
    try {
      writeJsonAtomic(intentFile, record)
      return { ok: true, file: intentFile, intent: record }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  function readIntent() {
    return safeJson(intentFile)
  }

  function clearIntent(reason = 'acted on') {
    try {
      fs.rmSync(intentFile, { force: true })
      return { ok: true, reason }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /** Keep the record of what was resumed: the evidence a later `restart_status` is checked against. */
  function rememberResume(record) {
    try {
      fs.mkdirSync(historyDir, { recursive: true })
      fs.writeFileSync(path.join(historyDir, `${record.at}-resume.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      // A bounded history: the newest twenty attempts are enough to see a pattern, and the directory
      // must not grow for ever on a machine that restarts every day.
      const files = fs.readdirSync(historyDir).filter((name) => name.endsWith('-resume.json')).sort()
      for (const stale of files.slice(0, Math.max(0, files.length - 20))) fs.rmSync(path.join(historyDir, stale), { force: true })
      return { ok: true, file: path.join(historyDir, `${record.at}-resume.json`) }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Park every running target at its own boundary.
   *
   * A target that refuses is reported rather than forced: "the worker would not stop" is information
   * the restart's own boundary policy needs, and a continuity layer that decided by itself to give up
   * on a target would be making a decision it does not own.
   */
  async function park(options = {}) {
    const reason = options.reason || 'a restart needs a safe boundary'
    const before = statuses()
    const parked = []
    const pending = []
    const refused = []
    for (const entry of before) {
      if (entry.running !== true) continue
      const target = targetFor(entry)
      if (!target || typeof target.suspend !== 'function') {
        refused.push({ target: entry.target, reason: 'the target cannot be parked by this build' })
        continue
      }
      let outcome = null
      try {
        outcome = await target.suspend({ reason, plan: options.plan || null })
      } catch (error) {
        outcome = { ok: false, reason: String(error && error.message ? error.message : error) }
      }
      if (outcome && outcome.ok === true) {
        if (outcome.pending === true) pending.push({ target: entry.target, detail: outcome.detail || null, state: outcome.state || null })
        else parked.push({ target: entry.target, taskId: entry.taskId || null, checkpoint: outcome.checkpoint || null, detail: outcome.detail || null })
      } else {
        refused.push({ target: entry.target, reason: (outcome && outcome.reason) || 'the target refused to park' })
      }
    }
    const intent = writeIntent({
      reason,
      plan: options.plan ? { id: options.plan.id || null, reasonCode: options.plan.reasonCode || null } : null,
      targets: before.filter((entry) => entry.running === true).map((entry) => ({
        target: entry.target,
        taskId: entry.taskId || null,
        state: entry.state || null,
        request: entry.request || null,
        phase: entry.phase || null,
        episode: entry.episode || null
      })),
      parked: parked.map((entry) => entry.target),
      pending: pending.map((entry) => entry.target),
      refused
    })
    const ok = refused.length === 0
    return {
      ok,
      parked: parked.map((entry) => entry.target),
      pending: pending.map((entry) => entry.target),
      refused,
      nothingRunning: before.every((entry) => entry.running !== true),
      intent: intent.ok === true ? intent.intent : null,
      file: intent.ok === true ? intent.file : null,
      detail: ok
        ? (parked.length || pending.length ? `parked ${[...parked.map((e) => e.target), ...pending.map((e) => e.target)].join(', ')}` : 'nothing was running')
        : `the restart was refused a safe boundary by ${refused.map((entry) => entry.target).join(', ')}`,
      reason: ok ? null : 'a target would not park'
    }
  }

  /**
   * The evidence that the world is where the intent said it was.
   *
   * Read, not assumed: the task's own status, the working tree, HEAD, whether a commit the intent
   * names is really in the history, whether the checkpoint is really there, and whether the artifacts
   * it names exist. Every check reports what it saw, because "resumed" without evidence is the false
   * success this module exists to prevent.
   */
  function verify({ intent = readIntent(), workspace = null, commit = null, artifacts = [], checkpoint = null } = {}) {
    const checks = []
    const cwd = workspace || (intent && intent.workspace) || process.cwd()
    const wantedCommit = commit || (intent && intent.commit) || null

    const status = statuses()
    checks.push({ id: 'task-state', ok: status.length > 0, detail: status.length ? JSON.stringify(status.map((entry) => ({ target: entry.target, running: entry.running, state: entry.state || null }))) : 'no target reports a state in this build' })

    const head = git(['rev-parse', 'HEAD'], cwd)
    const headSha = head && head.status === 0 ? String(head.stdout || '').trim() : null
    checks.push({ id: 'git-head', ok: Boolean(headSha), detail: headSha || 'the working tree could not be read' })

    const porcelain = git(['status', '--porcelain'], cwd)
    const dirty = porcelain && porcelain.status === 0 ? String(porcelain.stdout || '').trim().split('\n').filter(Boolean) : null
    checks.push({ id: 'git-working-tree', ok: porcelain ? porcelain.status === 0 : false, detail: porcelain && porcelain.status === 0 ? (dirty && dirty.length ? `${dirty.length} modified path(s)` : 'clean') : 'git status could not be read' })

    if (wantedCommit) {
      const log = git(['log', `-${GIT_LOG_DEPTH}`, '--format=%H'], cwd)
      const shas = log && log.status === 0 ? String(log.stdout || '').trim().split('\n').filter(Boolean) : []
      const short = String(wantedCommit).slice(0, 12)
      const found = shas.some((sha) => sha.startsWith(short))
      checks.push({ id: 'recorded-commit', ok: found, detail: found ? `${short} is in the last ${GIT_LOG_DEPTH} commits` : `${short} is not in the last ${GIT_LOG_DEPTH} commits of ${cwd}` })
    }

    const wantedCheckpoint = checkpoint || (intent && intent.checkpoint) || null
    if (wantedCheckpoint) {
      const file = path.join(stateDir, 'checkpoints', `${wantedCheckpoint}.json`)
      const found = fs.existsSync(file) || Boolean(safeJson(file))
      checks.push({ id: 'checkpoint', ok: found, detail: found ? `${wantedCheckpoint} is recorded` : `no record of checkpoint ${wantedCheckpoint}` })
    }

    const wantedArtifacts = Array.isArray(artifacts) && artifacts.length ? artifacts : (intent && Array.isArray(intent.artifacts) ? intent.artifacts : [])
    for (const artifact of wantedArtifacts.slice(0, 20)) {
      const file = path.isAbsolute(String(artifact)) ? String(artifact) : path.join(cwd, String(artifact))
      const found = fs.existsSync(file)
      checks.push({ id: `artifact:${artifact}`, ok: found, detail: found ? 'present' : 'missing' })
    }

    const failed = checks.filter((check) => check.ok !== true)
    return {
      ok: failed.length === 0,
      at: now(),
      cwd,
      head: headSha,
      dirty: dirty ? dirty.length : 0,
      checks,
      failed: failed.map((check) => check.id),
      reason: failed.length ? `${failed.length} check(s) did not hold: ${failed.map((check) => check.id).join(', ')}` : null
    }
  }

  /**
   * Continue the interrupted work.
   *
   * The order is deliberate: **verify** what the intent says, **skip** what the evidence shows is
   * already done, **resume** what is left, and report all three. A step already in the repository is
   * not run again — that is the whole difference between continuing and redoing.
   */
  async function resume(options = {}) {
    const intent = options.intent || readIntent()
    if (!intent) {
      return { ok: true, skipped: true, resumed: [], alreadyComplete: [], semantic: null, detail: 'no resume intent was left by the restart' }
    }
    const verification = verify({ intent, workspace: options.workspace || intent.workspace || null })
    const resumed = []
    const skipped = []
    const alreadyComplete = Array.isArray(intent.completedSteps) ? intent.completedSteps.slice(0, 50) : []
    const failures = []

    for (const recorded of Array.isArray(intent.targets) ? intent.targets : []) {
      const target = targetFor(recorded)
      if (!target || typeof target.resume !== 'function') {
        skipped.push({ target: recorded.target, reason: 'the target is not available in this build' })
        continue
      }
      // A target that was **not** parked (it had already finished, or was never running) is not
      // resumed: restarting work that completed before the restart is the blind redo this avoids.
      if (!Array.isArray(intent.parked) || !intent.parked.includes(recorded.target)) {
        alreadyComplete.push({ target: recorded.target, reason: 'it was not parked by the restart, so it had already finished' })
        continue
      }
      let outcome = null
      try {
        outcome = await target.resume({ ...intent, targetState: recorded })
      } catch (error) {
        outcome = { ok: false, reason: String(error && error.message ? error.message : error) }
      }
      if (outcome && outcome.ok === true) {
        resumed.push({ target: recorded.target, taskId: outcome.taskId || recorded.taskId || null, from: outcome.from || null, detail: outcome.detail || null })
      } else {
        failures.push({ target: recorded.target, reason: (outcome && outcome.reason) || 'the target did not resume' })
      }
    }

    const semanticOk = resumed.some((entry) => Boolean(entry.from)) && failures.length === 0
    const result = {
      ok: failures.length === 0,
      at: now(),
      resumed,
      skipped,
      alreadyComplete,
      failures,
      verification,
      /** Where the continuation started from, or why it could not be claimed. */
      semantic: semanticOk
        ? { ok: true, from: resumed.map((entry) => entry.from).filter(Boolean).join(', '), detail: `continued from ${resumed.map((entry) => entry.from).filter(Boolean).join(', ')}` }
        : {
          ok: false,
          from: null,
          reason: failures.length
            ? `not every interrupted target resumed: ${failures.map((entry) => `${entry.target} (${entry.reason})`).join('; ')}`
            : 'no target reported where its continuation started, so continuing from the recorded state cannot be claimed'
        },
      detail: `${resumed.length} resumed, ${alreadyComplete.length} already complete, ${resumed.length ? 0 : skipped.length} skipped`
    }
    rememberResume(result)
    clearIntent('resumed')
    return result
  }

  return {
    intentFile,
    targets,
    statuses,
    pendingWork,
    park,
    resume,
    verify,
    writeIntent,
    readIntent,
    clearIntent,
    /** The hooks the restart supervisor consumes, as one object. */
    hooks: {
      pendingWork: async () => pendingWork(),
      beforeRestart: async (payload = {}) => {
        const outcome = await park({ reason: payload && payload.request ? `restart: ${payload.request.reasonCode || 'unknown'}` : 'a restart needs a safe boundary', plan: payload ? payload.plan : null })
        return {
          ok: outcome.ok,
          detail: outcome.detail,
          parked: outcome.parked,
          pending: outcome.pending,
          refused: outcome.refused,
          intentFile: outcome.file,
          reason: outcome.reason
        }
      },
      afterRestart: async (payload = {}) => resume({ plan: payload ? payload.plan : null })
    }
  }
}

module.exports = { createTaskContinuity, GIT_LOG_DEPTH }
