/**
 * The restart companion: a process plugin that owns the restart logic DS-Hns must not have.
 *
 * This is the acceptance companion for `ProcessPluginAdapter`. It is deliberately an *external*
 * program: DS-Hns starts it, watches it, talks to it over the declared protocol, and stops it —
 * and DS-Hns contains none of what it does.
 *
 * ## What lives here, and why it is here rather than in HNS
 *
 * Everything that knows what "restart" means: how to wait for the application to leave, how to
 * bring it back, how to break a crash loop. DS-Hns's side is a capability bridge and nothing else —
 * it sends `invoke restart-control <method>` and gets an answer.
 *
 * The actual supervising is *not* reimplemented here either: this program drives the real
 * `dsh-restart-supervisor`, which does the waiting and the relaunching. What the companion adds is
 * the protocol half — reading that supervisor's own state files and turning them into answers.
 *
 * ## The protocol it speaks
 *
 * `dshns.process/v1` on stdio (see `app/core/plugin-adapters/process/contract.cjs`): newline
 * delimited JSON out on stdout, in on stdin. Nothing else is ever written to stdout, so a stray
 * `console.log` here would be a malformed frame — which is the contract's whole point.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const stateDir = process.env.DSHNS_STATE_DIR
const supervisorEntry = process.env.DSHNS_SUPERVISOR_ENTRY
const watchPid = Number(process.env.DSHNS_WATCH_PID || 0)
const launch = JSON.parse(process.env.DSHNS_LAUNCH || '[]')
const tickMs = Number(process.env.DSHNS_TICK_MS || 200)

let supervisor = null
let stopped = false
let lastSupervisorExit = null

/** The companion's own knowledge of the restart protocol: it reads the supervisor's real files. */
function supervisionState() {
  const heartbeat = readJson(path.join(stateDir, 'heartbeat.json'))
  const ledger = readJson(path.join(stateDir, 'ledger.json'))
  return {
    supervisorPid: supervisor ? supervisor.pid : null,
    supervisorAlive: Boolean(supervisor && supervisor.exitCode === null),
    watchedPid: heartbeat ? heartbeat.watchedPid : watchPid,
    phase: heartbeat ? heartbeat.state : 'UNKNOWN',
    sequence: heartbeat ? heartbeat.sequence : 0,
    heartbeatAt: heartbeat ? heartbeat.timestamp : null,
    relaunches: ledger && Number.isFinite(ledger.relaunches) ? ledger.relaunches : 0,
    uncleanStarts: ledger && Array.isArray(ledger.uncleanStarts) ? ledger.uncleanStarts.length : 0,
    safeMode: Boolean(ledger && ledger.safeMode),
    safeModeReason: ledger ? ledger.safeModeReason : null,
    lastSupervisorExit
  }
}

function startSupervisor() {
  const args = ['--state', stateDir, '--pid', String(watchPid), '--tick-ms', String(tickMs)]
  if (launch.length) args.push('--', ...launch)
  supervisor = spawn(process.execPath, [supervisorEntry, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  // The supervisor writes JSONL to stderr; it is a log channel here, never protocol.
  if (supervisor.stderr) supervisor.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) send({ kind: 'log', stream: 'stderr', line: line.slice(0, 400) })
    }
  })
  supervisor.once('exit', (code, signal) => {
    lastSupervisorExit = { code, signal, at: new Date().toISOString() }
    send({ kind: 'log', line: `supervisor exited code=${code}${signal ? ` signal=${signal}` : ''}` })
  })
}

/**
 * The business end: ask the application to leave.
 *
 * This is the one place in the whole acceptance that knows what a restart *is*, and it is
 * deliberately outside DS-Hns. The supervisor sees the exit and relaunches per its own protocol.
 */
async function requestRestart(args) {
  const target = Number(args && args[0] && args[0].pid ? args[0].pid : watchPid)
  if (!Number.isInteger(target) || target <= 0) return { ok: false, reason: 'no pid to restart' }
  const before = supervisionState()
  try {
    process.kill(target)
  } catch (error) {
    return { ok: false, reason: `the application could not be asked to leave: ${error && error.message ? error.message : error}` }
  }
  // Wait for the supervisor to notice and act, then report what it did -- not what we hoped.
  for (let waited = 0; waited < 8000; waited += tickMs) {
    await sleep(tickMs)
    const now = supervisionState()
    if (now.relaunches > before.relaunches || now.uncleanStarts > before.uncleanStarts) {
      return { ok: true, requested: target, observed: now }
    }
  }
  return { ok: false, reason: 'the supervisor did not report a relaunch in time', observed: supervisionState() }
}

async function cancelSupervision() {
  if (!supervisor || supervisor.exitCode !== null) return { ok: true, already: true }
  const pid = supervisor.pid
  supervisor.kill()
  return { ok: true, stopped: pid }
}

const capabilities = [{ name: 'restart-control', methods: ['status', 'request', 'cancel'] }]

async function onFrame(frame) {
  if (frame.kind === 'invoke') {
    let outcome
    try {
      if (frame.method === 'status') outcome = { ok: true, result: supervisionState() }
      else if (frame.method === 'request') outcome = { ok: true, result: await requestRestart(frame.args) }
      else if (frame.method === 'cancel') outcome = { ok: true, result: await cancelSupervision() }
      else outcome = { ok: false, reason: `unknown method ${frame.method}` }
    } catch (error) {
      outcome = { ok: false, reason: String(error && error.message ? error.message : error) }
    }
    send({ kind: 'result', id: frame.id, ok: outcome.ok, result: outcome.result, reason: outcome.reason })
    return
  }
  if (frame.kind === 'shutdown') {
    stopped = true
    await cancelSupervision()
    send({ kind: 'bye', reason: 'asked to stop' })
    process.exit(0)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) {
      try {
        onFrame(JSON.parse(line))
      } catch {
        send({ kind: 'fault', code: 'COMPANION_BAD_FRAME', reason: 'a line from the host was not JSON' })
      }
    }
    index = buffer.indexOf('\n')
  }
})

startSupervisor()
send({ kind: 'ready', capabilities, detail: { supervisorPid: supervisor ? supervisor.pid : null } })
const beat = setInterval(() => {
  if (!stopped) send({ kind: 'heartbeat', phase: supervisionState().phase })
}, 500)
beat.unref?.()
