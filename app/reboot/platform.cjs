'use strict'

/**
 * The restart, as the operating system does it.
 *
 * Everything here is one of five commands, and every one of them is built as an argv array and run
 * without a shell: a restart command assembled from a string is a command-injection surface, and the
 * label a user typed travels through this module.
 *
 *   1. **arm the relaunch** — a one-shot entry under `HKCU\…\CurrentVersion\Run`, so the machine
 *      coming back also brings DS-Hns back to continue the task. It is removed as soon as the
 *      application has read it, so it is a one-shot and not an autostart the user did not ask for.
 *   2. **disarm it** — after the intent has been acted on, or when a restart is refused.
 *   3. **ask the machine to restart** — `shutdown /r /t <seconds>` with a bounded reason.
 *   4. **abort a restart that has not happened yet** — `shutdown /a`.
 *   5. **ask whether the relaunch is armed** — a read, for the panel and for diagnostics.
 *
 * The runner is injectable, which is what makes this module testable *and* what keeps the tests from
 * ever restarting anything: the default runner spawns nothing until a real plan fires.
 *
 * A platform that cannot do this says so instead of pretending: `supported: false` and a refusal
 * from every action, so the panel can tell a user on a non-Windows build exactly what is missing.
 */

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { REBOOT_REASONS } = require('./plan.cjs')

/** Where the one-shot relaunch lives, and the name it lives under. */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'DSHnsRebootResume'
/** The flag the application is started with after a planned restart. */
const RESUME_FLAG = '--resume-reboot'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_REASON = 400

/** The default runner: a bounded, shell-free spawn that reports what happened. */
function defaultRun(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  })
  const command = [program, ...args]
  if (result.error) return { ok: false, code: REBOOT_REASONS.COMMAND_FAILED, command, reason: `${program} could not run: ${result.error.message}` }
  return {
    ok: result.status === 0,
    code: result.status === 0 ? null : REBOOT_REASONS.COMMAND_FAILED,
    command,
    status: result.status,
    stdout: String(result.stdout || '').slice(0, 4000),
    stderr: String(result.stderr || '').slice(0, 4000),
    reason: result.status === 0 ? null : `${command.join(' ')} exited with ${result.status}`
  }
}

/** A reason that cannot end the argument it is in, and cannot grow without bound. */
function safeReason(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/["\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON)
}

/**
 * @param {object} [options]
 * @param {Function} [options.run] `(program, args, { timeoutMs }) => { ok, command, … }`
 * @param {string} [options.platform] `process.platform`
 * @param {string} [options.execPath] the executable the relaunch starts
 * @param {string[]} [options.appArgs] arguments the relaunch passes before the resume flag
 * @param {Function} [options.log]
 */
function createRebootPlatform(options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun
  const platform = String(options.platform || process.platform)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const execPath = String(options.execPath || process.execPath)
  const appArgs = Array.isArray(options.appArgs) ? options.appArgs.map(String) : []
  const supported = platform === 'win32'

  function refuse(action) {
    return { ok: false, code: REBOOT_REASONS.UNSUPPORTED, action, reason: `scheduling a restart is not supported on ${platform}` }
  }

  /** The command line the one-shot entry runs after the machine comes back. */
  function relaunch() {
    return { program: execPath, args: [...appArgs, RESUME_FLAG], command: [execPath, ...appArgs, RESUME_FLAG] }
  }

  function armRelaunch() {
    if (!supported) return refuse('arm')
    const { command } = relaunch()
    // The value is a command line, so the executable is quoted inside it; `reg` receives it as one
    // argv entry and the quoting is Node's, not a shell's.
    const value = `"${command[0]}"${command.length > 1 ? ` ${command.slice(1).join(' ')}` : ''}`
    const result = run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f'], { timeoutMs: DEFAULT_TIMEOUT_MS })
    log(`relaunch ${result.ok ? 'armed' : 'could not be armed'}: ${value}`)
    return { ...result, action: 'arm', value }
  }

  function disarmRelaunch() {
    if (!supported) return refuse('disarm')
    const result = run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'], { timeoutMs: DEFAULT_TIMEOUT_MS })
    // "There was nothing to delete" is the state the caller wanted, not a failure of the call.
    const missing = !result.ok && /unable to find|cannot find/i.test(String(result.stderr || result.reason || ''))
    log(`relaunch ${result.ok || missing ? 'disarmed' : 'could not be disarmed'}`)
    return { ...result, ok: result.ok || missing, action: 'disarm', alreadyAbsent: missing }
  }

  function relaunchArmed() {
    if (!supported) return { ok: false, armed: false, ...refuse('query') }
    const result = run('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { timeoutMs: DEFAULT_TIMEOUT_MS })
    return { ok: true, armed: result.ok === true, action: 'query', stdout: result.stdout || '', command: result.command }
  }

  /**
   * Ask the machine to restart.
   *
   * `shutdown /r /t <seconds>` is the whole mechanism; the grace period is what gives the user a
   * window to abort with `cancelRestart`, and it is bounded here rather than trusted from a form.
   */
  function scheduleRestart(input = {}) {
    if (!supported) return refuse('restart')
    const seconds = Math.max(0, Math.min(86_400, Math.round(Number(input.seconds) || 0)))
    const reason = safeReason(input.reason) || 'DS-Hns: continuing a task after a restart'
    const args = ['/r', '/t', String(seconds), '/c', reason]
    const result = run('shutdown', args, { timeoutMs: DEFAULT_TIMEOUT_MS })
    log(`restart ${result.ok ? 'requested' : 'refused'} in ${seconds}s: ${reason}`)
    return { ...result, action: 'restart', seconds, reason }
  }

  /** Abort a restart that is still in its grace period. */
  function cancelRestart() {
    if (!supported) return refuse('abort')
    const result = run('shutdown', ['/a'], { timeoutMs: DEFAULT_TIMEOUT_MS })
    log(`restart abort ${result.ok ? 'accepted' : 'refused'}`)
    return { ...result, action: 'abort' }
  }

  return {
    supported,
    platform,
    runKey: RUN_KEY,
    runValue: RUN_VALUE,
    resumeFlag: RESUME_FLAG,
    relaunch,
    armRelaunch,
    disarmRelaunch,
    relaunchArmed,
    scheduleRestart,
    cancelRestart,
    /** What the panel shows about the mechanism itself. */
    describe() {
      const command = relaunch().command
      return {
        supported,
        platform,
        execPath,
        relaunch: { command, display: command.join(' ') },
        registryPath: `${RUN_KEY}\\${RUN_VALUE}`,
        restart: `shutdown /r /t <seconds> /c <reason>`,
        abort: 'shutdown /a',
        note: supported
          ? 'the machine is restarted with shutdown /r; the application is brought back by a one-shot Run entry that is removed once it has been read'
          : `scheduling a restart is not implemented for ${platform}`
      }
    }
  }
}

module.exports = { createRebootPlatform, defaultRun, safeReason, RUN_KEY, RUN_VALUE, RESUME_FLAG, DEFAULT_TIMEOUT_MS, MAX_REASON }
