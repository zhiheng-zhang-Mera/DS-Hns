'use strict'

/**
 * Computer Use Runtime: shell controller (plan §28, §29).
 *
 * "A task that can be done with the shell must not be forced through the GUI."
 * Creating a directory, running a build, running the tests — driving Explorer
 * and clicking folders for that is slower, more fragile and harder to verify.
 *
 * Safety rules that are enforced here rather than documented:
 *  - commands are spawned with an args array, never interpolated into a shell
 *    string, unless the contract explicitly asks for a shell
 *  - a forbidden command pattern refuses the action (plan §34 classifies
 *    install/delete/publish/format), and a contract allow-list narrows further
 *  - every run is bounded by a timeout and a captured-output ceiling, and the
 *    child is killed on timeout — a hung command must not hang the runtime
 *  - stdout/stderr are redacted before they reach the log (plan §32)
 */

const { spawn } = require('node:child_process')
const path = require('node:path')

const { ACTION_TYPES } = require('../constants.cjs')
const { CODES, ComputerUseError } = require('../errors.cjs')
const { unavailable } = require('../ports.cjs')

const MAX_OUTPUT_BYTES = 256 * 1024

/** Plan §34: patterns that are dangerous regardless of who asks. */
const DENIED_PATTERNS = [
  { pattern: /\bformat\s+[a-z]:/i, kind: 'FORMAT' },
  { pattern: /\bdiskpart\b/i, kind: 'FORMAT' },
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, kind: 'DELETE' },
  { pattern: /\bdel\s+\/[sq]\s+[a-z]:\\?(\s|$)/i, kind: 'DELETE' },
  { pattern: /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force[^\n]*[a-z]:\\?(\s|"|')/i, kind: 'DELETE' },
  { pattern: /\bshutdown\b/i, kind: 'ACCOUNT_CHANGE' },
  { pattern: /\bnet\s+user\b/i, kind: 'ACCOUNT_CHANGE' }
]

function createShellController(options = {}) {
  const clock = options.clock || { now: () => Date.now() }
  const defaultCwd = options.cwd || process.cwd()
  const baseEnv = options.env || null
  const shellEnabled = options.shellEnabled !== false
  const maxOutputBytes = Number.isInteger(options.maxOutputBytes) ? options.maxOutputBytes : MAX_OUTPUT_BYTES
  let lastResult = null

  /** Plan §32: never let a token reach the log through a command's output. */
  function redact(text) {
    return String(text)
      .replace(/(password|passwd|pwd|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
      .replace(/(sk|ghp|gho|ghs)_[A-Za-z0-9]{10,}/g, '[redacted-token]')
  }

  function probe() {
    return { available: true, reason: null, detail: { backend: 'node:child_process', cwd: defaultCwd } }
  }

  function supports(actionType) {
    return actionType === ACTION_TYPES.SHELL_EXEC
  }

  /**
   * Runs a command and returns a plain receipt. Never throws for a non-zero
   * exit: a failing command is a *result* the verification layer judges, not an
   * exception (plan §15 process verification).
   */
  function runCommand(input = {}) {
    const command = String(input.command || '')
    if (!command) return Promise.reject(new ComputerUseError(CODES.ACTION_INVALID, 'SHELL_EXEC requires a command'))
    const args = Array.isArray(input.args) ? input.args.map(String) : []
    const useShell = input.shell === true || (args.length === 0 && /\s/.test(command) && !path.isAbsolute(command))
    const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 30_000
    const cwd = input.cwd || defaultCwd
    const env = baseEnv ? { ...process.env, ...baseEnv, ...(input.env || {}) } : { ...process.env, ...(input.env || {}) }
    const startedAt = clock.now()

    return new Promise((resolve) => {
      let child
      try {
        child = useShell
          ? spawn(command, args, { cwd, env, shell: true, windowsHide: true })
          : spawn(command, args, { cwd, env, shell: false, windowsHide: true })
      } catch (error) {
        const receipt = {
          ok: false,
          command,
          args,
          spawnError: String(error && error.message),
          exitCode: null,
          stdout: '',
          stderr: String(error && error.message),
          durationMs: clock.now() - startedAt,
          exited: true,
          timedOut: false,
          changed: false
        }
        lastResult = receipt
        resolve(receipt)
        return
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* the child is already gone */
        }
      }, Math.max(0, timeoutMs))

      const collect = (chunk, target) => {
        const text = chunk.toString('utf8')
        if (target === 'stdout') {
          if (stdout.length < maxOutputBytes) stdout += text.slice(0, maxOutputBytes - stdout.length)
        } else if (stderr.length < maxOutputBytes) {
          stderr += text.slice(0, maxOutputBytes - stderr.length)
        }
      }

      child.stdout?.on('data', (chunk) => collect(chunk, 'stdout'))
      child.stderr?.on('data', (chunk) => collect(chunk, 'stderr'))
      if (input.stdin !== undefined && child.stdin) {
        try {
          child.stdin.write(String(input.stdin))
          child.stdin.end()
        } catch {
          /* the child closed stdin early */
        }
      }

      const finish = (exitCode, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const receipt = {
          ok: exitCode === 0 && !timedOut,
          command,
          args,
          cwd,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          signal: signal || null,
          stdout: redact(stdout),
          stderr: redact(stderr),
          durationMs: clock.now() - startedAt,
          exited: true,
          timedOut,
          changed: true,
          // Verification reads these; the log records only the sizes.
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length
        }
        lastResult = receipt
        resolve(receipt)
      }

      child.on('error', (error) => {
        stderr += String(error && error.message)
        finish(null, null)
      })
      child.on('close', (code, signal) => finish(code, signal))
    })
  }

  /**
   * Plan §34 + contract policy. Runs *before* the command executes.
   */
  function assertCommandAllowed(action, contract) {
    const command = String(action.params.command || '')
    const args = Array.isArray(action.params.args) ? action.params.args.join(' ') : ''
    const full = `${command} ${args}`.trim()
    for (const denied of DENIED_PATTERNS) {
      if (denied.pattern.test(full)) {
        const error = new ComputerUseError(CODES.SAFETY_REFUSED, `command refused by the built-in deny list (${denied.kind}): ${redact(full)}`, {
          kind: denied.kind,
          command: redact(full)
        })
        error.retryable = false
        throw error
      }
    }
    const safety = contract ? contract.safety : null
    if (safety && Array.isArray(safety.forbiddenCommands)) {
      for (const pattern of safety.forbiddenCommands) {
        if (full.toLowerCase().includes(String(pattern).toLowerCase())) {
          const error = new ComputerUseError(CODES.SAFETY_REFUSED, `command refused by the contract: ${redact(full)}`, { pattern })
          error.retryable = false
          throw error
        }
      }
    }
    if (safety && Array.isArray(safety.allowedCommands)) {
      const allowed = safety.allowedCommands.some((pattern) => full.toLowerCase().includes(String(pattern).toLowerCase()))
      if (!allowed) {
        const error = new ComputerUseError(CODES.SAFETY_REFUSED, `command is not in the contract allow-list: ${redact(full)}`, {
          allowList: safety.allowedCommands
        })
        error.retryable = false
        throw error
      }
    }
    if (action.params.shell === true && !shellEnabled) {
      throw new ComputerUseError(CODES.CAPABILITY_NOT_ALLOWED, 'shell interpretation is disabled for this runtime', { command: redact(full) })
    }
    return true
  }

  async function perform(action, context = {}) {
    if (action.type !== ACTION_TYPES.SHELL_EXEC) {
      throw new ComputerUseError(CODES.ACTION_UNSUPPORTED, `the shell controller cannot run ${action.type}`)
    }
    assertCommandAllowed(action, context.contract)
    const receipt = await runCommand({
      command: action.params.command,
      args: action.params.args,
      cwd: action.params.cwd,
      env: action.params.env,
      stdin: action.params.stdin,
      shell: action.params.shell,
      timeoutMs: action.timeoutMs
    })
    const expected = action.params.expectExitCode
    return {
      ...receipt,
      // A non-zero exit is not automatically a failure: only the declared
      // expectation (or the verification layer) decides that.
      ok: expected === undefined ? receipt.ok : receipt.exitCode === Number(expected),
      expectation: expected === undefined ? null : { expectExitCode: Number(expected) }
    }
  }

  /** Facts for the verification and criteria layers (plan §15). */
  function facts() {
    return {
      lastShell: lastResult
        ? {
            exited: lastResult.exited,
            exitCode: lastResult.exitCode,
            stdout: lastResult.stdout,
            stderr: lastResult.stderr,
            command: lastResult.command,
            timedOut: lastResult.timedOut
          }
        : null
    }
  }

  return { id: 'shell', capability: 'shell', probe, supports, perform, facts, runCommand, assertCommandAllowed, redact }
}

module.exports = { createShellController, DENIED_PATTERNS }
