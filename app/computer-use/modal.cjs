'use strict'

/**
 * Computer Use Runtime: fail-safe modal handling
 * (Update-Plan/24h.md Task 2, Task 9 of the plan).
 *
 * A blocking dialog is where a computer-use agent does the most damage. The old
 * behaviour — "no semantic match, press the first button" — is exactly how an
 * agent confirms *"Delete this file?"* or *"Publish to production?"* on behalf of
 * a user who never saw it.
 *
 * So a dialog's controls are classified first, and the classes are ordered by what
 * they can do to the world:
 *
 *   safe_dismiss        closes the dialog and changes nothing else
 *   neutral_acknowledge reports that a message was seen
 *   positive_confirm    proceeds with the flow the task itself asked for
 *   destructive         deletes, overwrites, sends, publishes, installs, buys
 *   unknown             cannot be classified
 *
 * The fail-safe rule:
 *
 *   a destructive control is only pressed when the execution contract allows it
 *   AND the expected effect matches AND the safety gate passed
 *
 * and otherwise the runtime reports `USER_ACTION_REQUIRED` and stops — it does not
 * guess, and it never falls back to "the first button".
 *
 * No dialog semantics are remembered between tasks: the classification is a pure
 * function of the labels in front of it (24h.md Global Constraints).
 */

const { DESTRUCTIVE_KINDS, DESTRUCTIVE_MODES } = require('./constants.cjs')

/** The classification vocabulary. */
const MODAL_KINDS = Object.freeze({
  SAFE_DISMISS: 'safe_dismiss',
  NEUTRAL_ACKNOWLEDGE: 'neutral_acknowledge',
  POSITIVE_CONFIRM: 'positive_confirm',
  DESTRUCTIVE: 'destructive',
  UNKNOWN: 'unknown'
})

/** What the runtime should do about a dialog. */
const MODAL_ACTION = Object.freeze({
  PRESS: 'press',
  USER_ACTION_REQUIRED: 'USER_ACTION_REQUIRED',
  NO_DIALOG: 'no_dialog'
})

/**
 * Label vocabulary, ordered by precedence: the *first* table that matches a label
 * decides it. Destructive is checked first on purpose — a button labelled
 * "Delete and close" must never be read as a dismissal because it contains
 * "close".
 */
const DESTRUCTIVE_LABELS = Object.freeze([
  { pattern: /\bdelete\b|删除|删除并/i, kind: 'DELETE' },
  { pattern: /\b(overwrite|replace|discard(?!\s+all\s+changes?\?)|不予保存|覆盖|替换)\b/i, kind: 'DELETE' },
  { pattern: /\b(send|submit|发送|提交)\b/i, kind: 'SEND' },
  { pattern: /\b(publish|deploy|release|上传|发布|部署)\b/i, kind: 'PUBLISH' },
  { pattern: /\b(uninstall|卸载)\b/i, kind: 'UNINSTALL' },
  { pattern: /\b(install|安装)\b/i, kind: 'INSTALL' },
  { pattern: /\b(purchase|buy|pay|checkout|订阅|购买|支付)\b/i, kind: 'PURCHASE' },
  { pattern: /\b(format|格式化|erase|清除全部)\b/i, kind: 'FORMAT' },
  { pattern: /\b(sign\s*out|log\s*out|注销|退出登录)\b/i, kind: 'ACCOUNT_CHANGE' },
  { pattern: /\b(allow|grant|授权|允许)\b/i, kind: 'ACCOUNT_CHANGE' }
])

