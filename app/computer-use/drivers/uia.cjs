'use strict'

/**
 * Computer Use Runtime: UI Automation accessibility driver (plan section 3.2/27).
 *
 * This is the `accessibility` port from ports.cjs, implemented on top of the
 * real Windows UI Automation tree. The heavy lifting lives in uia.ps1, because
 * UI Automation is only reachable through the .NET client assemblies and
 * powershell.exe is the one .NET host that exists on every supported Windows
 * build without adding a native dependency.
 *
 * Division of labour:
 *   - uia.ps1 reads the tree and acts on it, and answers with one JSON line.
 *   - this file owns the transport (request file, spawnSync, timeout, temp-file
 *     cleanup), the typed failures, option handling and a very short tree cache.
 *
 * Everything here is deliberately suspicious of the backend: a missing
 * powershell.exe, a timeout, empty stdout or a node without the documented
 * fields all become a typed ComputerUseError. A result is never invented.
 *
 * Ref format (produced by uia.ps1, accepted by every method that takes a ref):
 *
 *   w:<hwnd>              the top-level window itself
 *   w:<hwnd>/0.3.2        child 0, then its child 3, then its child 2
 *   w:0                   the desktop root (hwnd 0 = AutomationElement.RootElement)
 *
 * The child index path is positional, so it is only valid while the tree keeps
 * its shape: after a rebuild the same path can address a different control. A
 * path that no longer resolves raises a TARGET_STALE ComputerUseError rather
 * than returning a neighbouring element. A recycled window handle cannot be
 * detected from the ref alone, which is why callers should re-read the tree
 * after every action instead of hoarding refs.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { CODES, ComputerUseError } = require('../errors.cjs')
const { assertPort, unavailable } = require('../ports.cjs')

/** The name reported as `driver.backend`; also the probe detail marker. */
const BACKEND = 'powershell-uia'

/** The backend script, resolved next to this file unless `scriptPath` overrides it. */
const SCRIPT_FILE = 'uia.ps1'

/** The powerShell argv is fixed: -File keeps the script out of the profile's way. */
const POWERSHELL_ARGS = (scriptPath, requestFile) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Request', requestFile]

const DEFAULT_POWERSHELL = 'powershell.exe'
const DEFAULT_TIMEOUT_MS = 8000

/**
 * The probe's own budget: it includes a cold `powershell.exe` start and loading
 * the UIAutomation assemblies, which is not what the steady-state timeout is
 * sized for. A probe that gives up too early reports the accessibility
 * controller as unavailable and makes the runtime refuse work it could do.
 */
const PROBE_TIMEOUT_MS = 25_000
const DEFAULT_CACHE_TTL_MS = 250
const DEFAULT_LIMIT = 50

/**
 * The tree cache may not outlive one settle window: longer than this a cached
 * node would describe a UI that has already moved on.
 */
const CACHE_CEILING_MS = 250

/**
 * A window dump is large (a 4000 node tree is well over the 1 MiB default), and
 * a truncated stdout would look exactly like a broken backend.
 */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024

const REF_PATTERN = /^w:\d+(?:\/\d+(?:\.\d+)*)?$/
const NODE_BOOLEANS = ['enabled', 'focusable', 'focused', 'offscreen']
const RECT_FIELDS = ['x', 'y', 'width', 'height']

/**
 * @typedef {object} UiaDriverOptions
 * @property {string} [powershell] executable to run, default 'powershell.exe'
 * @property {number} [timeoutMs] spawnSync timeout, default 8000
 * @property {string} [scriptPath] absolute path of uia.ps1, default next to this file
 * @property {number} [maxNodes] walk cap handed to the backend, default its own 4000
 * @property {number} [maxDepth] depth cap handed to the backend, default its own 24
 * @property {number} [cacheTtlMs] tree cache lifetime, clamped to 250 ms; 0 disables it
 */

