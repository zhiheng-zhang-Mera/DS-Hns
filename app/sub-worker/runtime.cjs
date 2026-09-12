'use strict'

/**
 * Sub-worker runtime — the executor process (plan §6).
 *
 * This file is the ONLY thing the WorkerManager spawns. It is plain Node: no
 * Electron, no second GUI, no second Mega. It speaks the structured protocol
 * over stdio, executes exactly the task it was handed, and reports structured
 * results. It has no authority to change goals, widen its own permissions or
 * decide what to do next.
 *
 * Failure isolation (plan §24): every failure path is contained here. The
 * parent observes at most a non-zero exit plus a structured error, so a worker
 * crash can never take down the Harness.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const protocol = require('./protocol.cjs')
const permissions = require('./permissions.cjs')
const { SubWorkerStore, publicConfig } = require('./state.cjs')
const { EventBus } = require('./event-bus.cjs')
const { isPlainObject } = require('./protocol.cjs')
const { Reporter, createRuntimeLogger } = require('./reporter.cjs')
const { TaskController, TaskRunner } = require('./task-runner.cjs')

function parseArgs(argv) {
  const args = { root: null, workerId: null, role: null }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--root' && argv[i + 1]) args.root = argv[i + 1]
    else if (token === '--worker-id' && argv[i + 1]) args.workerId = argv[i + 1]
    else if (token === '--role' && argv[i + 1]) args.role = argv[i + 1]
    else if (token.startsWith('--root=')) args.root = token.slice('--root='.length)
    else if (token.startsWith('--worker-id=')) args.workerId = token.slice('--worker-id='.length)
    else if (token.startsWith('--role=')) args.role = token.slice('--role='.length)
  }
  return args
}

const ARGS = parseArgs(process.argv.slice(2))
const ROOT = path.resolve(ARGS.root || process.env.DSH_ROOT || path.join(__dirname, '..', '..'))
const WORKER_ID = ARGS.workerId || process.env.DSH_SUB_WORKER_ID || 'sub-1'
/**
 * Worker role (plan §14). Phase 1 shares one implementation and only varies the
 * role/profile/capability; a specialized process can be introduced later
 * without changing the protocol.
 */
const WORKER_ROLE = ARGS.role || process.env.DSH_SUB_WORKER_ROLE || 'generic'

const store = new SubWorkerStore({ root: ROOT })
const runtimeLog = createRuntimeLogger(ROOT)
const log = (message) => runtimeLog(`[worker:${WORKER_ID}] ${message}`)

const state = {
  state: 'STARTING',
  stage: null,
  workerId: WORKER_ID,
  role: WORKER_ROLE,
  taskId: null,
  objective: null,
  startedAt: null,
  shuttingDown: false,
  currentTask: null,
  currentPackage: null,
  // A task is being executed right now. Control messages must be able to reach
  // the running task, so they are never queued behind it.
  taskInFlight: false,
  taskSequence: 0,
  pauseRequested: false,
  stopRequested: false,
  stopReason: null,
  pauseReason: null,
  // Notes that arrived while the worker was idle: they apply to the next task
  // (plan §15 - a note is never dropped).
  idleNotes: [],
  /**
   * Liveness telemetry (plan §32, §33). A supervisor cannot judge a hang from
   * elapsed time alone, so the worker reports independent signals: CPU time it
   * actually consumed, resident memory, whether a subprocess is running, and
   * the timestamps of its last output and last file change.
   */
  telemetry: {
    cpu_ms: 0,
    rss_mb: 0,
    peak_rss_mb: 0,
    active_child: false,
    output_seq: 0,
    file_change_seq: 0,
    last_output_at: Date.now(),
    last_file_change_at: Date.now()
  },
  bootCpu: process.cpuUsage()
}

const reporter = new Reporter({ root: ROOT })
let bus = null
let controller = null
let heartbeatTimer = null

function send(type, payload = {}, extra = {}) {
  try {
    process.stdout.write(protocol.encode(protocol.envelope(type, payload, extra)))
    return true
  } catch (error) {
    log(`failed to write ${type}: ${error?.message || error}`)
    return false
  }
}

