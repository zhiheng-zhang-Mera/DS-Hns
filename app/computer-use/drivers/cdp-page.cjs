'use strict'

/**
 * Computer Use Runtime: Chromium page adapter over the Chrome DevTools Protocol.
 *
 * This is the production implementation of the `page` port (plan §26, §3.2). It
 * is written against a *transport*, not against Electron, so the same adapter
 * drives:
 *
 *   - the shell's own `WebContentsView` (Electron's `webContents.debugger`),
 *   - an external Chromium/Brave/Edge started with `--remote-debugging-port`
 *     (a WebSocket transport, see `createWebSocketTransport`),
 *
 * and, in tests, an in-process device. The adapter never guesses: it reads the
 * DOM and the accessibility tree, dispatches *real* input events through CDP,
 * and reports what actually happened (including "the click was swallowed"),
 * which is what the miss detector (plan §17) and the verifier (plan §14) need.
 *
 * Everything the adapter injects into the page is a small, documented helper:
 * a mutation counter and a ref registry. No page is ever asked to change its
 * own behaviour for the runtime.
 */

const { CODES, ComputerUseError } = require('../errors.cjs')

/** Injected once per document: a revision counter, a ref registry and click accounting. */
const BOOTSTRAP = `(() => {
  if (window.__dshCu) return 'already-installed'
  const state = {
    revision: 0,
    refs: new WeakMap(),
    byRef: new Map(),
    clicks: [],
    lastClick: null,
    dialogs: [],
    events: [],
    nextRef: 1
  }
  window.__dshCu = state
  const bump = () => { state.revision += 1 }
  const observer = new MutationObserver((records) => {
    state.revision += records.length
    state.events.push({ type: 'dom_mutated', at: Date.now(), count: records.length })
    if (state.events.length > 200) state.events.splice(0, state.events.length - 200)
  })
  const start = () => {
    if (!document.documentElement) return
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    bump()
  }
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
  document.addEventListener('click', (event) => {
    const entry = { at: Date.now(), target: describe(event.target), swallowed: event.defaultPrevented === false && state.revision === state.lastClickRevision }
    state.clicks.push(entry)
    state.events.push({ type: 'click', at: entry.at })
  }, true)
  document.addEventListener('input', (event) => {
    bump()
    state.events.push({ type: 'input', at: Date.now(), target: describe(event.target) })
  }, true)
  document.addEventListener('focusin', (event) => {
    state.events.push({ type: 'focus_changed', at: Date.now(), target: describe(event.target) })
  }, true)
  function describe(node) {
    if (!node || !node.tagName) return null
    return { tag: node.tagName.toLowerCase(), id: node.id || null, name: node.getAttribute ? node.getAttribute('name') : null }
  }
  state.refFor = (element) => {
    if (!element || element.nodeType !== 1) return null
    let ref = element.getAttribute('data-dsh-cu-ref')
    if (!ref) {
      ref = 'cu-' + (state.nextRef++)
      try { element.setAttribute('data-dsh-cu-ref', ref) } catch (error) { return null }
      state.refs.set(element, ref)
      state.byRef.set(ref, element)
    }
    return ref
  }
  state.elementFor = (ref) => {
    if (!ref) return null
    const cached = state.byRef.get(ref)
    if (cached && cached.isConnected) return cached
    return document.querySelector('[data-dsh-cu-ref="' + ref + '"]')
  }
  state.bump = bump
  return 'installed'
})()`

