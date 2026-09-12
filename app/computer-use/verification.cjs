'use strict'

/**
 * Computer Use Runtime: verification (plan §14, §15, §46).
 *
 * Every meaningful action is verified, and every verification answers with one
 * of exactly three values:
 *
 *   success — the expected effect was observed
 *   failure — the effect was observably absent
 *   unknown — the runtime could not check (the controller is down, the target
 *             vanished before it could be read, the observation source is
 *             unavailable)
 *
 * `unknown` exists so that "we could not tell" never gets rounded up to "it
 * worked". That single rule is what makes the rest of the loop honest: a step
 * that cannot be verified cannot end a task.
 */

const { VERDICTS, VERIFICATION_KINDS } = require('./constants.cjs')
const { meaningfulChange, evidenceDigest } = require('./world-state.cjs')

function createVerifier(options = {}) {
  const clock = options.clock || { now: () => Date.now() }

  /**
   * @param {object} input
   * @param {object} input.action normalized action
   * @param {object|null} input.before world state before the action
   * @param {object|null} input.after world state after grace + wait
   * @param {object} [input.facts] controller facts (file/shell/vision/window)
   * @param {object} [input.receipt] what the controller reported doing
   * @returns {Promise<{verdict:string, kind:string, evidence:Array, checkedAt:number}>}
   */
  async function verify(input) {
    const { action, before, after, facts = {}, receipt = null } = input
    const effects = collectEffects(action, input.expectedEffect)
    const evidence = []

    if (receipt && receipt.ok === false && receipt.error) {
      // A controller that reports a failed action does not need the world to
      // confirm it: failure is already established.
      return finish(VERDICTS.FAILURE, VERIFICATION_KINDS.NONE, [{ kind: 'receipt', ok: false, detail: receipt.error }], clock.now())
    }

    if (!effects.length) {
      // Plan §14/§15: an action that declares no effect still gets verified.
      // Some actions have an *implied* state to check rather than a change:
      // "focus this window" is verified by the window being in front, "close
      // this window" by the window being gone. Checking those directly is more
      // honest than demanding a change an already-focused window cannot make.
      const implied = impliedStateVerification(action, after)
      if (implied) return finish(implied.verdict, implied.kind, [implied.evidence], clock.now())

      // Otherwise the implicit expectation is "something changed". This is
      // exactly the check that catches a missed click (plan §17). It uses the
      // *evidence* digest (DOM revision, event stream, value) rather than the
      // stricter progress signature: a mutation is evidence that the action had
      // an effect, while whether it was *progress* is the stall detector's
      // question and must not be answered twice.
      const change = meaningfulChange(before, after)
      if (!before || !after) {
        return finish(VERDICTS.UNKNOWN, VERIFICATION_KINDS.DIRECT, [{ kind: 'world-change', ok: null, detail: 'no comparable observation' }], clock.now())
      }
      const beforeDigest = evidenceDigest(before)
      const afterDigest = evidenceDigest(after)
      const observed = change.changed || (beforeDigest !== null && afterDigest !== null && beforeDigest !== afterDigest)
      evidence.push({
        kind: 'world-change',
        ok: observed,
        detail: change.changed ? change.fields : observed ? ['DOM revision or event stream changed'] : []
      })
      if (receipt && receipt.signals) evidence.push(...receipt.signals)
      const receiptChanged = Boolean(receipt && receipt.changed === true)
      return finish(observed || receiptChanged ? VERDICTS.SUCCESS : VERDICTS.FAILURE, VERIFICATION_KINDS.DIRECT, evidence, clock.now())
    }

    // The declared mode wins: `all` means every listed effect must hold.
    const mode = input.effectMode || (action && action.expectedEffect && action.expectedEffect.mode) || 'any'
    const results = []
    for (const effect of effects) {
      const evaluated = await evaluateEffect(effect, { action, before, after, facts, receipt })
      results.push(evaluated)
      evidence.push(evaluated)
    }
    const anyOk = results.some((result) => result.ok === true)
    const anyUnknown = results.some((result) => result.ok === null || result.ok === undefined)
    const allOk = results.every((result) => result.ok === true)
    const kind = dominantKind(results)

    if (mode === 'all') {
      if (allOk) return finish(VERDICTS.SUCCESS, kind, evidence, clock.now())
      if (results.some((result) => result.ok === false)) return finish(VERDICTS.FAILURE, kind, evidence, clock.now())
      return finish(VERDICTS.UNKNOWN, kind, evidence, clock.now())
    }
    if (anyOk) return finish(VERDICTS.SUCCESS, kind, evidence, clock.now())
    if (anyUnknown) {
      // Some effects could not be checked; if the ones that *were* checked all
      // failed, the honest answer is still "could not tell" only when nothing
      // was checkable at all.
      const checked = results.filter((result) => result.ok === true || result.ok === false)
      if (!checked.length) return finish(VERDICTS.UNKNOWN, kind, evidence, clock.now())
      return finish(VERDICTS.FAILURE, kind, evidence, clock.now())
    }
    return finish(VERDICTS.FAILURE, kind, evidence, clock.now())
  }

  function finish(verdict, kind, evidence, checkedAt) {
    return { verdict, kind, evidence, checkedAt }
  }

  return { verify }
}

