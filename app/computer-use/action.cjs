'use strict'

/**
 * Computer Use Runtime: the Action Contract (plan §6, §16).
 *
 * Every interaction with the machine — a click, a keystroke, a shell command, a
 * screenshot — is described by *one* schema before anything happens. The
 * executor refuses to run an action it cannot validate, which is what keeps the
 * upper layers from smuggling a raw pyautogui-style script past the runtime
 * (plan §6: "上层不应直接生成 pyautogui 脚本").
 *
 * The schema is intentionally declarative: a target (how to find the thing), a
 * precondition (what must already be true), a stabilization window (how long to
 * let the UI settle), an expected effect (how success will be *verified*) and a
 * bounded retry budget. Verification is part of the action, never an
 * afterthought (plan §14).
 */

const { ACTION_TYPES, ACTION_TYPE_LIST, ACTION_CAPABILITY, TIMING, RETRY, DESTRUCTIVE_KINDS } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
const { normalizeTarget, describeTarget } = require('./target.cjs')

const VALID_ACTION_TYPES = new Set(ACTION_TYPE_LIST)

/** Per-type parameter requirements, checked without guessing. */
const PARAM_RULES = Object.freeze({
  [ACTION_TYPES.MOVE]: { any: ['point', 'target'] },
  [ACTION_TYPES.CLICK]: { any: ['target', 'point'] },
  [ACTION_TYPES.DOUBLE_CLICK]: { any: ['target', 'point'] },
  [ACTION_TYPES.RIGHT_CLICK]: { any: ['target', 'point'] },
  [ACTION_TYPES.TYPE]: { requires: ['text'] },
  [ACTION_TYPES.KEY_PRESS]: { requires: ['key'] },
  [ACTION_TYPES.HOTKEY]: { requires: ['keys'] },
  [ACTION_TYPES.SCROLL]: { any: ['target', 'point', 'dy', 'dx'], requires: [] },
  [ACTION_TYPES.DRAG]: { requires: ['from', 'to'] },
  [ACTION_TYPES.FOCUS]: { any: ['target', 'window'] },
  [ACTION_TYPES.SELECT]: { requires: ['target'], any: ['value', 'text', 'index'] },
  [ACTION_TYPES.OPEN_APP]: { requires: ['application'] },
  [ACTION_TYPES.CLOSE_WINDOW]: { any: ['target', 'window'], requires: [] },
  [ACTION_TYPES.SWITCH_WINDOW]: { any: ['target', 'window'], requires: [] },
  [ACTION_TYPES.BROWSER_NAVIGATE]: { requires: ['url'] },
  [ACTION_TYPES.BROWSER_BACK]: {},
  [ACTION_TYPES.BROWSER_FORWARD]: {},
  [ACTION_TYPES.BROWSER_REFRESH]: {},
  [ACTION_TYPES.DOM_CLICK]: { requires: ['target'] },
  [ACTION_TYPES.DOM_TYPE]: { requires: ['target'], any: ['text', 'value'] },
  [ACTION_TYPES.DOM_SELECT]: { requires: ['target'], any: ['value', 'text', 'index'] },
  [ACTION_TYPES.ACCESSIBILITY_INVOKE]: { requires: ['target'] },
  [ACTION_TYPES.ACCESSIBILITY_SET_VALUE]: { requires: ['target'], any: ['value', 'text'] },
  [ACTION_TYPES.SHELL_EXEC]: { requires: ['command'] },
  [ACTION_TYPES.FILE_READ]: { requires: ['path'] },
  [ACTION_TYPES.FILE_WRITE]: { requires: ['path'], any: ['content', 'text'] },
  [ACTION_TYPES.FILE_COPY]: { requires: ['path'], any: ['to', 'destination'] },
  [ACTION_TYPES.FILE_MOVE]: { requires: ['path'], any: ['to', 'destination'] },
  [ACTION_TYPES.FILE_DELETE]: { requires: ['path'] },
  [ACTION_TYPES.FILE_MKDIR]: { requires: ['path'] },
  [ACTION_TYPES.FILE_EXISTS]: { requires: ['path'] },
  [ACTION_TYPES.WAIT_EVENT]: { any: ['waitFor', 'event'] },
  [ACTION_TYPES.WAIT_STATE]: { any: ['expect', 'target', 'waitFor'] },
  [ACTION_TYPES.SCREENSHOT_REGION]: { any: ['target', 'clip', 'region'] },
  [ACTION_TYPES.SCREENSHOT_WINDOW]: { any: ['window', 'target'], requires: [] },
  [ACTION_TYPES.SCREENSHOT_FULL]: { requires: [] }
})