/** Element descriptor collection, shared by query/queryAll/snapshot. */
const DESCRIBE_FN = `(() => {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]:not([tabindex="-1"])'
  function accessibleName(element) {
    const aria = element.getAttribute && (element.getAttribute('aria-label') || element.getAttribute('title'))
    if (aria) return aria.trim()
    if (element.labels && element.labels.length) return Array.from(element.labels).map((label) => (label.innerText || '').trim()).join(' ').trim()
    const labelledBy = element.getAttribute && element.getAttribute('aria-labelledby')
    if (labelledBy) {
      const target = document.getElementById(labelledBy)
      if (target) return (target.innerText || '').trim()
    }
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
      const placeholder = element.getAttribute('placeholder')
      if (placeholder) return placeholder.trim()
      if (element.value) return String(element.value)
      if (element.name) return element.name
      if (element.id) return element.id
      return element.tagName.toLowerCase()
    }
    const text = (element.innerText || element.textContent || '').trim()
    return text.slice(0, 120)
  }
  function roleOf(element) {
    const explicit = element.getAttribute && element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (tag === 'summary') return 'button'
    return 'generic'
  }
  function visible(element, rect) {
    if (!rect || rect.width === 0 || rect.height === 0) return false
    const style = window.getComputedStyle(element)
    if (!style) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    return true
  }
  function selectorOf(element) {
    if (element.id) return '#' + CSS.escape(element.id)
    const testId = element.getAttribute && element.getAttribute('data-testid')
    if (testId) return '[data-testid="' + testId + '"]'
    const name = element.getAttribute && element.getAttribute('name')
    if (name) return element.tagName.toLowerCase() + '[name="' + name + '"]'
    return null
  }
  function describe(element) {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return {
      ref: window.__dshCu ? window.__dshCu.refFor(element) : null,
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      name: accessibleName(element),
      text: (element.innerText || '').trim().slice(0, 200),
      value: element.value === undefined ? null : String(element.value),
      checked: typeof element.checked === 'boolean' ? element.checked : null,
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      visible: visible(element, rect),
      actionable: !element.disabled,
      bbox: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
      selector: selectorOf(element),
      attributes: {
        id: element.id || null,
        class: element.className && typeof element.className === 'string' ? element.className : null,
        type: element.getAttribute('type'),
        name: element.getAttribute('name'),
        placeholder: element.getAttribute('placeholder'),
        href: element.getAttribute('href'),
        'aria-label': element.getAttribute('aria-label')
      },
      pointerEvents: style ? style.pointerEvents : null
    }
  }
  window.__dshCuDescribe = describe
  return describe
})()`