/**
 * @typedef {object} UiaDriver
 * @property {string} backend
 * @property {function(): {available:boolean, reason:string|null, detail:object}} probe
 * @property {function(): object} root
 * @property {function(string, {depth?:number}): object[]} children
 * @property {function(object, {limit?:number}): object[]} find
 * @property {function(string): object} invoke
 * @property {function(string, (string|number|boolean)): object} setValue
 * @property {function(string): object} focus
 * @property {function(string): object} value
 */

/**
 * Builds the accessibility driver. The returned object exposes the whole
 * ACCESSIBILITY_DRIVER_METHODS surface plus `backend`, and is cheap to create:
 * nothing is probed or spawned until a method is called.
 *
 * @param {UiaDriverOptions} [options]
 * @returns {UiaDriver}
 */
function createUiaDriver(options = {}) {
  const powershell = nonEmptyText(options.powershell) || DEFAULT_POWERSHELL
  const timeoutMs = boundedInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 500, 600000)
  const scriptPath = nonEmptyText(options.scriptPath) ? path.resolve(nonEmptyText(options.scriptPath)) : path.join(__dirname, SCRIPT_FILE)
  const cacheTtlMs = clampCacheTtl(options.cacheTtlMs)
  const maxNodes = options.maxNodes === undefined ? null : boundedInt(options.maxNodes, null, 1, 20000)
  const maxDepth = options.maxDepth === undefined ? null : boundedInt(options.maxDepth, null, 1, 64)

  // Keyed by the exact request payload, never persisted: it only exists so the
  // repeated reads inside one settle window do not re-walk the whole tree.
  const cache = new Map()
  let requestCounter = 0

  /**
   * The fields every request carries. Bounds are only sent when the caller set
   * them, so uia.ps1's own documented defaults stay in charge otherwise.
   *
   * @param {string} op
   * @returns {object}
   */
  function baseRequest(op) {
    const request = { op, timeoutMs }
    if (maxNodes !== null) request.maxNodes = maxNodes
    if (maxDepth !== null) request.maxDepth = maxDepth
    return request
  }

  /**
   * Runs one operation through powershell.exe and returns its `result` payload.
   *
   * The request goes to a temp file because command-line length and quoting are
   * both unreliable for a JSON payload with arbitrary names in it, and the file
   * is removed in a finally block so a request that names a window never
   * outlives the call.
   *
   * @param {object} request
   * @returns {object} the backend result, shape depends on the op
   * @throws {ComputerUseError} CONTROLLER_UNAVAILABLE, CONTROLLER_TIMEOUT, or the code uia.ps1 reported
   */
  function call(request) {
    assertWindows()
    const requestFile = nextRequestFile()
    try {
      fs.writeFileSync(requestFile, JSON.stringify(request), 'utf8')
    } catch (error) {
      throw unavailable('accessibility', `the UI Automation request file could not be written: ${error.message}`, { backend: BACKEND, op: request.op, requestFile })
    }

    let result
    try {
      result = spawnSync(powershell, POWERSHELL_ARGS(scriptPath, requestFile), {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_STDOUT_BYTES
      })
    } catch (error) {
      throw unavailable('accessibility', `powershell could not be started (${powershell}): ${error.message}`, { backend: BACKEND, op: request.op, powershell, scriptPath })
    } finally {
      try {
        fs.unlinkSync(requestFile)
      } catch {
        // A leftover temp file is harmless; masking a real failure would not be.
      }
    }

    return readPayload(result, request)
  }

  /**
   * Reads the single JSON response line and turns every failure mode into a
   * typed error. The exit code is deliberately not trusted on its own: uia.ps1
   * always exits 0 and reports through the payload.
   *
   * @param {object} result spawnSync result
   * @param {object} request the request that produced it, for context
   * @returns {object}
   */
  function readPayload(result, request) {
    const stdout = typeof result.stdout === 'string' ? result.stdout : ''
    const stderr = trimText(typeof result.stderr === 'string' ? result.stderr : '')
    const details = {
      backend: BACKEND,
      op: request.op,
      ref: typeof request.ref === 'string' ? request.ref : null,
      status: result.status === undefined ? null : result.status,
      signal: result.signal || null,
      stderr: stderr || null
    }

    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') throw timeoutFailure(request, result, stderr)
      if (result.error.code === 'ENOENT') {
        throw unavailable('accessibility', `powershell was not found ("${powershell}") or uia.ps1 is missing ("${scriptPath}"): ${result.error.message}`, details)
      }
      throw unavailable('accessibility', `powershell could not run uia.ps1: ${result.error.message}${stderrSuffix(stderr)}`, details)
    }
    // spawnSync reports the timeout kill as SIGTERM with no exit code.
    if (result.signal === 'SIGTERM' || result.status === null) throw timeoutFailure(request, result, stderr)

    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const last = lines.length ? lines[lines.length - 1] : ''
    if (!last) {
      throw unavailable('accessibility', `uia.ps1 answered op "${request.op}" with no JSON on stdout (exit ${result.status})${stderrSuffix(stderr)}`, { ...details, stdout: null })
    }

    let payload
    try {
      payload = JSON.parse(last)
    } catch (error) {
      throw unavailable('accessibility', `uia.ps1 answered op "${request.op}" with unparsable output (${error.message}): ${clipText(last)}${stderrSuffix(stderr)}`, { ...details, stdout: clipText(last) })
    }
    if (!payload || typeof payload !== 'object') {
      throw unavailable('accessibility', `uia.ps1 answered op "${request.op}" with a JSON value that is not a response object`, { ...details, stdout: clipText(last) })
    }

    if (payload.ok === true) return payload.result
    const reported = typeof payload.code === 'string' && typeof CODES[payload.code] === 'string' ? CODES[payload.code] : null
    const message = typeof payload.error === 'string' && payload.error ? payload.error : 'no reason was reported'
    throw new ComputerUseError(reported || CODES.CONTROLLER_FAILED, `${request.op} failed: ${message}${stderrSuffix(stderr)}`, { ...details, reportedCode: payload.code || null })
  }

  /**
   * A read whose answer may be reused for the cache TTL. Stored as JSON so every
   * caller gets its own object graph and cannot poison the cache by mutating it.
   *
   * @param {object} request
   * @returns {object}
   */
  function cachedCall(request) {
    const key = JSON.stringify(request)
    if (cacheTtlMs > 0) {
      const hit = cache.get(key)
      if (hit) {
        if (Date.now() - hit.at <= cacheTtlMs) return JSON.parse(hit.json)
        cache.delete(key)
      }
    }
    const value = call(request)
    if (cacheTtlMs > 0 && value !== null && typeof value === 'object') cache.set(key, { at: Date.now(), json: JSON.stringify(value) })
    return value
  }

  /**
   * A mutating call. Anything the cache holds may describe an element that the
   * action just replaced, renumbered or destroyed, so it is dropped in a finally
   * block: a mutation that throws halfway may still have changed the UI.
   *
   * @param {object} request
   * @returns {object}
   */
  function mutatingCall(request) {
    try {
      return call(request)
    } finally {
      cache.clear()
    }
  }

  /**
   * @returns {string} a unique path in the OS temp directory
   */
  function nextRequestFile() {
    requestCounter += 1
    return path.join(os.tmpdir(), `dsh-uia-${process.pid}-${Date.now().toString(36)}-${requestCounter}.json`)
  }

  /**
   * Reports whether this machine can drive UI Automation at all: powershell.exe
   * present, the UIAutomationClient/UIAutomationTypes assemblies loaded, and the
   * automation root reachable. Never throws, because a probe that throws cannot
   * be used to route around a broken port (ports.cjs fault isolation): a
   * transport failure is reported as the reason instead.
   *
   * @returns {{available:boolean, reason:string|null, detail:object}} plain serializable verdict
   */
  function probe() {
    if (process.platform !== 'win32') {
      return { available: false, reason: 'windows-only', detail: { backend: BACKEND, platform: process.platform } }
    }

    let result
    try {
      // The probe pays for a cold PowerShell start plus loading the UIAutomation
      // assemblies, which can exceed the per-call budget on a busy desktop. It is
      // the one call that must not be judged by the steady-state timeout: a
      // timeout here wrongly reports the whole accessibility controller as
      // unavailable, and the runtime then refuses desktop work it could do.
      result = call({ op: 'probe', timeoutMs: Math.max(timeoutMs, PROBE_TIMEOUT_MS) })
    } catch (error) {
      return {
        available: false,
        reason: `the uia.ps1 probe could not run: ${error.message}`,
        detail: {
          backend: BACKEND,
          platform: process.platform,
          powershell,
          scriptPath,
          code: error.code || null,
          stderr: error.details && error.details.stderr ? error.details.stderr : null
        }
      }
    }

    if (!result || typeof result !== 'object') {
      return { available: false, reason: 'uia.ps1 returned no probe payload', detail: { backend: BACKEND, powershell, scriptPath } }
    }
    const detail = {
      backend: BACKEND,
      powershell: nonEmptyText(result.powershell) || null,
      root: typeof result.root === 'string' ? result.root : null,
      nodes: Number.isFinite(Number(result.nodes)) ? Number(result.nodes) : 0,
      assemblies: result.assemblies === true,
      scriptPath
    }
    if (result.assemblies !== true) {
      return { available: false, reason: textOr(result.error, 'the UI Automation assemblies are not available'), detail }
    }
    if (result.rootAvailable !== true) {
      return { available: false, reason: textOr(result.error, 'the UI Automation root is not reachable (no interactive desktop?)'), detail }
    }
    return { available: true, reason: null, detail }
  }

  /**
   * Reads the desktop root as an AxNode with role 'desktop' and ref 'w:0'.
   *
   * @returns {object} AxNode
   * @throws {ComputerUseError} CONTROLLER_UNAVAILABLE when UI Automation is not usable here
   */
  function root() {
    const result = cachedCall(baseRequest('root'))
    if (!result || typeof result !== 'object') throw contractFailure('root', 'a result object')
    return assertNode(result.node, 'root')
  }

  /**
   * Lists the children of a ref. `depth` counts levels below the ref and
   * defaults to 1, so `children(ref)` means the direct children; a deeper value
   * walks that many levels, bounded by maxNodes and by the backend clock.
   *
   * @param {string} ref a ref such as 'w:0' or 'w:1234/0.3'
   * @param {{depth?:number}} [options]
   * @returns {object[]} AxNode[]; carries `truncated: true` when the node or time budget cut the walk short
   * @throws {ComputerUseError} TARGET_STALE when the ref no longer resolves
   */
  function children(ref, { depth } = {}) {
    const target = assertRef(ref, 'children')
    const request = { ...baseRequest('children'), ref: target, depth: normalizeDepth(depth, 1) }
    return nodeList(cachedCall(request), 'children')
  }

  /**
   * Finds automation elements across the whole desktop, not just the root's
   * direct children, so a control can be located without knowing its window.
   *
   * `exact !== false` matches the name exactly (UIA ordinal comparison), while
   * `exact: false` matches a case-insensitive substring, which no native
   * condition can express and therefore costs a bounded tree sweep.
   *
   * @param {{name?:string, role?:string, controlType?:string, automationId?:string, className?:string, windowHandle?:(string|number), processId?:number, exact?:boolean}} [criteria]
   * @param {{limit?:number}} [options] limit defaults to 50
   * @returns {object[]} AxNode[]; carries `truncated: true` when the search stopped at its node, depth or time budget
   */
  function find(criteria = {}, options = {}) {
    if (criteria === null || typeof criteria !== 'object') {
      throw new ComputerUseError(CODES.TARGET_INVALID, 'find needs a criteria object such as { name: "Save" }', { received: criteria === null ? 'null' : typeof criteria })
    }
    const request = { ...baseRequest('find'), limit: normalizeLimit(options.limit, DEFAULT_LIMIT), exact: criteria.exact !== false }
    assignText(request, 'name', criteria.name)
    assignText(request, 'role', criteria.role)
    assignText(request, 'controlType', criteria.controlType)
    assignText(request, 'automationId', criteria.automationId)
    assignText(request, 'className', criteria.className)
    if (criteria.windowHandle !== undefined && criteria.windowHandle !== null) request.windowHandle = String(criteria.windowHandle)
    if (criteria.processId !== undefined && criteria.processId !== null) request.processId = boundedInt(criteria.processId, null, 1, 2147483647, 'processId')
    return nodeList(cachedCall(request), 'find')
  }

  /**
   * Invokes a ref through the first pattern that applies, and reports which one
   * it was: InvokePattern, then SelectionItemPattern, ExpandCollapsePattern and
   * TogglePattern. The receipt names the pattern so a run can be audited for
   * "what did this click actually do".
   *
   * @param {string} ref
   * @returns {{ok:true, pattern:string, ref:string, name:string, role:string}}
   * @throws {ComputerUseError} TARGET_NOT_ACTIONABLE when no pattern applies
   */
  function invoke(ref) {
    const target = assertRef(ref, 'invoke')
    const result = mutatingCall({ ...baseRequest('invoke'), ref: target })
    if (!result || result.ok !== true || typeof result.pattern !== 'string') throw contractFailure('invoke', 'a receipt naming the pattern it used')
    return result
  }

  /**
   * Writes a value through ValuePattern. A read-only element is refused
   * (SAFETY_REFUSED) instead of reporting a write the UI ignored, and an element
   * without ValuePattern is TARGET_NOT_ACTIONABLE.
   *
   * @param {string} ref
   * @param {string|number|boolean} value
   * @returns {{ok:true, pattern:'ValuePattern', ref:string, name:string, requested:string, observed:(string|null), readOnly:false}}
   * @throws {ComputerUseError} SAFETY_REFUSED for a read-only element, TARGET_NOT_ACTIONABLE without ValuePattern
   */
  function setValue(ref, value) {
    const target = assertRef(ref, 'setValue')
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ComputerUseError(CODES.ACTION_INVALID, 'setValue needs a string value to write', { ref: target, received: value === null ? 'null' : typeof value })
    }
    const result = mutatingCall({ ...baseRequest('setValue'), ref: target, value: String(value) })
    if (!result || result.ok !== true) throw contractFailure('setValue', 'a receipt for the value it wrote')
    return result
  }

  /**
   * Moves keyboard focus to a ref and reports the state that was read back after
   * the call, not the state that was requested.
   *
   * @param {string} ref
   * @returns {{ok:true, ref:string, name:string, role:string, focused:boolean, focusable:boolean}}
   * @throws {ComputerUseError} TARGET_STALE when the element disappeared before it could be focused
   */
  function focus(ref) {
    const target = assertRef(ref, 'focus')
    const result = mutatingCall({ ...baseRequest('focus'), ref: target })
    if (!result || result.ok !== true || typeof result.focused !== 'boolean') throw contractFailure('focus', 'the resulting focus state')
    return result
  }

  /**
   * Reads the value-ish state of a ref: ValuePattern (value and readOnly) and
   * TogglePattern, either of which may be null when the element has no such
   * pattern. Nothing is inferred from the role.
   *
   * @param {string} ref
   * @returns {{ok:true, ref:string, name:string, role:string, value:(string|null), readOnly:(boolean|null), toggle:(string|null), patterns:string[]}}
   */
  function value(ref) {
    const target = assertRef(ref, 'value')
    const result = cachedCall({ ...baseRequest('value'), ref: target })
    if (!result || result.ok !== true || !Array.isArray(result.patterns)) throw contractFailure('value', 'a value payload')
    return result
  }

  /**
   * Fails on a non-Windows host with the port's typed unavailable error, so the
   * runtime can route around this driver instead of seeing a spawn failure.
   */
  function assertWindows() {
    if (process.platform !== 'win32') {
      throw unavailable('accessibility', 'the UI Automation driver is Windows-only', { backend: BACKEND, platform: process.platform })
    }
  }

  // A wiring bug must fail loudly at construction rather than as a confusing
  // "driver.invoke is not a function" in the middle of a run (ports.cjs).
  return assertPort('accessibility', {
    backend: BACKEND,
    probe,
    root,
    children,
    find,
    invoke,
    setValue,
    focus,
    value
  })
}