const SAFE_DISMISS_LABELS = Object.freeze([
  /\b(cancel|close|dismiss|no|not now|later|never mind|don'?t\s+save|keep)\b/i,
  /取消|关闭|以后再说|暂不|不保存|忽略/
])

const NEUTRAL_LABELS = Object.freeze([
  /\b(ok|okay|got it|i see|acknowledge|continue|next|知道了|好的|确定)\b/i
])

const POSITIVE_LABELS = Object.freeze([
  /\b(yes|confirm|proceed|save|apply|retry|try again|确认|继续|保存|重试)\b/i
])

/**
 * Classify one dialog control by its label.
 *
 * @param {string} label the button's visible text
 * @returns {{kind:string, destructiveKind:string|null, reason:string}}
 */
function classifyControl(label) {
  const text = String(label === undefined || label === null ? '' : label).trim()
  if (!text) return { kind: MODAL_KINDS.UNKNOWN, destructiveKind: null, reason: 'the control has no label' }

  for (const entry of DESTRUCTIVE_LABELS) {
    if (entry.pattern.test(text)) {
      return { kind: MODAL_KINDS.DESTRUCTIVE, destructiveKind: entry.kind, reason: `"${text}" names the ${entry.kind} effect` }
    }
  }
  for (const pattern of SAFE_DISMISS_LABELS) {
    if (pattern.test(text)) return { kind: MODAL_KINDS.SAFE_DISMISS, destructiveKind: null, reason: `"${text}" only closes the dialog` }
  }
  for (const pattern of NEUTRAL_LABELS) {
    if (pattern.test(text)) return { kind: MODAL_KINDS.NEUTRAL_ACKNOWLEDGE, destructiveKind: null, reason: `"${text}" acknowledges the message` }
  }
  for (const pattern of POSITIVE_LABELS) {
    if (pattern.test(text)) return { kind: MODAL_KINDS.POSITIVE_CONFIRM, destructiveKind: null, reason: `"${text}" proceeds with the flow` }
  }
  // A bare "Yes"/"No" pair is the classic unclassifiable dialog: "No" is safe,
  // "Yes" is not, and a label alone cannot say which effect it carries.
  if (/\byes\b|是|好的/i.test(text)) return { kind: MODAL_KINDS.UNKNOWN, destructiveKind: null, reason: `"${text}" carries no effect information` }
  return { kind: MODAL_KINDS.UNKNOWN, destructiveKind: null, reason: `"${text}" could not be classified` }
}

/**
 * Classify a whole dialog.
 *
 * @param {object} modal `{ message, type, controls: [{ label, ref }] }`
 */
function classifyModal(modal = {}) {
  const controls = Array.isArray(modal.controls) ? modal.controls.filter(Boolean) : []
  const classified = controls.map((control) => ({
    ref: control.ref || null,
    label: control.label || control.name || control.text || '',
    // The surface a candidate came from decides how it is pressed (a page modal
    // through the DOM, a native dialog through UI Automation), so it has to
    // survive classification — dropping it here turned every page control into a
    // desktop one.
    source: control.source || null,
    role: control.role || control.controlType || null,
    bbox: control.bbox || null,
    ...classifyControl(control.label || control.name || control.text)
  }))

  const messageText = String(modal.message || modal.text || '')
  // The dialog's own message can make an otherwise neutral button destructive:
  // "Delete this file?" with OK/Cancel means OK is the destructive one.
  const messageDestructive = DESTRUCTIVE_LABELS.find((entry) => entry.pattern.test(messageText)) || null

  return {
    type: modal.type || 'dialog',
    message: messageText || null,
    source: modal.source || null,
    ref: modal.ref || null,
    windowHandle: modal.windowHandle || null,
    messageDestructiveKind: messageDestructive ? messageDestructive.kind : null,
    controls: classified,
    counts: classified.reduce((acc, control) => {
      acc[control.kind] = (acc[control.kind] || 0) + 1
      return acc
    }, {})
  }
}

/**
 * Choose the control the runtime may press.
 *
 * @param {object} classification output of `classifyModal`
 * @param {object} [context]
 * @param {string} [context.destructiveMode] the contract's `safety.destructive_actions`
 * @param {string} [context.expectedEffect] what the current action expects to happen
 * @param {string[]} [context.destructiveKinds] kinds the *action* already declared
 * @param {boolean} [context.safetyPassed] did the safety gate allow this action?
 * @param {string} [context.goal] for the user-facing refusal message
 * @returns {{action:string, control:object|null, kind:string, reason:string, requiresUser:boolean, destructiveKind:string|null}}
 */
function chooseControl(classification, context = {}) {
  if (!classification || !classification.controls.length) {
    return {
      action: MODAL_ACTION.USER_ACTION_REQUIRED,
      control: null,
      kind: MODAL_KINDS.UNKNOWN,
      destructiveKind: classification ? classification.messageDestructiveKind : null,
      requiresUser: true,
      reason: 'the dialog exposes no control the runtime can classify'
    }
  }

  const safe = classification.controls.find((control) => control.kind === MODAL_KINDS.SAFE_DISMISS)
  const positive = classification.controls.find((control) => control.kind === MODAL_KINDS.POSITIVE_CONFIRM)
  const neutral = classification.controls.find((control) => control.kind === MODAL_KINDS.NEUTRAL_ACKNOWLEDGE)
  const destructive = classification.controls.filter((control) => control.kind === MODAL_KINDS.DESTRUCTIVE)

  // 1. A safe dismissal is always allowed: it is the only class that cannot change
  //    anything outside the dialog. It is preferred over everything else.
  if (safe) {
    return {
      action: MODAL_ACTION.PRESS,
      control: safe,
      kind: MODAL_KINDS.SAFE_DISMISS,
      destructiveKind: null,
      requiresUser: false,
      reason: `${safe.reason}; dismissing is the only action that cannot change the world`
    }
  }

  // 2. A destructive control needs all three conditions, and the dialog's own
  //    message can supply the destructiveness a bland label hides.
  if (destructive.length) {
    const mode = String(context.destructiveMode || DESTRUCTIVE_MODES.CONFIRM)
    const kinds = new Set([
      ...(Array.isArray(context.destructiveKinds) ? context.destructiveKinds : []),
      ...destructive.map((control) => control.destructiveKind).filter(Boolean),
      ...(classification.messageDestructiveKind ? [classification.messageDestructiveKind] : [])
    ])
    if (mode === DESTRUCTIVE_MODES.FORBIDDEN) {
      return {
        action: MODAL_ACTION.USER_ACTION_REQUIRED,
        control: null,
        kind: MODAL_KINDS.DESTRUCTIVE,
        destructiveKind: [...kinds][0] || null,
        requiresUser: true,
        reason: `the dialog offers ${[...kinds].join(', ') || 'a destructive'} and this contract forbids those actions`
      }
    }
    const expected = String(context.expectedEffect || '')
    const effectMatches = expected.length > 0 && [...kinds].some((kind) => expected.toUpperCase().includes(kind))
    if (!effectMatches) {
      return {
        action: MODAL_ACTION.USER_ACTION_REQUIRED,
        control: null,
        kind: MODAL_KINDS.DESTRUCTIVE,
        destructiveKind: [...kinds][0] || null,
        requiresUser: true,
        reason: `the dialog asks for ${[...kinds].join(', ') || 'a destructive action'} which the current action did not declare as its expected effect`
      }
    }
    if (context.safetyPassed !== true) {
      return {
        action: MODAL_ACTION.USER_ACTION_REQUIRED,
        control: null,
        kind: MODAL_KINDS.DESTRUCTIVE,
        destructiveKind: [...kinds][0] || null,
        requiresUser: true,
        reason: 'the safety gate did not authorize a destructive confirmation'
      }
    }
    return {
      action: MODAL_ACTION.PRESS,
      control: destructive[0],
      kind: MODAL_KINDS.DESTRUCTIVE,
      destructiveKind: [...kinds][0] || null,
      requiresUser: false,
      reason: `${destructive[0].reason}; authorized by the contract, the declared effect and the safety gate`
    }
  }

  // 3. A positive confirmation is only pressed when it is the flow's own next
  //    step, which the caller states by declaring it as the expected effect.
  if (positive) {
    const expected = String(context.expectedEffect || '')
    const declared = Array.isArray(context.destructiveKinds) && context.destructiveKinds.length > 0
    if (!declared && !expected) {
      return {
        action: MODAL_ACTION.USER_ACTION_REQUIRED,
        control: positive,
        kind: MODAL_KINDS.POSITIVE_CONFIRM,
        destructiveKind: null,
        requiresUser: true,
        reason: `"${positive.label}" proceeds with the flow, but the action declares no expected effect to justify it`
      }
    }
    return {
      action: MODAL_ACTION.PRESS,
      control: positive,
      kind: MODAL_KINDS.POSITIVE_CONFIRM,
      destructiveKind: null,
      requiresUser: false,
      reason: `${positive.reason}; the action declares the matching effect`
    }
  }

  // 4. An acknowledgement cannot change anything, so pressing it is the same class
  //    of decision as dismissing.
  if (neutral) {
    return {
      action: MODAL_ACTION.PRESS,
      control: neutral,
      kind: MODAL_KINDS.NEUTRAL_ACKNOWLEDGE,
      destructiveKind: null,
      requiresUser: false,
      reason: `${neutral.reason}; acknowledging a message changes nothing`
    }
  }

  // 5. Nothing classifiable: ask the user. Never "the first button".
  return {
    action: MODAL_ACTION.USER_ACTION_REQUIRED,
    control: null,
    kind: MODAL_KINDS.UNKNOWN,
    destructiveKind: classification.messageDestructiveKind,
    requiresUser: true,
    reason: `none of the dialog's ${classification.controls.length} control(s) could be classified (${classification.controls.map((entry) => entry.label || '?').join(', ')})`
  }
}

/** The destructive kinds a contract's mode allows at all. */
function destructiveAllowed(mode) {
  return String(mode || DESTRUCTIVE_MODES.CONFIRM) !== DESTRUCTIVE_MODES.FORBIDDEN
}

/** Is this kind one the plan names explicitly as destructive? */
function isDestructiveKind(kind) {
  return DESTRUCTIVE_KINDS.includes(String(kind || ''))
}

/**
 * Turn a list of candidate controls into a classification and a decision.
 *
 * The executor used to gather candidates and then pick one with three escalating
 * heuristics, the last of which was *"the dialog's own first button"*. This
 * function replaces those heuristics: candidates are classified by label, and the
 * decision comes from `chooseControl`, which never falls back to position.
 *
 * @param {object} input
 * @param {object} input.modal the observed dialog
 * @param {object[]} input.candidates `[{ ref, label, role, bbox, source }]`
 * @param {object} [input.context] forwarded to `chooseControl`
 * @returns {{action:string, control:object|null, classification:object, ref:string|null, source:string|null, reason:string, requiresUser:boolean, destructiveKind:string|null}}
 */
function planModal({ modal = {}, candidates = [], context = {} } = {}) {
  const usable = (Array.isArray(candidates) ? candidates : [])
    .filter(Boolean)
    .map((candidate) => ({
      ref: candidate.ref || null,
      label: candidate.label || candidate.name || candidate.text || '',
      role: candidate.role || candidate.controlType || null,
      bbox: candidate.bbox || null,
      source: candidate.source || null,
      disabled: candidate.disabled === true
    }))
    // A disabled control cannot be pressed, so it must not be classified as if it
    // could: pretending it is available would produce a choice that cannot run.
    .filter((candidate) => !candidate.disabled)

  const classification = classifyModal({ ...modal, controls: usable })
  const decision = chooseControl(classification, context)
  return {
    ...decision,
    classification,
    ref: decision.control ? decision.control.ref : null,
    source: decision.control ? decision.control.source : null
  }
}

module.exports = {
  MODAL_KINDS,
  MODAL_ACTION,
  DESTRUCTIVE_LABELS,
  SAFE_DISMISS_LABELS,
  NEUTRAL_LABELS,
  POSITIVE_LABELS,
  classifyControl,
  classifyModal,
  chooseControl,
  planModal,
  destructiveAllowed,
  isDestructiveKind
}