function emitState(nextState, { stage = state.stage, extra = {} } = {}) {
  state.state = nextState
  if (stage !== undefined) state.stage = stage
  send('state', {
    worker_id: WORKER_ID,
    state: nextState,
    stage: state.stage,
    task_id: state.taskId,
    at: new Date().toISOString(),
    ...extra
  })
  log(`state=${nextState}${state.stage ? ` stage=${state.stage}` : ''}${state.taskId ? ` task=${state.taskId}` : ''}`)
  return nextState
}

function emitStage(stage) {
  state.stage = stage
  send('stage', {
    worker_id: WORKER_ID,
    stage,
    task_id: state.taskId,
    at: new Date().toISOString()
  })
}

/** The transport half of the observability bus: every event goes to the parent. */
function transportEvent(event) {
  send('event', { event })
}

function makeBus(taskId) {
  const instance = new EventBus({
    taskId,
    onEvent: transportEvent
  })
  // One subscriber, wired once: the reporter is the single projector from the
  // raw event stream onto the auditable summary.
  instance.subscribe((event) => reporter.record(event))
  // A second, cheap subscriber keeps the liveness telemetry current (§33).
  instance.subscribe((event) => noteTelemetryEvent(event))
  return instance
}

/** Update the liveness signals the supervisor watches for a hang. */
function noteTelemetryEvent(event) {
  const telemetry = state.telemetry
  switch (event?.type) {
    case 'command_output':
      telemetry.output_seq += 1
      telemetry.last_output_at = Date.now()
      break
    case 'command_started':
      telemetry.active_child = true
      break
    case 'command_finished':
      telemetry.active_child = false
      telemetry.output_seq += 1
      telemetry.last_output_at = Date.now()
      break
    case 'file_write':
    case 'file_delete':
      telemetry.file_change_seq += 1
      telemetry.last_file_change_at = Date.now()
      break
    case 'file_read':
    case 'inspection_started':
    case 'test_started':
    case 'test_result':
    case 'git_status':
    case 'diff_generated':
      telemetry.last_output_at = Date.now()
      break
    default:
      break
  }
}

/** Snapshot the telemetry, refreshing the OS-reported numbers. */
function telemetrySnapshot() {
  const telemetry = state.telemetry
  const usage = process.cpuUsage(state.bootCpu)
  telemetry.cpu_ms = Math.round((Number(usage.user) + Number(usage.system)) / 1000)
  const memory = process.memoryUsage()
  telemetry.rss_mb = Math.round(Number(memory.rss) / (1024 * 1024))
  telemetry.peak_rss_mb = Math.max(Number(telemetry.peak_rss_mb) || 0, telemetry.rss_mb)
  return {
    worker_id: WORKER_ID,
    role: state.role,
    state: state.state,
    stage: state.stage,
    task_id: state.taskId,
    node_id: state.currentPackage?.node_id || null,
    cpu_ms: telemetry.cpu_ms,
    rss_mb: telemetry.rss_mb,
    peak_rss_mb: telemetry.peak_rss_mb,
    active_child: telemetry.active_child,
    output_seq: telemetry.output_seq,
    file_change_seq: telemetry.file_change_seq,
    last_output_at: telemetry.last_output_at,
    last_file_change_at: telemetry.last_file_change_at,
    uptime_ms: Math.round(process.uptime() * 1000)
  }
}

function startHeartbeat() {
  const intervalMs = publicConfig(store.loadConfig()).heartbeatMs
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    // §32: state, task, CPU, RAM, elapsed time and last progress time.
    send('heartbeat', telemetrySnapshot())
  }, intervalMs)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
}

function resolveWorkspace(task) {
  const candidate = task.workspace ? path.resolve(String(task.workspace)) : path.join(ROOT, 'workspace', 'sub-worker', task.task_id)
  fs.mkdirSync(candidate, { recursive: true })
  return candidate
}