/**
 * Turns a timeout into the typed failure the recovery ladder understands.
 *
 * @param {object} request
 * @param {object} result spawnSync result
 * @param {string} stderr already trimmed
 * @returns {ComputerUseError}
 */
function timeoutFailure(request, result, stderr) {
  return new ComputerUseError(CODES.CONTROLLER_TIMEOUT, `uia.ps1 did not answer op "${request.op}" within its timeout${result.signal ? ` (${result.signal})` : ''}${stderrSuffix(stderr)}`, {
    backend: BACKEND,
    op: request.op,
    ref: typeof request.ref === 'string' ? request.ref : null,
    signal: result.signal || null,
    stderr: stderr || null
  })
}

/**
 * Checks that a backend node carries the whole documented AxNode surface. The
 * check exists so a broken uia.ps1 is reported instead of handing the runtime a
 * node with missing fields that later reads as "no such control".
 *
 * @param {object} node
 * @param {string} op
 * @returns {object} the same node
 * @throws {ComputerUseError} CONTROLLER_FAILED when a field is missing or mistyped
 */
function assertNode(node, op) {
  if (!node || typeof node !== 'object') throw contractFailure(op, 'a node object')
  if (typeof node.ref !== 'string' || !node.ref) throw contractFailure(op, 'node.ref as a non-empty string')
  if (typeof node.role !== 'string') throw contractFailure(op, 'node.role as a string')
  if (typeof node.name !== 'string') throw contractFailure(op, 'node.name as a string')
  if (typeof node.value !== 'string') throw contractFailure(op, 'node.value as a string')
  for (const field of NODE_BOOLEANS) {
    if (typeof node[field] !== 'boolean') throw contractFailure(op, `node.${field} as a boolean`)
  }
  if (!node.bounds || typeof node.bounds !== 'object') throw contractFailure(op, 'node.bounds as a rectangle')
  for (const field of RECT_FIELDS) {
    if (!Number.isFinite(Number(node.bounds[field]))) throw contractFailure(op, `node.bounds.${field} as a number`)
  }
  if (!Array.isArray(node.patterns)) throw contractFailure(op, 'node.patterns as an array')
  if (!Number.isFinite(Number(node.processId))) throw contractFailure(op, 'node.processId as a number')
  if (typeof node.windowHandle !== 'string') throw contractFailure(op, 'node.windowHandle as a string')
  if (!Number.isFinite(Number(node.childrenCount))) throw contractFailure(op, 'node.childrenCount as a number')
  return node
}

