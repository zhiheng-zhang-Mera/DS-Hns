'use strict'

/**
 * DS-Hns Core: the Cordis bridge contract.
 *
 * A community plugin written for DeepSeek Harness expects a Cordis container and the host services
 * it declared in `inject`. It must not get either. What it gets instead is this: a **closed,
 * versioned, mediated surface** in which every interaction with the host is a named capability
 * call that the host validates, applies and can refuse.
 *
 * The rule the whole module exists to enforce:
 *
 * > A Cordis plugin never receives an HNS Core object. It receives functions that describe an
 * > intention, and the host decides what that intention means.
 *
 * That is a stronger statement than "the plugin runs in a child process". A child process with a
 * message channel to the parent can still be handed a live object (through a structured-clone of
 * something that should not have been sent), can still be told "call this and you may do anything",
 * and can still be given a `ctx` that is a real Cordis context with the whole container behind it.
 * None of those happen here, and each is prevented by construction rather than by convention:
 *
 *   1. **The capability vocabulary is closed.** A plugin that asks for a service not on this list
 *      does not get a proxy that fails later; the name is refused, by name, at activation.
 *   2. **The method vocabulary is closed per capability.** `webServer` has exactly `register` and
 *      `unregister`. `registerFallback`, `registerUpgrade` and the raw `server` field --?all real
 *      members of the real service --?are not reachable through the bridge at all.
 *   3. **Arguments are data.** Every call crosses the boundary as JSON. There is no handle, no
 *      reference, no function and no prototype chain in either direction, so there is nothing to
 *      walk back to a host object --?and the payload is bounded, so there is nothing to exhaust.
 *   4. **The host validates before it applies.** A route path is normalised and checked against
 *      reserved prefixes; a settings namespace is checked against the namespace pattern. The
 *      plugin's *intention* is data; the host's *action* is the host's.
 *   5. **A refusal is reported, never swallowed.** Every refused call is recorded with a code and
 *      reaches the plugin's health and error surfaces, because a bridge that silently drops what
 *      it will not do is a bridge whose plugin appears to work and does not.
 */

/** The version a bridge payload declares. Bumped when the message shape changes. */
const BRIDGE_API_VERSION = 'dshns.cordis-bridge/v1'

/**
 * The capabilities a community plugin may ask for, and exactly what each one exposes.
 *
 * `methods` is an allow-list, not documentation. A method that is not here is refused with
 * `BRIDGE_UNKNOWN_METHOD` even though the real service implements it, because the point of the
 * bridge is that the plugin's reach is the list.
 *
 * `exposes` names, in the contract itself, what the real service has that is deliberately *not*
 * reachable. Stating it here rather than in a comment is what makes "we did not hand over the
 * server object" a fact a reader can check.
 */
const BRIDGE_CAPABILITIES = Object.freeze({
  webServer: Object.freeze({
    summary: 'register HTTP routes served by the host',
    detail: 'the plugin keeps its handler; the host owns the socket, the routing and the response',
    /**
     * `unregister` is here because disposal is part of registration: the real service returns a
     * disposer from `register`, and a bridge that could add a route but never remove one would make
     * "disable" and "reload" leak a route per cycle.
     */
    methods: Object.freeze(['register', 'unregister']),
    required: Object.freeze(['kind', 'path', 'handler']),
    exposes: Object.freeze([]),
    withholds: Object.freeze(['server', 'registerUpgrade', 'registerFallback', 'indexTaps', 'config', 'listen', 'close']),
    /** Route kinds the real service accepts, mirrored so a bad kind is refused at the bridge. */
    kinds: Object.freeze(['exact', 'prefix'])
  }),
  settings: Object.freeze({
    summary: 'register a settings namespace the user can edit',
    detail: 'the schema is reduced to a serialisable description; the host owns the namespace',
    methods: Object.freeze(['register', 'installSection']),
    required: Object.freeze(['namespace']),
    exposes: Object.freeze([]),
    withholds: Object.freeze(['update', 'get', 'watcher', 'scope', 'internal'])
  })
})

/** Every capability name, for validation and for the panel. */
const BRIDGE_CAPABILITY_IDS = Object.freeze(Object.keys(BRIDGE_CAPABILITIES).sort())

/**
 * The route prefixes the *host* owns.
 *
 * These are not "off-limits to plugins" --?`/api/market/install-skin` is a legitimate route for a
 * plugin whose entire purpose is a market API, and refusing it was a real defect this list caused
 * before it was corrected. What must not happen is a plugin **swallowing** the host's surface: a
 * `prefix` route at `/api` or `/api/` would sit in front of every harness endpoint, and an `exact`
 * route at an existing host path would shadow it.
 *
 * So the rule is about ancestry, not membership:
 *
 *   * a candidate that is an ancestor of a reserved prefix (`/api`, `/api/`) is refused;
 *   * a candidate *under* a reserved prefix (`/api/market/installed`) is allowed, and collisions
 *     with a path the host actually registered are caught by the real service's own duplicate
 *     check, which is the mechanism that already exists for exactly this.
 */