/**
 * Discard work when configuration says stopped work must not be kept.
 *
 * This is scoped to Stop/cancel (plan §15 `keep_changes_on_stop`): a task that
 * ran to completion is always kept, because its changes are the deliverable the
 * Controller is about to review. A shared workspace is never touched: the
 * Controller owns it and the worker will not risk unrelated edits.
 */
function revertIfRequired(task, workspace, config, status = 'cancelled') {
  if (config.keepChangesOnStop !== false) return { reverted: false, reason: 'keepChangesOnStop=true' }
  if (status === 'completed') return { reverted: false, reason: 'completed work is kept for Controller review' }
  if (task.workspace_mode !== 'isolated_worktree') {
    return { reverted: false, reason: 'shared workspace is never reverted by the worker' }
  }
  const result = spawnSync('git', ['checkout', '--', '.'], { cwd: workspace, windowsHide: true, timeout: 60_000 })
  return { reverted: result.status === 0, reason: result.status === 0 ? 'worktree reverted' : 'git checkout failed' }
}

/**
 * States in which the worker may accept the next task.
 *
 * BLOCKED/FAILED/READY_FOR_REVIEW are *task* outcomes: the Controller's next
 * decision arrives as a new task, so the worker must accept it. PAUSED and the
 * RUNNING family must not accept work.
 */
