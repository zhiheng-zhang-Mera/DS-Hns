'use strict'

/**
 * Computer Use Runtime: World State (plan §5).
 *
 * Perception from every source is folded into one short-lived structure that
 * serves the *current* task: what app is in front, what page is loaded, which
 * control has focus, which targets are reachable, what the system just did.
 *
 * Two rules from the plan are enforced here rather than promised in prose:
 *
 *  - The world state is discarded when the task ends (plan §5). `discard()`
 *    erases the contents, and nothing in this module writes to disk, so there
 *    is no path from "observed the UI" to "learned the application" (plan §42).
 *  - Progress is judged on *meaningful* change, not on any change (plan §20).
 *    A spinner that mutates the DOM forever must not look like progress, while a
 *    toast, a navigation, a window switch or a control state flip must.
 */

const crypto = require('node:crypto')

const MEANINGFUL_FIELDS = Object.freeze([
  'url',
  'title',
  'readyState',
  'activeApp',
  'activeWindowHandle',
  'foregroundProcessId',
  'focusedRef',
  'dialogSignature',
  'controlSignature',
  'windowSignature',
  'axSignature',
  'lastActionType',
  'lastActionResult'
])

/**
 * Builds a world state from whatever the observation sources managed to
 * collect. Missing sources are recorded as unavailable, with their reason —
 * they must never be silently replaced by a guess (plan §3/§37).
 */
function createWorldState(parts = {}) {
  const browser = parts.browser || {}
  const desktop = parts.desktop || {}
  const system = parts.system || {}
  const controls = Array.isArray(browser.controls) ? browser.controls.filter(Boolean) : []
  const ax = Array.isArray(browser.ax) ? browser.ax.filter(Boolean) : Array.isArray(desktop.ax) ? desktop.ax.filter(Boolean) : []
  const windows = Array.isArray(desktop.windows) ? desktop.windows.filter(Boolean) : []
  const foreground = desktop.foreground || windows.find((window) => window.foreground) || null
  const dialogs = [
    ...(Array.isArray(browser.dialogs) ? browser.dialogs : []),
    ...(Array.isArray(desktop.dialogs) ? desktop.dialogs : [])
  ]
  const world = {
    taskId: parts.taskId || null,
    capturedAt: Number.isFinite(parts.capturedAt) ? parts.capturedAt : Date.now(),
    revision: Number.isFinite(browser.revision) ? browser.revision : null,

    activeApp: parts.activeApp || desktop.activeApp || (foreground ? foreground.processName || foreground.className || null : null),
    activeWindow: foreground ? foreground.title || null : null,
    activeWindowHandle: foreground ? String(foreground.handle) : null,
    foregroundProcessId: foreground ? foreground.processId ?? null : null,
    url: typeof browser.url === 'string' ? browser.url : null,
    title: typeof browser.title === 'string' ? browser.title : null,
    readyState: browser.readyState || null,
    loading: Boolean(browser.loading),
    focusedRef: browser.focusedRef || desktop.focusedRef || null,
    focusedElement: parts.focusedElement || describeFocused(controls, browser.focusedRef) || (desktop.focusedElement || null),

    controls,
    visibleTargets: Array.isArray(parts.visibleTargets) ? parts.visibleTargets.filter(Boolean) : defaultVisibleTargets(controls),
    ax,
    windows,
    foreground,
    dialogs,

    systemEvents: Array.isArray(system.events) ? system.events : [],
    lastAction: parts.lastAction || null,
    uiStable: parts.uiStable === undefined ? null : Boolean(parts.uiStable),
    confidence: 0,
    sources: {
      browser: normalizeSource(browser.source, { available: browser.available !== false, reason: browser.reason || null }),
      desktop: normalizeSource(desktop.source, { available: desktop.available !== false, reason: desktop.reason || null }),
      system: normalizeSource(system.source, { available: system.available !== false, reason: system.reason || null })
    },
    notes: Array.isArray(parts.notes) ? parts.notes.slice(0, 20) : []
  }
  world.confidence = computeConfidence(world)
  world.dialogSignature = dialogs.map((dialog) => `${dialog.type || 'dialog'}:${dialog.message || ''}`).join('|')
  world.controlSignature = signatureOf(controls)
  world.windowSignature = signatureOf(windows.map((window) => ({
    handle: String(window.handle),
    title: window.title,
    bounds: window.bounds,
    foreground: Boolean(window.foreground),
    minimized: Boolean(window.minimized)
  })))
  world.axSignature = signatureOf(ax.slice(0, 200).map((node) => ({
    ref: node.ref,
    role: node.role,
    name: node.name,
    value: node.value,
    enabled: node.enabled,
    focused: node.focused,
    bounds: node.bounds
  })))
  world.signature = signatureOf(pickMeaningful(world))
  return world
}

