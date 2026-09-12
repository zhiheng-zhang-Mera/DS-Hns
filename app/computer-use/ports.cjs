'use strict'

/**
 * Computer Use Runtime: ports.
 *
 * The runtime never talks to Chromium, user32, UI Automation or the disk
 * directly. It talks to *ports* — small, documented interfaces — and the host
 * injects one implementation per port. That is what makes three things true at
 * once:
 *
 *  1. Fault isolation (plan §37/§38): a port that is missing, broken or slow
 *     degrades one controller instead of the whole runtime.
 *  2. Structure first (plan §3/§55): perception is read from structured ports
 *     (DOM, accessibility, window state, filesystem), never from pixels by
 *     default.
 *  3. Testability without pretending: the acceptance harness injects a real
 *     Chromium page over CDP and real Windows drivers, while unit tests inject
 *     an in-process device that implements exactly this document.
 *
 * Every function below is documented as a contract, not as a suggestion. A port
 * implementation that cannot honour a method must say so through `probe()` and
 * leave the method throwing `CONTROLLER_UNAVAILABLE`, so the runtime can route
 * around it and report *why* — never silently return a made-up value.
 */

const { CODES, ComputerUseError } = require('./errors.cjs')

/**
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} ElementDescriptor
 * @property {string} ref            stable handle inside the current revision
 * @property {string} tag            lower-case tag name, or a synthetic role
 * @property {string} role           ARIA/semantic role (button, textbox, link…)
 * @property {string} name           accessible name
 * @property {string} [text]         visible text
 * @property {string} [value]        current control value
 * @property {boolean} [checked]     checkbox/radio state
 * @property {boolean} disabled
 * @property {boolean} visible
 * @property {boolean} actionable    can be clicked/typed into at all
 * @property {Rect} bbox             viewport coordinates
 * @property {string|null} selector  a CSS selector that resolves back to it
 * @property {object} [attributes]   small attribute bag (id, class, type, href…)
 */

/**
 * @typedef {object} PageSnapshot
 * @property {string} id
 * @property {string} url
 * @property {string} title
 * @property {string} readyState            'loading' | 'interactive' | 'complete'
 * @property {boolean} loading
 * @property {string|null} focusedRef
 * @property {number} revision              monotonically increasing DOM revision
 * @property {Array<{id:string,url:string,title:string,active:boolean}>} tabs
 * @property {ElementDescriptor[]} controls interactive elements, in DOM order
 * @property {Array<{type:string,message:string,open:boolean}>} dialogs
 * @property {Rect} viewport
 */

/**
 * @typedef {object} AxNode
 * @property {string} ref
 * @property {string} role
 * @property {string} name
 * @property {string} [value]
 * @property {boolean} enabled
 * @property {boolean} focusable
 * @property {boolean} focused
 * @property {boolean} offscreen
 * @property {Rect} bounds
 * @property {string[]} patterns    supported UIA/ARIA action patterns
 * @property {AxNode[]} [children]
 */

/**
 * @typedef {object} WindowInfo
 * @property {string} handle
 * @property {string} title
 * @property {string} className
 * @property {number} processId
 * @property {Rect} bounds
 * @property {boolean} visible
 * @property {boolean} minimized
 * @property {boolean} foreground
 */

/**
 * @typedef {object} ActionReceipt
 * @property {boolean} ok
 * @property {object} [detail]
 */

/** Page adapter (browser capability) — plan §26. */
const PAGE_ADAPTER_METHODS = [
  'probe',
  'snapshot',
  'query',
  'queryAll',
  'accessibility',
  'clickElement',
  'focusElement',
  'typeText',
  'setValue',
  'selectOption',
  'scroll',
  'navigate',
  'historyBack',
  'historyForward',
  'reload',
  'tabs',
  'dialogs',
  'answerDialog',
  'waitFor',
  'events',
  'screenshot',
  'close'
]