const TASK_ACCEPTING_STATES = Object.freeze(['STARTING', 'IDLE', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED'])

function canAcceptTask() {
  return !state.taskInFlight && !state.currentTask && TASK_ACCEPTING_STATES.includes(state.state)
}

async function handleAssignTask(message) {
  const payload = message.payload || {}
  const rawTask = payload.task
  const validation = protocol.validateTask(rawTask)

  if (state.state === 'HANDOFF') {
    const result = protocol.blockedResult(protocol.sanitizeTaskId(rawTask?.task_id) || 'unknown', {
      code: protocol.RESULT_CODES.BLOCKED,
      reason: 'the worker handed the workspace over to the Controller; restart it before dispatching work'
    })
    send('result', { result }, { task_id: result.task_id })
    return result
  }

  if (!canAcceptTask()) {
    const result = protocol.blockedResult(protocol.sanitizeTaskId(rawTask?.task_id) || 'unknown', {
      code: protocol.RESULT_CODES.BLOCKED,
      reason: `worker ${WORKER_ID} is not accepting work (state ${state.state}${state.taskId ? `, task ${state.taskId}` : ''})`
    })
    send('result', { result }, { task_id: result.task_id })
    return result
  }

  if (!validation.ok) {
    const taskId = protocol.sanitizeTaskId(rawTask?.task_id) || 'invalid-task'
    const result = protocol.blockedResult(taskId, {
      code: protocol.RESULT_CODES.TASK_REJECTED,
      reason: `invalid task object: ${validation.errors.join('; ')}`
    })
    send('error', { code: protocol.RESULT_CODES.TASK_REJECTED, message: result.reason, task_id: taskId })
    send('result', { result }, { task_id: taskId })
    return result
  }

  const task = validation.task
  const config = store.loadConfig()
  state.taskInFlight = true
  state.taskSequence += 1
  state.taskId = task.task_id
  state.objective = task.objective
  state.startedAt = new Date().toISOString()
  state.currentTask = task
  // The Worker Task Package (plan §21) travels alongside the Task Object: it
  // carries the goal, scope, constraints and timeout the Controller bounded this
  // node with. The executor's own guard already enforces write_scope and
  // read_only_files, because the supervisor folds them into the task.
  state.currentPackage = isPlainObject(payload.package) ? payload.package : null

  reporter.reset(task.task_id)
  bus = makeBus(task.task_id)
  controller = new TaskController()

  // Notes that arrived while the worker was idle are injected before the first
  // execution boundary of this task.
  const queued = state.idleNotes.splice(0)
  for (const note of queued) controller.addNote(note)

  // A Pause or Stop that arrived while the task was still being admitted is
  // honoured immediately instead of being lost.
  if (state.stopRequested) {
    state.stopRequested = false
    controller.cancel(state.stopReason || 'stopped before the task started')
  } else if (state.pauseRequested) {
    state.pauseRequested = false
    controller.pause(state.pauseReason || 'paused before the task started')
  }

  emitState('ASSIGNED', { stage: null, extra: { objective: task.objective, risk_level: task.risk_level } })
  bus.emit('task_received', {
    objective: task.objective,
    risk_level: task.risk_level,
    allowed_paths: task.allowed_paths,
    forbidden_paths: task.forbidden_paths,
    operations: task.operations.length,
    notes: queued.length,
    summary: `Task received: ${task.objective}`
  })

  let workspace
  try {
    workspace = resolveWorkspace(task)
  } catch (error) {
    const result = protocol.blockedResult(task.task_id, {
      code: protocol.RESULT_CODES.OPERATION_FAILED,
      reason: `workspace unavailable: ${error?.message || error}`
    })
    state.currentTask = null
    state.taskId = null
    emitState('IDLE', { stage: null })
    send('result', { result }, { task_id: task.task_id })
    return result
  }

  emitState('RUNNING', { stage: 'INSPECTING' })

  let result
  try {
    const runner = new TaskRunner({
      root: ROOT,
      task,
      workspace,
      controller,
      reporter,
      bus,
      config,
      log
    })
    const unsubscribe = bus.subscribe((event) => {
      if (event.type === 'stage_changed' && event.stage) emitStage(event.stage)
    })
    try {
      result = await runner.run()
    } finally {
      unsubscribe()
    }
  } catch (error) {
    log(`task ${task.task_id} threw: ${error?.stack || error}`)
    result = protocol.createResult(task.task_id, {
      status: 'failed',
      summary: `executor crashed: ${error?.message || error}`,
      code: protocol.RESULT_CODES.OPERATION_FAILED,
      reason: String(error?.message || error)
    })
    send('error', {
      code: protocol.RESULT_CODES.OPERATION_FAILED,
      message: String(error?.message || error),
      task_id: task.task_id
    })
  }

  const revert = revertIfRequired(task, workspace, config, result.status)
  if (revert.reverted || /failed|reverted/.test(revert.reason)) {
    result.warnings.push(`revert: ${revert.reason}`)
  }
  result.workspace = workspace
  result.worker_id = WORKER_ID
  result.worker_role = state.role
  // §38/§40: the supervisor learns each role's real cost from these numbers
  // instead of trusting the seed profile forever.
  result.resource_usage = telemetrySnapshot()

  // Persistence of `data/sub-worker/**` belongs to the WorkerManager alone: a
  // single writer keeps the queue, history and task records race-free. The
  // runtime's durable output is its log files plus this result message.
  send('result', { result, live_view: reporter.describe() }, { task_id: task.task_id })
  log(`task ${task.task_id} -> ${result.status} (${result.code})`)

  state.currentTask = null
  state.currentPackage = null
  state.taskId = null
  state.objective = null
  state.startedAt = null
  state.taskInFlight = false
  state.pauseRequested = false
  state.stopRequested = false
  state.telemetry.active_child = false
  bus = null
  controller = null
  emitState(result.status === 'completed' ? 'READY_FOR_REVIEW' : (result.status === 'blocked' ? 'BLOCKED' : (result.status === 'cancelled' ? 'IDLE' : 'FAILED')), { stage: null })
  return result
}

function handlePause(message) {
  const reason = message?.payload?.reason || 'paused by controller'
  if (!controller) {
    if (state.taskInFlight) {
      // The task is still being admitted: remember the request so it is applied
      // the moment the controller exists (plan §15).
      state.pauseRequested = true
      state.pauseReason = reason
      send('log', { level: 'info', message: 'pause will apply before the task starts' })
      return { ok: true, deferred: true }
    }
    emitState('PAUSED', { extra: { reason: 'no task running' } })
    send('log', { level: 'info', message: 'pause acknowledged while idle' })
    return { ok: true, idle: true }
  }
  controller.pause(reason)
  emitState('PAUSING')
  // The pause becomes real at the next operation boundary, so it is announced
  // as PAUSED once the current atomic step has settled.
  setTimeout(() => {
    if (state.state === 'PAUSING') emitState('PAUSED')
  }, 0).unref?.()
  return { ok: true }
}

function handleResume() {
  if (!controller) {
    if (state.taskInFlight) {
      state.pauseRequested = false
      send('log', { level: 'info', message: 'pause request withdrawn before the task started' })
      return { ok: true, deferred: true }
    }
    emitState('IDLE')
    return { ok: true, idle: true }
  }
  controller.resume('resumed by controller')
  emitState('RUNNING')
  return { ok: true }
}

function handleStopTask(message) {
  const reason = message?.payload?.reason || 'stopped by controller'
  if (!controller) {
    if (state.taskInFlight) {
      state.stopRequested = true
      state.stopReason = reason
      send('log', { level: 'info', message: 'stop will apply before the task starts' })
      return { ok: true, deferred: true }
    }
    send('log', { level: 'info', message: 'stop requested while idle' })
    return { ok: true, idle: true }
  }
  // Cancelling a *task* is not the worker stop sequence: the worker stays alive
  // and keeps accepting work, so its lifecycle state must not become STOPPING.
  controller.cancel(reason)
  send('log', { level: 'info', message: `task cancel requested: ${reason}` })
  return { ok: true }
}

function handleNote(message) {
  const note = message?.payload?.note
  if (!controller) {
    // The note is never dropped: it is queued and injected before the first
    // execution boundary of the next task. A plain sentence and a structured
    // {note, forbid, allow} object are both accepted.
    const hasContent = typeof note === 'string'
      ? note.trim().length > 0
      : Boolean(note && (note.note || note.forbid || note.allow))
    if (hasContent) state.idleNotes.push(note)
    send('note_applied', {
      note: typeof note === 'string' ? note : String(note?.note || ''),
      applied: false,
      queued: hasContent,
      at: Date.now(),
      effects: hasContent ? ['queued while idle; it will apply to the next task'] : ['the note carried no content']
    })
    return { ok: true, idle: true, queued: state.idleNotes.length }
  }
  const { effects } = controller.addNote(note)
  send('log', { level: 'info', message: `note queued for the next execution boundary (${effects.join('; ') || 'informational'})` })
  return { ok: true, effects }
}

function handleTakeOver() {
  if (controller) controller.pause('workspace handover')
  if (state.state !== 'HANDOFF') emitState('HANDOFF', { extra: { reason: 'workspace handed to the Controller' } })
  const handoff = {
    worker_id: WORKER_ID,
    task_id: state.taskId,
    state: 'HANDOFF',
    at: new Date().toISOString(),
    live_view: reporter.describe()
  }
  send('log', { level: 'info', message: 'workspace handover acknowledged; the Controller owns the workspace from now on' })
  return handoff
}

function handleShutdown(message) {
  state.shuttingDown = true
  if (controller) controller.cancel(message?.payload?.reason || 'runtime shutdown')
  send('bye', { worker_id: WORKER_ID, reason: String(message?.payload?.reason || 'shutdown'), at: Date.now() })
  log('shutdown requested')
  return { ok: true }
}

const HANDLERS = {
  hello: () => ({ worker_id: WORKER_ID, root: ROOT, capabilities: protocol.CAPABILITIES, protocol: protocol.PROTOCOL_VERSION }),
  assign_task: handleAssignTask,
  pause: handlePause,
  resume: handleResume,
  stop_task: handleStopTask,
  note: handleNote,
  take_over: handleTakeOver,
  shutdown: handleShutdown,
  ping: (message) => ({ at: message?.payload?.at || null, now: Date.now() })
}

async function handleMessage(message) {
  const validation = protocol.validateMessage(message, 'controller-to-worker')
  if (!validation.ok) {
    send('error', { code: protocol.RESULT_CODES.INVALID_MESSAGE, message: validation.error })
    return
  }
  const type = message.type
  if (type === 'ping') {
    send('pong', { echo: message.payload })
    return
  }
  const handler = HANDLERS[type]
  if (!handler) {
    send('error', { code: protocol.RESULT_CODES.INVALID_MESSAGE, message: `no handler for ${type}` })
    return
  }
  try {
    const outcome = await handler(message)
    if (type === 'take_over') {
      send('state', { worker_id: WORKER_ID, state: 'HANDOFF', stage: null, task_id: state.taskId, handoff: outcome })
    }
    if (type === 'shutdown') {
      flushAndExit(0)
    }
  } catch (error) {
    log(`handler ${type} failed: ${error?.stack || error}`)
    send('error', { code: protocol.RESULT_CODES.OPERATION_FAILED, message: String(error?.message || error) })
  }
}

/**
 * Message loop.
 *
 * `assign_task` is exclusive and long-running, so it is serialized. Every other
 * message is a control message (pause / resume / stop_task / note / take_over /
 * shutdown / ping) and MUST be handled immediately: queuing them behind a
 * running task would make Pause, Stop and Send Note useless exactly when the
 * user needs them, which is while the worker is busy.
 */
let taskChain = Promise.resolve()
function enqueue(message) {
  const type = message?.type
  if (type === 'assign_task') {
    taskChain = taskChain.then(() => handleMessage(message)).catch((error) => {
      log(`task loop error: ${error?.stack || error}`)
    })
    return taskChain
  }
  return Promise.resolve()
    .then(() => handleMessage(message))
    .catch((error) => log(`message loop error: ${error?.stack || error}`))
}

/**
 * Exit without truncating the pipe: a final `result`/`error`/`bye` message must
 * reach the Controller even on the crash path, so the exit waits for stdout to
 * drain (bounded, so a wedged pipe can never keep the worker alive).
 */
function flushAndExit(code) {
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  } catch {}
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    process.exit(code)
  }
  // Hard ceiling: never hang on a stalled stdout.
  const ceiling = setTimeout(finish, 1000)
  if (typeof ceiling.unref === 'function') ceiling.unref()
  try {
    if (process.stdout.writableLength === 0) setTimeout(finish, 10)
    else process.stdout.write('', () => setTimeout(finish, 10))
  } catch {
    setTimeout(finish, 10)
  }
}

