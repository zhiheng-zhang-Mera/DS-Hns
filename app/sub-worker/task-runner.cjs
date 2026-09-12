'use strict'

/**
 * Sub-worker task runner — the "minimal executor" of plan §4.2 and §36/05.
 *
 * Contract:
 *   - The runner executes an explicit specification supplied by the Controller.
 *   - It never invents goals, never re-plans the product, never widens the
 *     allowed path range and never delegates onwards.
 *   - Anything it cannot do ends as BLOCKED (or REJECTED for L3/L4) instead of
 *     an improvised workaround.
 *
 * Every operation is gated by permissions.cjs, every action emits an event, and
 * pause / note / cancel are honoured at operation boundaries — an atomic
 * operation that is already running is never cut in half (plan §15).
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const {
  RESULT_CODES,
  EXECUTION_STAGES,
  hasExecutableSpecification,
  blockedResult,
  isPlainObject
} = require('./protocol.cjs')
const permissions = require('./permissions.cjs')
const { parseTestOutput, resolveTestResult } = require('./reporter.cjs')
const { redactSecrets } = require('./event-bus.cjs')

const MAX_READ_BYTES = 512 * 1024
const MAX_LIST_ENTRIES = 400
const MAX_OUTPUT_CHARS = 200_000

class OperationError extends Error {
  constructor(code, message, { requiresController = false } = {}) {
    super(message)
    this.name = 'OperationError'
    this.code = code
    this.requiresController = requiresController
  }
}

/** Cooperative control surface owned by the runtime, injected into the runner. */
class TaskController {
  constructor({ onEvent = () => {}, now = () => Date.now() } = {}) {
    this.cancelled = false
    this.cancelReason = null
    this.paused = false
    this.pauseReason = null
    this._resumers = new Set()
    this.notes = []
    this.runtimeForbidden = []
    this.runtimeAllowed = null
    this.onEvent = onEvent
    this.now = now
    this.currentChild = null
    this.keepChanges = true
  }

  cancel(reason = 'cancelled by controller') {
    this.cancelled = true
    this.cancelReason = reason
    // "terminate child command" (plan §15 Stop): a running atomic command is
    // killed through its process tree, never left orphaned.
    if (this.currentChild?.pid) killProcessTree(this.currentChild.pid)
    this.resume('cancelled')
    return true
  }

  pause(reason = 'paused by controller') {
    this.paused = true
    this.pauseReason = reason
    return true
  }

  resume(reason = 'resumed') {
    this.paused = false
    this.pauseReason = null
    for (const resolve of [...this._resumers]) resolve(reason)
    this._resumers.clear()
    return true
  }