/** Desktop driver (windows, focus, mouse, keyboard) — plan §27. */
const DESKTOP_DRIVER_METHODS = [
  'probe',
  'listWindows',
  'foregroundWindow',
  'focusWindow',
  'closeWindow',
  'moveWindow',
  'openApplication',
  'cursorPosition',
  'moveMouse',
  'click',
  'drag',
  'scroll',
  'keyPress',
  'hotkey',
  'typeText',
  'clipboardRead',
  'clipboardWrite',
  'screenMetrics'
]

/** Accessibility driver (UI Automation) — plan §3.2/§27. */
const ACCESSIBILITY_DRIVER_METHODS = ['probe', 'root', 'children', 'find', 'invoke', 'setValue', 'focus', 'value']

/** Screenshot driver (vision fallback) — plan §4.2. */
const SCREENSHOT_DRIVER_METHODS = ['probe', 'captureRegion', 'captureWindow', 'captureFull']

/** Command runner (shell capability) — plan §28. */
const SHELL_RUNNER_METHODS = ['probe', 'run']

const PORTS = Object.freeze({
  page: { methods: PAGE_ADAPTER_METHODS, capability: 'browser', label: 'page adapter' },
  desktop: { methods: DESKTOP_DRIVER_METHODS, capability: 'desktop', label: 'desktop driver' },
  accessibility: { methods: ACCESSIBILITY_DRIVER_METHODS, capability: 'desktop', label: 'accessibility driver' },
  screenshot: { methods: SCREENSHOT_DRIVER_METHODS, capability: 'vision', label: 'screenshot driver' },
  shell: { methods: SHELL_RUNNER_METHODS, capability: 'shell', label: 'shell runner' }
})

function unavailable(portName, message, details = {}) {
  const port = PORTS[portName] || { label: portName, capability: null }
  return new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, message || `${port.label} is not available`, {
    port: portName,
    capability: port.capability,
    ...details
  })
}

/**
 * Checks that an injected port exposes the whole documented surface.
 * Returns `{ ok, missing }` instead of throwing, because the callers differ:
 * controllers degrade (plan §37) while a wiring bug should fail loudly.
 */
function inspectPort(portName, candidate) {
  const port = PORTS[portName]
  if (!port) return { ok: false, missing: ['<unknown port>'] }
  if (!candidate || typeof candidate !== 'object') return { ok: false, missing: port.methods.slice() }
  const missing = port.methods.filter((method) => typeof candidate[method] !== 'function')
  return { ok: missing.length === 0, missing }
}

/** Throws a typed, actionable error when a port is incomplete. */
function assertPort(portName, candidate) {
  const { ok, missing } = inspectPort(portName, candidate)
  if (!ok) {
    const port = PORTS[portName]
    throw unavailable(portName, `${port.label} is missing required method(s): ${missing.join(', ')}`, { missing })
  }
  return candidate
}

/**
 * A probed port may still be unusable on this machine (no UI Automation
 * assembly, no interactive desktop, no Chromium attached). Controllers call
 * this once per run and cache the verdict.
 */
function normalizeProbe(probeResult) {
  if (probeResult === true) return { available: true, reason: null, detail: {} }
  if (probeResult === false || probeResult === undefined || probeResult === null) {
    return { available: false, reason: 'probe returned no verdict', detail: {} }
  }
  return {
    available: Boolean(probeResult.available),
    reason: probeResult.reason || null,
    detail: probeResult.detail && typeof probeResult.detail === 'object' ? probeResult.detail : {}
  }
}

/** A tiny clock port: deterministic tests inject their own. */
function createClock(overrides = {}) {
  const now = typeof overrides.now === 'function' ? overrides.now : () => Date.now()
  const sleep = typeof overrides.sleep === 'function' ? overrides.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  return { now, sleep }
}

module.exports = {
  PORTS,
  PAGE_ADAPTER_METHODS,
  DESKTOP_DRIVER_METHODS,
  ACCESSIBILITY_DRIVER_METHODS,
  SCREENSHOT_DRIVER_METHODS,
  SHELL_RUNNER_METHODS,
  inspectPort,
  assertPort,
  normalizeProbe,
  unavailable,
  createClock
}