function collectEffects(action, override) {
  const source = override || (action ? action.expectedEffect : null)
  if (!source) return []
  if (Array.isArray(source.any)) return source.any
  if (Array.isArray(source.all)) return source.all
  return []
}

function dominantKind(results) {
  const kinds = results.map((result) => result.verificationKind).filter(Boolean)
  if (!kinds.length) return VERIFICATION_KINDS.NONE
  const order = [
    VERIFICATION_KINDS.NAVIGATION,
    VERIFICATION_KINDS.FILE,
    VERIFICATION_KINDS.PROCESS,
    VERIFICATION_KINDS.EVENT,
    VERIFICATION_KINDS.STATE,
    VERIFICATION_KINDS.FOCUS,
    VERIFICATION_KINDS.VISUAL,
    VERIFICATION_KINDS.DIRECT
  ]
  for (const kind of order) if (kinds.includes(kind)) return kind
  return kinds[0]
}

/**
 * One expected-effect evaluator per documented signal. Every branch returns
 * `{ ok, detail, verificationKind }` and uses `ok: null` when the fact it needs
 * is unavailable.
 */
async function evaluateEffect(effect, context) {
  const { action, before, after, facts, receipt } = context
  if (effect.event !== undefined) {
    const name = String(effect.event)
    const seen = (after && after.systemEvents ? after.systemEvents : []).some((event) => event && (event.type === name || event.name === name))
    if (seen) return ok(VERIFICATION_KINDS.EVENT, `event observed: ${name}`)
    if (!after) return unknown(VERIFICATION_KINDS.EVENT, 'no observation to search for the event')
    return failed(VERIFICATION_KINDS.EVENT, `event not observed: ${name}`)
  }
  if (effect.dom_mutated !== undefined) {
    if (!before || !after) return unknown(VERIFICATION_KINDS.EVENT, 'no comparable DOM revision')
    if (before.revision === null || after.revision === null) return unknown(VERIFICATION_KINDS.EVENT, 'the page does not report a DOM revision')
    return before.revision !== after.revision
      ? ok(VERIFICATION_KINDS.EVENT, `DOM revision ${before.revision} -> ${after.revision}`)
      : failed(VERIFICATION_KINDS.EVENT, `DOM revision unchanged (${after.revision})`)
  }
  if (effect.navigation !== undefined || effect.url_changed !== undefined) {
    if (!before || !after) return unknown(VERIFICATION_KINDS.NAVIGATION, 'no comparable URL')
    if (before.url === null || after.url === null) return unknown(VERIFICATION_KINDS.NAVIGATION, 'no page is attached')
    return before.url !== after.url
      ? ok(VERIFICATION_KINDS.NAVIGATION, `${before.url} -> ${after.url}`)
      : failed(VERIFICATION_KINDS.NAVIGATION, `URL unchanged (${after.url})`)
  }
  if (effect.url_matches !== undefined) {
    const url = after ? after.url : null
    if (typeof url !== 'string') return unknown(VERIFICATION_KINDS.NAVIGATION, 'no page is attached')
    const matches = String(url).toLowerCase().includes(String(effect.url_matches).toLowerCase())
    return matches ? ok(VERIFICATION_KINDS.NAVIGATION, `url matches ${effect.url_matches}`) : failed(VERIFICATION_KINDS.NAVIGATION, `url ${url} does not match ${effect.url_matches}`)
  }
  if (effect.toast !== undefined) {
    const present = await textPresent(effect.toast, after, facts, effect)
    if (present === true) return ok(VERIFICATION_KINDS.DIRECT, `text visible: ${effect.toast}`)
    if (present === null) return unknown(VERIFICATION_KINDS.DIRECT, 'no observation to read')
    return failed(VERIFICATION_KINDS.DIRECT, `text not visible: ${effect.toast}`)
  }
  if (effect.text_appears !== undefined) {
    const present = await textPresent(effect.text_appears, after, facts, effect)
    if (present === true) return ok(VERIFICATION_KINDS.DIRECT, `text appeared: ${effect.text_appears}`)
    if (present === null) return unknown(VERIFICATION_KINDS.DIRECT, 'no observation to read')
    return failed(VERIFICATION_KINDS.DIRECT, `text did not appear: ${effect.text_appears}`)
  }
  if (effect.text_disappears !== undefined) {
    const present = await textPresent(effect.text_disappears, after, facts, effect)
    if (present === null) return unknown(VERIFICATION_KINDS.DIRECT, 'no observation to read')
    return present ? failed(VERIFICATION_KINDS.DIRECT, `text still visible: ${effect.text_disappears}`) : ok(VERIFICATION_KINDS.DIRECT, `text disappeared: ${effect.text_disappears}`)
  }
  if (effect.control_state_changed !== undefined) {
    const change = targetChange(action, before, after)
    if (change === null) return unknown(VERIFICATION_KINDS.STATE, 'the target could not be compared')
    return change ? ok(VERIFICATION_KINDS.STATE, 'the target control changed state') : failed(VERIFICATION_KINDS.STATE, 'the target control did not change state')
  }
  if (effect.target_disappears !== undefined) {
    const still = targetPresent(action, after)
    if (still === null) return unknown(VERIFICATION_KINDS.DIRECT, 'the target could not be located after the action')
    return still ? failed(VERIFICATION_KINDS.DIRECT, 'the target is still present') : ok(VERIFICATION_KINDS.DIRECT, 'the target disappeared')
  }
  if (effect.target_appears !== undefined) {
    const present = targetPresent(action, after)
    if (present === null) return unknown(VERIFICATION_KINDS.DIRECT, 'the target could not be located after the action')
    return present ? ok(VERIFICATION_KINDS.DIRECT, 'the target appeared') : failed(VERIFICATION_KINDS.DIRECT, 'the target did not appear')
  }
  if (effect.value_equals !== undefined) {
    const focused = after && after.focusedElement ? after.focusedElement.value : undefined
    const elementValue = focused !== undefined ? focused : findValue(after, action)
    if (elementValue === undefined || elementValue === null) return unknown(VERIFICATION_KINDS.STATE, 'no value could be read')
    return String(elementValue) === String(effect.value_equals)
      ? ok(VERIFICATION_KINDS.STATE, `value is ${effect.value_equals}`)
      : failed(VERIFICATION_KINDS.STATE, `value is ${JSON.stringify(elementValue)}, expected ${JSON.stringify(effect.value_equals)}`)
  }
  if (effect.checked_equals !== undefined) {
    const control = findControl(after, action)
    if (!control || control.checked === undefined) return unknown(VERIFICATION_KINDS.STATE, 'no checkbox state could be read')
    return Boolean(control.checked) === Boolean(effect.checked_equals)
      ? ok(VERIFICATION_KINDS.STATE, `checked=${effect.checked_equals}`)
      : failed(VERIFICATION_KINDS.STATE, `checked=${control.checked}`)
  }
  if (effect.focus_changed !== undefined) {
    if (!before || !after) return unknown(VERIFICATION_KINDS.FOCUS, 'no comparable focus state')
    return before.focusedRef !== after.focusedRef
      ? ok(VERIFICATION_KINDS.FOCUS, `focus ${before.focusedRef} -> ${after.focusedRef}`)
      : failed(VERIFICATION_KINDS.FOCUS, `focus unchanged (${after.focusedRef})`)
  }
  if (effect.window_changed !== undefined) {
    if (!before || !after) return unknown(VERIFICATION_KINDS.STATE, 'no comparable window state')
    const changed = before.activeWindowHandle !== after.activeWindowHandle
    return changed ? ok(VERIFICATION_KINDS.STATE, `window ${before.activeWindow} -> ${after.activeWindow}`) : failed(VERIFICATION_KINDS.STATE, 'the active window did not change')
  }
  if (effect.file_created !== undefined || effect.file_exists !== undefined) {
    const target = effect.file_created !== undefined ? effect.file_created : effect.file_exists
    if (typeof facts.fileExists !== 'function') return unknown(VERIFICATION_KINDS.FILE, 'the file controller is unavailable')
    const exists = await facts.fileExists(target)
    return exists ? ok(VERIFICATION_KINDS.FILE, `file exists: ${target}`) : failed(VERIFICATION_KINDS.FILE, `file missing: ${target}`)
  }
  if (effect.file_missing !== undefined) {
    if (typeof facts.fileExists !== 'function') return unknown(VERIFICATION_KINDS.FILE, 'the file controller is unavailable')
    const exists = await facts.fileExists(effect.file_missing)
    return exists
      ? failed(VERIFICATION_KINDS.FILE, `file still exists: ${effect.file_missing}`)
      : ok(VERIFICATION_KINDS.FILE, `file is gone: ${effect.file_missing}`)
  }
  if (effect.file_modified !== undefined) {
    if (typeof facts.fileModifiedSince !== 'function') return unknown(VERIFICATION_KINDS.FILE, 'the file controller is unavailable')
    // `file_modified: "<path>"` asks "was this file written during this action?";
    // the baseline is when the pre-action observation was taken.
    const target = effect.file_modified === true ? (action.params.path || null) : effect.file_modified
    if (!target) return unknown(VERIFICATION_KINDS.FILE, 'no path was given for the file_modified expectation')
    const since = effect.since !== undefined ? effect.since : (before ? before.capturedAt : null)
    const modified = await facts.fileModifiedSince(target, since)
    if (modified === null || modified === undefined) return unknown(VERIFICATION_KINDS.FILE, 'no file mtime could be read')
    return modified ? ok(VERIFICATION_KINDS.FILE, `file was modified: ${target}`) : failed(VERIFICATION_KINDS.FILE, `file was not modified: ${target}`)
  }
  if (effect.process_exited !== undefined) {
    if (!facts.lastShell) return unknown(VERIFICATION_KINDS.PROCESS, 'no shell result has been recorded')
    const exited = facts.lastShell.exited === true
    return exited ? ok(VERIFICATION_KINDS.PROCESS, `process exited with ${facts.lastShell.exitCode}`) : failed(VERIFICATION_KINDS.PROCESS, 'the process has not exited')
  }
  if (effect.exit_code !== undefined) {
    if (!facts.lastShell || typeof facts.lastShell.exitCode !== 'number') return unknown(VERIFICATION_KINDS.PROCESS, 'no exit code has been recorded')
    return facts.lastShell.exitCode === Number(effect.exit_code)
      ? ok(VERIFICATION_KINDS.PROCESS, `exit code ${effect.exit_code}`)
      : failed(VERIFICATION_KINDS.PROCESS, `exit code ${facts.lastShell.exitCode}, expected ${effect.exit_code}`)
  }
  if (effect.stdout_matches !== undefined || effect.stderr_matches !== undefined) {
    if (!facts.lastShell) return unknown(VERIFICATION_KINDS.PROCESS, 'no shell result has been recorded')
    const text = effect.stdout_matches !== undefined ? facts.lastShell.stdout : facts.lastShell.stderr
    const pattern = effect.stdout_matches !== undefined ? effect.stdout_matches : effect.stderr_matches
    if (typeof text !== 'string') return unknown(VERIFICATION_KINDS.PROCESS, 'no captured output')
    const matched = new RegExp(String(pattern), 'i').test(text)
    return matched ? ok(VERIFICATION_KINDS.PROCESS, `output matches ${pattern}`) : failed(VERIFICATION_KINDS.PROCESS, `output does not match ${pattern}`)
  }
  if (effect.visual_change !== undefined) {
    if (typeof facts.visualChange !== 'function') return unknown(VERIFICATION_KINDS.VISUAL, 'the vision controller is unavailable')
    const result = await facts.visualChange(effect)
    if (result === null || result === undefined) return unknown(VERIFICATION_KINDS.VISUAL, 'no visual comparison was possible')
    return result ? ok(VERIFICATION_KINDS.VISUAL, 'the observed region changed') : failed(VERIFICATION_KINDS.VISUAL, 'the observed region is unchanged')
  }
  return unknown(VERIFICATION_KINDS.NONE, `unsupported expected effect: ${Object.keys(effect).join(', ')}`)
}