const HOST_ROUTE_PREFIXES = Object.freeze(['/api/', '/assets/', '/static/', '/__'])

/** The message kinds that cross the boundary. Anything else is malformed by definition. */
const BRIDGE_MESSAGES = Object.freeze({
  /** child --?host: the plugin finished applying and the capability report is complete. */
  READY: 'ready',
  /** child --?host: activation failed; `code` and `reason` are the report. */
  FAILED: 'failed',
  /** child --?host: one mediated capability call. */
  CALL: 'call',
  /** host --?child: the answer to a call. */
  CALL_RESULT: 'call-result',
  /** host --?child: an inbound HTTP request to dispatch to a registered route. */
  REQUEST: 'request',
  /** child --?host: response status and headers. */
  RESPONSE_HEAD: 'response-head',
  /** child --?host: one response body chunk. */
  RESPONSE_CHUNK: 'response-chunk',
  /** child --?host: the response is complete. */
  RESPONSE_END: 'response-end',
  /** host --?child: unwind the plugin. */
  SHUTDOWN: 'shutdown',
  /** child --?host: a log line the plugin emitted. */
  LOG: 'log',
  /** child --?host: something went wrong that is not an activation failure. */
  FAULT: 'fault'
})

/** The fault vocabulary. A code, not a message, because every caller branches on it. */
const BRIDGE_FAULT_CODES = Object.freeze({
  SPAWN_FAILED: 'BRIDGE_SPAWN_FAILED',
  HANDSHAKE_FAILED: 'BRIDGE_HANDSHAKE_FAILED',
  ACTIVATION_TIMEOUT: 'BRIDGE_ACTIVATION_TIMEOUT',
  ACTIVATION_FAILED: 'BRIDGE_ACTIVATION_FAILED',
  UNKNOWN_CAPABILITY: 'BRIDGE_UNKNOWN_CAPABILITY',
  UNKNOWN_METHOD: 'BRIDGE_UNKNOWN_METHOD',
  MISSING_ARGUMENT: 'BRIDGE_MISSING_ARGUMENT',
  RESERVED_PATH: 'BRIDGE_RESERVED_PATH',
  BAD_PATH: 'BRIDGE_BAD_PATH',
  BAD_KIND: 'BRIDGE_BAD_KIND',
  DUPLICATE_ROUTE: 'BRIDGE_DUPLICATE_ROUTE',
  ROUTE_LIMIT: 'BRIDGE_ROUTE_LIMIT',
  SERVICE_UNAVAILABLE: 'BRIDGE_SERVICE_UNAVAILABLE',
  NOT_ACTIVATED: 'BRIDGE_NOT_ACTIVATED',
  EXITED: 'BRIDGE_EXITED',
  TIMEOUT: 'BRIDGE_TIMEOUT',
  PAYLOAD_TOO_LARGE: 'BRIDGE_PAYLOAD_TOO_LARGE',
  MALFORMED_MESSAGE: 'BRIDGE_MALFORMED_MESSAGE',
  NO_ENTRY: 'BRIDGE_NO_ENTRY',
  ENTRY_MISSING: 'BRIDGE_ENTRY_MISSING',
  MISSING_DEPENDENCIES: 'BRIDGE_MISSING_DEPENDENCIES',
  IMPORT_FAILED: 'BRIDGE_IMPORT_FAILED',
  UNSUPPORTED_API: 'BRIDGE_UNSUPPORTED_API',
  HANDLER_FAILED: 'BRIDGE_HANDLER_FAILED',
  DISPOSED: 'BRIDGE_DISPOSED'
})

/** The worker's one report line is prefixed so plugin stdout cannot be mistaken for a report. */
const BRIDGE_REPORT_PREFIX = '@@DSHNS-BRIDGE@@'

/**
 * The budgets. Every one exists because the thing it bounds is controlled by the plugin.
 *
 * A plugin is third-party code: it decides how many routes it registers, how large a response it
 * writes and how long it takes to activate. Each of those is a way for a plugin to consume the
 * host, so each has a number here rather than an assumption somewhere else.
 */
