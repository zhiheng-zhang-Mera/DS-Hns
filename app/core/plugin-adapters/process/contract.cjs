'use strict'

/**
 * DS-Hns Core: the process-plugin contract.
 *
 * Some plugins should not run inside DS-Hns at all. A supervisor that must outlive the application,
 * a Python model server with its own interpreter, a compiled helper with its own lifetime — none of
 * them belong in the main process, and none of them can be adapted by *loading* them. They have to
 * be **run**, watched and talked to.
 *
 * This module is the contract that makes that a plugin rather than a special case. The rule it is
 * built around is the one thing an adapter must never do:
 *
 * > The adapter understands *processes*. It does not understand what any process is for.
 *
 * Everything here is therefore deliberately generic. A plugin declares a command, a transport, a
 * heartbeat expectation, a restart policy and the capabilities it offers; the adapter starts it,
 * stops it, watches it, restarts it within bounds, collects its logs and routes frames. The word
 * "restart" in the plugin's own sense — restart *what*, and *why* — never appears on this side of
 * the boundary. That is what lets one adapter serve a supervisor, a model server and a compiled
 * binary without a branch for any of them.
 *
 * ## The isolation rules, and how they are structural
 *
 *   1. **No HNS object crosses.** The plugin is a separate OS process. It cannot be handed a
 *      capability, a registry, a bus or a context, because there is no channel that carries one:
 *      every frame is JSON, and the transports are newline-framed text over a pipe or a socket.
 *      There is nothing to serialise an object *into*.
 *   2. **One transport, named and closed.** `stdio-jsonl` and `localhost-jsonl` are the whole
 *      vocabulary. A plugin that asks for anything else is refused by name at adaptation, not
 *      given a transport that half works.
 *   3. **The protocol is a closed vocabulary too.** A frame whose `kind` is not in `PROCESS_FRAMES`
 *      is refused and counted, so a plugin cannot invent a message that the host will act on.
 *   4. **Capabilities are declared, not discovered.** A plugin says in its manifest which
 *      capabilities it offers and with which methods; the host registers exactly those. The
 *      adapter never asks the process what it can do and never guesses.
 */

/** The version a process plugin declares in its `dshns-process.json`. */
const PROCESS_API_VERSION = 'dshns.process/v1'

/** The declaration file, beside the plugin's code. */
const PROCESS_MANIFEST_FILE = 'dshns-process.json'

/**
 * The transports.
 *
 * `stdio-jsonl` is the default because it needs nothing: the child's stdin and stdout are the
 * channel, so a plugin written in any language that can read a line and write a line can speak it.
 * `localhost-jsonl` exists for a plugin that owns its standard streams for its own reasons — a
 * Python server whose stdout is a log firehose, or a compiled binary that writes binary to stdout.
 * Both are line-framed JSON, so neither can carry an object.
 */
const PROCESS_TRANSPORTS = Object.freeze({
  STDIO: Object.freeze({
    id: 'stdio-jsonl',
    summary: 'newline-delimited JSON on the process\'s own stdin and stdout',
    detail: 'the host writes the child\'s stdin and reads its stdout; the child\'s stderr is log-only and never parsed as protocol'
  }),
  LOCALHOST: Object.freeze({
    id: 'localhost-jsonl',
    summary: 'newline-delimited JSON over a loopback TCP socket',
    detail: 'the child listens on 127.0.0.1 and reports its port; a per-start token is required in every frame, and the host refuses non-loopback peers'
  })
})

/** Every transport id, for validation and for the panel. */
const PROCESS_TRANSPORT_IDS = Object.freeze(Object.values(PROCESS_TRANSPORTS).map((entry) => entry.id))

/**
 * The frame vocabulary. Closed on purpose.
 *
 * A frame the host does not recognise is not "an extension" — it is a plugin trying to make the
 * host act on something the contract does not describe, and it is refused and counted rather than
 * ignored. Ignoring it would be worse: the plugin would believe it had been understood.
 */
const PROCESS_FRAMES = Object.freeze({
  /** child → host: the plugin is up and has declared what it offers. */
  READY: 'ready',
  /** child → host: I am alive. The payload may carry anything the plugin likes; the host does not read it. */
  HEARTBEAT: 'heartbeat',
  /** child → host: a log line. */
  LOG: 'log',
  /** child → host: these are the capabilities and methods I offer. */
  PROVIDE: 'provide',
  /** host → child: call this method. */
  INVOKE: 'invoke',
  /** child → host: the answer to an `invoke`. */
  RESULT: 'result',
  /** host → child: stop, please, in your own time. */
  SHUTDOWN: 'shutdown',
  /** host → child: the transport is established; here is the token and the host's own version. */
  WELCOME: 'welcome',
  /** child → host: I am leaving, and this is why. */
  BYE: 'bye',
  /** either direction: something went wrong that is not a lifecycle event. */
  FAULT: 'fault'
})