  /** Await at an operation boundary while paused. */
  async waitIfPaused() {
    if (!this.paused || this.cancelled) return
    await new Promise((resolve) => {
      let timer = null
      const done = (reason) => {
        this._resumers.delete(done)
        if (timer) clearTimeout(timer)
        resolve(reason)
      }
      this._resumers.add(done)
      // A pause must never be able to deadlock cancellation: re-check the
      // cancelled flag while still parked on the gate.
      timer = setInterval(() => {
        if (this.cancelled) done('cancelled')
      }, 100)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /**
   * Notes are injected at the next execution boundary (plan §15 Send Note).
   * Structured fields are honoured when present; a plain sentence is parsed for
   * the two constraints the plan's example uses.
   */
  addNote(note) {
    const entry = isPlainObject(note) ? { ...note } : { note: String(note == null ? '' : note) }
    const text = String(entry.note || '')
    // The supervisor may deliver the same note twice (once while idle, once at
    // dispatch); applying it twice would only duplicate the audit line.
    const signature = `${text}|${JSON.stringify(entry.forbid || [])}|${JSON.stringify(entry.allow || [])}`
    if (this.notes.some((existing) => existing.signature === signature)) {
      return { note: entry, effects: [], duplicate: true }
    }
    const effects = []
    const addForbidden = (pattern) => {
      const value = String(pattern || '').trim().replaceAll('\\', '/').replace(/[.,;:。；：]+$/, '')
      if (!value) return
      this.runtimeForbidden.push(value)
      effects.push(`forbidden += ${value}`)
    }
    const addAllowed = (pattern) => {
      const value = String(pattern || '').trim().replaceAll('\\', '/').replace(/[.,;:。；：]+$/, '')
      if (!value) return
      this.runtimeAllowed = this.runtimeAllowed ? [...this.runtimeAllowed, value] : [value]
      effects.push(`allowed = ${value}`)
    }

    if (Array.isArray(entry.forbid)) for (const pattern of entry.forbid) addForbidden(pattern)
    if (Array.isArray(entry.allow) && entry.allow.length) for (const pattern of entry.allow) addAllowed(pattern)

    // "Do not modify <path>." / "不要修改 <path>。"
    const forbidMatch = text.match(/(?:do not|don't|never|不要|不得|禁止)[^\n]{0,12}?(?:modify|change|touch|edit|write|修改|改动|触碰|写入)\s*([^\s,;。；]+)/i)
    if (forbidMatch) addForbidden(forbidMatch[1])

    // "Only fix <path>." / "只修改 <path>。"
    const onlyMatch = text.match(/(?:only|仅|只)[^\n]{0,12}?(?:fix|modify|change|edit|touch|修改|改动|修复)\s*([^\s,;。；]+)/i)
    if (onlyMatch) addAllowed(onlyMatch[1])

    this.notes.push({ ...entry, signature, applied: false, effects, at: new Date(this.now()).toISOString() })
    return { note: entry, effects }
  }

  /** Runtime narrowing applies on top of the Controller's task policy. */
  effectiveTask(task) {
    if (!this.runtimeForbidden.length && !this.runtimeAllowed) return task
    return {
      ...task,
      forbidden_paths: [...(task.forbidden_paths || []), ...this.runtimeForbidden],
      allowed_paths: this.runtimeAllowed ? [...(task.allowed_paths || []), ...this.runtimeAllowed] : (task.allowed_paths || [])
    }
  }
}

function resolveInsideWorkspace(workspace, relativePath) {
  const target = path.resolve(workspace, relativePath)
  const base = path.resolve(workspace)
  const withSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`
  if (target !== base && !target.startsWith(withSep)) {
    throw new OperationError(RESULT_CODES.PATH_FORBIDDEN, `path ${relativePath} escapes the workspace`)
  }
  return target
}

function truncateOutput(text) {
  const value = String(text == null ? '' : text)
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]` : value
}

/**
 * Build the environment for a delegated command.
 *
 * Node's own instrumentation variables are removed: a command must observe the
 * same reality whether or not the shell that hosts the worker was itself started
 * from a test runner, a coverage run or a debugger. Leaking them silently
 * changes how a child `node --test` reports, which would make the worker's test
 * evidence wrong.
 */
function childEnvironment(task) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'NODE_OPTIONS' || key === 'NODE_V8_COVERAGE' || key.startsWith('NODE_TEST_') || key === 'NODE_DEBUG') {
      delete env[key]
    }
  }
  // Markers so a delegated command (and the user reading a log) can see that it
  // ran inside the executor, never as the Controller.
  env.DSH_SUB_WORKER = '1'
  env.DSH_SUB_WORKER_TASK = task?.task_id || ''
  env.CI = env.CI || '1'
  env.npm_config_yes = 'true'
  return env
}

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // A command that already exited needs no cleanup.
  }
}

/**
 * The runner owns exactly one workspace for exactly one task.
 */