/**
 * The state an action implies, checked when the author declared no effect.
 * Only the actions whose whole purpose *is* a state are covered here; everything
 * else falls through to "did something change".
 */
function impliedStateVerification(action, after) {
  if (!after || !action) return null
  const kindOf = (window) => (window ? `${window.title || ''}#${window.handle}` : null)
  switch (action.type) {
    case 'FOCUS':
    case 'SWITCH_WINDOW': {
      const expected = action.target && action.target.window ? action.target.window : null
      if (!expected) return null
      const foreground = after.foreground || (after.windows || []).find((window) => window.foreground) || null
      if (!foreground) {
        return {
          verdict: VERDICTS.UNKNOWN,
          kind: VERIFICATION_KINDS.FOCUS,
          evidence: { kind: 'focus-state', ok: null, detail: 'no foreground window could be observed' }
        }
      }
      const matches = (!expected.handle || String(foreground.handle) === String(expected.handle))
        && (!expected.title || String(foreground.title || '').toLowerCase().includes(String(expected.title).toLowerCase()))
        && (expected.processId === undefined || Number(foreground.processId) === Number(expected.processId))
      return {
        verdict: matches ? VERDICTS.SUCCESS : VERDICTS.FAILURE,
        kind: VERIFICATION_KINDS.FOCUS,
        evidence: {
          kind: 'focus-state',
          ok: matches,
          detail: matches ? `focus is on ${kindOf(foreground)}` : `focus is on ${kindOf(foreground)}, not on the requested window`
        }
      }
    }
    case 'CLOSE_WINDOW': {
      const expected = action.target && action.target.window ? action.target.window : null
      if (!expected) return null
      const still = (after.windows || []).some((window) => (!expected.handle || String(window.handle) === String(expected.handle))
        && (!expected.title || String(window.title || '').toLowerCase().includes(String(expected.title).toLowerCase())))
      return {
        verdict: still ? VERDICTS.FAILURE : VERDICTS.SUCCESS,
        kind: VERIFICATION_KINDS.STATE,
        evidence: { kind: 'window-state', ok: !still, detail: still ? 'the window is still open' : 'the window is gone' }
      }
    }
    default:
      return null
  }
}

