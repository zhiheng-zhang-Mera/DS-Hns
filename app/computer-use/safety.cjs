'use strict'

/**
 * Computer Use Runtime: safety gate (plan §30, §31, §32, §33, §34).
 *
 * Five refusals live here, and every one of them is a *check before acting*
 * rather than a promise in a document:
 *
 *  §34 destructive gate — DELETE / PURCHASE / SEND / PUBLISH / INSTALL / … are
 *      classified and then allowed, confirmed or refused by the contract.
 *  §33 window safety   — clicking screen coordinates while another window is in
 *      front is how a computer-use agent types a password into the wrong app.
 *  §31 focus safety    — typing without a verified focus is refused.
 *  §32 input safety    — secrets are never written to the log, and a long text
 *      is verified after it lands.
 *  §30 modal handling  — a blocking dialog pauses the original action.
 */

const { DESTRUCTIVE_MODES } = require('./constants.cjs')
const { CODES, ComputerUseError, redactDetails } = require('./errors.cjs')
const { destructiveKinds, describeAction } = require('./action.cjs')
const { describeTarget } = require('./target.cjs')

const TYPING_ACTIONS = new Set(['TYPE', 'KEY_PRESS', 'HOTKEY', 'DOM_TYPE', 'ACCESSIBILITY_SET_VALUE'])
const POINTING_ACTIONS = new Set(['MOVE', 'CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'DRAG', 'SCROLL'])

function createSafetyGuard(options = {}) {
  const confirm = typeof options.confirm === 'function' ? options.confirm : null
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const decisions = []

  function record(decision) {
    decisions.push({ at: now(), ...decision })
    return decision
  }

  /**
   * Plan §34. Returns a decision instead of throwing so the executor can log
   * "refused" as a first-class step result; `assertActionAllowed` is the
   * throwing wrapper used right before execution.
   */
  function classify(action) {
    return {
      actionType: action.type,
      kinds: destructiveKinds(action),
      target: action.target ? describeTarget(action.target) : null,
      description: describeAction(action)
    }
  }

  function evaluateDestructive(action, context = {}) {
    const info = classify(action)
    if (!info.kinds.length) return record({ kind: 'destructive', allowed: true, mode: DESTRUCTIVE_MODES.ALLOWED, ...info })
    const contract = context.contract || options.contract || null
    const mode = contract ? contract.safety.destructiveActions : DESTRUCTIVE_MODES.CONFIRM
    if (mode === DESTRUCTIVE_MODES.FORBIDDEN) {
      return record({
        kind: 'destructive',
        allowed: false,
        mode,
        code: CODES.DESTRUCTIVE_FORBIDDEN,
        reason: `destructive action(s) ${info.kinds.join(', ')} are forbidden by this contract`,
        ...info
      })
    }
    if (mode === DESTRUCTIVE_MODES.CONFIRM) {
      // The confirmation itself is asynchronous, so the gate only records that
      // it is required; `assertActionAllowed` performs it.
      return record({
        kind: 'destructive',
        allowed: true,
        requiresConfirmation: true,
        mode,
        reason: `destructive action(s) ${info.kinds.join(', ')} require confirmation`,
        ...info
      })
    }
    return record({ kind: 'destructive', allowed: true, mode, ...info })
  }

  /**
   * Throws when the action must not run. `context.confirmed` lets a caller that
   * already obtained consent (an interactive panel, an acceptance harness) pass
   * it down without the guard asking twice.
   */
  async function assertActionAllowed(action, context = {}) {
    const decision = evaluateDestructive(action, context)
    if (!decision.allowed) {
      throw new ComputerUseError(decision.code || CODES.SAFETY_REFUSED, decision.reason, {
        action: decision.actionType,
        kinds: decision.kinds,
        mode: decision.mode
      })
    }
    if (decision.requiresConfirmation && !context.confirmed) {
      if (typeof confirm !== 'function') {
        throw new ComputerUseError(CODES.DESTRUCTIVE_NEEDS_CONFIRMATION, decision.reason, {
          action: decision.actionType,
          kinds: decision.kinds,
          hint: 'no confirmation callback was supplied by the host'
        })
      }
      const answer = await confirm({
        action: decision.actionType,
        kinds: decision.kinds,
        target: decision.target,
        description: decision.description,
        goal: context.contract ? context.contract.goal : null
      })
      if (answer !== true) {
        throw new ComputerUseError(CODES.SAFETY_REFUSED, `destructive action was not confirmed: ${decision.kinds.join(', ')}`, {
          action: decision.actionType,
          kinds: decision.kinds
        })
      }
      record({ kind: 'destructive-confirmation', allowed: true, confirmed: true, ...decision })
    }
    return decision
  }

  /**
   * Plan §33. `expectedWindow` is the window the action believes it is acting
   * on; when the foreground is something else, a coordinate click would land in
   * the wrong application and is refused.
   */
  function checkWindow(action, world, expectedWindow = null) {
    if (!POINTING_ACTIONS.has(action.type) && action.type !== 'ACCESSIBILITY_INVOKE') return record({ kind: 'window', allowed: true, checked: false })
    const contract = options.contract
    if (contract && contract.safety.requireForegroundWindow === false) return record({ kind: 'window', allowed: true, checked: false, reason: 'contract disables the foreground check' })
    const target = expectedWindow || windowFromTarget(action.target)
    if (!target) return record({ kind: 'window', allowed: true, checked: false, reason: 'no window expectation for this action' })
    const foreground = world ? world.foreground : null
    if (!foreground) {
      return record({
        kind: 'window',
        allowed: false,
        checked: true,
        code: CODES.WINDOW_MISMATCH,
        reason: 'no foreground window could be observed - refusing to click blind',
        expected: target
      })
    }
    if (!matchesWindow(foreground, target)) {
      return record({
        kind: 'window',
        allowed: false,
        checked: true,
        code: CODES.WINDOW_MISMATCH,
        reason: `foreground window "${foreground.title}" (pid ${foreground.processId}) is not the expected window`,
        expected: target,
        foreground: { title: foreground.title, handle: String(foreground.handle), processId: foreground.processId }
      })
    }
    return record({ kind: 'window', allowed: true, checked: true, foreground: { title: foreground.title, handle: String(foreground.handle) } })
  }

  function assertWindowAllowed(action, world, expectedWindow = null) {
    const decision = checkWindow(action, world, expectedWindow)
    if (!decision.allowed) {
      throw new ComputerUseError(decision.code || CODES.WINDOW_MISMATCH, decision.reason, {
        action: action.type,
        expected: decision.expected || null,
        foreground: decision.foreground || null
      })
    }
    return decision
  }

  /**
   * Plan §31. Typing goes to whatever has focus, so the focus is verified
   * first: either the world reports the target as focused, or the caller
   * supplies a verified focus receipt from the FOCUS action it just ran.
   */
  function checkFocus(action, world, options_ = {}) {
    if (!TYPING_ACTIONS.has(action.type)) return record({ kind: 'focus', allowed: true, checked: false })
    const contract = options.contract
    if (contract && contract.safety.requireFocusForTyping === false) return record({ kind: 'focus', allowed: true, checked: false, reason: 'contract disables the focus check' })
    if (options_.verifiedFocusRef) {
      return record({ kind: 'focus', allowed: true, checked: true, focusRef: options_.verifiedFocusRef, source: 'verified-receipt' })
    }
    const target = action.target
    const focusedRef = world ? world.focusedRef : null
    if (!target) {
      if (focusedRef) return record({ kind: 'focus', allowed: true, checked: true, focusRef: focusedRef, source: 'world' })
      return record({
        kind: 'focus',
        allowed: false,
        checked: true,
        code: CODES.FOCUS_MISMATCH,
        reason: 'no element has focus - typing would go to an unknown target'
      })
    }
    if (!focusedRef) {
      return record({
        kind: 'focus',
        allowed: false,
        checked: true,
        code: CODES.FOCUS_MISMATCH,
        reason: `target ${describeTarget(target)} is not focused - focus must be established and verified before typing`
      })
    }
    const expectedRefs = collectRefs(target, world)
    if (expectedRefs.length && !expectedRefs.includes(focusedRef)) {
      return record({
        kind: 'focus',
        allowed: false,
        checked: true,
        code: CODES.FOCUS_MISMATCH,
        reason: `focus is on ${focusedRef}, not on ${describeTarget(target)}`,
        focusedRef,
        expected: expectedRefs
      })
    }
    return record({ kind: 'focus', allowed: true, checked: true, focusRef: focusedRef, source: 'world' })
  }

  function assertFocusAllowed(action, world, options_ = {}) {
    const decision = checkFocus(action, world, options_)
    if (!decision.allowed) {
      throw new ComputerUseError(decision.code || CODES.FOCUS_MISMATCH, decision.reason, {
        action: action.type,
        focusedRef: decision.focusedRef || null
      })
    }
    return decision
  }

  /**
   * Plan §30. A blocking modal is reported so the caller can pause the original
   * action, handle the modal and resume — the gate never dismisses a dialog by
   * itself, because "which button is the safe one" is task knowledge.
   */
  function inspectModals(world) {
    const dialogs = (world && world.dialogs) || []
    if (!dialogs.length) return record({ kind: 'modal', blocking: false, modals: [] })
    const blocking = dialogs.filter((dialog) => dialog.blocking !== false && dialog.open !== false)
    return record({
      kind: 'modal',
      blocking: blocking.length > 0,
      modals: blocking.map((dialog) => ({
        type: dialog.type || 'dialog',
        message: dialog.message || '',
        ref: dialog.ref || null,
        // Which surface owns the dialog decides how it is answered: a page modal
        // through the DOM, a native dialog through UI Automation (plan §30).
        source: dialog.source || null,
        bounds: dialog.bounds || null,
        windowHandle: dialog.windowHandle || null,
        dismissible: dialog.dismissible === undefined ? null : Boolean(dialog.dismissible),
        // A file picker or a permission prompt is not the task's own dialog and
        // is exactly the case the plan calls out as "unexpected modal".
        unexpected: dialog.unexpected === undefined ? true : Boolean(dialog.unexpected)
      }))
    })
  }

  function assertNoBlockingModal(world) {
    const decision = inspectModals(world)
    if (decision.blocking) {
      throw new ComputerUseError(CODES.MODAL_BLOCKING, `a blocking dialog is open: ${decision.modals.map((modal) => modal.message || modal.type).join('; ')}`, {
        modals: decision.modals
      })
    }
    return decision
  }

  /** Plan §32: what may be written to the execution log for this action. */
  function redactAction(action) {
    const safe = {
      type: action.type,
      target: action.target ? describeTarget(action.target) : null,
      params: { ...action.params },
      destructive: action.destructive,
      sensitive: action.sensitive
    }
    if (action.sensitive || action.type === 'TYPE' || action.type === 'DOM_TYPE' || action.type === 'ACCESSIBILITY_SET_VALUE') {
      if (safe.params.text !== undefined) safe.params.text = '[redacted]'
      if (safe.params.value !== undefined) safe.params.value = '[redacted]'
    }
    if (safe.params.keys) safe.params.keys = safe.params.keys.map((key) => (String(key).length === 1 && action.sensitive ? '*' : key))
    if (safe.params.stdin !== undefined) safe.params.stdin = '[redacted]'
    if (safe.params.env !== undefined) safe.params.env = Object.keys(safe.params.env)
    return redactDetails(safe)
  }

  /** Plan §37: never leak a secret through an error message. */
  function redactText(text) {
    return String(text)
      .replace(/(password|passwd|pwd|token|secret|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
  }

  return {
    classify,
    evaluateDestructive,
    assertActionAllowed,
    checkWindow,
    assertWindowAllowed,
    checkFocus,
    assertFocusAllowed,
    inspectModals,
    assertNoBlockingModal,
    redactAction,
    redactText,
    decisions() {
      return decisions.slice()
    }
  }
}

function windowFromTarget(target) {
  if (!target) return null
  return target.window || null
}

function matchesWindow(window, expected) {
  if (!window || !expected) return false
  if (expected.handle !== undefined && String(window.handle) !== String(expected.handle)) return false
  if (expected.processId !== undefined && Number(window.processId) !== Number(expected.processId)) return false
  if (expected.className && String(window.className || '').toLowerCase() !== String(expected.className).toLowerCase()) return false
  if (expected.process) {
    const name = String(window.processName || window.process || '').toLowerCase()
    if (!name.includes(String(expected.process).toLowerCase())) return false
  }
  if (expected.title) {
    const title = String(window.title || '').toLowerCase()
    // A window title often carries a document name, so "contains" is the only
    // honest comparison; exact matching would refuse the right window.
    if (!title.includes(String(expected.title).toLowerCase())) return false
  }
  return true
}

function collectRefs(target, world) {
  const refs = []
  if (target.ref) refs.push(target.ref)
  if (!world) return refs
  const pools = [world.controls || [], world.ax || []]
  for (const pool of pools) {
    for (const entry of pool) {
      if (!entry) continue
      if (target.selector && entry.selector === target.selector) refs.push(entry.ref)
      if (target.accessibility && entry.role && target.accessibility.role && String(entry.role).toLowerCase() === String(target.accessibility.role).toLowerCase()
        && (!target.accessibility.name || String(entry.name || '').toLowerCase().includes(String(target.accessibility.name).toLowerCase()))) {
        refs.push(entry.ref)
      }
      if (target.semantic && entry.name && target.semantic.text && String(entry.name).toLowerCase().includes(String(target.semantic.text).toLowerCase())) {
        refs.push(entry.ref)
      }
    }
  }
  return [...new Set(refs.filter(Boolean))]
}

module.exports = { createSafetyGuard, TYPING_ACTIONS, POINTING_ACTIONS, matchesWindow }