class TaskRunner {
  constructor({
    root,
    task,
    workspace,
    controller,
    reporter,
    bus,
    config = {},
    capabilities = undefined,
    log = () => {}
  }) {
    this.root = root
    this.task = task
    this.workspace = path.resolve(workspace)
    this.controller = controller
    this.reporter = reporter
    this.bus = bus
    this.config = config
    this.capabilities = capabilities
    this.log = log
    this.stage = null
    this.operationIndex = 0
    this.notesApplied = 0
    this.timeouts = 0
  }

  /**
   * Emit through the bus only. The reporter is a bus subscriber (wired by the
   * runtime), so recording here as well would duplicate every summary line.
   */
  emit(type, payload = {}) {
    return this.bus.emit(type, payload)
  }

  setStage(stage) {
    if (!EXECUTION_STAGES.includes(stage) || this.stage === stage) return this.stage
    const from = this.stage
    this.stage = stage
    this.bus.emit('stage_changed', { stage, previous_stage: from, summary: `Stage ${stage}` })
    return stage
  }

  async run() {
    const startedAt = new Date().toISOString()
    const task = this.task

    const guard = permissions.guardTask(task, { capabilities: this.capabilities })
    if (!guard.ok) {
      const result = blockedResult(task.task_id, {
        code: guard.code,
        reason: guard.reason,
        requires_controller: true
      })
      this.emit('blocked', { reason: guard.reason, code: guard.code, summary: guard.reason })
      return result
    }

    if (!hasExecutableSpecification(task)) {
      const reason = task.risk_level === 'L0'
        ? 'the task carries no executable command; an L0 task must specify at least one operation'
        : 'the task carries no executable specification (operations); the worker will not invent an implementation plan'
      this.emit('blocked', { reason, code: RESULT_CODES.MISSING_SPECIFICATION, summary: reason })
      return blockedResult(task.task_id, { code: RESULT_CODES.MISSING_SPECIFICATION, reason })
    }

    this.bus.emit('task_started', { objective: task.objective, risk_level: task.risk_level, workspace: this.workspace })

    let acceptanceFailed = false

    try {
      for (this.operationIndex = 0; this.operationIndex < task.operations.length; this.operationIndex += 1) {
        await this.controller.waitIfPaused()
        if (this.controller.cancelled) return this.cancelledResult(startedAt)
        this.applyPendingNotes()

        const operation = task.operations[this.operationIndex]
        const stage = stageForOperation(operation, { afterFailedTest: this.lastTestFailed() })
        if (stage) this.setStage(stage)

        try {
          await this.executeOperation(operation, { task: this.controller.effectiveTask(task) })
        } catch (error) {
          // A cancelled run reports cancellation, not the side effect of
          // killing its own command.
          if (this.controller.cancelled) return this.cancelledResult(startedAt)
          if (error instanceof OperationError) {
            if (error.requiresController) {
              this.emit('blocked', { reason: error.message, code: error.code, summary: error.message })
              return blockedResult(task.task_id, { code: error.code, reason: error.message })
            }
            this.emit('error', { summary: error.message, code: error.code, operation: operation?.op })
            return this.failedResult(startedAt, error.message, error.code)
          }
          this.emit('error', { summary: String(error?.message || error), stack: String(error?.stack || '') })
          return this.failedResult(startedAt, String(error?.message || error), RESULT_CODES.OPERATION_FAILED)
        }
      }

      // Acceptance commands are the Controller's own verification gate.
      const acceptanceResult = await this.runAcceptanceCommands()
      acceptanceFailed = acceptanceResult.failed

      // The *last* test run decides the outcome, so the documented
      // TESTING -> FIXING -> re-run flow can end green (plan §5).
      const lastTest = this.reporter.testRuns[this.reporter.testRuns.length - 1]
      const failedTest = Boolean(lastTest && Number(lastTest.failed) > 0)

      this.setStage('REPORTING')
      await this.refreshGitState()
      const status = failedTest || acceptanceFailed ? 'failed' : 'completed'
      const summary = this.buildSummary(status)
      const result = this.reporter.buildResult(task.task_id, {
        status,
        summary,
        code: status === 'completed' ? RESULT_CODES.OK : (failedTest ? RESULT_CODES.TESTS_FAILED : RESULT_CODES.ACCEPTANCE_FAILED),
        reason: status === 'completed' ? null : (failedTest ? 'the last test run reported failures' : 'an acceptance command failed'),
        needs_controller_review: true,
        needs_controller_decision: status !== 'completed',
        started_at: startedAt
      })
      this.emit(status === 'completed' ? 'task_completed' : 'task_failed', { summary, changed_files: result.changed_files })
      return result
    } finally {
      if (this.controller.cancelled) {
        this.emit('warning', { summary: `task cancelled: ${this.controller.cancelReason || 'cancelled'}` })
      }
    }
  }

