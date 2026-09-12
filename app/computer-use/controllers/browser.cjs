'use strict'

/**
 * Computer Use Runtime: browser controller (plan §26, §3.2).
 *
 * Order of preference is fixed: DOM, then accessibility, then the browser API,
 * and only then vision. That is why this controller works entirely against a
 * *page adapter* — a Chromium page exposed over CDP in production, an
 * in-process device in tests — and never against pixels.
 *
 * The important property it gives the runtime is identity: a DOM click targets
 * a node, not a coordinate, so a button that moved by 80 ms of animation is
 * still the same button (plan §10). Coordinates only enter the picture when the
 * router has exhausted the structured channels.
 */

const { ACTION_TYPES, TIMING } = require('../constants.cjs')
const { CODES, ComputerUseError } = require('../errors.cjs')
const { assertPort, normalizeProbe, unavailable } = require('../ports.cjs')
const { matchesSemantic } = require('../target.cjs')

function createBrowserController(options = {}) {
  const clock = options.clock || { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const config = { defaultWaitTimeoutMs: TIMING.defaultWaitTimeoutMs, ...(options.config || {}) }
  let page = options.page || null
  let probeCache = null

  function setPage(next) {
    page = next || null
    probeCache = null
  }

  function probe() {
    if (probeCache) return probeCache
    if (!page) {
      probeCache = normalizeProbe({ available: false, reason: 'no browser page is attached to the runtime' })
      return probeCache
    }
    try {
      assertPort('page', page)
      probeCache = normalizeProbe(page.probe())
    } catch (error) {
      probeCache = normalizeProbe({ available: false, reason: error && error.message ? error.message : String(error) })
    }
    return probeCache
  }

  function supports(actionType) {
    return [
      ACTION_TYPES.BROWSER_NAVIGATE,
      ACTION_TYPES.BROWSER_BACK,
      ACTION_TYPES.BROWSER_FORWARD,
      ACTION_TYPES.BROWSER_REFRESH,
      ACTION_TYPES.DOM_CLICK,
      ACTION_TYPES.DOM_TYPE,
      ACTION_TYPES.DOM_SELECT,
      ACTION_TYPES.CLICK,
      ACTION_TYPES.DOUBLE_CLICK,
      ACTION_TYPES.TYPE,
      ACTION_TYPES.SELECT,
      ACTION_TYPES.SCROLL,
      ACTION_TYPES.FOCUS,
      ACTION_TYPES.WAIT_EVENT,
      ACTION_TYPES.WAIT_STATE
    ].includes(actionType)
  }

  function requirePage() {
    if (!page) throw unavailable('page', 'no browser page is attached to the runtime')
    return page
  }

  /**
   * Plan §3.2 structured state: URL, title, DOM, accessibility tree, controls,
   * loading/navigation state, tabs, focused element.
   */
  async function snapshot() {
    const current = requirePage()
    const snapshot = await current.snapshot()
    const controls = Array.isArray(snapshot.controls) ? snapshot.controls : []
    return {
      available: true,
      source: { available: true, reason: null, backend: 'page-adapter' },
      url: snapshot.url,
      title: snapshot.title,
      readyState: snapshot.readyState,
      loading: Boolean(snapshot.loading),
      revision: Number.isFinite(snapshot.revision) ? snapshot.revision : null,
      focusedRef: snapshot.focusedRef || null,
      tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs : [],
      dialogs: collectDialogs(snapshot, controls),
      controls,
      viewport: snapshot.viewport || null,
      events: collectEvents(current)
    }
  }

  /**
   * Plan §30: an unexpected modal is a structured observation, not a surprise.
   * Two shapes count — a native JS dialog (`dialogs`) and a DOM modal
   * (`modals`: a real `role="dialog"` node with its own dismiss control) — and
   * both are reported as blocking, so the executor pauses the original action
   * instead of clicking through an overlay.
   */
  function collectDialogs(snapshot, controls) {
    const dialogs = []
    for (const dialog of Array.isArray(snapshot.dialogs) ? snapshot.dialogs : []) {
      dialogs.push({ ...dialog, source: 'browser', blocking: dialog.blocking !== false })
    }
    for (const modal of Array.isArray(snapshot.modals) ? snapshot.modals : []) {
      const dialogControl = controls.find((control) => control.ref === modal.ref)
        || controls.find((control) => String(control.role || '').toLowerCase() === 'dialog')
      dialogs.push({
        type: 'dom-modal',
        message: modal.message || '',
        ref: modal.ref || (dialogControl ? dialogControl.ref : null),
        bounds: dialogControl ? dialogControl.bbox : null,
        open: true,
        blocking: true,
        unexpected: true,
        source: 'browser',
        dismissible: true
      })
    }
    return dialogs
  }

  /** Plan §3.2 accessibility tree, used when a DOM handle is not enough. */
  async function accessibility() {
    const current = requirePage()
    if (typeof current.accessibility !== 'function') return []
    const tree = await current.accessibility()
    return flattenAx(tree)
  }

  /** Target resolution helper used by the executor and the stabilizer. */
  async function locate(target) {
    if (!target || !page) return null
    const current = requirePage()
    if (target.selector) {
      const hits = asList(await safe(() => current.query(target.selector), []))
      if (hits.length) return toResolution(hits[0], 'selector')
    }
    if (target.semantic) {
      const all = asList(await safe(() => current.queryAll(), []))
      const match = all.find((element) => matchesSemantic(element, target.semantic))
      if (match) return toResolution(match, 'semantic')
    }
    if (target.accessibility) {
      const nodes = await accessibility()
      const match = nodes.find((node) => {
        if (target.accessibility.role && String(node.role || '').toLowerCase() !== String(target.accessibility.role).toLowerCase()) return false
        if (target.accessibility.name && !String(node.name || '').toLowerCase().includes(String(target.accessibility.name).toLowerCase())) return false
        return true
      })
      if (match) return toResolution(match, 'accessibility')
    }
    if (target.ref) {
      const all = asList(await safe(() => current.queryAll(), []))
      const match = all.find((element) => element.ref === target.ref)
      if (match) return toResolution(match, 'accessibility')
    }
    if (target.bbox) return { kind: 'bbox', ref: null, bbox: target.bbox, point: centerOf(target.bbox), source: 'page', coordinateFallback: true }
    if (target.point) return { kind: 'point', ref: null, bbox: null, point: target.point, source: 'page', coordinateFallback: true }
    return null
  }

  function toResolution(element, kind) {
    const bbox = element.bbox || element.bounds || null
    return {
      kind,
      ref: element.ref || null,
      bbox,
      point: bbox ? centerOf(bbox) : null,
      role: element.role || null,
      name: element.name || null,
      selector: element.selector || null,
      disabled: element.disabled === undefined ? (element.enabled === undefined ? null : !element.enabled) : Boolean(element.disabled),
      visible: element.visible === undefined ? (element.offscreen === undefined ? null : !element.offscreen) : Boolean(element.visible),
      element,
      source: 'page',
      coordinateFallback: kind === 'bbox' || kind === 'point'
    }
  }

  /**
   * Executes one action through the DOM/API channel. The receipt says what was
   * actually done, including whether the page reacted at all (`missed`), which
   * the miss detector consumes (plan §17).
   */
  async function perform(action, context = {}) {
    const current = requirePage()
    const resolved = context.resolved || (await locate(action.target))
    const before = context.world || null

    switch (action.type) {
      case ACTION_TYPES.BROWSER_NAVIGATE: {
        const receipt = await current.navigate(String(action.params.url), { waitUntil: action.params.waitUntil })
        return receipt_(action, { ...receipt, changed: true, detail: { url: action.params.url } })
      }
      case ACTION_TYPES.BROWSER_BACK: {
        const receipt = await current.historyBack()
        return receipt_(action, { ...receipt, changed: true })
      }
      case ACTION_TYPES.BROWSER_FORWARD: {
        const receipt = await current.historyForward()
        return receipt_(action, { ...receipt, changed: true })
      }
      case ACTION_TYPES.BROWSER_REFRESH: {
        const receipt = await current.reload()
        return receipt_(action, { ...receipt, changed: true })
      }
      case ACTION_TYPES.DOM_CLICK:
      case ACTION_TYPES.CLICK:
      case ACTION_TYPES.DOUBLE_CLICK: {
        if (!resolved || (!resolved.ref && !resolved.point)) {
          throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the click target could not be resolved inside the page', { target: action.target })
        }
        const receipt = await current.clickElement(resolved.ref || resolved, {
          button: action.type === ACTION_TYPES.RIGHT_CLICK ? 'right' : 'left',
          double: action.type === ACTION_TYPES.DOUBLE_CLICK
        })
        return receipt_(action, {
          ...receipt,
          ref: resolved.ref,
          bbox: resolved.bbox,
          // A click the page swallowed is reported, not hidden: this is the
          // evidence the retry ladder acts on.
          missed: receipt && receipt.missed === true,
          changed: receipt && receipt.changed !== undefined ? receipt.changed : !(receipt && receipt.missed === true)
        })
      }
      case ACTION_TYPES.DOM_TYPE:
      case ACTION_TYPES.TYPE: {
        if (!resolved || !resolved.ref) {
          throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the typing target could not be resolved inside the page', { target: action.target })
        }
        const focusReceipt = await current.focusElement(resolved.ref)
        const text = action.params.text !== undefined ? action.params.text : action.params.value
        const receipt = await current.typeText(resolved.ref, String(text === undefined ? '' : text), { clear: action.params.clear !== false })
        return receipt_(action, {
          ...receipt,
          ref: resolved.ref,
          focus: focusReceipt,
          value: receipt && receipt.value !== undefined ? receipt.value : undefined,
          changed: true,
          sensitive: action.sensitive
        })
      }
      case ACTION_TYPES.DOM_SELECT:
      case ACTION_TYPES.SELECT: {
        if (!resolved || !resolved.ref) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the select target could not be resolved inside the page')
        const receipt = await current.selectOption(resolved.ref, action.params.value !== undefined ? action.params.value : action.params.text, { index: action.params.index })
        return receipt_(action, { ...receipt, ref: resolved.ref, changed: true })
      }
      case ACTION_TYPES.FOCUS: {
        if (!resolved || !resolved.ref) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the focus target could not be resolved inside the page')
        const receipt = await current.focusElement(resolved.ref)
        return receipt_(action, { ...receipt, ref: resolved.ref, changed: true })
      }
      case ACTION_TYPES.SCROLL: {
        const receipt = await current.scroll({ dx: action.params.dx, dy: action.params.dy, ref: resolved ? resolved.ref : null })
        return receipt_(action, { ...receipt, changed: true })
      }
      case ACTION_TYPES.WAIT_EVENT:
      case ACTION_TYPES.WAIT_STATE: {
        const condition = waitCondition(action, before)
        const timeoutMs = action.timeoutMs || config.defaultWaitTimeoutMs
        const started = clock.now()
        const result = await current.waitFor({ ...condition, timeoutMs })
        return receipt_(action, {
          ok: Boolean(result && result.ok),
          changed: Boolean(result && result.ok),
          detail: { condition, waitedMs: clock.now() - started },
          timedOut: Boolean(result && result.timedOut)
        })
      }
      default:
        throw new ComputerUseError(CODES.ACTION_UNSUPPORTED, `the browser controller cannot run ${action.type}`)
    }
  }

  /**
   * Plan §12: a big wait is an event wait, not a sleep. The expected effect
   * decides *what* is being waited for; without one the wait is on the page
   * becoming idle.
   */
  function waitCondition(action, world) {
    const effect = action.expectedEffect && Array.isArray(action.expectedEffect.any) ? action.expectedEffect.any[0] : null
    if (effect) {
      if (effect.dom_mutated !== undefined) return { condition: 'mutation', baseRevision: world ? world.revision : null }
      if (effect.navigation !== undefined || effect.url_changed !== undefined) return { condition: 'navigation' }
      if (effect.toast !== undefined || effect.text_appears !== undefined) {
        return { condition: 'text', text: effect.toast !== undefined ? effect.toast : effect.text_appears }
      }
      if (effect.target_disappears !== undefined) return { condition: 'selector-gone', selector: action.target && action.target.selector }
    }
    if (action.params.waitFor) {
      if (typeof action.params.waitFor === 'string') return { condition: action.params.waitFor }
      return { ...action.params.waitFor }
    }
    return { condition: 'idle' }
  }

  function receipt_(action, receipt) {
    return {
      controller: 'browser',
      channel: 'dom',
      actionType: action.type,
      at: clock.now(),
      ok: receipt && receipt.ok === undefined ? true : Boolean(receipt && receipt.ok),
      ...receipt
    }
  }

  function collectEvents(current) {
    try {
      if (typeof current.events !== 'function') return []
      const events = current.events()
      if (!events) return []
      if (typeof events.sinceLastCheck === 'function') return events.sinceLastCheck()
      return Array.isArray(events) ? events : []
    } catch {
      return []
    }
  }

  async function safe(fn, fallback) {
    try {
      return await fn()
    } catch {
      return fallback
    }
  }

  /** Plan §26: screenshot fallback for a canvas or an unreadable page. */
  async function screenshot(clip) {
    const current = requirePage()
    if (typeof current.screenshot !== 'function') return null
    return current.screenshot(clip ? { clip } : {})
  }

  function facts() {
    return {
      domQuery: async (selector) => {
        if (!page) return null
        try {
          return asList(await page.query(selector))
        } catch {
          return null
        }
      },
      domText: async (selector) => {
        if (!page) return null
        try {
          const hits = asList(await page.query(selector || 'body'))
          if (!hits.length) return null
          return hits.map((element) => element.text || element.name || '').join(' ')
        } catch {
          return null
        }
      },
      domValue: async (selector) => {
        if (!page) return null
        try {
          const hits = asList(await page.query(selector))
          if (!hits.length) return null
          return hits[0].value
        } catch {
          return null
        }
      }
    }
  }

  return {
    id: 'browser',
    capability: 'browser',
    probe,
    supports,
    snapshot,
    accessibility,
    locate,
    perform,
    facts,
    screenshot,
    setPage,
    get page() {
      return page
    }
  }
}

function centerOf(rect) {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

/**
 * A page adapter may answer a lookup with one descriptor or with a list of
 * them (the CDP adapter returns a list, a single-hit device returns one
 * element). Both are legal; the controller normalizes instead of insisting.
 */
function asList(value) {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function flattenAx(tree, out = []) {
  if (!tree) return out
  if (Array.isArray(tree)) {
    for (const node of tree) flattenAx(node, out)
    return out
  }
  if (typeof tree !== 'object') return out
  out.push({
    ref: tree.ref,
    role: tree.role || tree.controlType || null,
    name: tree.name || null,
    value: tree.value,
    enabled: tree.enabled === undefined ? true : Boolean(tree.enabled),
    focusable: Boolean(tree.focusable),
    focused: Boolean(tree.focused),
    offscreen: Boolean(tree.offscreen),
    bounds: tree.bounds || tree.bbox || null,
    patterns: Array.isArray(tree.patterns) ? tree.patterns : [],
    automationId: tree.automationId || null,
    className: tree.className || null,
    processId: tree.processId,
    windowHandle: tree.windowHandle
  })
  if (Array.isArray(tree.children)) for (const child of tree.children) flattenAx(child, out)
  return out
}

module.exports = { createBrowserController, flattenAx }
