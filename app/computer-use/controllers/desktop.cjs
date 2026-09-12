'use strict'

/**
 * Computer Use Runtime: desktop controller (plan §27, §3.2).
 *
 * UI Automation first, mouse and keyboard second, vision only after both have
 * failed (plan §27). The controller therefore reads windows, focus, dialogs and
 * controls from real structured sources, and treats raw input as the *rendering*
 * of an intent it has already validated: the window is checked, the focus is
 * checked, the target is re-located immediately before the click.
 *
 * Everything here is a thin, honest layer over two ports (a window/input driver
 * and an accessibility driver). If either is missing the controller says so and
 * the runtime routes around it (plan §37) instead of inventing a state.
 */

const { ACTION_TYPES, TIMING } = require('../constants.cjs')
const { CODES, ComputerUseError } = require('../errors.cjs')
const { normalizeProbe, unavailable } = require('../ports.cjs')

function createDesktopController(options = {}) {
  const clock = options.clock || { now: () => Date.now() }
  const driver = options.driver || null
  const accessibility = options.accessibility || null
  const config = { appStartTimeoutMs: TIMING.appStartTimeoutMs, ...(options.config || {}) }

  function probe() {
    if (!driver) return normalizeProbe({ available: false, reason: 'no desktop driver is attached to the runtime' })
    try {
      return normalizeProbe(driver.probe())
    } catch (error) {
      return normalizeProbe({ available: false, reason: error && error.message ? error.message : String(error) })
    }
  }

  function accessibilityProbe() {
    if (!accessibility) return normalizeProbe({ available: false, reason: 'no accessibility driver is attached to the runtime' })
    try {
      return normalizeProbe(accessibility.probe())
    } catch (error) {
      return normalizeProbe({ available: false, reason: error && error.message ? error.message : String(error) })
    }
  }

  function supports(actionType) {
    return [
      ACTION_TYPES.MOVE,
      ACTION_TYPES.CLICK,
      ACTION_TYPES.DOUBLE_CLICK,
      ACTION_TYPES.RIGHT_CLICK,
      ACTION_TYPES.TYPE,
      ACTION_TYPES.KEY_PRESS,
      ACTION_TYPES.HOTKEY,
      ACTION_TYPES.SCROLL,
      ACTION_TYPES.DRAG,
      ACTION_TYPES.FOCUS,
      ACTION_TYPES.SELECT,
      ACTION_TYPES.OPEN_APP,
      ACTION_TYPES.CLOSE_WINDOW,
      ACTION_TYPES.SWITCH_WINDOW,
      ACTION_TYPES.ACCESSIBILITY_INVOKE,
      ACTION_TYPES.ACCESSIBILITY_SET_VALUE,
      ACTION_TYPES.WAIT_EVENT,
      ACTION_TYPES.WAIT_STATE
    ].includes(actionType)
  }

  function requireDriver() {
    if (!driver) throw unavailable('desktop', 'no desktop driver is attached to the runtime')
    return driver
  }

  /**
   * Plan §3.2 desktop structured state: the foreground window, its process,
   * bounds, the accessibility tree, the focused control and any dialog.
   *
   * The UI Automation walk is the expensive part of perception (it crosses
   * process boundaries), so it is read when the caller actually needs it — a
   * desktop action, a dialog check, or the first observation of a run — and
   * skipped for the polling inside a browser step's wait (plan §3.1: use the
   * cheapest source that can answer the question).
   */
  async function snapshot(options = {}) {
    const windows = await safe(() => requireDriver().listWindows(), [])
    const foreground = (windows || []).find((window) => window.foreground) || (await safe(() => requireDriver().foregroundWindow(), null))
    let ax = []
    let dialogs = []
    const wantAx = options.ax !== false
    if (wantAx && foreground && accessibility) {
      ax = await safe(() => readWindowTree(foreground), [])
    }
    // System dialogs are detected from the *window list*, which is cheap: a
    // Win32 dialog is a real window of class #32770, usually owned by another
    // window. This is what keeps "an unexpected modal blocks the action" true
    // (plan §30) even when the accessibility tree is not being read.
    dialogs = [...detectDialogs(ax, foreground), ...detectWindowDialogs(windows, foreground)]
    const focused = ax.find((node) => node.focused) || null
    return {
      available: true,
      source: { available: true, reason: null, backend: driver && driver.backend ? driver.backend : 'desktop-driver' },
      windows: windows || [],
      foreground,
      activeApp: foreground ? foreground.processName || foreground.className || null : null,
      focusedRef: focused ? focused.ref : null,
      focusedElement: focused ? { ref: focused.ref, role: focused.role, name: focused.name, value: focused.value } : null,
      ax,
      dialogs,
      events: []
    }
  }

  async function readWindowTree(window) {
    if (!accessibility) return []
    const nodes = await accessibility.children(`w:${window.handle}`, { depth: 3 })
    return flattenAx(nodes)
  }

  /**
   * Plan §30: an unexpected modal is a first-class observation. A dialog is a
   * top-level window of the dialog class, or an automation element whose control
   * type says so.
   */
  /**
   * Plan §30 from the window list alone: a visible, owned `#32770` window is a
   * system dialog (a permission prompt, a file picker, a confirmation box).
   */
  function detectWindowDialogs(windows, foreground) {
    const dialogs = []
    for (const window of windows || []) {
      const className = String(window.className || '')
      const isDialogClass = className === '#32770' || /dialog/i.test(className)
      if (!isDialogClass) continue
      if (!window.visible || window.minimized) continue
      if (foreground && String(window.handle) === String(foreground.handle) && !/dialog/i.test(className)) continue
      dialogs.push({
        type: 'system-dialog',
        message: window.title || '',
        ref: `w:${window.handle}`,
        blocking: Boolean(window.foreground) || window.ownerHandle === undefined ? Boolean(window.foreground) : true,
        unexpected: true,
        source: 'desktop',
        windowHandle: window.handle,
        bounds: window.bounds || null
      })
    }
    return dialogs
  }

  /**
   * Plan §30: which automation nodes are *dialogs* rather than ordinary
   * window furniture. A Chromium window is full of panes and window nodes, so
   * "role window/pane" is not a dialog and treating it as one would make the
   * runtime refuse to act on perfectly ordinary applications.
   */
  function detectDialogs(ax, foreground) {
    const dialogs = []
    for (const node of ax) {
      const role = String(node.controlType || node.role || '').toLowerCase()
      const className = String(node.className || '').toLowerCase()
      const isDialogClass = className === '#32770' || className.includes('dialog')
      const isDialogRole = role === 'dialog' || role === 'alertdialog' || role === 'window-dialog'
      if (!isDialogClass && !isDialogRole) continue
      // The foreground window itself is never "an unexpected modal".
      if (node === ax[0] && !isDialogClass) continue
      dialogs.push({
        type: isDialogClass ? 'system-dialog' : 'dialog',
        message: node.name || '',
        ref: node.ref || null,
        blocking: true,
        unexpected: true,
        source: 'desktop',
        windowHandle: node.windowHandle || (foreground ? foreground.handle : null),
        bounds: node.bounds || null
      })
    }
    return dialogs
  }

  /** Target resolution over the accessibility tree + the window list. */
  async function locate(target) {
    if (!target) return null
    if (target.window) {
      const window = await resolveWindow(target.window)
      if (window) {
        // `windowHandle` is what the window-safety gate checks the foreground
        // against, so a window target must carry it (plan §33).
        return {
          kind: 'window',
          ref: `w:${window.handle}`,
          handle: window.handle,
          windowHandle: window.handle,
          bbox: window.bounds,
          point: centerOf(window.bounds),
          role: 'window',
          name: window.title,
          visible: window.visible,
          disabled: false,
          window,
          source: 'desktop'
        }
      }
      return null
    }
    if (target.accessibility && accessibility) {
      const query = { ...target.accessibility }
      if (target.window) query.windowHandle = target.window.handle
      const hits = await safe(() => accessibility.find(query, { limit: 5 }), [])
      if (hits && hits.length) return toResolution(hits[0], 'accessibility')
    }
    if (target.ref && accessibility) {
      const value = await safe(() => accessibility.value(target.ref), null)
      if (value) return toResolution({ ref: target.ref, ...value }, 'accessibility')
    }
    if (target.semantic && accessibility) {
      const query = { name: target.semantic.text || target.semantic.label || target.semantic.name || target.semantic.placeholder }
      if (target.semantic.role) query.role = target.semantic.role
      const hits = await safe(() => accessibility.find(query, { limit: 5 }), [])
      if (hits && hits.length) return toResolution(hits[0], 'semantic')
    }
    if (target.bbox) return { kind: 'bbox', ref: null, bbox: target.bbox, point: centerOf(target.bbox), source: 'desktop', coordinateFallback: true, disabled: null, visible: null }
    if (target.point) return { kind: 'point', ref: null, bbox: null, point: target.point, source: 'desktop', coordinateFallback: true, disabled: null, visible: null }
    return null
  }

  function toResolution(node, kind) {
    const bbox = node.bounds || node.bbox || null
    return {
      kind,
      ref: node.ref || null,
      handle: node.windowHandle || null,
      windowHandle: node.windowHandle || null,
      bbox,
      point: bbox ? centerOf(bbox) : null,
      role: node.role || node.controlType || null,
      name: node.name || null,
      disabled: node.enabled === undefined ? null : !node.enabled,
      visible: node.offscreen === undefined ? null : !node.offscreen,
      patterns: node.patterns || [],
      element: node,
      source: 'ax',
      coordinateFallback: kind === 'bbox' || kind === 'point'
    }
  }

  async function resolveWindow(reference) {
    const windows = await safe(() => requireDriver().listWindows(), [])
    if (!windows || !windows.length) return null
    if (reference.handle !== undefined) return windows.find((window) => String(window.handle) === String(reference.handle)) || null
    if (reference.processId !== undefined) return windows.find((window) => Number(window.processId) === Number(reference.processId)) || null
    if (reference.title) {
      const needle = String(reference.title).toLowerCase()
      return windows.find((window) => String(window.title || '').toLowerCase().includes(needle)) || null
    }
    if (reference.process) {
      const needle = String(reference.process).toLowerCase()
      return windows.find((window) => String(window.processName || window.className || '').toLowerCase().includes(needle)) || null
    }
    return null
  }

  /**
   * Executes one desktop action. The caller (executor) has already run the
   * window/focus/destructive gates; this method is the hands.
   */
  async function perform(action, context = {}) {
    const resolved = context.resolved || (await locate(action.target))
    switch (action.type) {
      case ACTION_TYPES.MOVE: {
        const point = pointOf(action, resolved)
        await requireDriver().moveMouse(point.x, point.y)
        return receipt_(action, { ok: true, point, changed: true })
      }
      case ACTION_TYPES.CLICK:
      case ACTION_TYPES.DOUBLE_CLICK:
      case ACTION_TYPES.RIGHT_CLICK: {
        const point = pointOf(action, resolved)
        // Plan §10 at the last moment: the coordinate is re-read from the
        // structured source immediately before the click, never reused blindly.
        const fresh = resolved && resolved.ref ? await revalidatePoint(resolved, point) : { point, movement: 0 }
        if (fresh.stale) {
          throw new ComputerUseError(CODES.TARGET_STALE, `the target moved ${fresh.movement}px immediately before the click - not clicking a stale coordinate`, {
            movement: fresh.movement,
            previous: point,
            current: fresh.point
          })
        }
        const kind = action.type === ACTION_TYPES.RIGHT_CLICK ? 'right' : 'left'
        await requireDriver().click({
          x: fresh.point.x,
          y: fresh.point.y,
          button: kind,
          double: action.type === ACTION_TYPES.DOUBLE_CLICK
        })
        return receipt_(action, {
          ok: true,
          point: fresh.point,
          movement: fresh.movement,
          changed: true,
          target: resolved ? resolved.name || resolved.role : null
        })
      }
      case ACTION_TYPES.DRAG: {
        const from = normalizePoint(action.params.from)
        const to = normalizePoint(action.params.to)
        await requireDriver().drag({ from, to, button: action.params.button || 'left' })
        return receipt_(action, { ok: true, from, to, changed: true })
      }
      case ACTION_TYPES.SCROLL: {
        const point = action.params.point ? normalizePoint(action.params.point) : resolved && resolved.point ? resolved.point : await requireDriver().cursorPosition()
        const dx = Number(action.params.dx) || 0
        const dy = Number(action.params.dy) || 0
        await requireDriver().scroll({ x: point.x, y: point.y, dx, dy })
        return receipt_(action, { ok: true, point, dx, dy, changed: true })
      }
      case ACTION_TYPES.TYPE: {
        const text = String(action.params.text === undefined ? '' : action.params.text)
        await requireDriver().typeText(text)
        return receipt_(action, { ok: true, typed: text.length, changed: true, sensitive: action.sensitive })
      }
      case ACTION_TYPES.KEY_PRESS: {
        await requireDriver().keyPress(String(action.params.key), { times: action.params.times })
        return receipt_(action, { ok: true, key: action.params.key, changed: true })
      }
      case ACTION_TYPES.HOTKEY: {
        await requireDriver().hotkey(action.params.keys.map(String))
        return receipt_(action, { ok: true, keys: action.params.keys, changed: true })
      }
      case ACTION_TYPES.FOCUS:
      case ACTION_TYPES.SWITCH_WINDOW: {
        const window = await resolveWindow(action.target && action.target.window ? action.target.window : action.params.window || { title: action.params.title })
        if (!window && resolved && resolved.window) return focusResolved(action, resolved)
        if (!window) {
          if (resolved && resolved.ref) return focusResolved(action, resolved)
          throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'no window matched the focus request', { target: action.target })
        }
        const receipt = await requireDriver().focusWindow(window.handle)
        return receipt_(action, { ...receipt, ok: true, window: { handle: window.handle, title: window.title }, changed: true })
      }
      case ACTION_TYPES.CLOSE_WINDOW: {
        const reference = action.target && action.target.window ? action.target.window : action.params.window || {}
        const window = await resolveWindow(reference)
        if (!window) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'no window matched the close request', { reference })
        const receipt = await requireDriver().closeWindow(window.handle)
        return receipt_(action, { ...receipt, ok: true, window: { handle: window.handle, title: window.title }, changed: true })
      }
      case ACTION_TYPES.OPEN_APP: {
        const receipt = await requireDriver().openApplication(String(action.params.application), {
          args: action.params.args || [],
          cwd: action.params.cwd,
          waitForWindowMs: action.params.waitForWindowMs === undefined ? config.appStartTimeoutMs : action.params.waitForWindowMs
        })
        return receipt_(action, { ...receipt, ok: receipt && receipt.ok !== false, changed: true })
      }
      case ACTION_TYPES.ACCESSIBILITY_INVOKE: {
        if (!accessibility) throw unavailable('accessibility', 'no accessibility driver is attached to the runtime')
        if (!resolved || !resolved.ref) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'no accessibility node matched the invoke request', { target: action.target })
        const receipt = await accessibility.invoke(resolved.ref)
        return receipt_(action, { ...receipt, ok: receipt && receipt.ok !== false, ref: resolved.ref, changed: true })
      }
      case ACTION_TYPES.ACCESSIBILITY_SET_VALUE:
      case ACTION_TYPES.SELECT: {
        if (!accessibility) throw unavailable('accessibility', 'no accessibility driver is attached to the runtime')
        if (!resolved || !resolved.ref) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'no accessibility node matched the value request', { target: action.target })
        const value = action.params.value !== undefined ? action.params.value : action.params.text
        const receipt = await accessibility.setValue(resolved.ref, String(value === undefined ? '' : value))
        return receipt_(action, { ...receipt, ok: receipt && receipt.ok !== false, ref: resolved.ref, changed: true, sensitive: action.sensitive })
      }
      case ACTION_TYPES.WAIT_EVENT:
      case ACTION_TYPES.WAIT_STATE: {
        // Desktop waits are window/element waits: poll the structured sources
        // until the condition holds or the timeout expires (plan §12).
        const timeoutMs = action.timeoutMs || config.defaultWaitTimeoutMs
        const startedAt = clock.now()
        const condition = waitCondition(action, context)
        for (;;) {
          const current = await safe(() => requireDriver().listWindows(), [])
          const satisfied = evaluateWait(condition, current || [], context)
          if (satisfied) return receipt_(action, { ok: true, changed: true, detail: { condition, waitedMs: clock.now() - startedAt } })
          if (clock.now() - startedAt >= timeoutMs) {
            return receipt_(action, { ok: false, changed: false, timedOut: true, detail: { condition, waitedMs: clock.now() - startedAt } })
          }
          await sleep(config.eventPollMs, clock)
        }
      }
      default:
        throw new ComputerUseError(CODES.ACTION_UNSUPPORTED, `the desktop controller cannot run ${action.type}`)
    }
  }

  async function focusResolved(action, resolved) {
    if (resolved.ref && accessibility) {
      const receipt = await accessibility.focus(resolved.ref)
      return receipt_(action, { ...receipt, ok: receipt && receipt.ok !== false, ref: resolved.ref, changed: true })
    }
    if (resolved.windowHandle) {
      const receipt = await requireDriver().focusWindow(resolved.windowHandle)
      return receipt_(action, { ...receipt, ok: true, changed: true })
    }
    throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the focus target has neither an automation ref nor a window', { target: action.target })
  }

  /** Re-reads the element's bounds right before a coordinate click (plan §10). */
  async function revalidatePoint(resolved, previousPoint) {
    if (!accessibility || !resolved.ref) return { point: previousPoint, movement: 0, stale: false }
    const current = await safe(() => accessibility.find({ ref: resolved.ref, byRef: true }, { limit: 1 }), null)
    const node = Array.isArray(current) && current.length ? current[0] : null
    if (!node || !node.bounds) return { point: previousPoint, movement: 0, stale: false, detail: 'the element could not be re-read; using the verified coordinate' }
    const point = centerOf(node.bounds)
    const movement = Math.round(Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y))
    // Plan §10: > updatePx means the coordinate is stale; the executor's own
    // revalidation uses the same thresholds, this is the last-instant check.
    return { point, movement, stale: movement > 10 }
  }

  function waitCondition(action, context) {
    const effect = action.expectedEffect && Array.isArray(action.expectedEffect.any) ? action.expectedEffect.any[0] : null
    if (action.params.waitFor && typeof action.params.waitFor === 'object') return action.params.waitFor
    if (effect && effect.window_changed !== undefined) return { kind: 'foreground-changed', from: context.world ? context.world.activeWindowHandle : null }
    if (effect && effect.process_exited !== undefined) return { kind: 'process-exited' }
    if (action.params.window) return { kind: 'window-exists', window: action.params.window }
    return { kind: 'window-exists', window: action.target && action.target.window ? action.target.window : null }
  }

  function evaluateWait(condition, windows, context) {
    switch (condition.kind) {
      case 'foreground-changed': {
        const foreground = windows.find((window) => window.foreground)
        if (!foreground) return false
        return condition.from === null || condition.from === undefined || String(foreground.handle) !== String(condition.from)
      }
      case 'window-exists': {
        if (!condition.window) return windows.length > 0
        const needle = condition.window.title ? String(condition.window.title).toLowerCase() : null
        if (needle) return windows.some((window) => String(window.title || '').toLowerCase().includes(needle))
        if (condition.window.process) {
          const process = String(condition.window.process).toLowerCase()
          return windows.some((window) => String(window.processName || window.className || '').toLowerCase().includes(process))
        }
        return windows.length > 0
      }
      case 'process-exited': {
        if (!condition.pid) return false
        return !windows.some((window) => Number(window.processId) === Number(condition.pid))
      }
      default:
        return windows.length > 0
    }
  }

  function pointOf(action, resolved) {
    if (action.params.point) return normalizePoint(action.params.point)
    if (resolved && resolved.point) return resolved.point
    throw new ComputerUseError(CODES.TARGET_NOT_FOUND, `no coordinate is known for ${action.type}`, { target: action.target })
  }

  function receipt_(action, receipt) {
    return { controller: 'desktop', channel: 'gui', actionType: action.type, at: clock.now(), ...receipt }
  }

  async function safe(fn, fallback) {
    try {
      return await fn()
    } catch {
      return fallback
    }
  }

  /** Facts for verification and criteria (plan §15). */
  function facts() {
    return {
      windowExists: async (criterion) => {
        const windows = await safe(() => requireDriver().listWindows(), [])
        if (!windows) return null
        const needle = criterion.title ? String(criterion.title).toLowerCase() : null
        const process = criterion.process ? String(criterion.process).toLowerCase() : null
        return windows.some((window) => {
          if (needle && !String(window.title || '').toLowerCase().includes(needle)) return false
          if (process && !String(window.processName || window.className || '').toLowerCase().includes(process)) return false
          return Boolean(needle || process)
        })
      },
      foregroundWindow: async () => {
        const windows = await safe(() => requireDriver().listWindows(), [])
        return (windows || []).find((window) => window.foreground) || null
      },
      processRunning: async (name) => {
        const windows = await safe(() => requireDriver().listWindows(), [])
        if (!windows) return null
        return windows.some((window) => String(window.processName || '').toLowerCase().includes(String(name).toLowerCase()))
      },
      axFind: async (criterion) => {
        if (!accessibility) return null
        const hits = await safe(() => accessibility.find({ name: criterion.name, role: criterion.role, controlType: criterion.controlType, automationId: criterion.automationId }, { limit: 5 }), null)
        return hits
      }
    }
  }

  return {
    id: 'desktop',
    capability: 'desktop',
    probe,
    accessibilityProbe,
    supports,
    snapshot,
    locate,
    resolveWindow,
    perform,
    facts,
    get driver() {
      return driver
    },
    get accessibility() {
      return accessibility
    }
  }
}

function centerOf(rect) {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}

function normalizePoint(point) {
  if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    throw new ComputerUseError(CODES.ACTION_INVALID, 'a point needs finite x and y', { received: point })
  }
  return { x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }
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
    controlType: tree.controlType || tree.role || null,
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
    windowHandle: tree.windowHandle || null,
    processId: tree.processId
  })
  if (Array.isArray(tree.children)) for (const child of tree.children) flattenAx(child, out)
  return out
}

function sleep(ms, clock) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { createDesktopController, flattenAx }