/**
 * Reads a node list out of a backend payload.
 *
 * @param {object} result
 * @param {string} op
 * @returns {object[]} AxNode[]
 */
function nodeList(result, op) {
  if (!result || !Array.isArray(result.nodes)) throw contractFailure(op, 'a nodes array')
  const nodes = result.nodes.map((node) => assertNode(node, op))
  // The backend flags a walk that its node or time budget cut short; the flag
  // rides on the array so a partial tree is never mistaken for a complete one.
  if (result.truncated === true) nodes.truncated = true
  return nodes
}

/**
 * @param {string} op
 * @param {string} expected
 * @returns {ComputerUseError}
 */
function contractFailure(op, expected) {
  return new ComputerUseError(CODES.CONTROLLER_FAILED, `uia.ps1 did not return ${expected} for op "${op}"`, { backend: BACKEND, op, expected })
}

/**
 * Validates a ref before it reaches the backend, so a malformed handle is a
 * caller error (TARGET_INVALID) and not a powershell round trip.
 *
 * @param {string} ref
 * @param {string} method
 * @returns {string} the trimmed ref
 */
function assertRef(ref, method) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new ComputerUseError(CODES.TARGET_INVALID, `${method} needs a ref such as "w:1234/0.3" or "w:0"`, { received: ref === undefined ? 'undefined' : String(ref) })
  }
  const trimmed = ref.trim()
  if (!REF_PATTERN.test(trimmed)) {
    throw new ComputerUseError(CODES.TARGET_INVALID, `${method} received a malformed ref "${trimmed}": expected w:<hwnd>[/<child index path>]`, { ref: trimmed })
  }
  return trimmed
}