  lastTestFailed() {
    const last = this.reporter.testRuns[this.reporter.testRuns.length - 1]
    return Boolean(last && Number(last.failed) > 0)
  }

  /**
   * Re-read git state at the end of the run so the Result Object reports the
   * final state of the workspace rather than the state at inspection time
   * (plan §8: `git: { dirty: true, commit: null }`).
   */
  async refreshGitState() {
    try {
      if (!fs.existsSync(path.join(this.workspace, '.git'))) return null
      if (!this.task.permissions?.shell) return null
      return await this.gitStatus()
    } catch (error) {
      this.emit('warning', { summary: `could not refresh git state: ${error?.message || error}` })
      return null
    }
  }

  applyPendingNotes() {
    const pending = this.controller.notes.filter((entry) => !entry.applied)
    for (const entry of pending) {
      entry.applied = true
      entry.applied_at = new Date().toISOString()
      entry.applied_at_operation = this.operationIndex
      this.notesApplied += 1
      this.emit('note_applied', {
        summary: entry.effects?.length ? entry.effects.join('; ') : String(entry.note || ''),
        note: String(entry.note || ''),
        effects: entry.effects || []
      })
    }
  }

  async executeOperation(rawOperation, { task }) {
    const operation = { ...rawOperation }
    const decision = permissions.checkOperation(task, operation, {
      allowGitCommit: this.config.allowGitCommit === true,
      branch: this.reporter.git.branch
    })
    if (!decision.allowed) {
      // Every policy refusal is a BLOCKED task, never an improvised workaround
      // and never a silent skip (plan §4.2): the Controller decides what to do.
      throw new OperationError(decision.code, decision.reason, { requiresController: true })
    }

    switch (operation.op) {
      case 'list_dir':
        return this.listDir(operation)
      case 'read_file':
        return this.readFile(operation)
      case 'write_file':
        return this.writeFile(operation)
      case 'replace_in_file':
        return this.replaceInFile(operation)
      case 'delete_file':
        return this.deleteFile(operation)
      case 'run_command':
        return this.runCommand(operation)
      case 'run_tests':
        return this.runTests(operation)
      case 'git_status':
        return this.gitStatus(operation)
      case 'git_diff':
        return this.gitDiff(operation)
      default:
        throw new OperationError(RESULT_CODES.NO_EXECUTABLE_OPERATION, `unknown operation: ${operation.op}`)
    }
  }