function describeFocused(controls, focusedRef) {
  if (!focusedRef) return null
  const match = controls.find((control) => control.ref === focusedRef)
  if (!match) return { ref: focusedRef }
  return { ref: match.ref, role: match.role, name: match.name, value: match.value === undefined ? null : match.value }
}

function normalizeSource(source, fallback) {
  if (source && typeof source === 'object') {
    return { available: Boolean(source.available), reason: source.reason || null, backend: source.backend || null }
  }
  return { available: Boolean(fallback.available), reason: fallback.reason || null, backend: null }
}

function defaultVisibleTargets(controls) {
  return controls.filter((control) => control.visible !== false && control.disabled !== true)
}

/**
 * Plan §5 confidence: how much of the picture is actually structured and
 * current. A screenshot-only world state is possible but is reported as low
 * confidence instead of being mistaken for structured knowledge.
 */
function computeConfidence(world) {
  let score = 0
  let weight = 0
  const add = (value, amount) => {
    weight += amount
    if (value === true) score += amount
  }
  add(world.sources.browser.available, 0.3)
  add(Boolean(world.url), 0.1)
  add(world.sources.desktop.available, 0.25)
  add(Boolean(world.foreground), 0.1)
  add(world.sources.system.available, 0.1)
  add(world.controls.length > 0 || world.ax.length > 0 || world.windows.length > 0, 0.1)
  add(world.dialogs.length === 0, 0.05)
  const raw = weight ? score / weight : 0
  return Math.round(raw * 100) / 100
}

function signatureOf(value) {
  try {
    return crypto.createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 16)
  } catch {
    return null
  }
}

function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function pickMeaningful(world) {
  const picked = {}
  for (const field of MEANINGFUL_FIELDS) {
    if (world[field] !== undefined) picked[field] = world[field]
  }
  return picked
}

/**
 * Plan §20/§13: did anything *meaningful* change between two observations?
 *
 * Two things are deliberately excluded. DOM revision churn, because an
 * animation loop must not be able to hide a stalled task. And the runtime's own
 * bookkeeping (`lastAction`), because the action we just issued is not a change
 * in the environment — counting it would make every step look like progress and
 * stall detection (plan §20) could never fire.
 */
function meaningfulChange(previous, next) {
  if (!previous) return { changed: true, fields: ['<first observation>'], meaningful: true }
  if (!next) return { changed: true, fields: ['<observation lost>'], meaningful: true }
  const fields = []
  const compare = (name, a, b) => {
    if (a === b) return
    if (a === undefined && b === undefined) return
    fields.push(name)
  }
  for (const field of MEANINGFUL_FIELDS) {
    compare(field, previous[field], next[field])
  }
  return { changed: fields.length > 0, fields, meaningful: fields.length > 0 }
}

/**
 * The broad evidence digest, used by verification (plan §15) rather than by
 * stall detection: it includes DOM revision and the event stream, because a
 * mutation *is* evidence that something happened.
 */
function evidenceDigest(world) {
  if (!world) return null
  return signatureOf({
    signature: world.signature,
    revision: world.revision,
    events: (world.systemEvents || []).map((event) => `${event.type || event.name}:${event.detail || ''}`),
    value: world.focusedElement ? world.focusedElement.value : null
  })
}

/** Compact, log-safe summary (plan §39 — a step log carries a summary, not the tree). */
function summarizeWorldState(world) {
  if (!world) return null
  return {
    activeApp: world.activeApp,
    activeWindow: world.activeWindow,
    url: world.url,
    title: world.title,
    readyState: world.readyState,
    loading: world.loading,
    focused: world.focusedElement ? `${world.focusedElement.role || '?'}:${world.focusedElement.name || world.focusedElement.ref || ''}` : null,
    controls: world.controls.length,
    axNodes: world.ax.length,
    windows: world.windows.length,
    dialogs: world.dialogs.length,
    uiStable: world.uiStable,
    confidence: world.confidence,
    revision: world.revision,
    signature: world.signature,
    // A degraded source is part of the step's pre-state: a summary that hides
    // "the desktop controller timed out" would hide the reason a step failed.
    notes: world.notes && world.notes.length ? world.notes.slice(0, 5) : undefined
  }
}

/**
 * Plan §5: a task's world state is dropped when the task ends. The object is
 * emptied (not just dereferenced) so a stale reference cannot keep observing.
 */
function discardWorldState(world) {
  if (!world) return null
  const summary = summarizeWorldState(world)
  world.discarded = true
  world.controls = []
  world.visibleTargets = []
  world.ax = []
  world.windows = []
  world.systemEvents = []
  world.dialogs = []
  world.focusedElement = null
  world.url = null
  world.title = null
  world.foreground = null
  world.signature = null
  return summary
}

module.exports = {
  MEANINGFUL_FIELDS,
  createWorldState,
  meaningfulChange,
  evidenceDigest,
  summarizeWorldState,
  discardWorldState,
  computeConfidence,
  signatureOf,
  stableStringify
}