const EXPECTED_EFFECT_KEYS = Object.freeze([
  'toast',
  'text_appears',
  'text_disappears',
  'control_state_changed',
  'target_disappears',
  'target_appears',
  'url_changed',
  'url_matches',
  'file_created',
  'file_modified',
  'file_exists',
  'file_missing',
  'process_exited',
  'exit_code',
  'stdout_matches',
  'stderr_matches',
  'focus_changed',
  'window_changed',
  'value_equals',
  'checked_equals',
  'dom_mutated',
  'navigation',
  'visual_change',
  'event'
])

function invalid(message, details) {
  return new ComputerUseError(CODES.ACTION_INVALID, message, details)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalizes the many shapes an author may write into one action object.
 * Accepted inputs:
 *   - a bare action type string ('BROWSER_REFRESH')
 *   - `{ type, target, ... }`
 *   - `{ action: { type, target, ... } }` (the YAML shape in plan §16)
 */
function normalizeAction(input, options = {}) {
  if (typeof input === 'string') return buildAction({ type: input }, options)
  if (!isPlainObject(input)) throw invalid('an action must be an object or an action type string', { received: typeof input })
  const body = isPlainObject(input.action) ? { ...input.action, ...omit(input, ['action']) } : input
  return buildAction(body, options)
}

function omit(object, keys) {
  const out = {}
  for (const [key, value] of Object.entries(object)) if (!keys.includes(key)) out[key] = value
  return out
}

function buildAction(body, options = {}) {
  const type = String(body.type || body.actionType || '').toUpperCase()
  if (!VALID_ACTION_TYPES.has(type)) {
    throw invalid(`unsupported action type: ${body.type || '(missing)'}`, { type: body.type || null, supported: ACTION_TYPE_LIST })
  }
  const target = body.target === undefined || body.target === null ? null : normalizeTarget(body.target)
  const params = {
    ...(isPlainObject(body.params) ? body.params : {}),
    ...collectParams(body, type)
  }
  const action = {
    type,
    capability: ACTION_CAPABILITY[type] || 'desktop',
    target,
    params,
    // Plan §16: precondition.target_exists / target_enabled are first-class.
    precondition: normalizePrecondition(body.precondition),
    stabilization: normalizeStabilization(body.stabilization, options),
    expectedEffect: normalizeExpectedEffect(body.expected_effect || body.expectedEffect),
    timeoutMs: positiveOr(body.timeout_ms ?? body.timeoutMs, TIMING.defaultActionTimeoutMs),
    retry: normalizeRetry(body.retry, options),
    destructive: normalizeDestructive(body.destructive || body.safety),
    id: body.id ? String(body.id) : null,
    description: body.description ? String(body.description) : null,
    // Plan §39: the log records what was asked for, not the secrets typed into it.
    sensitive: Boolean(body.sensitive || body.secret)
  }
  validateAction(action)
  return action
}

function collectParams(body, type) {
  const params = {}
  const copy = [
    'point', 'clip', 'region', 'text', 'value', 'key', 'keys', 'url', 'command', 'args', 'cwd',
    'application', 'window', 'target', 'from', 'to', 'dx', 'dy', 'waitFor', 'event', 'expect',
    'timeout_ms', 'expectExitCode', 'shell', 'stdin', 'env', 'tabId', 'page', 'path', 'content',
    'destination', 'encoding', 'overwrite', 'recursive'
  ]
  for (const key of copy) {
    if (body[key] !== undefined) params[key] = body[key]
  }
  if (Array.isArray(body.keys)) params.keys = body.keys.map((key) => String(key))
  if (params.args !== undefined && !Array.isArray(params.args)) params.args = [String(params.args)]
  return params
}

function normalizePrecondition(input) {
  const raw = isPlainObject(input) ? input : {}
  return {
    targetExists: raw.target_exists === undefined ? true : Boolean(raw.target_exists),
    targetEnabled: raw.target_enabled === undefined ? true : Boolean(raw.target_enabled),
    targetVisible: raw.target_visible === undefined ? true : Boolean(raw.target_visible),
    windowForeground: raw.window_foreground === undefined ? null : Boolean(raw.window_foreground),
    focusMatches: raw.focus_matches === undefined ? null : Boolean(raw.focus_matches),
    custom: Array.isArray(raw.custom) ? raw.custom.slice() : []
  }
}

/**
 * Plan §9/§16: the pre-action settling window. `minimum_ms` is what the author
 * asks for; it is clamped into the documented band so an action cannot order a
 * two-second sleep and call it stabilization (plan §25).
 */
function normalizeStabilization(input, options = {}) {
  const raw = isPlainObject(input) ? input : {}
  const min = numberOr(raw.minimum_ms ?? raw.minimumMs, null)
  const requested = min === null ? options.settleMinMs ?? TIMING.settleMinMs : min
  const maximum = numberOr(raw.maximum_ms ?? raw.maximumMs, TIMING.settleMaxMs)
  return {
    minimumMs: clamp(requested, 0, TIMING.settleMaxMs),
    maximumMs: clamp(maximum, 0, TIMING.settleMaxMs),
    requireStable: raw.require_stable === undefined ? true : Boolean(raw.require_stable),
    waitForQuiet: raw.wait_for_quiet === undefined ? true : Boolean(raw.wait_for_quiet)
  }
}

function normalizeExpectedEffect(input) {
  if (input === undefined || input === null) return null
  if (typeof input === 'string') return { any: [{ event: input }] }
  if (Array.isArray(input)) return { any: input.map(normalizeEffect) }
  if (!isPlainObject(input)) throw invalid('expected_effect must be an object, string or array', { received: typeof input })
  if (Array.isArray(input.any)) return { any: input.any.map(normalizeEffect), mode: 'any' }
  if (Array.isArray(input.all)) return { all: input.all.map(normalizeEffect), mode: 'all' }
  return { any: [normalizeEffect(input)], mode: 'any' }
}

function normalizeEffect(effect) {
  if (typeof effect === 'string') return { event: effect }
  if (!isPlainObject(effect)) throw invalid('an expected effect must be an object', { received: typeof effect })
  const out = {}
  for (const [key, value] of Object.entries(effect)) {
    const normalizedKey = key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
    if (!EXPECTED_EFFECT_KEYS.includes(normalizedKey)) {
      throw invalid(`unknown expected_effect key: ${key}`, { key, supported: EXPECTED_EFFECT_KEYS })
    }
    out[normalizedKey] = value
  }
  if (!Object.keys(out).length) throw invalid('an expected effect needs at least one signal')
  return out
}

function normalizeRetry(input, options = {}) {
  const raw = isPlainObject(input) ? input : {}
  const maxAttempts = clamp(
    numberOr(raw.max_attempts ?? raw.maxAttempts, options.maxRetriesPerAction ?? RETRY.maxAttempts),
    0,
    5
  )
  return {
    maxAttempts,
    // Plan §18: the second attempt must not be a blind repeat — it uses a
    // different interaction channel where one exists.
    allowAlternative: raw.allow_alternative === undefined ? true : Boolean(raw.allow_alternative),
    backoffMs: clamp(numberOr(raw.backoff_ms ?? raw.backoffMs, TIMING.cooldownBaseMs), 0, TIMING.cooldownSoftMaxMs)
  }
}

function normalizeDestructive(input) {
  if (input === true) return { kinds: ['DELETE'], explicit: true }
  if (input === false || input === undefined || input === null) return null
  if (typeof input === 'string') return { kinds: [input.toUpperCase()], explicit: true }
  if (isPlainObject(input)) {
    const kinds = []
    if (Array.isArray(input.kinds)) for (const kind of input.kinds) kinds.push(String(kind).toUpperCase())
    if (input.kind) kinds.push(String(input.kind).toUpperCase())
    for (const key of DESTRUCTIVE_KINDS) if (input[key.toLowerCase()] === true) kinds.push(key)
    return { kinds: kinds.length ? kinds : ['DELETE'], explicit: input.explicit === undefined ? true : Boolean(input.explicit) }
  }
  throw invalid('destructive must be a boolean, a kind string or an object', { received: typeof input })
}

/**
 * Plan §16: an action that is missing the thing it must act on is rejected at
 * build time, not discovered halfway through an execution run.
 */
function validateAction(action) {
  const rules = PARAM_RULES[action.type] || {}
  for (const key of rules.requires || []) {
    const value = action.params[key]
    if (value === undefined || value === null || value === '') {
      throw invalid(`${action.type} requires "${key}"`, { type: action.type, missing: key })
    }
  }
  if (rules.any && rules.any.length) {
    const present = rules.any.some((key) => {
      const value = action.params[key] !== undefined ? action.params[key] : action.target
      return value !== undefined && value !== null && value !== ''
    })
    if (!present) throw invalid(`${action.type} requires one of: ${rules.any.join(', ')}`, { type: action.type, requiredAny: rules.any })
  }
  if (action.type === ACTION_TYPES.TYPE && typeof action.params.text !== 'string') {
    throw invalid('TYPE requires text to be a string', { received: typeof action.params.text })
  }
  if (action.type === ACTION_TYPES.HOTKEY && (!Array.isArray(action.params.keys) || action.params.keys.length === 0)) {
    throw invalid('HOTKEY requires a non-empty keys array')
  }
  if (action.type === ACTION_TYPES.SHELL_EXEC && typeof action.params.command !== 'string') {
    throw invalid('SHELL_EXEC requires command to be a string')
  }
  if (action.stabilization.minimumMs > action.stabilization.maximumMs) {
    throw invalid('stabilization.minimum_ms may not exceed stabilization.maximum_ms', {
      minimumMs: action.stabilization.minimumMs,
      maximumMs: action.stabilization.maximumMs
    })
  }
  return action
}

/** True when the action needs a resolved target before it can be executed. */
function requiresTarget(action) {
  if (action.target) {
    return true
  }
  return [ACTION_TYPES.CLICK, ACTION_TYPES.DOUBLE_CLICK, ACTION_TYPES.RIGHT_CLICK, ACTION_TYPES.DOM_CLICK,
    ACTION_TYPES.DOM_TYPE, ACTION_TYPES.DOM_SELECT, ACTION_TYPES.ACCESSIBILITY_INVOKE,
    ACTION_TYPES.ACCESSIBILITY_SET_VALUE, ACTION_TYPES.FOCUS, ACTION_TYPES.SELECT].includes(action.type)
}

/** A short, log-safe description of the action (plan §39). */
function describeAction(action) {
  const parts = [action.type]
  if (action.target) parts.push(describeTarget(action.target))
  const params = { ...action.params }
  if (typeof params.text === 'string') params.text = action.sensitive ? '[redacted]' : truncate(params.text, 60)
  if (typeof params.value === 'string' && action.sensitive) params.value = '[redacted]'
  if (params.command) params.command = truncate(params.command, 80)
  const keys = Object.keys(params)
  if (keys.length) parts.push(keys.map((key) => `${key}=${JSON.stringify(params[key])}`).join(' '))
  return parts.join(' ')
}

function truncate(value, max) {
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** Plan §34: the executor asks this before running anything dangerous. */
function destructiveKinds(action) {
  if (action.destructive && Array.isArray(action.destructive.kinds) && action.destructive.kinds.length) {
    return action.destructive.kinds.slice()
  }
  const kinds = []
  // A file deletion is a deletion, whether it is expressed as a structured
  // action or as a shell command (plan §34).
  if (action.type === ACTION_TYPES.FILE_DELETE) kinds.push('DELETE')
  const command = String(action.params.command || '')
  if (action.type === ACTION_TYPES.SHELL_EXEC) {
    if (/\b(rm|del|erase|rmdir|rd|Remove-Item)\b/i.test(command)) kinds.push('DELETE')
    if (/\b(format|diskpart)\b/i.test(command)) kinds.push('FORMAT')
    if (/\b(npm i|npm install|pip install|winget install|choco install|Install-)\b/i.test(command)) kinds.push('INSTALL')
    if (/\b(git push)\b/i.test(command)) kinds.push('PUBLISH')
  }
  return kinds
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function positiveOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

module.exports = {
  VALID_ACTION_TYPES,
  EXPECTED_EFFECT_KEYS,
  PARAM_RULES,
  normalizeAction,
  validateAction,
  normalizeExpectedEffect,
  normalizeStabilization,
  normalizePrecondition,
  normalizeRetry,
  normalizeDestructive,
  requiresTarget,
  describeAction,
  destructiveKinds
}