/**
 * Copies one optional text criterion, rejecting an explicitly empty one instead
 * of silently reading it as "no filter" (which would match everything).
 *
 * @param {object} request
 * @param {string} key
 * @param {*} value
 */
function assignText(request, key, value) {
  if (value === undefined || value === null) return
  const text = String(value)
  if (!text) {
    throw new ComputerUseError(CODES.ACTION_INVALID, `find received an empty ${key}: omit it to leave the criterion out`, { criteria: key })
  }
  request[key] = text
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeDepth(value, fallback) {
  if (value === undefined || value === null) return fallback
  return boundedInt(value, null, 0, 64, 'depth')
}

/**
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeLimit(value, fallback) {
  if (value === undefined || value === null) return fallback
  return boundedInt(value, null, 1, 500, 'limit')
}

/**
 * Parses an integer option and keeps it inside the range the backend can honour.
 * A non-null `fallback` means "tuning knob, absorb bad input"; `null` means the
 * value is a real argument and bad input has to be reported.
 *
 * @param {*} value
 * @param {number|null} fallback returned for undefined, null or unusable input
 * @param {number} min
 * @param {number} max
 * @param {string} [label] used in the failure when fallback is null
 * @returns {number|null}
 */
function boundedInt(value, fallback, min, max, label = 'value') {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isInteger(number)) {
    if (fallback !== null) return fallback
    throw new ComputerUseError(CODES.ACTION_INVALID, `${label} must be an integer, received ${clipText(String(value))}`, { [label]: String(value) })
  }
  if (number < min || number > max) {
    if (fallback !== null) return fallback
    throw new ComputerUseError(CODES.ACTION_INVALID, `${label} must be between ${min} and ${max}, received ${number}`, { [label]: number })
  }
  return number
}

/**
 * The tree cache may never outlive one settle window (see CACHE_CEILING_MS).
 *
 * @param {*} value
 * @returns {number}
 */
function clampCacheTtl(value) {
  if (value === undefined || value === null) return DEFAULT_CACHE_TTL_MS
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return DEFAULT_CACHE_TTL_MS
  return Math.min(CACHE_CEILING_MS, Math.floor(number))
}

/**
 * @param {*} value
 * @returns {string|null}
 */
function nonEmptyText(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * @param {*} value
 * @param {string} fallback
 * @returns {string}
 */
function textOr(value, fallback) {
  return typeof value === 'string' && value ? value : fallback
}

/**
 * @param {string} value
 * @returns {string}
 */
function trimText(value) {
  const trimmed = value.trim()
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}...` : trimmed
}

/**
 * @param {string} value
 * @returns {string}
 */
function clipText(value) {
  return value.length > 400 ? `${value.slice(0, 400)}...` : value
}

/**
 * @param {string} stderr already trimmed
 * @returns {string} '' or a message suffix
 */
function stderrSuffix(stderr) {
  return stderr ? ` (stderr: ${stderr})` : ''
}

module.exports = { createUiaDriver }