function createCdpPage(options = {}) {
  const transport = options.transport
  const clock = options.clock || { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const id = options.id || 'page-1'
  const pollMs = options.pollMs || 40
  let attached = false
  let bootstrapState = null
  let eventLog = []
  const listeners = []
  let pendingDialog = null

  function requireTransport() {
    if (!transport || typeof transport.send !== 'function') {
      throw new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, 'the CDP transport is not attached')
    }
    return transport
  }

  async function send(method, params = {}) {
    return requireTransport().send(method, params)
  }

  function record(event) {
    eventLog.push({ at: clock.now(), ...event })
    if (eventLog.length > 300) eventLog.splice(0, eventLog.length - 300)
  }

  /** Called by the host when the transport starts delivering CDP events. */
  function handleEvent(method, params) {
    if (method === 'Page.javascriptDialogOpening') {
      pendingDialog = { type: params.type, message: params.message, open: true, blocking: true, url: params.url }
      record({ type: 'dialog_opened', dialog: pendingDialog })
    } else if (method === 'Page.javascriptDialogClosed') {
      pendingDialog = null
      record({ type: 'dialog_closed' })
    } else if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
      record({ type: 'url_changed', url: params.frame.url })
    } else if (method === 'Page.loadEventFired') {
      record({ type: 'load_state_changed', readyState: 'complete' })
    }
    for (const listener of listeners) {
      try {
        listener(method, params)
      } catch {
        /* a listener must never break the page adapter */
      }
    }
  }

  /**
   * Attaches to the page: enables the CDP domains the adapter needs and installs
   * the page-side helper. Safe to call more than once.
   */
  async function attach() {
    if (attached) return { ok: true, bootstrap: bootstrapState }
    const domains = [
      ['Page.enable', {}],
      ['Runtime.enable', {}],
      ['DOM.enable', {}],
      ['Accessibility.enable', {}]
    ]
    for (const [method, params] of domains) {
      try {
        await send(method, params)
      } catch {
        // A domain that cannot be enabled degrades that capability only.
      }
    }
    try {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTSTRAP })
      // The descriptor helper is installed the same way, so it survives every
      // navigation instead of only existing on the first document.
      await send('Page.addScriptToEvaluateOnNewDocument', { source: DESCRIBE_FN })
    } catch {
      /* older protocol versions */
    }
    bootstrapState = await evaluate(BOOTSTRAP, { raw: true })
    // The document that is already loaded never saw the new-document scripts.
    await evaluate(DESCRIBE_FN, { raw: true })
    attached = true
    record({ type: 'attached' })
    return { ok: true, bootstrap: bootstrapState }
  }

  async function evaluate(expression, options_ = {}) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: options_.awaitPromise === true,
      userGesture: options_.userGesture === true
    })
    if (result && result.exceptionDetails) {
      const message = result.exceptionDetails.exception && result.exceptionDetails.exception.description
        ? result.exceptionDetails.exception.description
        : result.exceptionDetails.text
      throw new ComputerUseError(CODES.CONTROLLER_FAILED, `the page raised an error while evaluating: ${message}`, { expression: options_.label || null })
    }
    return result && result.result ? result.result.value : undefined
  }

  function probe() {
    if (!transport || typeof transport.send !== 'function') {
      return { available: false, reason: 'no CDP transport is attached', detail: { adapter: 'cdp' } }
    }
    if (transport.probe) {
      try {
        const verdict = transport.probe()
        if (verdict && verdict.available === false) return verdict
      } catch (error) {
        return { available: false, reason: error && error.message ? error.message : String(error), detail: { adapter: 'cdp' } }
      }
    }
    return { available: true, reason: null, detail: { adapter: 'cdp', attached } }
  }

  async function snapshot() {
    await attach()
    const raw = await evaluate(`(() => {
      const state = window.__dshCu || { revision: 0 }
      const active = document.activeElement
      const describe = window.__dshCuDescribe
      const controls = describe
        ? Array.from(document.querySelectorAll('a[href],button,input,select,textarea,summary,[role],[onclick]'))
            .filter((element) => element.offsetParent !== null || element.tagName === 'OPTION')
            .slice(0, 300)
            .map(describe)
        : []
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        revision: state.revision || 0,
        focusedRef: active && state.refFor ? state.refFor(active) : null,
        viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
        controls,
        // Plan §30: a DOM modal is an open dialog the runtime has to notice. It
        // is reported separately from the interactive controls, because an
        // overlay is exactly what makes those controls unclickable.
        modals: Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal="true"]')).map((element) => ({
          id: element.id || null,
          ref: state.refFor ? state.refFor(element) : null,
          message: (element.innerText || element.textContent || '').trim().slice(0, 200)
        }))
      }
    })()`)
    const tabs = await tabs_()
    return {
      id,
      url: raw.url,
      title: raw.title,
      readyState: raw.readyState,
      loading: raw.readyState === 'loading',
      revision: raw.revision,
      focusedRef: raw.focusedRef,
      viewport: raw.viewport,
      controls: raw.controls || [],
      tabs,
      // Open DOM modals travel with the page snapshot; native JS dialogs are
      // tracked from the protocol events.
      modals: Array.isArray(raw.modals) ? raw.modals : [],
      dialogs: pendingDialog ? [pendingDialog] : [],
      targetInfos: []
    }
  }

  async function tabs_() {
    try {
      const result = await send('Target.getTargets', {})
      const pages = (result.targetInfos || []).filter((info) => info.type === 'page')
      return pages.map((info, index) => ({ id: info.targetId, url: info.url, title: info.title, active: index === 0 }))
    } catch {
      return [{ id, url: (await safeUrl()), title: null, active: true }]
    }
  }

  async function safeUrl() {
    try {
      return await evaluate('location.href')
    } catch {
      return null
    }
  }

  async function query(selector) {
    await attach()
    const hits = await evaluate(`(() => {
      const describe = window.__dshCuDescribe
      if (!describe) return []
      return Array.from(document.querySelectorAll(${JSON.stringify(String(selector))})).slice(0, 50).map(describe)
    })()`)
    return Array.isArray(hits) ? hits : []
  }

  async function queryAll() {
    return (await snapshot()).controls
  }

  async function accessibility() {
    await attach()
    const tree = await send('Accessibility.getFullAXTree', {})
    const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : []
    return nodes.map((node) => {
      const value = node.value ? node.value.value : undefined
      const name = node.name ? node.name.value : undefined
      return {
        ref: node.backendDOMNodeId !== undefined ? `ax-${node.backendDOMNodeId}` : node.nodeId,
        role: node.role ? node.role.value : null,
        name: name === undefined ? null : String(name),
        value: value === undefined ? null : String(value),
        enabled: node.properties ? !node.properties.some((property) => property.name === 'disabled' && property.value && property.value.value === true) : true,
        focusable: node.properties ? node.properties.some((property) => property.name === 'focusable' && property.value && property.value.value === true) : false,
        focused: node.properties ? node.properties.some((property) => property.name === 'focused' && property.value && property.value.value === true) : false,
        offscreen: node.properties ? node.properties.some((property) => property.name === 'offscreen' && property.value && property.value.value === true) : false,
        bounds: null,
        patterns: node.properties ? node.properties.map((property) => property.name) : [],
        backendDOMNodeId: node.backendDOMNodeId
      }
    })
  }

  /**
   * Plan §17/§33 at the page level: before clicking, ask the page what is
   * actually at that point. A covered element is reported as covered instead of
   * being clicked blindly.
   */
  async function hitTest(ref) {
    return evaluate(`(() => {
      const state = window.__dshCu
      const element = state && state.elementFor(${JSON.stringify(ref)})
      if (!element) return { ok: false, reason: 'element-gone' }
      const rect = element.getBoundingClientRect()
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      const top = document.elementFromPoint(x, y)
      return {
        ok: true,
        point: { x, y },
        covered: Boolean(top && top !== element && !element.contains(top)),
        topTag: top ? top.tagName.toLowerCase() : null,
        revision: state.revision
      }
    })()`)
  }

  async function clickElement(refOrPoint, clickOptions = {}) {
    await attach()
    let point = null
    let ref = null
    let revisionBefore = null
    if (typeof refOrPoint === 'string') {
      ref = refOrPoint
      const hit = await hitTest(ref)
      if (!hit || !hit.ok) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the element is no longer in the page', { ref })
      point = hit.point
      revisionBefore = hit.revision
      if (hit.covered && clickOptions.force !== true) {
        return { ok: false, covered: true, missed: true, point, detail: `another element (${hit.topTag}) is on top of the target - not clicking a covered coordinate` }
      }
    } else if (refOrPoint && Number.isFinite(refOrPoint.x)) {
      point = { x: Math.round(refOrPoint.x), y: Math.round(refOrPoint.y) }
    } else {
      const resolved = await query(String(refOrPoint && refOrPoint.selector ? refOrPoint.selector : refOrPoint))
      if (!resolved.length) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the selector matched nothing', { selector: refOrPoint })
      ref = resolved[0].ref
      const hit = await hitTest(ref)
      point = hit.point
      revisionBefore = hit.revision
    }

    const button = clickOptions.button === 'right' ? 'right' : 'left'
    const clickCount = clickOptions.double ? 2 : 1
    const base = { x: point.x, y: point.y, button, clickCount, buttons: button === 'right' ? 2 : 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 })
    for (let count = 1; count <= clickCount; count += 1) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: count })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: count })
    }

    // Plan §17: "the action was issued" is not "the action had an effect".
    // The page-side counter decides, not optimism.
    const after = await evaluate('window.__dshCu ? window.__dshCu.revision : 0')
    const missed = revisionBefore !== null && after === revisionBefore
    if (missed) {
      // One short grace before declaring a miss: a handler may schedule its
      // mutation on a microtask or a rAF (plan §11).
      await clock.sleep(30)
      const later = await evaluate('window.__dshCu ? window.__dshCu.revision : 0')
      return { ok: true, point, ref, missed: later === revisionBefore, changed: later !== revisionBefore, revisionBefore, revisionAfter: later }
    }
    return { ok: true, point, ref, missed: false, changed: true, revisionBefore, revisionAfter: after }
  }

  async function focusElement(ref) {
    await attach()
    const ok = await evaluate(`(() => {
      const element = window.__dshCu && window.__dshCu.elementFor(${JSON.stringify(ref)})
      if (!element) return false
      if (typeof element.focus === 'function') element.focus({ preventScroll: false })
      return document.activeElement === element
    })()`)
    if (!ok) throw new ComputerUseError(CODES.FOCUS_MISMATCH, 'the element could not take focus', { ref })
    return { ok: true, ref }
  }

  /**
   * Real typing. The value is inserted through CDP so the page sees genuine
   * input events; the value is read back so the caller can verify it (plan §32).
   */
  async function typeText(ref, text, typeOptions = {}) {
    await attach()
    if (ref) await focusElement(ref)
    if (typeOptions.clear !== false) {
      await evaluate(`(() => {
        const element = window.__dshCu && window.__dshCu.elementFor(${JSON.stringify(ref)})
        if (element && 'value' in element) { element.value = '' ; element.dispatchEvent(new Event('input', { bubbles: true })) }
        else if (document.activeElement && 'value' in document.activeElement) { document.activeElement.value = '' ; document.activeElement.dispatchEvent(new Event('input', { bubbles: true })) }
        return true
      })()`)
    }
    await send('Input.insertText', { text: String(text) })
    // The DOM value is the ground truth; `Input.insertText` may not update a
    // controlled React input, in which case the explicit fallback is used.
    const value = await evaluate(`(() => {
      const element = ${ref ? `window.__dshCu && window.__dshCu.elementFor(${JSON.stringify(ref)})` : 'document.activeElement'}
      if (!element || !('value' in element)) return null
      if (element.value === ${JSON.stringify(String(text))}) return element.value
      element.value = ${JSON.stringify(String(text))}
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return element.value
    })()`)
    return { ok: true, ref, value, typed: String(text).length }
  }

  async function setValue(ref, value) {
    return typeText(ref, value, { clear: true })
  }

  async function selectOption(ref, value, selectOptions = {}) {
    await attach()
    const selected = await evaluate(`(() => {
      const element = window.__dshCu && window.__dshCu.elementFor(${JSON.stringify(ref)})
      if (!element || element.tagName !== 'SELECT') return null
      const options = Array.from(element.options)
      const index = ${Number.isInteger(selectOptions.index) ? selectOptions.index : 'null'}
      let target = null
      if (index !== null) target = options[index]
      else target = options.find((option) => option.value === ${JSON.stringify(value === undefined ? null : String(value))}) || options.find((option) => (option.textContent || '').trim() === ${JSON.stringify(value === undefined ? null : String(value))})
      if (!target) return null
      element.value = target.value
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return target.value
    })()`)
    if (selected === null) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'the option could not be selected', { ref, value })
    return { ok: true, ref, value: selected }
  }

  async function scroll(scrollOptions = {}) {
    await attach()
    if (scrollOptions.ref) {
      const rect = await evaluate(`(() => {
        const element = window.__dshCu && window.__dshCu.elementFor(${JSON.stringify(scrollOptions.ref)})
        if (!element) return null
        const box = element.getBoundingClientRect()
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
      })()`)
      if (rect) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: rect.x,
          y: rect.y,
          deltaX: Number(scrollOptions.dx) || 0,
          deltaY: Number(scrollOptions.dy) || 0
        })
        return { ok: true, ...rect }
      }
    }
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 10,
      y: 10,
      deltaX: Number(scrollOptions.dx) || 0,
      deltaY: Number(scrollOptions.dy) || 0
    })
    return { ok: true }
  }

  async function navigate(url, navigateOptions = {}) {
    await attach()
    const result = await send('Page.navigate', { url: String(url) })
    if (result && result.errorText) throw new ComputerUseError(CODES.CONTROLLER_FAILED, `navigation failed: ${result.errorText}`, { url })
    await waitFor({ condition: navigateOptions.waitUntil === 'domcontentloaded' ? 'domcontentloaded' : 'load', timeoutMs: navigateOptions.timeoutMs || 15000 })
    return { ok: true, url, loaderId: result ? result.loaderId : null }
  }

  async function historyBack() {
    await attach()
    const history = await send('Page.getNavigationHistory', {})
    if (!history || history.currentIndex <= 0) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'there is no previous history entry')
    await send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id })
    await waitFor({ condition: 'load', timeoutMs: 15000 })
    return { ok: true }
  }

  async function historyForward() {
    await attach()
    const history = await send('Page.getNavigationHistory', {})
    if (!history || history.currentIndex >= history.entries.length - 1) throw new ComputerUseError(CODES.TARGET_NOT_FOUND, 'there is no next history entry')
    await send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex + 1].id })
    await waitFor({ condition: 'load', timeoutMs: 15000 })
    return { ok: true }
  }

  async function reload() {
    await attach()
    await send('Page.reload', { ignoreCache: false })
    await waitFor({ condition: 'load', timeoutMs: 15000 })
    return { ok: true }
  }

  async function dialogs() {
    return pendingDialog ? [pendingDialog] : []
  }

  async function answerDialog(accept, promptText) {
    if (!pendingDialog) return { ok: false, reason: 'no dialog is open' }
    await send('Page.handleJavaScriptDialog', { accept: Boolean(accept), promptText })
    const answered = { ...pendingDialog }
    pendingDialog = null
    return { ok: true, dialog: answered }
  }

  /**
   * Plan §12: conditional, event-driven waiting. The timeout is a ceiling; the
   * wait ends the moment the condition is true.
   */
  async function waitFor(waitOptions = {}) {
    await attach()
    const timeoutMs = Number.isFinite(waitOptions.timeoutMs) ? waitOptions.timeoutMs : 5000
    const startedAt = clock.now()
    const initial = await evaluate('({ url: location.href, revision: window.__dshCu ? window.__dshCu.revision : 0, state: document.readyState })')
    let lastRevision = initial.revision
    let quietPolls = 0
    for (;;) {
      const current = await evaluate('({ url: location.href, revision: window.__dshCu ? window.__dshCu.revision : 0, state: document.readyState, text: (document.body ? document.body.innerText : "").slice(0, 20000) })')
      const elapsed = clock.now() - startedAt
      switch (waitOptions.condition) {
        case 'load':
          if (current.state === 'complete') return { ok: true, waitedMs: elapsed, detail: 'load' }
          break
        case 'domcontentloaded':
          if (current.state !== 'loading') return { ok: true, waitedMs: elapsed, detail: 'domcontentloaded' }
          break
        case 'navigation':
          if (current.url !== initial.url) return { ok: true, waitedMs: elapsed, detail: current.url }
          break
        case 'mutation':
          if (current.revision !== (waitOptions.baseRevision === undefined || waitOptions.baseRevision === null ? lastRevision : waitOptions.baseRevision)) {
            return { ok: true, waitedMs: elapsed, detail: `revision ${current.revision}` }
          }
          break
        case 'text':
          if (String(waitOptions.text || '') && current.text.toLowerCase().includes(String(waitOptions.text).toLowerCase())) {
            return { ok: true, waitedMs: elapsed, detail: waitOptions.text }
          }
          break
        case 'selector':
          if (waitOptions.selector && (await query(waitOptions.selector)).length) return { ok: true, waitedMs: elapsed, detail: waitOptions.selector }
          break
        case 'selector-gone':
          if (waitOptions.selector && !(await query(waitOptions.selector)).length) return { ok: true, waitedMs: elapsed, detail: waitOptions.selector }
          break
        case 'idle':
        default:
          if (current.revision === lastRevision && current.state === 'complete') {
            quietPolls += 1
            if (quietPolls >= 2) return { ok: true, waitedMs: elapsed, detail: 'idle' }
          } else {
            quietPolls = 0
          }
          break
      }
      lastRevision = current.revision
      if (elapsed >= timeoutMs) return { ok: false, timedOut: true, waitedMs: elapsed, detail: `condition ${waitOptions.condition || 'idle'} not met` }
      await clock.sleep(Math.min(pollMs, Math.max(0, timeoutMs - elapsed)))
    }
  }

  async function screenshot(captureOptions = {}) {
    await attach()
    const params = { format: 'png', captureBeyondViewport: false }
    if (captureOptions.clip) params.clip = { ...captureOptions.clip, scale: 1 }
    const result = await send('Page.captureScreenshot', params)
    return { png: Buffer.from(result.data, 'base64'), format: 'png' }
  }

  /**
   * Where the page's viewport sits on the screen.
   *
   * Vision inside a page must use the page's *own* pixels (a viewport capture is
   * exact, a window capture is not) and then translate the hit back to screen
   * coordinates for the real click. The chrome offset is the difference between
   * the window's outer and inner size.
   */
  async function pageOrigin() {
    await attach()
    try {
      const origin = await evaluate(`(() => {
        const chromeHeight = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0))
        const chromeWidth = Math.max(0, Math.round(((window.outerWidth || 0) - (window.innerWidth || 0)) / 2))
        return {
          x: Math.round((window.screenX || 0) + chromeWidth),
          y: Math.round((window.screenY || 0) + chromeHeight),
          // The page works in CSS pixels, the screen driver clicks in physical
          // ones: the device pixel ratio is what connects them.
          devicePixelRatio: window.devicePixelRatio || 1,
          viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 }
        }
      })()`)
      return origin || null
    } catch {
      return null
    }
  }

  async function close() {
    try {
      await send('Page.close', {})
    } catch {
      /* the page may already be gone */
    }
    return { ok: true }
  }

  function events() {
    return {
      sinceLastCheck() {
        const drained = eventLog.slice()
        eventLog = []
        return drained
      },
      peek() {
        return eventLog.slice()
      }
    }
  }

  return {
    id,
    probe,
    attach,
    handleEvent,
    snapshot,
    query,
    queryAll,
    accessibility,
    locate: null,
    clickElement,
    focusElement,
    typeText,
    setValue,
    selectOption,
    scroll,
    navigate,
    historyBack,
    historyForward,
    reload,
    tabs: tabs_,
    dialogs,
    answerDialog,
    waitFor,
    events,
    screenshot,
    pageOrigin,
    evaluate,
    hitTest,
    close,
    on(method, listener) {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    }
  }
}