/** The fault vocabulary. A code, because every caller branches on it. */
const PROCESS_FAULT_CODES = Object.freeze({
  BAD_MANIFEST: 'PROCESS_BAD_MANIFEST',
  NO_COMMAND: 'PROCESS_NO_COMMAND',
  COMMAND_ESCAPES: 'PROCESS_COMMAND_ESCAPES',
  UNSUPPORTED_TRANSPORT: 'PROCESS_UNSUPPORTED_TRANSPORT',
  SPAWN_FAILED: 'PROCESS_SPAWN_FAILED',
  HANDSHAKE_TIMEOUT: 'PROCESS_HANDSHAKE_TIMEOUT',
  HANDSHAKE_REFUSED: 'PROCESS_HANDSHAKE_REFUSED',
  UNKNOWN_FRAME: 'PROCESS_UNKNOWN_FRAME',
  MALFORMED_FRAME: 'PROCESS_MALFORMED_FRAME',
  FRAME_TOO_LARGE: 'PROCESS_FRAME_TOO_LARGE',
  HEARTBEAT_STALE: 'PROCESS_HEARTBEAT_STALE',
  EXITED: 'PROCESS_EXITED',
  EXIT_NONZERO: 'PROCESS_EXIT_NONZERO',
  STOP_TIMEOUT: 'PROCESS_STOP_TIMEOUT',
  KILLED: 'PROCESS_KILLED',
  RESTART_LIMIT: 'PROCESS_RESTART_LIMIT',
  CRASH_LOOP: 'PROCESS_CRASH_LOOP',
  NOT_RUNNING: 'PROCESS_NOT_RUNNING',
  NO_SUCH_CAPABILITY: 'PROCESS_NO_SUCH_CAPABILITY',
  /** The process offered something its manifest never declared. */
  UNDECLARED_CAPABILITY: 'PROCESS_UNDECLARED_CAPABILITY',
  INVOKE_TIMEOUT: 'PROCESS_INVOKE_TIMEOUT',
  INVOKE_FAILED: 'PROCESS_INVOKE_FAILED',
  PORT_NOT_REPORTED: 'PROCESS_PORT_NOT_REPORTED',
  BAD_TOKEN: 'PROCESS_BAD_TOKEN',
  DISPOSED: 'PROCESS_DISPOSED'
})

/**
 * The lifecycle states, as separate facts.
 *
 * `SAFE_MODE` is the terminal one and the reason this vocabulary exists: a plugin that has
 * crash-looped is not `FAILED`, it is a plugin a human has to look at, and a state machine that
 * collapsed the two would keep restarting it forever.
 */
const PROCESS_STATES = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  DEGRADED: 'degraded',
  RESTARTING: 'restarting',
  SAFE_MODE: 'safe-mode',
  FAILED: 'failed'
})

/** How a departed process is classified, which is what the restart policy acts on. */
const EXIT_KINDS = Object.freeze({
  CLEAN: 'clean',
  FAILURE: 'failure',
  SIGNAL: 'signal',
  UNKNOWN: 'unknown'
})

/** The restart policies. Closed, and `never` is not the default — `on-failure` is. */
const RESTART_POLICIES = Object.freeze({
  NEVER: 'never',
  ON_FAILURE: 'on-failure',
  ALWAYS: 'always'
})

/** The heartbeat's default expectations, in milliseconds. */
const DEFAULT_HEARTBEAT = Object.freeze({
  /** How often the plugin says it will beat. */
  intervalMs: 5_000,
  /** How long the host waits before calling it stale. Deliberately several intervals. */
  timeoutMs: 30_000,
  /** How long the host waits for the first frame after spawn. */
  handshakeTimeoutMs: 20_000
})

/** The restart bounds. Every one of them is a way an infinite loop is prevented. */
const DEFAULT_RESTART = Object.freeze({
  policy: RESTART_POLICIES.ON_FAILURE,
  /** Restarts allowed inside the window before the breaker trips. */
  maxRestarts: 3,
  /** The rolling window. */
  windowMs: 600_000,
  /** First backoff, doubled per consecutive failure. */
  backoffMs: 1_000,
  /** The ceiling of that doubling. */
  backoffMaxMs: 30_000,
  /** Whether tripping the breaker also enters safe mode, which stops everything. */
  safeModeOnLoop: true
})