  async listDir(operation) {
    const target = resolveInsideWorkspace(this.workspace, operation.path)
    const entries = await fsp.readdir(target, { withFileTypes: true })
    const names = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`)
    this.bus.emit('inspection_started', {
      path: operation.path,
      summary: `Listed ${operation.path} (${entries.length} entries)`
    })
    return { path: operation.path, entries: names, truncated: entries.length > MAX_LIST_ENTRIES }
  }

  async readFile(operation) {
    const target = resolveInsideWorkspace(this.workspace, operation.path)
    const stat = await fsp.stat(target)
    if (stat.size > MAX_READ_BYTES && !operation.allow_large) {
      throw new OperationError(
        RESULT_CODES.OPERATION_FAILED,
        `refusing to read ${operation.path}: ${stat.size} bytes exceeds the ${MAX_READ_BYTES} byte inspection limit`
      )
    }
    const content = await fsp.readFile(target, 'utf8')
    this.emit('file_read', { path: operation.path, bytes: stat.size, summary: `Read ${operation.path}` })
    return { path: operation.path, content, bytes: stat.size }
  }

  async writeFile(operation) {
    if (typeof operation.content !== 'string') {
      throw new OperationError(RESULT_CODES.NO_EXECUTABLE_OPERATION, `write_file ${operation.path} requires a string content`)
    }
    const target = resolveInsideWorkspace(this.workspace, operation.path)
    const existed = fs.existsSync(target)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, operation.content, 'utf8')
    this.emit('file_write', {
      path: operation.path,
      op: existed ? 'update' : 'create',
      bytes: Buffer.byteLength(operation.content, 'utf8'),
      summary: `${existed ? 'Updated' : 'Created'} ${operation.path}`
    })
    return { path: operation.path, created: !existed }
  }

  async replaceInFile(operation) {
    if (typeof operation.find !== 'string' || typeof operation.replace !== 'string') {
      throw new OperationError(RESULT_CODES.NO_EXECUTABLE_OPERATION, `replace_in_file ${operation.path} requires find/replace strings`)
    }
    const target = resolveInsideWorkspace(this.workspace, operation.path)
    const before = await fsp.readFile(target, 'utf8')
    const occurrences = before.split(operation.find).length - 1
    if (occurrences === 0) {
      throw new OperationError(RESULT_CODES.OPERATION_FAILED, `replace_in_file ${operation.path}: the find string was not present`)
    }
    if (operation.expect_occurrences != null && Number(operation.expect_occurrences) !== occurrences) {
      throw new OperationError(
        RESULT_CODES.OPERATION_FAILED,
        `replace_in_file ${operation.path}: expected ${operation.expect_occurrences} occurrence(s), found ${occurrences}`
      )
    }
    const after = before.split(operation.find).join(operation.replace)
    await fsp.writeFile(target, after, 'utf8')
    this.emit('file_write', {
      path: operation.path,
      op: 'update',
      occurrences,
      summary: `Patched ${operation.path} (${occurrences} occurrence(s))`
    })
    return { path: operation.path, occurrences }
  }

  async deleteFile(operation) {
    const target = resolveInsideWorkspace(this.workspace, operation.path)
    if (!fs.existsSync(target)) {
      throw new OperationError(RESULT_CODES.OPERATION_FAILED, `delete_file ${operation.path}: the file does not exist`)
    }
    await fsp.rm(target, { force: true })
    this.emit('file_delete', { path: operation.path, summary: `Deleted ${operation.path}` })
    return { path: operation.path }
  }

  /**
   * Launch one command, stream its output as events, allow cancellation and
   * enforce the configured timeout.
   */
  runShell(command, { phase = 'IMPLEMENTING', timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const limit = Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : Number(this.config.commandTimeoutMs) || 0
      let stdout = ''
      let stderr = ''
      let timedOut = false

      const child = spawn(command, {
        cwd: this.workspace,
        shell: true,
        windowsHide: true,
        env: childEnvironment(this.task),
        stdio: ['ignore', 'pipe', 'pipe']
      })

      this.controller.currentChild = child
      const timer = limit
        ? setTimeout(() => {
          timedOut = true
          killProcessTree(child.pid)
        }, limit)
        : null

      const pump = (stream, sink) => {
        stream.on('data', (chunk) => {
          const text = chunk.toString()
          if (sink === 'stdout') stdout += text
          else stderr += text
          this.bus.emit('command_output', { command, stream: sink, text: redactSecrets(text) })
        })
      }
      pump(child.stdout, 'stdout')
      pump(child.stderr, 'stderr')

      const finish = (code, error) => {
        if (timer) clearTimeout(timer)
        this.controller.currentChild = null
        if (timedOut) this.timeouts += 1
        const durationMs = Date.now() - startedAt
        if (error) {
          const message = `command failed to start: ${error.message || error}`
          this.emit('error', { summary: message, command, phase })
          reject(new OperationError(RESULT_CODES.OPERATION_FAILED, message))
          return
        }
        this.emit('command_finished', {
          command,
          exitCode: code,
          durationMs,
          timedOut,
          summary: `${command} exited ${code}${timedOut ? ' (timeout)' : ''}`
        })
        resolve({ code, stdout: truncateOutput(stdout), stderr: truncateOutput(stderr), durationMs, timedOut })
      }

      child.once('error', (error) => finish(null, error))
      child.once('close', (code) => finish(code == null ? -1 : code, null))
    })
  }

  async runCommand(operation) {
    const command = String(operation.command || '')
    const phase = String(operation.phase || 'IMPLEMENTING').toUpperCase()
    this.emit('command_started', { command, phase, summary: `Running ${command}` })
    const outcome = await this.runShell(command, { timeoutMs: operation.timeoutMs })
    if (outcome.timedOut) {
      throw new OperationError(RESULT_CODES.TIMEOUT, `command timed out: ${command}`)
    }
    if (outcome.code !== 0 && operation.allow_failure !== true) {
      throw new OperationError(RESULT_CODES.OPERATION_FAILED, `command exited ${outcome.code}: ${command}`)
    }
    return outcome
  }

  async runTests(operation) {
    const command = String(operation.command || '')
    this.emit('test_started', { command, summary: `Running tests: ${command}` })
    const outcome = await this.runShell(command, { timeoutMs: operation.timeoutMs, phase: 'TESTING' })
    const combined = `${outcome.stdout}\n${outcome.stderr}`
    const counts = resolveTestResult(parseTestOutput(combined), outcome.code)
    this.emit('test_result', {
      command,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      parser: counts.parser,
      inferred: Boolean(counts.inferred),
      exitCode: outcome.code,
      summary: counts.inferred
        ? `test command exited ${outcome.code}`
        : `${counts.passed} passed / ${counts.failed} failed`
    })
    // A failing test run is an observation, not an executor crash: the run
    // continues so a following FIXING operation can repair it, and the last
    // test run decides the task outcome.
    if (counts.failed > 0 || (counts.inferred && outcome.code !== 0)) {
      const message = `test command exited ${outcome.code}: ${command}`
      this.emit('warning', { summary: message })
    }
    return { ...outcome, counts }
  }

  async gitStatus() {
    const outcome = await this.runShell('git status --porcelain=v1', { timeoutMs: 60_000 })
    const branchOutcome = await this.runShell('git rev-parse --abbrev-ref HEAD', { timeoutMs: 60_000 })
    const branch = branchOutcome.code === 0 ? branchOutcome.stdout.trim().split(/\r?\n/).pop() : null
    const commitOutcome = await this.runShell('git rev-parse HEAD', { timeoutMs: 60_000 })
    const commit = commitOutcome.code === 0 ? commitOutcome.stdout.trim().split(/\r?\n/).pop() : null
    const dirty = outcome.stdout.trim().length > 0
    this.emit('git_status', {
      dirty,
      branch,
      commit,
      summary: `Git status: ${branch || 'detached'}${dirty ? ' (dirty)' : ' (clean)'}`
    })
    return { dirty, branch, commit, porcelain: outcome.stdout }
  }

  async gitDiff() {
    const outcome = await this.runShell('git diff --stat', { timeoutMs: 60_000 })
    const files = outcome.stdout.trim() ? outcome.stdout.trim().split(/\r?\n/).length : 0
    this.emit('diff_generated', { files, summary: `Diff generated for ${files} file(s)` })
    return { stat: outcome.stdout, files }
  }

  async runAcceptanceCommands() {
    const commands = Array.isArray(this.task.acceptance_commands) ? this.task.acceptance_commands : []
    const entries = []
    let failed = false
    if (!commands.length) {
      for (const criterion of Array.isArray(this.task.acceptance) ? this.task.acceptance : []) {
        entries.push({ criterion: String(criterion), status: 'manual_review', verified: false })
      }
      this.reporter.recordAcceptance(entries)
      if (entries.length) {
        this.emit('warning', {
          summary: `${entries.length} acceptance criterion/criteria have no automated command; the Controller must review them`
        })
      }
      return { failed: false, entries }
    }

    this.setStage('VALIDATING')
    for (const command of commands) {
      const decision = permissions.checkCommand(this.controller.effectiveTask(this.task), command, {
        allowGitCommit: this.config.allowGitCommit === true,
        branch: this.reporter.git.branch
      })
      if (!decision.allowed) {
        entries.push({ criterion: `acceptance command: ${command}`, status: 'denied', verified: false, reason: decision.reason })
        failed = true
        continue
      }
      this.emit('command_started', { command, phase: 'VALIDATING', summary: `Verifying: ${command}` })
      const outcome = await this.runShell(command, { phase: 'VALIDATING' })
      const ok = outcome.code === 0
      if (!ok) failed = true
      entries.push({
        criterion: `acceptance command: ${command}`,
        status: ok ? 'passed' : 'failed',
        verified: true,
        exitCode: outcome.code
      })
    }
    this.reporter.recordAcceptance(entries)
    return { failed, entries }
  }

  cancelledResult(startedAt) {
    const summary = `Task cancelled: ${this.controller.cancelReason || 'cancelled by controller'}`
    const result = this.reporter.buildResult(this.task.task_id, {
      status: 'cancelled',
      summary,
      code: RESULT_CODES.CANCELLED,
      reason: summary,
      needs_controller_review: false,
      needs_controller_decision: true,
      started_at: startedAt
    })
    this.emit('task_failed', { summary, cancelled: true })
    return result
  }

  failedResult(startedAt, message, code) {
    const result = this.reporter.buildResult(this.task.task_id, {
      status: 'failed',
      summary: message,
      code: code || RESULT_CODES.OPERATION_FAILED,
      reason: message,
      needs_controller_review: true,
      needs_controller_decision: true,
      started_at: startedAt
    })
    this.emit('task_failed', { summary: message })
    return result
  }

  buildSummary(status) {
    const changed = this.reporter.changedFiles.size
    const tests = this.reporter.tests
    const parts = [
      status === 'completed'
        ? `Executed ${this.task.operations.length} operation(s) for "${this.task.objective}".`
        : `Task finished with status ${status} for "${this.task.objective}".`,
      changed ? `${changed} file(s) changed.` : 'No files were changed.',
      tests.parser ? `Tests: ${tests.passed} passed / ${tests.failed} failed.` : 'No test command was run.'
    ]
    if (this.timeouts) parts.push(`${this.timeouts} command(s) hit the timeout.`)
    return parts.join(' ')
  }
}

/**
 * Map an operation onto the documented execution stage. A modification that
 * follows a failing test run is a FIXING step, not a fresh implementation.
 */
function stageForOperation(operation, { afterFailedTest = false } = {}) {
  switch (operation?.op) {
    case 'list_dir':
    case 'read_file':
    case 'git_status':
      return 'INSPECTING'
    case 'git_diff':
      return 'PLANNING_EXECUTION'
    case 'write_file':
    case 'replace_in_file':
    case 'delete_file':
      return afterFailedTest ? 'FIXING' : 'IMPLEMENTING'
    case 'run_command':
      return afterFailedTest ? 'FIXING' : 'IMPLEMENTING'
    case 'run_tests':
      return 'TESTING'
    default:
      return null
  }
}

module.exports = {
  TaskController,
  TaskRunner,
  OperationError,
  stageForOperation,
  resolveInsideWorkspace,
  killProcessTree,
  MAX_READ_BYTES
}