function ok(kind, detail) {
  return { ok: true, verificationKind: kind, detail }
}

function failed(kind, detail) {
  return { ok: false, verificationKind: kind, detail }
}

function unknown(kind, detail) {
  return { ok: null, verificationKind: kind, detail }
}

function findText(world, needle) {
  if (!world) return null
  const pools = [world.controls || [], world.ax || []]
  for (const pool of pools) {
    for (const item of pool) {
      if (!item) continue
      const haystack = `${item.name || ''} ${item.text || ''} ${item.value || ''} ${item.role || ''}`.toLowerCase()
      if (haystack.includes(needle)) return item
    }
  }
  return null
}

/**
 * Is a piece of text on screen?
 *
 * The world state carries the controls and the accessibility tree, which is
 * enough for a toast that the page exposes as a control. A plain text node —
 * `<p role="status">Saved</p>` — is not an interactive element and may not be in
 * either pool, so the page itself is asked for its visible text as a fallback
 * (one `domText` lookup, not a screenshot).
 *
 * @returns {Promise<boolean|null>} null when nothing could be read at all
 */
async function textPresent(value, world, facts, effect) {
  const needle = String(value).toLowerCase()
  if (findText(world, needle)) return true
  const selector = effect && effect.selector ? effect.selector : 'body'
  if (typeof facts.domText === 'function') {
    const text = await facts.domText(selector)
    if (typeof text === 'string') return text.toLowerCase().includes(needle)
  }
  if (world) return false
  return null
}