/** The budgets. Each bounds something the plugin controls. */
const DEFAULT_LIMITS = Object.freeze({
  /** One frame, after decoding. */
  maxFrameBytes: 1024 * 1024,
  /** Log lines retained for the report. */
  maxLogLines: 500,
  /** One log line, truncated to this for the report. */
  maxLogLineBytes: 8_192,
  /** How long a graceful stop may take before the process is terminated. */
  stopTimeoutMs: 10_000,
  /** How long one capability invocation may take. */
  invokeTimeoutMs: 30_000,
  /** Exits retained in the history. */
  maxExitHistory: 25
})

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** A coded refusal, in the one shape every caller branches on. */
function processFault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

/**
 * Classify how a process left.
 *
 * The distinction that matters to the restart policy: a clean exit is a plugin that finished, a
 * non-zero exit is a plugin that broke, and a signal is usually the host's own doing. Restarting a
 * plugin that exited cleanly, forever, is the classic way a supervisor becomes a fork bomb.
 */
function classifyExit(code, signal) {
  if (signal) return { kind: EXIT_KINDS.SIGNAL, code: code === null || code === undefined ? null : Number(code), signal: String(signal) }
  if (code === 0) return { kind: EXIT_KINDS.CLEAN, code: 0, signal: null }
  if (Number.isInteger(code)) return { kind: EXIT_KINDS.FAILURE, code, signal: null }
  return { kind: EXIT_KINDS.UNKNOWN, code: null, signal: null }
}

/** Whether a policy wants this exit restarted. Business-free: it only reads the classification. */
function policyWantsRestart(policy, exitKind) {
  if (policy === RESTART_POLICIES.NEVER) return false
  if (policy === RESTART_POLICIES.ALWAYS) return true
  return exitKind === EXIT_KINDS.FAILURE || exitKind === EXIT_KINDS.SIGNAL || exitKind === EXIT_KINDS.UNKNOWN
}

/**
 * Validate one `dshns-process.json`.
 *
 * A process declaration names a command the host will execute, so this is the one manifest in the
 * platform that describes an *action* rather than a component. Everything that can be checked
 * before anything runs is checked here.
 *
 * @param {object} declaration
 * @param {object} [context]
 * @param {string} [context.dir] the plugin directory, for the containment check
 * @returns {{ok:boolean, errors:string[], manifest?:object}}
 */