/**
 * A CDP transport over an Electron `webContents.debugger` (the shell's own
 * view). The shell creates one of these per view; the adapter above never knows
 * the difference.
 */
function createElectronDebuggerTransport(webContents) {
  if (!webContents || !webContents.debugger) {
    return { send: async () => {
      throw new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, 'this webContents has no debugger')
    } }
  }
  const debugger_ = webContents.debugger
  const handlers = []
  let listening = false
  return {
    probe: () => ({ available: true, reason: null, detail: { backend: 'electron-webcontents-debugger' } }),
    async send(method, params) {
      if (!debugger_.isAttached()) debugger_.attach('1.3')
      if (!listening) {
        listening = true
        debugger_.on('message', (_event, method_, params_) => {
          for (const handler of handlers) {
            try {
              handler(method_, params_)
            } catch {
              /* listener isolation */
            }
          }
        })
        debugger_.on('detach', () => {
          listening = false
        })
      }
      return debugger_.sendCommand(method, params)
    },
    onEvent(handler) {
      handlers.push(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    detach() {
      try {
        if (debugger_.isAttached()) debugger_.detach()
      } catch {
        /* already detached */
      }
    }
  }
}

module.exports = { createCdpPage, createElectronDebuggerTransport, BOOTSTRAP, DESCRIBE_FN }