const BRIDGE_LIMITS = Object.freeze({
  /** How long activation may take before the child is killed and reported. */
  activationTimeoutMs: 20_000,
  /** How long one mediated call may take before it is refused. */
  callTimeoutMs: 5_000,
  /** How long one forwarded HTTP request may take. */
  requestTimeoutMs: 60_000,
  /** One message's payload, after base64 decoding. */
  maxMessageBytes: 4 * 1024 * 1024,
  /** A forwarded request body. */
  maxRequestBodyBytes: 2 * 1024 * 1024,
  /** Response chunks are streamed, so the cap is per chunk rather than per response. */
  maxChunkBytes: 1024 * 1024,
  /** How many routes one plugin may register. */
  maxRoutes: 64,
  /** How many log lines the child retains for the report. */
  maxLogs: 200,
  /** How many capability calls may be in flight at once. */
  maxPendingCalls: 128
})

/** A coded refusal, in the one shape every caller branches on. */
function bridgeFault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

/** Normalise a route path: absolute, no traversal, no duplicate slashes. */
function normalizeRoutePath(value) {
  const raw = String(value || '').trim()
  if (!raw) return { ok: false, code: BRIDGE_FAULT_CODES.BAD_PATH, reason: 'a route path is required' }
  if (!raw.startsWith('/')) return { ok: false, code: BRIDGE_FAULT_CODES.BAD_PATH, reason: `the route path ${raw} must start with /` }
  if (raw.includes('\\') || raw.includes('..') || raw.includes('//')) {
    return { ok: false, code: BRIDGE_FAULT_CODES.BAD_PATH, reason: `the route path ${raw} contains a traversal or an empty segment` }
  }
  if (/[\s<>"{}|^`]/.test(raw)) return { ok: false, code: BRIDGE_FAULT_CODES.BAD_PATH, reason: `the route path ${raw} contains an illegal character` }

  // Ancestry, not membership: a plugin may live under a host prefix, but it may not sit in front
  // of one. See `HOST_ROUTE_PREFIXES`.
  const bare = raw.replace(/\/$/, '')
  for (const reserved of HOST_ROUTE_PREFIXES) {
    const reservedBare = reserved.replace(/\/$/, '')
    if (bare === reservedBare || reserved.startsWith(`${bare}/`)) {
      return {
        ok: false,
        code: BRIDGE_FAULT_CODES.RESERVED_PATH,
        reason: `the route path ${raw} would sit in front of the host's ${reserved} surface; register a path under it instead`
      }
    }
  }
  return { ok: true, path: raw }
}

/**
 * Validate one mediated call before the host applies it.
 *
 * This runs on the host, on data that arrived from the child, which is the only place it can run:
 * a check performed in the child would be a check the plugin's own process could skip.
 *
 * @param {object} call `{ capability, method, args }`
 * @returns {{ok:boolean, code?:string, reason?:string, capability?:object, args?:Array}}
 */
function validateBridgeCall(call) {
  if (!call || typeof call !== 'object') return bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, 'a capability call must be an object')
  const capabilityName = String(call.capability || '')
  const definition = Object.prototype.hasOwnProperty.call(BRIDGE_CAPABILITIES, capabilityName)
    ? BRIDGE_CAPABILITIES[capabilityName]
    : null
  if (!definition) {
    return bridgeFault(BRIDGE_FAULT_CODES.UNKNOWN_CAPABILITY, `${capabilityName || '(nothing)'} is not a capability this bridge provides`, {
      available: BRIDGE_CAPABILITY_IDS
    })
  }
  const method = String(call.method || '')
  if (!definition.methods.includes(method)) {
    return bridgeFault(BRIDGE_FAULT_CODES.UNKNOWN_METHOD, `${capabilityName}.${method || '(nothing)'} is not reachable through the bridge`, {
      available: definition.methods.slice(),
      withheld: definition.withholds.slice()
    })
  }
  if (!Array.isArray(call.args)) return bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, `${capabilityName}.${method} must carry an arguments array`)
  return { ok: true, capability: definition, capabilityName, method, args: call.args }
}

/** How much of a call is retained for the diagnostic surface. */
const CALL_SUMMARY_KEYS = Object.freeze(['kind', 'path', 'namespace', 'name'])

/** A short, safe description of a call's arguments: names only, never values or handlers. */
function summarizeArgs(args) {
  const first = Array.isArray(args) && args[0] && typeof args[0] === 'object' ? args[0] : {}
  const summary = {}
  for (const key of CALL_SUMMARY_KEYS) {
    if (first[key] !== undefined && typeof first[key] !== 'object') summary[key] = String(first[key])
  }
  return summary
}

module.exports = {
  BRIDGE_API_VERSION,
  BRIDGE_CAPABILITIES,
  BRIDGE_CAPABILITY_IDS,
  BRIDGE_MESSAGES,
  BRIDGE_FAULT_CODES,
  BRIDGE_LIMITS,
  BRIDGE_REPORT_PREFIX,
  HOST_ROUTE_PREFIXES,
  bridgeFault,
  normalizeRoutePath,
  validateBridgeCall,
  summarizeArgs
}