function main() {
  store.ensureDirs()
  const config = store.loadConfig()
  state.config = config
  log(`runtime start pid=${process.pid} root=${ROOT} worker=${WORKER_ID}`)

  const decoder = new protocol.LineDecoder()
  process.stdin.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) enqueue(message)
    for (const error of decoder.errors.splice(0)) send('error', { code: protocol.RESULT_CODES.INVALID_MESSAGE, message: error })
  })
  process.stdin.on('end', () => {
    log('stdin closed; exiting')
    flushAndExit(0)
  })
  process.stdin.on('error', (error) => log(`stdin error: ${error?.message || error}`))
  process.stdin.resume()

  emitState('IDLE', { stage: null })
  send('ready', {
    worker_id: WORKER_ID,
    role: WORKER_ROLE,
    pid: process.pid,
    root: ROOT,
    capabilities: protocol.CAPABILITIES,
    protocol: protocol.PROTOCOL_VERSION,
    config
  })
  startHeartbeat()
}

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error?.stack || error}`)
  try {
    send('error', { code: protocol.RESULT_CODES.CRASHED, message: String(error?.message || error) })
    emitState('CRASHED')
  } catch {}
  flushAndExit(1)
})

process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error?.stack || error}`)
  try {
    send('error', { code: protocol.RESULT_CODES.CRASHED, message: String(error?.message || error) })
    emitState('CRASHED')
  } catch {}
  flushAndExit(1)
})

if (require.main === module) main()

module.exports = {
  parseArgs,
  WORKER_ID,
  ROOT,
  HANDLERS,
  handleMessage,
  state,
  revertIfRequired
}