function findControl(world, action) {
  if (!world || !action || !action.target) return null
  const pools = [world.controls || [], world.ax || []]
  for (const pool of pools) {
    for (const item of pool) {
      if (!item) continue
      if (action.target.ref && item.ref === action.target.ref) return item
      if (action.target.selector && item.selector === action.target.selector) return item
      if (action.target.semantic && action.target.semantic.text && String(item.name || '').toLowerCase().includes(String(action.target.semantic.text).toLowerCase())) return item
      if (action.target.accessibility && action.target.accessibility.name && String(item.name || '').toLowerCase().includes(String(action.target.accessibility.name).toLowerCase())) return item
    }
  }
  return null
}

function findValue(world, action) {
  const control = findControl(world, action)
  return control ? control.value : undefined
}

function targetPresent(world, action) {
  if (!world || !action || !action.target) return null
  if (!world.controls && !world.ax) return null
  return Boolean(findControl(world, action))
}

/** Plan §17: "the control's own state changed" — the strongest direct signal. */
function targetChange(action, before, after) {
  const first = findControl(before, action)
  const second = findControl(after, action)
  if (!first || !second) return null
  const fields = ['value', 'checked', 'disabled', 'visible', 'name', 'text']
  for (const field of fields) {
    const a = first[field]
    const b = second[field]
    if (a === undefined && b === undefined) continue
    if (JSON.stringify(a) !== JSON.stringify(b)) return true
  }
  return false
}

function verifyFactsFrom(state) {
  return { worldDigest: evidenceDigest(state) }
}

module.exports = { createVerifier, evaluateEffect, verifyFactsFrom, targetPresent, findControl }
