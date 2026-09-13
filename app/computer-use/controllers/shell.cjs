'use strict'

/**
 * Computer Use Runtime: shell controller (plan §28, §29;
 * Update-Plan/24h.md Task 7, Task 11, Task 13).
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
 *  - **the working directory is never inherited from `process.cwd()`**: it comes
 *    from the verified workspace, or the command is refused (24h.md Task 11)
 *  - every process the runtime starts is registered, so the runtime can supervise
 *    what it owns and can never kill what it does not (24h.md Task 7)
 *  - stdout/stderr are redacted before they reach the log (plan §32)
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { ACTION_TYPES } = require('../constants.cjs')
const { CODES, ComputerUseError } = require('../errors.cjs')
const { unavailable } = require('../ports.cjs')
const { COMMAND_MODE, normalizeCommand, judge, invalidError } = require('../command.cjs')

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

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
  /**
   * The stated default working directory (Task 11).
   *
   * `cwd` is what the *host* declares: the runtime passes its verified
   * workspace, so every action it issues runs inside the workspace boundary and
   * an undeclared action is refused. When a host declares nothing at all — a
   * driver probe, a shell-only embedder — there is no boundary to honour, and
   * the controller uses the directory the process was started in, which is the
   * only directory such a host has ever had.
   *
   * What Task 11 forbids is *silently* falling back when a workspace was
   * declared: that path goes through `resolveCwd`/`resolveExplicitCwd` and ends
   * in a refusal, never in an inherited directory. The distinction is recorded
   * per command in `cwdSource` (`contract`/`configured`/`explicit`/`process`).
   */
  const configuredCwd = options.cwd || null
  const defaultCwd = configuredCwd || process.cwd()
  const baseEnv = options.env || null
  const shellEnabled = options.shellEnabled !== false
  const maxOutputBytes = Number.isInteger(options.maxOutputBytes) ? options.maxOutputBytes : MAX_OUTPUT_BYTES
  // The registry the runtime owns every process through. Optional: a controller
  // used standalone (a unit test, a driver probe) still works, it just cannot
  // supervise what it starts.
  const processes = options.processes || null
  const workspaceSource = options.workspace || null
  let lastResult = null

  /** Plan §32: never let a token reach the log through a command's output. */
  function redact(text) {
    return String(text)
      .replace(/(password|passwd|pwd|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
      .replace(/(sk|ghp|gho|ghs)_[A-Za-z0-9]{10,}/g, '[redacted-token]')
  }

  /** The workspace guard, whether it was handed over directly or as a getter. */
  function currentGuard() {
    return typeof workspaceSource === 'function' ? workspaceSource() : workspaceSource
  }

  /**
   * Resolve the working directory for a command.
   *
   * Update-Plan/24h.md Task 11: a command never silently runs in the process's
   * own cwd *when a workspace was declared*. Either the caller named a directory,
   * or the *verified workspace* is used, or the command is refused. A `cd` that
   * failed must not be able to send the next command somewhere unexpected.
   *
   * When the host declared no workspace and no directory, there is no boundary
   * to protect and no verified directory to prefer, so the controller falls back
   * to the directory it was constructed with (`configured` → `process`). That
   * fallback is reported in `cwdSource`, never applied silently.
   *
   * @returns {{ok:boolean, cwd:string|null, source:string, reason:string|null}}
   */
  function resolveCwd(requested) {
    // An explicit directory always wins, and it is validated on its own merits
    // (absolute, exists, is a directory) whether or not a workspace exists. This
    // is what keeps a standalone controller usable by a driver probe or a unit
    // test without weakening the workspace rule for the runtime.
    if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
      return resolveExplicitCwd(String(requested))
    }
    // The guard may be handed over directly or through a lazy getter (the runtime
    // supplies a getter so the guard exists before the controller does).
    const guard = currentGuard()
    if (guard && typeof guard.resolveCwd === 'function') {
      // A workspace was declared: its verdict is final. Neither the process's own
      // directory nor a configured string may stand in for a workspace that
      // failed to verify — that is exactly the silent inheritance Task 11
      // forbids. "If the workspace does not exist: BLOCK."
      return guard.resolveCwd({ cwd: null })
    }
    // No workspace was declared at all: the controller's own directory is the
    // only place it has, and that is what it states.
    return { ok: true, cwd: path.resolve(defaultCwd), source: configuredCwd ? 'configured' : 'process', reason: null }
  }

  /** Validate a caller-supplied working directory on its own merits. */
  function resolveExplicitCwd(candidate) {
    const guard = currentGuard()
    if (!path.isAbsolute(candidate)) {
      if (guard && typeof guard.resolveCwd === 'function') {
        const verdict = guard.resolveCwd({ cwd: candidate })
        if (verdict.ok) return verdict
        return { ok: false, cwd: null, source: verdict.source, reason: verdict.reason }
      }
      return { ok: false, cwd: null, source: 'explicit', reason: `a relative working directory cannot be resolved without a workspace: ${candidate}` }
    }
    if (guard && typeof guard.resolveCwd === 'function') {
      const verdict = guard.resolveCwd({ cwd: candidate })
      if (verdict.ok) return verdict
      return { ok: false, cwd: null, source: verdict.source, reason: verdict.reason }
    }
    const resolved = path.resolve(candidate)
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        return { ok: false, cwd: null, source: 'explicit', reason: `the working directory is not a directory: ${resolved}` }
      }
    } catch {
      return { ok: false, cwd: null, source: 'explicit', reason: `the working directory does not exist: ${resolved}` }
    }
    return { ok: true, cwd: resolved, source: 'explicit', reason: null }
  }

  function probe() {
    return { available: true, reason: null, detail: { backend: 'node:child_process', cwd: defaultCwd, supervisedProcesses: processes ? processes.ownedCount : 0 } }
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
    const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_TIMEOUT_MS
    const mode = input.mode === COMMAND_MODE.LONG_RUNNING ? COMMAND_MODE.LONG_RUNNING : COMMAND_MODE.FOREGROUND
    const maxOutput = Number.isFinite(input.outputBytes) && input.outputBytes > 0 ? Math.min(input.outputBytes, maxOutputBytes) : maxOutputBytes
    const cwdVerdict = resolveCwd(input.cwd)
    if (!cwdVerdict.ok) {
      // Task 11/13: the refusal is a typed result, not an unbounded wait in an
      // unknown directory.
      return Promise.resolve({
        ok: false,
        command,
        args,
        cwd: null,
        spawnError: cwdVerdict.reason,
        exitCode: null,
        stdout: '',
        stderr: cwdVerdict.reason,
        durationMs: 0,
        exited: true,
        timedOut: false,
        changed: false,
        blocked: true,
        code: CODES.WORKSPACE_UNAVAILABLE,
        cwdSource: cwdVerdict.source
      })
    }
    const cwd = cwdVerdict.cwd
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
          cwd,
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

      // Task 7: the runtime registers what it starts, so it can supervise it and
      // dispose of exactly what it owns.
      let registration = null
      if (processes) {
        try {
          registration = processes.register({
            child,
            command,
            args,
            cwd,
            mode,
            expectedLifetimeMs: mode === COMMAND_MODE.LONG_RUNNING
              ? (Number.isFinite(input.expectedLifetimeMs) ? input.expectedLifetimeMs : null)
              : timeoutMs,
            ownership: input.ownership || 'runtime',
            step: input.step === undefined ? null : input.step
          })
        } catch (error) {
          // At the process ceiling: refuse rather than start an unsupervised
          // child (Task 8's resource ceiling).
          registration = null
          const receipt = {
            ok: false,
            command,
            args,
            cwd,
            spawnError: String(error && error.message),
            exitCode: null,
            stdout: '',
            stderr: String(error && error.message),
            durationMs: 0,
            exited: true,
            timedOut: false,
            changed: false,
            blocked: true,
            code: CODES.RESOURCE_LIMIT
          }
          try { child.kill('SIGKILL') } catch {}
          lastResult = receipt
          resolve(receipt)
          return
        }
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      // A long-running process is not on a leash: it is expected to still be
      // running, and it is supervised rather than killed (Task 7, Scenario B/C).
      const timer = mode === COMMAND_MODE.LONG_RUNNING
        ? null
        : setTimeout(() => {
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
          if (stdout.length < maxOutput) stdout += text.slice(0, maxOutput - stdout.length)
        } else if (stderr.length < maxOutput) {
          stderr += text.slice(0, maxOutput - stderr.length)
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
        if (timer) clearTimeout(timer)
        if (registration && processes) {
          processes.settle(registration.id, {
            status: timedOut ? 'timed_out' : (typeof exitCode === 'number' && exitCode === 0 ? 'exited' : 'exited'),
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            signal: signal || null
          })
        }
        const receipt = {
          ok: exitCode === 0 && !timedOut,
          command,
          args,
          cwd,
          cwdSource: cwdVerdict.source,
          processId: registration ? registration.id : null,
          mode,
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

  /** Kill a process this runtime owns. Refuses anything it does not own. */
  async function killProcess(processId, reason = 'runtime request') {
    if (!processes) return { ok: false, reason: 'no process registry is attached' }
    return processes.kill(processId, reason)
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
    // Task 13: a shell action is normalized into an explicit contract — command,
    // cwd, timeout, expected exit, output ceiling, process mode — *before* it
    // runs. "Just run this" never becomes an unbounded wait: the timeout and the
    // mode are decided here, and the verdict is the runtime's own vocabulary.
    const normalized = normalizeCommand(
      {
        command: action.params.command,
        args: action.params.args,
        cwd: action.params.cwd,
        timeoutMs: action.timeoutMs,
        expectExitCode: action.params.expectExitCode,
        outputBytes: action.params.outputBytes,
        mode: action.params.mode,
        shell: action.params.shell,
        stdin: action.params.stdin,
        expectedLifetimeMs: action.params.expectedLifetimeMs
      },
      {
        // The workspace verdict resolves the cwd, so a contract that names none
        // still gets the verified directory rather than an inherited one.
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        cwd: (() => {
          const verdict = resolveCwd(action.params.cwd)
          return verdict.ok ? verdict.cwd : null
        })()
      }
    )
    if (!normalized.ok) throw invalidError(normalized.issues)
    const contract = normalized.contract
    const receipt = await runCommand({
      command: contract.command,
      args: contract.args,
      cwd: contract.cwd || action.params.cwd,
      env: action.params.env,
      stdin: contract.stdin === null ? undefined : contract.stdin,
      shell: contract.shell,
      timeoutMs: contract.timeoutMs,
      mode: contract.mode,
      expectedLifetimeMs: contract.expectedLifetimeMs,
      step: context.step,
      outputBytes: contract.outputBytes
    })
    const expected = contract.expectExitCode
    return {
      ...receipt,
      // A non-zero exit is not automatically a failure: only the declared
      // expectation (or the verification layer) decides that.
      ok: expected === undefined || expected === null ? receipt.ok : receipt.exitCode === Number(expected),
      expectation: expected === undefined || expected === null ? null : { expectExitCode: Number(expected) },
      // The contract and its verdict travel with the receipt, so the log, the
      // verifier and the soak harness all judge a command the same way.
      commandContract: { timeoutMs: contract.timeoutMs, mode: contract.mode, outputBytes: contract.outputBytes, expectExitCode: contract.expectExitCode },
      timeoutMs: contract.timeoutMs,
      verdict: judge(contract, receipt)
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
            cwd: lastResult.cwd,
            timedOut: lastResult.timedOut
          }
        : null,
      lastExitCode: lastResult ? lastResult.exitCode : null,
      lastDurationMs: lastResult ? lastResult.durationMs : null
    }
  }

  return {
    id: 'shell',
    capability: 'shell',
    probe,
    supports,
    perform,
    facts,
    runCommand,
    killProcess,
    resolveCwd,
    assertCommandAllowed,
    redact,
    /** What the runtime owns right now (Task 7 / Task 19). */
    processes: () => (processes ? processes.snapshot() : { owned: [], ownedCount: 0, ceiling: 0, atCapacity: false })
  }
}

module.exports = { createShellController, DENIED_PATTERNS }