function validateProcessManifest(declaration, context = {}) {
  const errors = []
  if (!declaration || typeof declaration !== 'object') {
    return { ok: false, errors: ['a process manifest must be an object'] }
  }
  const id = String(declaration.id || '')
  if (!ID_PATTERN.test(id)) errors.push(`id "${id}" is not a valid plugin id (lowercase letters, digits, dot, dash, underscore)`)
  if (!SEMVER_PATTERN.test(String(declaration.version || ''))) errors.push(`version "${declaration.version}" is not a semantic version`)

  const command = Array.isArray(declaration.command) ? declaration.command : null
  if (!command || command.length === 0) {
    errors.push('command must be a non-empty argv array (a string would be run through a shell, which this contract does not do)')
  } else if (command.some((part) => typeof part !== 'string' || !part.trim())) {
    errors.push('every element of command must be a non-empty string')
  }

  const transport = declaration.transport === undefined
    ? PROCESS_TRANSPORTS.STDIO.id
    : (declaration.transport && typeof declaration.transport === 'object' ? declaration.transport.kind : declaration.transport)
  if (!PROCESS_TRANSPORT_IDS.includes(String(transport))) {
    errors.push(`transport "${transport}" is not one of ${PROCESS_TRANSPORT_IDS.join(', ')}`)
  }

  const restart = declaration.restart && typeof declaration.restart === 'object' ? declaration.restart : {}
  if (restart.policy !== undefined && !Object.values(RESTART_POLICIES).includes(restart.policy)) {
    errors.push(`restart.policy must be one of ${Object.values(RESTART_POLICIES).join(', ')}`)
  }
  for (const field of ['maxRestarts', 'windowMs', 'backoffMs', 'backoffMaxMs']) {
    if (restart[field] !== undefined && (!Number.isFinite(restart[field]) || restart[field] < 0)) {
      errors.push(`restart.${field} must be a non-negative number`)
    }
  }
  if (Number.isFinite(restart.backoffMs) && Number.isFinite(restart.backoffMaxMs) && restart.backoffMs > restart.backoffMaxMs) {
    errors.push('restart.backoffMs must not exceed restart.backoffMaxMs')
  }

  const heartbeat = declaration.heartbeat && typeof declaration.heartbeat === 'object' ? declaration.heartbeat : {}
  for (const field of ['intervalMs', 'timeoutMs', 'handshakeTimeoutMs']) {
    if (heartbeat[field] !== undefined && (!Number.isFinite(heartbeat[field]) || heartbeat[field] <= 0)) {
      errors.push(`heartbeat.${field} must be a positive number`)
    }
  }
  if (Number.isFinite(heartbeat.intervalMs) && Number.isFinite(heartbeat.timeoutMs) && heartbeat.timeoutMs <= heartbeat.intervalMs) {
    errors.push('heartbeat.timeoutMs must exceed heartbeat.intervalMs')
  }

  const provides = declaration.provides && Array.isArray(declaration.provides.capabilities) ? declaration.provides.capabilities : []
  for (const capability of provides) {
    if (!capability || typeof capability !== 'object') {
      errors.push('every entry of provides.capabilities must be an object')
      continue
    }
    if (!ID_PATTERN.test(String(capability.name || ''))) errors.push(`capability name "${capability.name}" is not a valid name`)
    const methods = capability.methods
    if (!Array.isArray(methods) || methods.length === 0 || methods.some((method) => typeof method !== 'string' || !method.trim())) {
      errors.push(`capability ${capability.name || '(unnamed)'} must list a non-empty methods array`)
    }
  }

  // A command that points outside the plugin directory is refused: a manifest that could run any
  // binary on the machine is a manifest that makes the plugin directory meaningless.
  const dir = context.dir ? String(context.dir) : null
  if (dir && command && command.length) {
    const path = require('node:path')
    for (const part of command) {
      if (!part.startsWith('.') && !path.isAbsolute(part)) continue
      const resolved = path.resolve(dir, part)
      const relative = path.relative(dir, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        errors.push(`command entry "${part}" resolves outside the plugin directory`)
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  return { ok: true, errors: [], manifest: normalizeProcessManifest(declaration, { transport: String(transport) }) }
}

/** Apply the documented defaults, so nothing downstream guesses one. */
function normalizeProcessManifest(declaration, extra = {}) {
  const restart = declaration.restart && typeof declaration.restart === 'object' ? declaration.restart : {}
  const heartbeat = declaration.heartbeat && typeof declaration.heartbeat === 'object' ? declaration.heartbeat : {}
  const limits = declaration.limits && typeof declaration.limits === 'object' ? declaration.limits : {}
  return {
    api_version: PROCESS_API_VERSION,
    id: String(declaration.id),
    name: declaration.name ? String(declaration.name) : String(declaration.id),
    version: String(declaration.version),
    description: declaration.description ? String(declaration.description) : null,
    command: declaration.command.map(String),
    cwd: declaration.cwd ? String(declaration.cwd) : null,
    /** Only these environment variables are passed through, over a minimal base. */
    env: declaration.env && typeof declaration.env === 'object' ? { ...declaration.env } : {},
    transport: { kind: extra.transport || PROCESS_TRANSPORTS.STDIO.id },
    heartbeat: {
      intervalMs: Number.isFinite(heartbeat.intervalMs) ? Number(heartbeat.intervalMs) : DEFAULT_HEARTBEAT.intervalMs,
      timeoutMs: Number.isFinite(heartbeat.timeoutMs) ? Number(heartbeat.timeoutMs) : DEFAULT_HEARTBEAT.timeoutMs,
      handshakeTimeoutMs: Number.isFinite(heartbeat.handshakeTimeoutMs) ? Number(heartbeat.handshakeTimeoutMs) : DEFAULT_HEARTBEAT.handshakeTimeoutMs
    },
    restart: {
      policy: restart.policy || DEFAULT_RESTART.policy,
      maxRestarts: Number.isFinite(restart.maxRestarts) ? Number(restart.maxRestarts) : DEFAULT_RESTART.maxRestarts,
      windowMs: Number.isFinite(restart.windowMs) ? Number(restart.windowMs) : DEFAULT_RESTART.windowMs,
      backoffMs: Number.isFinite(restart.backoffMs) ? Number(restart.backoffMs) : DEFAULT_RESTART.backoffMs,
      backoffMaxMs: Number.isFinite(restart.backoffMaxMs) ? Number(restart.backoffMaxMs) : DEFAULT_RESTART.backoffMaxMs,
      safeModeOnLoop: restart.safeModeOnLoop !== false
    },
    provides: {
      capabilities: (declaration.provides && Array.isArray(declaration.provides.capabilities) ? declaration.provides.capabilities : [])
        .map((capability) => ({ name: String(capability.name), methods: capability.methods.map(String), detail: capability.detail ? String(capability.detail) : null }))
    },
    permissions: {
      declares: declaration.permissions && Array.isArray(declaration.permissions.declares) ? declaration.permissions.declares.map(String) : []
    },
    limits: {
      maxFrameBytes: Number.isFinite(limits.maxFrameBytes) ? Number(limits.maxFrameBytes) : DEFAULT_LIMITS.maxFrameBytes,
      maxLogLines: Number.isFinite(limits.maxLogLines) ? Number(limits.maxLogLines) : DEFAULT_LIMITS.maxLogLines,
      maxLogLineBytes: Number.isFinite(limits.maxLogLineBytes) ? Number(limits.maxLogLineBytes) : DEFAULT_LIMITS.maxLogLineBytes,
      stopTimeoutMs: Number.isFinite(limits.stopTimeoutMs) ? Number(limits.stopTimeoutMs) : DEFAULT_LIMITS.stopTimeoutMs,
      invokeTimeoutMs: Number.isFinite(limits.invokeTimeoutMs) ? Number(limits.invokeTimeoutMs) : DEFAULT_LIMITS.invokeTimeoutMs,
      maxExitHistory: Number.isFinite(limits.maxExitHistory) ? Number(limits.maxExitHistory) : DEFAULT_LIMITS.maxExitHistory
    },
    fault_level: declaration.fault_level === 'degraded' || declaration.fault_level === 'soft' ? declaration.fault_level : 'soft'
  }
}

/**
 * The environment a managed process is given.
 *
 * Deliberately *not* `process.env`. A background plugin is third-party code from the host's point
 * of view, and inheriting the whole environment hands it every token, key and proxy the shell
 * happens to be carrying. It gets a minimal base, plus exactly the variables it declared, plus the
 * two the protocol itself defines.
 */
function environmentFor(manifest, extra = {}) {
  const base = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    // A packaged application runs its children with Electron's binary; the child must be node.
    ELECTRON_RUN_AS_NODE: '1',
    DSHNS_PROCESS_ID: manifest.id,
    DSHNS_PROCESS_PROTOCOL: PROCESS_API_VERSION,
    ...manifest.env
  }
  if (extra.token) base.DSHNS_PROCESS_TOKEN = extra.token
  return base
}

/** One frame, as a line. Bounded, so a plugin cannot flood the pipe with one message. */
function encodeFrame(frame, maxBytes) {
  const text = JSON.stringify(frame)
  const size = Buffer.byteLength(text, 'utf8')
  if (size > maxBytes) {
    return processFault(PROCESS_FAULT_CODES.FRAME_TOO_LARGE, `a ${size} byte frame exceeds the ${maxBytes} byte limit`)
  }
  return { ok: true, line: `${text}\n`, bytes: size }
}

/**
 * Decode one line into a frame, or refuse it.
 *
 * Refusing is the point: a line that is not JSON, or JSON that is not an object, or an object whose
 * `kind` is outside the vocabulary, is a plugin doing something the contract does not describe. It
 * is counted and reported, never quietly dropped — a dropped frame the plugin believes was
 * delivered is worse than a loud refusal.
 */
function decodeFrame(line, maxBytes) {
  const text = String(line || '')
  const size = Buffer.byteLength(text, 'utf8')
  if (size > maxBytes) {
    return processFault(PROCESS_FAULT_CODES.FRAME_TOO_LARGE, `a ${size} byte frame exceeds the ${maxBytes} byte limit`)
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return processFault(PROCESS_FAULT_CODES.MALFORMED_FRAME, 'the frame is not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return processFault(PROCESS_FAULT_CODES.MALFORMED_FRAME, 'a frame must be a JSON object')
  }
  const kind = String(parsed.kind || '')
  if (!Object.values(PROCESS_FRAMES).includes(kind)) {
    return processFault(PROCESS_FAULT_CODES.UNKNOWN_FRAME, `"${kind}" is not a frame this protocol defines`, { frame: parsed })
  }
  return { ok: true, frame: parsed }
}

module.exports = {
  PROCESS_API_VERSION,
  PROCESS_MANIFEST_FILE,
  PROCESS_TRANSPORTS,
  PROCESS_TRANSPORT_IDS,
  PROCESS_FRAMES,
  PROCESS_FAULT_CODES,
  PROCESS_STATES,
  EXIT_KINDS,
  RESTART_POLICIES,
  DEFAULT_HEARTBEAT,
  DEFAULT_RESTART,
  DEFAULT_LIMITS,
  processFault,
  classifyExit,
  policyWantsRestart,
  validateProcessManifest,
  normalizeProcessManifest,
  environmentFor,
  encodeFrame,
  decodeFrame
}
