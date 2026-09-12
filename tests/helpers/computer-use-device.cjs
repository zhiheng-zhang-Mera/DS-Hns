'use strict'

/**
 * Test helper: an in-process, deterministic "computer" for the Computer Use
 * Runtime.
 *
 * It is a *device*, not a mock: pages are parsed into the mini-DOM
 * (computer-use-minidom.cjs) and every port method reads or changes real state.
 * Clicking a submit button really submits the form, a covered window really
 * receives the click, a frozen page really stops applying script effects and a
 * canvas target exists only as painted pixels.
 *
 * Ports satisfied
 * ---------------
 *   page          PAGE_ADAPTER_METHODS
 *   desktop       DESKTOP_DRIVER_METHODS
 *   accessibility ACCESSIBILITY_DRIVER_METHODS
 *   screenshot    SCREENSHOT_DRIVER_METHODS
 *
 * Time
 * ----
 * The device owns a *virtual* clock: timers are queued by deadline and only run
 * when virtual time advances, which `waitFor()` does while it waits. Nothing in
 * the default path touches the wall clock, so a scenario that needs 700 ms of
 * fixture delay costs no real time and lands on exactly 700 ms.
 * `options.now` / `options.sleep` are honoured (see ports.createClock): when
 * either is injected the clock switches to realtime mode and `advance()` is
 * unavailable, because virtual advancement would no longer mean anything.
 *
 * Fixture contract
 * ----------------
 * Fixtures are data. Everything a page does is declared in attributes the
 * device understands. `data-cu-*` attributes are device instructions and are
 * deliberately NOT exposed through `ElementDescriptor.attributes` or the
 * accessibility tree: the runtime learns about them the way it would learn
 * about a real application's behaviour, by acting and observing.
 *
 *   data-cu-load-ms="N"       on <html>: readyState reaches 'complete' after N ms
 *   data-cu-delay-ms="N"      the element's script runs N ms after the click; the
 *                             element is disabled and marked data-cu-busy while pending
 *   data-cu-eat-clicks="N"    the first N clicks are swallowed: the click event is
 *                             delivered, no script runs, the default action is cancelled
 *   data-cu-freeze="1"        clicking it stalls the page: no further fixture script
 *                             effect is applied (typing, focus and scrolling keep working)
 *   data-cu-move-after-ms="N" relocates N ms after load completes
 *   data-cu-move-to="x,y"     the destination in page px (position: absolute)
 *   data-cu-modal="message"   clicking opens a real role="dialog" node plus an overlay
 *                             that blocks every other control until dismissed
 *   data-cu-file="doc.txt"    Ctrl+S writes the control's value into the device filesystem
 *   data-cu-paint="label|#rrggbb|w|h"
 *                             drawn into the framebuffer at the canvas rect; no DOM
 *                             node for the painted target is ever created
 *   data-cu-on-click|on-dblclick|on-input|on-change|on-submit|on-keydown|on-save|on-accept
 *                             run the script below when the event reaches the element
 *   data-cu-on-valid|on-invalid
 *                             run after a form submit that passed / failed constraint
 *                             validation (required + filled)
 *
 * Script subset (also accepted in `onclick="..."`)
 * -----------------------------------------------
 *   show <sel> | hide <sel> | toggle <sel>            visibility (the hidden attribute)
 *   text <sel> <text>                                 replace the element's text
 *   value <sel> <text>                                set a control value
 *   focus <sel> | click <sel>                         real focus / real click
 *   class-add|class-remove|class-toggle <sel> <name>  class attribute
 *   attr <sel> <name>=<value>                         any attribute
 *   remove <sel>                                      detach the node (its refs go stale)
 *   navigate <target>                                 fixture name or URL
 *   alert|confirm|prompt <message>                    blocking JS dialog
 *   open-modal <sel> <message> | close-modal          DOM modal stack
 *   freeze                                            stall the page
 * Statements are separated by ';'. Arguments with spaces or ';' are quoted with
 * double quotes. Text arguments expand {field} (the first invalid field's
 * label), {value:<sel>}, {file}, {prompt}, {url} and {title}.
 *
 * Layout / rendering constants
 * ----------------------------
 * CHAR_WIDTH 8, LINE_HEIGHT 20 (see the mini-DOM header), TITLE_BAR_HEIGHT 24,
 * default screen 1280x800, default page viewport 1024x768, default window frame
 * {x:0,y:0,width:1024,height:792} so the window content is exactly 1024x768 with
 * its origin at (0,24).
 *
 * Screenshot palette (flat fills; role colour + explicit background)
 * -----------------------------------------------------------------
 *   desktop background  #101418   window frame  the window paint (default #2b3440)
 *   title bar            paint mixed 30% towards white      page background  #ffffff
 *   heading #111827   textbox #f1f5f9   button #2563eb   link #0ea5e9
 *   checkbox/radio #16a34a   combobox/option/slider #7c3aed   status #22c55e
 *   alert #dc2626   dialog #f59e0b   list/table #cbd5e1   nav #94a3b8
 *   form #e2e8f0   img/canvas #1e293b   generic #e5e7eb   modal overlay #0f172a @55%
 * An element's inline `background`/`background-color` wins over its role colour.
 * Text is not rasterised, so a run of text shows as its element's colour box;
 * canvas paints are painted exactly at the canvas layout rect.
 */

const fs = require('node:fs')
const path = require('node:path')

const png = require('../../app/extensions/mega/theme/png')
const { CODES, fail } = require('../../app/computer-use/errors.cjs')
const md = require('./computer-use-minidom.cjs')

/** Directory holding the hand-written fixture pages. */
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'computer-use')

const TITLE_BAR_HEIGHT = 24
const DEFAULT_SCREEN = { x: 0, y: 0, width: 1280, height: 800 }
const DEFAULT_VIEWPORT = { width: 1024, height: 768 }
const DEFAULT_WINDOW_BOUNDS = { x: 0, y: 0, width: 1024, height: 792 }
const DEFAULT_WINDOW_PAINT = [43, 52, 64]
const DESKTOP_PAINT = [16, 20, 24]
const PAGE_PAINT = [255, 255, 255]
const OVERLAY_PAINT = [15, 23, 42]
const MODAL_WIDTH = 320
const MODAL_HEIGHT = 96

const ROLE_PALETTE = {
  button: [37, 99, 235],
  link: [14, 165, 233],
  textbox: [241, 245, 249],
  checkbox: [22, 163, 74],
  radio: [22, 163, 74],
  combobox: [124, 58, 237],
  option: [124, 58, 237],
  slider: [124, 58, 237],
  heading: [17, 24, 39],
  status: [34, 197, 94],
  alert: [220, 38, 38],
  dialog: [245, 158, 11],
  list: [203, 213, 225],
  listitem: [226, 232, 240],
  table: [203, 213, 225],
  form: [226, 232, 240],
  navigation: [148, 163, 184],
  img: [30, 41, 59],
  canvas: [30, 41, 59],
  generic: [229, 231, 235]
}

/** Attribute bag exposed through ElementDescriptor (device instructions stay hidden). */
const DESCRIPTOR_ATTRIBUTES = [
  'id', 'class', 'name', 'type', 'role', 'href', 'placeholder', 'aria-label', 'aria-labelledby',
  'aria-modal', 'aria-invalid', 'alt', 'title', 'value', 'width', 'height', 'for', 'checked', 'disabled', 'required'
]

const SCRIPT_BY_EVENT = {
  click: 'click',
  dblclick: 'dblclick',
  input: 'input',
  change: 'change',
  submit: 'submit',
  keydown: 'keydown'
}

const SCRIPT_VERBS = new Set([
  'show', 'hide', 'toggle', 'text', 'value', 'focus', 'click', 'class-add', 'class-remove', 'class-toggle',
  'attr', 'remove', 'navigate', 'alert', 'confirm', 'prompt', 'open-modal', 'close-modal', 'freeze'
])

const WAIT_CONDITIONS = new Set(['selector', 'mutation', 'navigation', 'load', 'idle'])
const MAX_WAIT_PUMPS = 10000
const MAX_TIMER_FIRES = 10000
const PRINTABLE_KEY = /^[\x20-\x7e]$/

/** Page port methods, used to install the disposed-device guard (ports.cjs order). */
const PAGE_PORT_METHODS = [
  'probe', 'snapshot', 'query', 'queryAll', 'accessibility', 'clickElement', 'focusElement', 'typeText', 'setValue',
  'selectOption', 'scroll', 'navigate', 'historyBack', 'historyForward', 'reload', 'tabs', 'dialogs', 'answerDialog',
  'waitFor', 'events', 'screenshot', 'close'
]

// ------------------------------------------------------------------- clock ---

/**
 * The injectable device clock.
 *
 * Virtual mode (the default) keeps a timer queue ordered by deadline and moves
 * `now` only when somebody advances it, which is what lets `waitFor` land on the
 * exact millisecond a fixture mutation is due.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]   inject to switch to realtime mode
 * @param {(ms:number) => Promise<void>} [options.sleep]
 * @param {number} [options.startTime]   virtual start time (default 0)
 * @returns {{kind:string, now:Function, sleep:Function, setTimeout:Function, clearTimeout:Function, pendingCount:Function, nextDeadline:Function, advance:Function}}
 */
function createDeviceClock(options = {}) {
  if (typeof options.now === 'function' || typeof options.sleep === 'function') {
    const now = typeof options.now === 'function' ? options.now : () => Date.now()
    const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let seq = 0
    const handles = new Map()
    return {
      kind: 'realtime',
      now,
      sleep,
      setTimeout(callback, ms) {
        seq += 1
        const id = seq
        const handle = setTimeout(() => {
          handles.delete(id)
          callback()
        }, Math.max(0, Number(ms) || 0))
        handles.set(id, handle)
        return id
      },
      clearTimeout(id) {
        const handle = handles.get(id)
        if (handle) {
          clearTimeout(handle)
          handles.delete(id)
        }
      },
      pendingCount() {
        return handles.size
      },
      nextDeadline() {
        return null
      },
      advance() {
        throw fail(CODES.ACTION_UNSUPPORTED, 'the device clock is in realtime mode: virtual time cannot be advanced')
      }
    }
  }
  let current = Number.isFinite(options.startTime) ? Number(options.startTime) : 0
  let seq = 0
  const timers = new Map()
  const clock = {
    kind: 'virtual',
    now: () => current,
    /** Queue a callback; it runs when virtual time reaches `now + ms`. */
    setTimeout(callback, ms) {
      seq += 1
      const id = seq
      timers.set(id, { id, seq, at: current + Math.max(0, Number(ms) || 0), callback })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    pendingCount() {
      return timers.size
    },
    /** Earliest pending deadline, or null when nothing is scheduled. */
    nextDeadline() {
      let best = null
      for (const timer of timers.values()) {
        if (best === null || timer.at < best) best = timer.at
      }
      return best
    },
    /** Run every timer due within `ms`, in deadline order, then set `now += ms`. */
    advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0)
      let fired = 0
      for (;;) {
        let due = null
        for (const timer of timers.values()) {
          if (timer.at > target) continue
          if (!due || timer.at < due.at || (timer.at === due.at && timer.seq < due.seq)) due = timer
        }
        if (!due) break
        timers.delete(due.id)
        current = due.at
        fired += 1
        if (fired > MAX_TIMER_FIRES) throw fail(CODES.CONTROLLER_FAILED, 'virtual clock timer storm: a timer keeps rescheduling itself')
        due.callback()
      }
      current = target
      return fired
    },
    /** Run the single earliest timer; false when none is pending. */
    advanceToNext() {
      const next = clock.nextDeadline()
      if (next === null) return false
      clock.advance(next - current)
      return true
    },
    /** Sleep in virtual time: nothing is waited out on the wall clock. */
    sleep(ms) {
      clock.advance(ms)
      return Promise.resolve()
    }
  }
  return clock
}

// --------------------------------------------------------------- event log ---

/**
 * A SystemEvent log with `sinceLastCheck()` semantics.
 *
 * @param {{clock: object}} deps
 */
function createEventLog({ clock }) {
  const entries = []
  let seq = 0
  let listeners = []
  let cursor = 0
  const log = {
    /** Push one event; `at` is virtual time. */
    push(event) {
      seq += 1
      const entry = { seq, at: clock.now(), pageId: null, windowId: null, ...event }
      entries.push(entry)
      for (const listener of listeners.slice()) {
        try {
          listener(entry)
        } catch {
          // An observer must never be able to break the device.
        }
      }
      return entry
    },
    all() {
      return entries.map((entry) => ({ ...entry }))
    },
    /** Events recorded since the previous call, then move the cursor. */
    sinceLastCheck() {
      const out = entries.filter((entry) => entry.seq > cursor).map((entry) => ({ ...entry }))
      cursor = seq
      return out
    },
    cursor() {
      return cursor
    },
    /** Sequence number of the newest event, whatever the read cursor is. */
    lastSeq() {
      return seq
    },
    onEvent(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.push(listener)
      return () => {
        listeners = listeners.filter((item) => item !== listener)
      }
    }
  }
  Object.defineProperty(log, 'entries', {
    enumerable: true,
    get() {
      return log.all()
    }
  })
  return log
}

/** A page-scoped view over the device log with its own cursor. */
function createEventView(log, predicate) {
  let cursor = 0
  const view = {
    sinceLastCheck() {
      const out = log.all().filter((entry) => entry.seq > cursor && (!predicate || predicate(entry)))
      cursor = log.lastSeq()
      return out
    },
    cursor() {
      return cursor
    }
  }
  Object.defineProperty(view, 'entries', {
    enumerable: true,
    get() {
      return log.all().filter((entry) => !predicate || predicate(entry))
    }
  })
  return view
}

// -------------------------------------------------------------- virtual fs ---

/**
 * A tiny in-memory filesystem with real semantics (content, size, mtime).
 * Paths are virtual and POSIX-shaped (`/workspace/doc.txt`); the real disk is
 * never touched.
 *
 * @param {{clock: object, root?: string}} deps
 */
function createVirtualFs({ clock, root = '/workspace' }) {
  const files = new Map()
  const normalize = (target) => {
    const text = String(target === null || target === undefined ? '' : target).replace(/\\/g, '/')
    const base = text.startsWith('/') ? text : `${root}/${text}`
    const parts = []
    for (const part of base.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return `/${parts.join('/')}`
  }
  return {
    root,
    /** Normalised absolute path inside the virtual filesystem. */
    resolve(target) {
      return normalize(target)
    },
    write(target, content) {
      const key = normalize(target)
      const text = content === null || content === undefined ? '' : String(content)
      const entry = { path: key, content: text, size: Buffer.byteLength(text, 'utf8'), mtime: clock.now(), type: 'file' }
      files.set(key, entry)
      return { ...entry }
    },
    read(target) {
      const key = normalize(target)
      const entry = files.get(key)
      if (!entry) throw fail(CODES.TARGET_NOT_FOUND, `virtual file not found: ${key}`, { path: key })
      return entry.content
    },
    exists(target) {
      return files.has(normalize(target))
    },
    stat(target) {
      const key = normalize(target)
      const entry = files.get(key)
      if (!entry) throw fail(CODES.TARGET_NOT_FOUND, `virtual file not found: ${key}`, { path: key })
      return { ...entry }
    },
    /** Flat listing of one virtual directory. */
    list(directory) {
      const prefix = normalize(directory)
      const out = []
      for (const entry of files.values()) {
        const dir = entry.path.slice(0, entry.path.lastIndexOf('/')) || '/'
        if (dir === prefix) out.push({ ...entry })
      }
      return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    },
    remove(target) {
      return files.delete(normalize(target))
    },
    clear() {
      files.clear()
    }
  }
}

/**
 * The device clipboard: one real buffer shared by the port and Ctrl+C/Ctrl+V.
 *
 * @param {{events: object}} deps
 */
function createClipboard({ events }) {
  let text = ''
  return {
    read() {
      return text
    },
    write(value) {
      text = value === null || value === undefined ? '' : String(value)
      events.push({ type: 'clipboard_changed', detail: { length: text.length } })
      return text
    },
    clear() {
      text = ''
    }
  }
}

// ------------------------------------------------------------ script engine ---

/** Split a script into statements, honouring double-quoted arguments. */
function splitStatements(script) {
  const statements = []
  let current = ''
  let quoted = false
  for (const char of String(script)) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (char === ';' && !quoted) {
      statements.push(current)
      current = ''
      continue
    }
    current += char
  }
  statements.push(current)
  return statements.map((statement) => statement.trim()).filter(Boolean)
}

/** Split one statement into tokens; `""` yields an empty argument. */
function tokenizeStatement(statement) {
  const tokens = []
  let current = ''
  let quoted = false
  let open = false
  for (const char of String(statement)) {
    if (char === '"') {
      quoted = !quoted
      open = true
      continue
    }
    if (/\s/.test(char) && !quoted) {
      if (current || open) tokens.push(current)
      current = ''
      open = false
      continue
    }
    current += char
  }
  if (current || open) tokens.push(current)
  return tokens
}

/** Expand the documented substitution variables in a text argument. */
function expandText(page, text, context) {
  return String(text).replace(/\{([a-z-]+)(?::([^}]+))?\}/gi, (match, name, argument) => {
    switch (String(name).toLowerCase()) {
      case 'field': return context.field === undefined || context.field === null ? '' : String(context.field)
      case 'file': return context.file === undefined || context.file === null ? '' : String(context.file)
      case 'prompt': return context.prompt === undefined || context.prompt === null ? '' : String(context.prompt)
      case 'url': return page.url
      case 'title': return page.document.title
      case 'value': {
        if (!argument) return ''
        const target = resolveTarget(page, argument.trim(), { optional: true })
        return target ? target.value : ''
      }
      default: return match
    }
  })
}

// ------------------------------------------------------------------ helpers ---

/** Merge declarations into an element's `style` attribute (a real mutation). */
function setStyleProperties(el, properties) {
  const kept = []
  for (const declaration of String(el.getAttribute('style') || '').split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    if (!name || Object.prototype.hasOwnProperty.call(properties, name)) continue
    kept.push(`${name}:${declaration.slice(colon + 1).trim()}`)
  }
  for (const [name, value] of Object.entries(properties)) kept.push(`${name}:${value}`)
  el.setAttribute('style', kept.join(';'))
}

/** Remove one declaration from an element's `style` attribute. */
function removeStyleProperty(el, name) {
  const kept = []
  for (const declaration of String(el.getAttribute('style') || '').split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    if (declaration.slice(0, colon).trim().toLowerCase() === name) continue
    kept.push(declaration.trim())
  }
  if (kept.length) el.setAttribute('style', kept.join(';'))
  else el.removeAttribute('style')
}

function isInside(el, ancestor) {
  let node = el
  while (node) {
    if (node === ancestor) return true
    node = node.parentNode
  }
  return false
}

/** Screen rect for a rect expressed in a page's viewport coordinates. */
function toScreenRect(hostRect, rect) {
  return { x: hostRect.x + rect.x, y: hostRect.y + rect.y, width: rect.width, height: rect.height }
}

function clipRect(rect, bounds) {
  const x = Math.max(rect.x, bounds.x)
  const y = Math.max(rect.y, bounds.y)
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width)
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

function attributeBag(el) {
  const bag = {}
  for (const name of DESCRIPTOR_ATTRIBUTES) {
    const value = el.getAttribute(name)
    if (value !== null) bag[name] = value
  }
  return bag
}

/** Resolve a ref or selector argument to an element, with typed failures. */
function resolveTarget(page, input, options = {}) {
  const doc = page.document
  let ref = null
  let selector = null
  if (typeof input === 'string' && input.trim()) {
    const text = input.trim()
    if (/^e\d+$/.test(text)) ref = text
    else selector = text
  } else if (input && typeof input === 'object') {
    if (typeof input.ref === 'string') ref = input.ref
    else if (typeof input.selector === 'string') selector = input.selector
  }
  if (ref) {
    const el = doc.byRef(ref)
    if (!el) {
      if (options.optional) return null
      throw fail(CODES.TARGET_STALE, `element ref is no longer attached: ${ref}`, { ref, reason: 'detached' })
    }
    return el
  }
  if (selector) {
    const el = doc.querySelector(selector)
    if (!el) {
      if (options.optional) return null
      throw fail(CODES.TARGET_NOT_FOUND, `selector matched no element: ${selector}`, { selector })
    }
    return el
  }
  if (options.optional) return null
  throw fail(CODES.TARGET_INVALID, 'a ref or a CSS selector is required', { input })
}

/** Port probe payload; ports.normalizeProbe turns this into a verdict. */
function probePort(name, id) {
  return {
    available: true,
    reason: null,
    detail: { port: name, backend: 'device', id: id === undefined ? null : id, kind: 'in-process' }
  }
}

// --------------------------------------------------------------------- page ---

/**
 * Build one page (a browser tab) over a mini-DOM document.
 *
 * @param {object} ctx device context
 * @param {object} options id, source, url, title, viewport, hostRect, windowHandle, defer
 */
function createPage(ctx, options) {
  const state = {
    id: options.id,
    doc: null,
    source: options.source,
    url: options.url || 'about:blank',
    title: options.title || '',
    readyState: 'complete',
    historyBack: [],
    historyForward: [],
    timers: new Set(),
    modals: [],
    frozen: false,
    busy: new Set(),
    eaten: new Map(),
    closed: false,
    hostRect: options.hostRect ? { ...options.hostRect } : { x: 0, y: 0, ...DEFAULT_VIEWPORT },
    windowHandle: options.windowHandle || null,
    eventView: null
  }
  const page = {
    id: state.id,
    __state: state,
    __ctx: ctx,
    get document() {
      return state.doc
    },
    get url() {
      return state.url
    },
    get frozen() {
      return state.frozen
    },
    get windowHandle() {
      return state.windowHandle
    },
    /** Test introspection; not part of the page port. */
    debug() {
      return {
        id: state.id,
        url: state.url,
        revision: state.doc ? state.doc.revision : 0,
        readyState: state.readyState,
        loading: isPageLoading(page),
        frozen: state.frozen,
        modals: state.modals.length,
        pendingTimers: state.timers.size,
        busy: [...state.busy],
        eatenClicks: Object.fromEntries(state.eaten),
        scroll: state.doc ? { x: state.doc.scrollX, y: state.doc.scrollY } : { x: 0, y: 0 },
        windowHandle: state.windowHandle
      }
    },
    probe: () => probePort('page', state.id),
    snapshot: () => pageSnapshot(page),
    query: (selector) => describeElement(page, resolveTarget(page, selector)),
    queryAll: (selector) => {
      // The port contract (app/computer-use/ports.cjs) allows `queryAll()` with
      // no selector: "every element on the page". A selector narrows it.
      if (selector === undefined || selector === null) {
        return state.doc.controls().map((el) => describeElement(page, el))
      }
      return state.doc.querySelectorAll(selector).map((el) => describeElement(page, el))
    },
    accessibility: () => accessibilityTreeOfPage(page),
    clickElement: (target, actionOptions) => performClickOnTarget(page, target, actionOptions || {}),
    focusElement: (target) => focusElementOnPage(page, target),
    typeText: (target, text, typeOptions) => typeIntoElement(page, target, text, typeOptions || {}),
    setValue: (target, value) => setElementValue(page, target, value),
    selectOption: (target, choice) => selectElementOption(page, target, choice),
    scroll: (scrollOptions) => scrollPage(page, scrollOptions || {}),
    navigate: (target, navigateOptions) => navigatePage(page, target, navigateOptions || {}),
    historyBack: () => stepHistory(page, -1),
    historyForward: () => stepHistory(page, 1),
    reload: () => loadPage(page, { url: state.url, source: state.source, reason: 'reload' }),
    tabs: () => ctx.browser.tabs(),
    dialogs: () => ctx.browser.dialogs(state.id),
    answerDialog: (answer) => ctx.browser.answerDialog(page, answer || {}),
    waitFor: (spec) => waitForCondition(page, spec || {}),
    events: () => {
      if (!state.eventView) {
        state.eventView = createEventView(ctx.events, (entry) => entry.pageId === state.id || (state.windowHandle !== null && entry.windowId === state.windowHandle))
      }
      return state.eventView
    },
    screenshot: (shot) => screenshotPage(page, shot || {}),
    close: () => {
      closePage(page)
      return { ok: true, detail: { id: state.id } }
    },
    /** Internal: dispatch a keyboard action into this page's DOM. */
    handleKey: (spec) => handleKey(page, spec),
    /** Internal: the page's screen origin. */
    hostRect: () => ({ ...state.hostRect })
  }
  // Every port method refuses to answer once the device is disposed, so a test
  // can never read a snapshot of a machine that no longer exists.
  for (const name of PAGE_PORT_METHODS) {
    const original = page[name]
    page[name] = (...args) => {
      guardDevice(ctx)
      return original(...args)
    }
  }
  loadPage(page, { url: state.url, source: state.source, reason: 'open', defer: Boolean(options.defer) })
  return page
}

function guardDevice(ctx) {
  if (ctx.disposed) throw fail(CODES.CONTROLLER_UNAVAILABLE, 'the virtual device has been disposed')
}

/** Load (or reload) a page: parse the source, reset state, schedule fixture work. */
function loadPage(page, spec) {
  const state = page.__state
  const ctx = page.__ctx
  guardDevice(ctx)
  cancelPageTimers(page)
  while (state.modals.length) closeModal(page)
  ctx.browser.dismissDialogs(page, spec.reason || 'load')
  const previous = { doc: state.doc, url: state.url, title: state.title }
  const viewport = state.doc ? { ...state.doc.viewport } : { x: 0, y: 0, ...DEFAULT_VIEWPORT }
  const source = spec.source || state.source
  const doc = md.createDocument({
    html: source.html || '',
    url: spec.url || state.url,
    viewport,
    // A load is itself a state transition, so PageSnapshot.revision stays
    // monotonic across navigations and reloads.
    revision: state.doc ? state.doc.revision + 1 : 0
  })
  state.doc = doc
  state.source = source
  state.url = spec.url || state.url
  state.title = doc.title
  state.frozen = false
  state.busy.clear()
  state.eaten.clear()
  state.modals = []

  doc.setHooks({
    onEventScript: (event, eventPath) => runEventScripts(page, event, eventPath),
    onSubmit: (form) => handleFormSubmit(page, form),
    onNavigate: (anchor) => {
      const href = anchor.getAttribute('href')
      try {
        navigatePage(page, href)
      } catch (error) {
        ctx.events.push({ type: 'navigation_failed', pageId: state.id, detail: { href, code: error.code || null, message: error.message } })
      }
    }
  })
  doc.onMutation((record) => {
    ctx.events.push({
      type: 'dom_mutated',
      pageId: state.id,
      detail: { revision: record.revision, kind: record.type, target: record.target, selector: record.selector, name: record.name }
    })
  })
  doc.onFocusChange((change) => {
    ctx.events.push({
      type: 'focus_changed',
      pageId: state.id,
      detail: { from: change.from ? change.from.ref : null, to: change.to ? change.to.ref : null }
    })
  })

  scheduleFixtureWork(page)

  const loadMs = Math.max(0, Number(source.loadMs || 0))
  if (spec.defer || loadMs > 0) {
    state.readyState = 'loading'
    ctx.events.push({ type: 'load_state_changed', pageId: state.id, detail: { state: 'loading', url: state.url } })
    schedule(page, loadMs, () => {
      state.readyState = 'complete'
      ctx.events.push({ type: 'load_state_changed', pageId: state.id, detail: { state: 'complete', url: state.url } })
    })
  } else {
    state.readyState = 'complete'
    ctx.events.push({ type: 'load_state_changed', pageId: state.id, detail: { state: 'complete', url: state.url } })
  }
  if (previous.doc && previous.url !== state.url) {
    ctx.events.push({
      type: 'url_changed',
      pageId: state.id,
      detail: { from: previous.url, to: state.url, title: state.title, reason: spec.reason || 'load' }
    })
  }
  return { ok: true, detail: { url: state.url, title: state.title, revision: doc.revision } }
}

/** Schedule a device timer owned by the page (cancelled on navigation/dispose). */
function schedule(page, ms, callback) {
  const state = page.__state
  const ctx = page.__ctx
  const id = ctx.clock.setTimeout(() => {
    state.timers.delete(id)
    if (state.closed || ctx.disposed) return
    callback()
  }, ms)
  state.timers.add(id)
  return id
}

function cancelPageTimers(page) {
  const state = page.__state
  for (const id of state.timers) page.__ctx.clock.clearTimeout(id)
  state.timers.clear()
}

/** Timers and sizing a fixture asks for at load time. */
function scheduleFixtureWork(page) {
  const doc = page.document
  for (const el of doc.elements()) {
    const cu = el.cu
    if (el.tagName === 'canvas' && cu.paint) {
      if (cu.paint.width !== null && el.getAttribute('width') === null) el.setAttribute('width', String(cu.paint.width))
      if (cu.paint.height !== null && el.getAttribute('height') === null) el.setAttribute('height', String(cu.paint.height))
    }
    if (cu.moveAfterMs !== null && cu.moveTo) {
      const destination = cu.moveTo
      schedule(page, Math.max(0, cu.moveAfterMs), () => {
        const before = el.bbox
        setStyleProperties(el, { position: 'absolute', left: `${destination.x}px`, top: `${destination.y}px` })
        doc.relayout()
        page.__ctx.events.push({
          type: 'element_moved',
          pageId: page.id,
          detail: { ref: el.ref, selector: doc.cssPath(el), from: before, to: el.bbox, at: page.__ctx.clock.now() }
        })
      })
    }
  }
}

function isPageLoading(page) {
  const state = page.__state
  return state.readyState !== 'complete' || page.__ctx.browser.dialogs(state.id).length > 0
}

/** Blocking JS dialog opened by this page (browser wide, one at a time). */
function pageDialog(page) {
  const dialog = page.__ctx.browser.dialog
  return dialog && dialog.pageId === page.id ? dialog : null
}

// --------------------------------------------------------------- form logic ---

/** Required/filled state for every usable control of a form. */
function collectFields(form) {
  const elements = form.getElementsByTagName('input').concat(form.getElementsByTagName('textarea'), form.getElementsByTagName('select'))
  return elements
    .filter((el) => !el.disabled)
    .map((el) => {
      const type = el.tagName === 'input' ? md.inputType(el) : el.tagName
      const filled = type === 'checkbox' || type === 'radio' ? el.checked : String(el.value || '').trim() !== ''
      const labels = md.labelTextsFor(el)
      return {
        element: el,
        name: el.getAttribute('name') || el.getAttribute('id') || el.tagName,
        label: labels[0] || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName,
        required: el.hasAttribute('required') || String(el.getAttribute('aria-required') || '') === 'true',
        filled,
        type
      }
    })
}

/** Form default action: constraint validation, then the fixture's branch script. */
function handleFormSubmit(page, form) {
  const state = page.__state
  if (state.frozen) {
    page.__ctx.events.push({ type: 'submit_suppressed', pageId: state.id, detail: { reason: 'frozen', form: form.ref } })
    return
  }
  const fields = collectFields(form)
  const invalid = fields.filter((field) => field.required && !field.filled)
  if (form.hasAttribute('data-cu-invalid')) form.removeAttribute('data-cu-invalid')
  for (const field of fields) {
    if (field.element.hasAttribute('aria-invalid')) field.element.removeAttribute('aria-invalid')
  }
  if (invalid.length) {
    form.setAttribute('data-cu-invalid', '1')
    for (const field of invalid) field.element.setAttribute('aria-invalid', 'true')
    runScript(page, form, form.cu.scripts.invalid, { context: { field: invalid[0].label } })
  } else {
    runScript(page, form, form.cu.scripts.valid, { context: {} })
  }
  page.__ctx.events.push({
    type: 'form_submitted',
    pageId: state.id,
    detail: {
      form: form.ref,
      selector: state.doc.cssPath(form),
      valid: invalid.length === 0,
      invalidFields: invalid.map((field) => field.name),
      values: Object.fromEntries(fields.filter((field) => field.type !== 'password').map((field) => [field.name, field.element.value]))
    }
  })
}

// ------------------------------------------------------------ event scripts ---

/** Run the fixture behaviour attributes an event reached during bubbling. */
function runEventScripts(page, event, eventPath) {
  const state = page.__state
  const scriptKey = SCRIPT_BY_EVENT[event.type]
  if (!scriptKey) return
  if (event.type === 'click') {
    const freezer = eventPath.find((node) => md.isElement(node) && node.cu.freeze)
    if (freezer) {
      engageFreeze(page, freezer)
      event.preventDefault()
      event.__cuEaten = true
      return
    }
  }
  if (state.frozen) {
    const blocked = eventPath.find((node) => md.isElement(node) && node.cu.scripts[scriptKey])
    if (blocked) {
      page.__ctx.events.push({ type: 'script_suppressed', pageId: state.id, detail: { reason: 'frozen', ref: blocked.ref, event: event.type } })
      event.preventDefault()
      event.__cuEaten = true
    }
    return
  }
  for (const node of eventPath) {
    if (!md.isElement(node)) continue
    // A modal attribute opens the dialog whether or not the element also has a
    // script: the two declarations are independent.
    if (event.type === 'click' && node.cu.modal) openModal(page, node.cu.modal, node)
    if (node.cu.freeze) {
      engageFreeze(page, node)
      return
    }
    const script = node.cu.scripts[scriptKey]
    if (!script) continue
    if (event.type === 'click' && remainingEats(page, node) > 0) {
      state.eaten.set(node.ref, remainingEats(page, node) - 1)
      event.preventDefault()
      event.__cuEaten = true
      page.__ctx.events.push({
        type: 'click_swallowed',
        pageId: state.id,
        detail: { ref: node.ref, selector: state.doc.cssPath(node), remaining: state.eaten.get(node.ref) }
      })
      return
    }
    const delay = node.cu.delayMs
    if (delay && delay > 0 && event.type === 'click') {
      scheduleDelayedScript(page, node, script, event)
      continue
    }
    runScript(page, node, script, { context: {} })
  }
}

function remainingEats(page, node) {
  const state = page.__state
  if (!state.eaten.has(node.ref)) state.eaten.set(node.ref, node.cu.eatClicks || 0)
  return state.eaten.get(node.ref)
}

/** A delayed action marks the control busy, then applies its script. */
function scheduleDelayedScript(page, node, script, event) {
  const state = page.__state
  const delay = Math.max(0, node.cu.delayMs)
  node.setAttribute('data-cu-busy', '1')
  if (node.tagName === 'button' || node.tagName === 'input') node.setAttribute('disabled', 'disabled')
  state.busy.add(node.ref)
  page.__ctx.events.push({
    type: 'action_deferred',
    pageId: state.id,
    detail: { ref: node.ref, selector: state.doc.cssPath(node), delayMs: delay, event: event.type, dueAt: page.__ctx.clock.now() + delay }
  })
  schedule(page, delay, () => {
    state.busy.delete(node.ref)
    if (node.isConnected) {
      node.removeAttribute('data-cu-busy')
      node.removeAttribute('disabled')
    }
    page.__ctx.events.push({
      type: 'deferred_action_applied',
      pageId: state.id,
      detail: { ref: node.ref, selector: state.doc.cssPath(node), at: page.__ctx.clock.now() }
    })
    runScript(page, node, script, { context: {} })
  })
}

function engageFreeze(page, node) {
  const state = page.__state
  if (state.frozen) return
  state.frozen = true
  page.__ctx.events.push({
    type: 'page_frozen',
    pageId: state.id,
    detail: { ref: node ? node.ref : null, selector: node ? state.doc.cssPath(node) : null }
  })
}

/** Execute one fixture script; unknown verbs fail loudly, missing targets are skipped. */
function runScript(page, node, script, options = {}) {
  const context = options.context || {}
  const statements = splitStatements(script)
  let applied = 0
  for (const statement of statements) {
    const tokens = tokenizeStatement(statement)
    const verb = String(tokens[0] || '').toLowerCase()
    if (!SCRIPT_VERBS.has(verb)) {
      throw fail(CODES.ACTION_UNSUPPORTED, `unknown fixture script verb: ${verb || statement}`, { script, verb })
    }
    const rest = tokens.slice(1)
    const target = () => resolveTarget(page, rest[0], { optional: true })
    const textFrom = (from) => expandText(page, rest.slice(from).join(' '), context)
    switch (verb) {
      case 'show': {
        const el = target()
        if (el) {
          if (el.hasAttribute('hidden')) el.removeAttribute('hidden')
          if (el.style.display === 'none') removeStyleProperty(el, 'display')
          applied += 1
        }
        break
      }
      case 'hide': {
        const el = target()
        if (el) {
          el.setAttribute('hidden', 'hidden')
          applied += 1
        }
        break
      }
      case 'toggle': {
        const el = target()
        if (el) {
          if (el.visible) el.setAttribute('hidden', 'hidden')
          else el.removeAttribute('hidden')
          applied += 1
        }
        break
      }
      case 'text': {
        const el = target()
        if (el) {
          el.setText(textFrom(1))
          applied += 1
        }
        break
      }
      case 'value': {
        const el = target()
        if (el) {
          el.value = textFrom(1)
          applied += 1
        }
        break
      }
      case 'focus': {
        const el = target()
        if (el) {
          page.document.focusElement(el)
          applied += 1
        }
        break
      }
      case 'click': {
        const el = target()
        if (el) {
          performClick(page, el, { via: 'script' })
          applied += 1
        }
        break
      }
      case 'class-add':
      case 'class-remove':
      case 'class-toggle': {
        const el = target()
        if (el && rest[1]) {
          if (verb === 'class-add') el.classList.add(rest[1])
          else if (verb === 'class-remove') el.classList.remove(rest[1])
          else el.classList.toggle(rest[1])
          applied += 1
        }
        break
      }
      case 'attr': {
        const el = target()
        const assignment = rest.slice(1).join(' ')
        const equals = assignment.indexOf('=')
        if (el && equals > 0) {
          el.setAttribute(assignment.slice(0, equals).trim(), expandText(page, assignment.slice(equals + 1).trim(), context))
          applied += 1
        }
        break
      }
      case 'remove': {
        const el = target()
        if (el) {
          el.remove()
          applied += 1
        }
        break
      }
      case 'navigate': {
        navigatePage(page, expandText(page, rest.join(' '), context))
        applied += 1
        break
      }
      case 'alert':
      case 'confirm':
      case 'prompt': {
        page.__ctx.browser.openDialog(page, { type: verb, message: textFrom(0), element: node })
        applied += 1
        break
      }
      case 'open-modal': {
        const el = target()
        openModal(page, textFrom(1), el || node)
        applied += 1
        break
      }
      case 'close-modal': {
        closeModal(page)
        applied += 1
        break
      }
      case 'freeze': {
        engageFreeze(page, node)
        applied += 1
        break
      }
      default:
        break
    }
  }
  return applied
}

// ------------------------------------------------------------------ modals ---

/** Open a real modal: an overlay plus a role="dialog" node created in the DOM. */
function openModal(page, message, sourceElement) {
  const state = page.__state
  const doc = page.document
  const id = `m${state.modals.length + 1}-${doc.revision}`
  const overlay = doc.createElement('div')
  overlay.setAttribute('data-cu-overlay', '1')
  setStyleProperties(overlay, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: `${doc.viewport.width}px`,
    height: `${doc.viewport.height}px`,
    background: `rgb(${OVERLAY_PAINT[0]},${OVERLAY_PAINT[1]},${OVERLAY_PAINT[2]})`,
    opacity: '0.55'
  })
  const dialog = doc.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', message || 'Dialog')
  dialog.setAttribute('data-cu-modal-id', id)
  const text = doc.createElement('p')
  text.setText(message || '')
  const dismiss = doc.createElement('button')
  dismiss.setAttribute('type', 'button')
  dismiss.setText('Dismiss')
  dialog.appendChild(text)
  dialog.appendChild(dismiss)
  setStyleProperties(dialog, {
    position: 'absolute',
    left: `${Math.max(0, Math.round((doc.viewport.width - MODAL_WIDTH) / 2))}px`,
    top: `${Math.max(0, Math.round((doc.viewport.height - MODAL_HEIGHT) / 2))}px`,
    width: `${MODAL_WIDTH}px`,
    height: `${MODAL_HEIGHT}px`
  })
  doc.body.appendChild(overlay)
  doc.body.appendChild(dialog)
  const record = { id, overlay, dialog, dismiss, message: message || '', opener: sourceElement ? sourceElement.ref : null }
  state.modals.push(record)
  dismiss.addEventListener('click', () => {
    closeModal(page, id)
  })
  doc.relayout()
  doc.focusElement(dismiss)
  page.__ctx.events.push({
    type: 'modal_opened',
    pageId: state.id,
    detail: { id, message: record.message, ref: dialog.ref, depth: state.modals.length }
  })
  return record
}

/** Close the topmost modal (or the one with the given id). */
function closeModal(page, id) {
  const state = page.__state
  const index = id ? state.modals.findIndex((record) => record.id === id) : state.modals.length - 1
  if (index < 0) return null
  const [record] = state.modals.splice(index, 1)
  const doc = page.document
  const previous = doc.activeElement
  record.dialog.remove()
  record.overlay.remove()
  doc.relayout()
  if (previous && !previous.isConnected) doc.focusElement(null)
  page.__ctx.events.push({ type: 'modal_closed', pageId: state.id, detail: { id: record.id, depth: state.modals.length } })
  return record
}

function blockedByModal(page, el) {
  const state = page.__state
  if (!state.modals.length) return false
  const top = state.modals[state.modals.length - 1]
  return !isInside(el, top.dialog)
}

// -------------------------------------------------------------- descriptors ---

/** ElementDescriptor for any element (see ports.cjs). */
function describeElement(page, el) {
  const role = md.roleOf(el)
  const descriptor = {
    ref: el.ref,
    tag: el.tagName,
    role,
    name: md.accessibleName(el),
    text: md.normalizeText(md.innerTextOf(el)),
    disabled: el.disabled,
    visible: el.visible,
    actionable: isActionable(page, el),
    bbox: el.bbox,
    selector: page.document.cssPath(el),
    attributes: attributeBag(el)
  }
  if (el.tagName === 'input' || el.tagName === 'textarea' || el.tagName === 'select' || el.tagName === 'option' || el.tagName === 'button') {
    descriptor.value = el.value
  }
  if (el.tagName === 'input' && (md.inputType(el) === 'checkbox' || md.inputType(el) === 'radio')) {
    descriptor.checked = el.checked
  }
  return descriptor
}

function isActionable(page, el) {
  const state = page.__state
  if (!el.visible || el.disabled) return false
  if (state.readyState !== 'complete') return false
  if (pageDialog(page)) return false
  if (blockedByModal(page, el)) return false
  const rect = el.bbox
  return rect.width > 0 && rect.height > 0
}

function requireActionable(page, target, action) {
  const el = resolveTarget(page, target)
  const dialog = pageDialog(page)
  if (dialog) {
    throw fail(CODES.MODAL_BLOCKING, `a blocking ${dialog.type} dialog is open`, { ref: el.ref, action, dialog: dialog.type })
  }
  if (blockedByModal(page, el)) {
    throw fail(CODES.MODAL_BLOCKING, 'a modal dialog blocks this control', { ref: el.ref, action, selector: page.document.cssPath(el) })
  }
  if (page.__state.readyState !== 'complete') {
    throw fail(CODES.TARGET_NOT_ACTIONABLE, 'the page is still loading', { ref: el.ref, action, reason: 'loading' })
  }
  if (!el.visible) throw fail(CODES.TARGET_NOT_ACTIONABLE, 'element is not visible', { ref: el.ref, action, reason: 'hidden' })
  if (el.disabled) throw fail(CODES.TARGET_NOT_ACTIONABLE, 'element is disabled', { ref: el.ref, action, reason: 'disabled' })
  const rect = el.bbox
  if (rect.width <= 0 || rect.height <= 0) {
    throw fail(CODES.TARGET_NOT_ACTIONABLE, 'element has an empty box', { ref: el.ref, action, reason: 'zero-size', bbox: rect })
  }
  return el
}

/** The page snapshot (see ports.cjs PageSnapshot). */
function pageSnapshot(page) {
  const state = page.__state
  const doc = page.document
  doc.ensureLayout()
  return {
    id: state.id,
    url: state.url,
    title: state.title,
    readyState: state.readyState,
    loading: isPageLoading(page),
    focusedRef: doc.activeElement ? doc.activeElement.ref : null,
    revision: doc.revision,
    tabs: page.__ctx.browser.tabs(),
    controls: doc.controls().map((el) => describeElement(page, el)),
    dialogs: page.__ctx.browser.dialogs(state.id),
    viewport: { x: 0, y: 0, width: doc.viewport.width, height: doc.viewport.height },
    scroll: { x: doc.scrollX, y: doc.scrollY },
    modals: state.modals.map((record) => ({ id: record.id, ref: record.dialog.ref, message: record.message })),
    frozen: state.frozen,
    windowHandle: state.windowHandle
  }
}

/** AxNode for one element; `offset` maps viewport coordinates to screen ones. */
function axNode(page, el, offset, depth) {
  const doc = page.document
  const rect = el.bbox
  const role = md.roleOf(el)
  const node = {
    ref: el.ref,
    role,
    name: md.accessibleName(el),
    enabled: !el.disabled && !pageDialog(page) && !blockedByModal(page, el),
    focusable: !el.disabled && el.visible && md.isInteractive(el),
    focused: doc.activeElement === el,
    offscreen: rect.y + rect.height <= 0 || rect.y >= doc.viewport.height || rect.x + rect.width <= 0 || rect.x >= doc.viewport.width,
    bounds: toScreenRect(offset, rect),
    patterns: patternsFor(el, role),
    elementRef: el.ref,
    selector: doc.cssPath(el)
  }
  if (el.tagName === 'input' || el.tagName === 'textarea' || el.tagName === 'select') node.value = el.value
  if (depth < 8) {
    const children = el.children.map((child) => axNode(page, child, offset, depth + 1))
    if (children.length) node.children = children
  }
  return node
}

function patternsFor(el, role) {
  const patterns = []
  if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'option') patterns.push('invoke')
  if (role === 'checkbox' || role === 'radio') patterns.push('toggle')
  if (role === 'textbox' || role === 'combobox' || role === 'slider') patterns.push('value', 'setValue')
  patterns.push('focus')
  return patterns
}

/** AX tree of one page in viewport coordinates (the port translates to screen). */
function accessibilityTreeOfPage(page) {
  const doc = page.document
  const seen = new Set()
  const roots = doc.controls().concat(doc.querySelectorAll('[role="dialog"], [role="status"], [role="alert"], canvas'))
  return roots
    .filter((el) => {
      if (seen.has(el)) return false
      seen.add(el)
      return true
    })
    .map((el) => axNode(page, el, { x: 0, y: 0 }, 0))
}

// ----------------------------------------------------------------- actions ---

/** Real click: focus, mousedown/mouseup/click, fixture scripts, default action. */
function performClick(page, el, options = {}) {
  const doc = page.document
  if (el.tagName === 'input' || el.tagName === 'button' || el.tagName === 'select' || el.tagName === 'textarea' || el.hasAttribute('tabindex')) {
    doc.focusElement(el)
  }
  const detail = { button: options.button || 'left', clickCount: options.double ? 2 : 1, via: options.via || 'port' }
  el.dispatchEvent(md.createEvent('mousedown', { detail }))
  el.dispatchEvent(md.createEvent('mouseup', { detail }))
  const event = md.createEvent('click', { detail })
  const accepted = el.dispatchEvent(event)
  if (options.double) el.dispatchEvent(md.createEvent('dblclick', { detail }))
  return { target: el, prevented: event.defaultPrevented, eaten: Boolean(event.__cuEaten), accepted, detail }
}

function performClickOnTarget(page, target, options) {
  const el = requireActionable(page, target, 'click')
  const before = page.document.revision
  const result = performClick(page, el, { button: options.button, double: options.double, via: 'page-port' })
  return {
    ok: true,
    detail: {
      ref: el.ref,
      selector: page.document.cssPath(el),
      tag: el.tagName,
      name: md.accessibleName(el),
      revisionBefore: before,
      revisionAfter: page.document.revision,
      prevented: result.prevented,
      swallowed: result.eaten,
      clickCount: result.detail.clickCount
    }
  }
}

function focusElementOnPage(page, target) {
  const el = requireActionable(page, target, 'focus')
  const moved = page.document.focusElement(el)
  if (!moved && page.document.activeElement !== el) {
    throw fail(CODES.TARGET_NOT_ACTIONABLE, 'element cannot take focus', { ref: el.ref, tag: el.tagName })
  }
  return { ok: true, detail: { ref: el.ref, selector: page.document.cssPath(el), focused: true, already: !moved } }
}

/** Type text into a control with real keydown/input events and caret movement. */
function typeIntoElement(page, target, text, options) {
  const el = requireActionable(page, target, 'typeText')
  if (!md.isTextInput(el)) {
    throw fail(CODES.ACTION_UNSUPPORTED, `cannot type into <${el.tagName}>`, { ref: el.ref, tag: el.tagName })
  }
  const doc = page.document
  doc.focusElement(el)
  if (options.clear) el.setSelectionRange(0, el.value.length)
  for (const character of String(text === null || text === undefined ? '' : text).split('')) {
    const event = md.createEvent('keydown', { key: character })
    if (!el.dispatchEvent(event)) continue
    el.insertText(character)
    el.dispatchEvent(md.createEvent('input', { detail: { value: el.value } }))
  }
  return {
    ok: true,
    detail: { ref: el.ref, selector: doc.cssPath(el), value: el.value, length: el.value.length, cleared: Boolean(options.clear) }
  }
}

function setElementValue(page, target, value) {
  const el = requireActionable(page, target, 'setValue')
  if (el.tagName === 'select') return selectElementOption(page, el, value)
  if (el.tagName !== 'input' && el.tagName !== 'textarea') {
    throw fail(CODES.ACTION_UNSUPPORTED, `cannot set a value on <${el.tagName}>`, { ref: el.ref, tag: el.tagName })
  }
  const type = el.tagName === 'input' ? md.inputType(el) : 'textarea'
  if (type === 'checkbox' || type === 'radio') {
    el.checked = Boolean(value)
    md.fireValueEvents(page.document, el)
    return { ok: true, detail: { ref: el.ref, checked: el.checked } }
  }
  el.value = value === null || value === undefined ? '' : String(value)
  md.fireValueEvents(page.document, el)
  return { ok: true, detail: { ref: el.ref, value: el.value } }
}

function selectElementOption(page, target, choice) {
  const el = requireActionable(page, target, 'selectOption')
  if (el.tagName !== 'select') throw fail(CODES.ACTION_UNSUPPORTED, `cannot select an option on <${el.tagName}>`, { ref: el.ref })
  const options = el.getElementsByTagName('option')
  let match = null
  if (choice && typeof choice === 'object') {
    if (Number.isInteger(choice.index)) match = options[choice.index] || null
    else if (choice.label !== undefined) match = options.find((option) => md.normalizeText(md.innerTextOf(option)) === String(choice.label)) || null
    else if (choice.value !== undefined) match = options.find((option) => md.optionValue(option) === String(choice.value)) || null
  } else {
    match = options.find((option) => md.optionValue(option) === String(choice)) || null
  }
  if (!match) {
    throw fail(CODES.TARGET_NOT_FOUND, `no option matches ${JSON.stringify(choice)}`, {
      ref: el.ref,
      options: options.map((option) => md.optionValue(option))
    })
  }
  el.value = md.optionValue(match)
  md.fireValueEvents(page.document, el)
  return { ok: true, detail: { ref: el.ref, value: el.value, label: md.normalizeText(md.innerTextOf(match)) } }
}

/** Move the viewport offset for real, so every bbox shifts. */
function scrollPage(page, options) {
  const doc = page.document
  if (options.ref || options.selector) {
    const el = resolveTarget(page, options.ref || options.selector)
    const rect = el.bbox
    let target = doc.scrollY
    if (rect.y < 0) target = doc.scrollY + rect.y
    else if (rect.y + rect.height > doc.viewport.height) target = doc.scrollY + (rect.y + rect.height - doc.viewport.height)
    doc.setScroll(doc.scrollX, target)
  } else {
    const nextX = options.x !== undefined ? options.x : doc.scrollX + (options.deltaX || 0)
    const nextY = options.y !== undefined ? options.y : doc.scrollY + (options.deltaY || 0)
    doc.setScroll(nextX, nextY)
  }
  return { ok: true, detail: { scroll: { x: doc.scrollX, y: doc.scrollY }, contentHeight: doc.contentHeight } }
}

// ------------------------------------------------------------- navigation ---

function navigatePage(page, target, options = {}) {
  const state = page.__state
  const dialog = pageDialog(page)
  if (dialog) {
    throw fail(CODES.MODAL_BLOCKING, `a blocking ${dialog.type} dialog is open`, { url: state.url })
  }
  const source = resolveSource(target, options)
  if (options.history !== 'keep') {
    state.historyBack.push({ url: state.url, source: state.source })
    state.historyForward.length = 0
  }
  return loadPage(page, { url: source.url, source, reason: 'navigate' })
}

function stepHistory(page, direction) {
  const state = page.__state
  const stack = direction < 0 ? state.historyBack : state.historyForward
  if (!stack.length) {
    return { ok: false, detail: { reason: 'NO_HISTORY', direction: direction < 0 ? 'back' : 'forward', url: state.url } }
  }
  const other = direction < 0 ? state.historyForward : state.historyBack
  other.push({ url: state.url, source: state.source })
  const entry = stack.pop()
  const result = loadPage(page, { url: entry.url, source: entry.source, reason: direction < 0 ? 'back' : 'forward' })
  return { ok: true, detail: { ...result.detail, direction: direction < 0 ? 'back' : 'forward' } }
}

/** `data-cu-load-ms` declared on the <html> element, or 0. */
function loadMsFromHtml(html) {
  const match = /<html[^>]*data-cu-load-ms="(\d+)"/i.exec(String(html || ''))
  return match ? Number(match[1]) : 0
}

/** Resolve a fixture name, a URL or an inline {html} object into a page source. */
function resolveSource(target, options = {}) {
  if (target && typeof target === 'object') {
    const html = typeof target.html === 'string' ? target.html : ''
    const doc = md.createDocument({ html })
    return {
      html,
      url: target.url || options.url || 'about:blank',
      title: doc.title,
      fixture: null,
      loadMs: target.loadMs === undefined ? loadMsFromHtml(html) : Number(target.loadMs || 0)
    }
  }
  const text = String(target === null || target === undefined ? '' : target).trim()
  if (!text || text === 'about:blank') {
    return {
      html: '<!doctype html><html><head><title>Blank</title></head><body></body></html>',
      url: 'about:blank',
      title: 'Blank',
      fixture: null,
      loadMs: 0
    }
  }
  let fixture = text
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    fixture = text.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || ''
  }
  const candidate = path.isAbsolute(fixture) ? fixture : path.join(FIXTURE_DIR, fixture)
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    const html = fs.readFileSync(candidate, 'utf8')
    const doc = md.createDocument({ html })
    const name = path.basename(candidate)
    return {
      html,
      url: options.url || `https://device.test/${name}`,
      title: doc.title,
      fixture: name,
      file: candidate,
      loadMs: loadMsFromHtml(html)
    }
  }
  throw fail(CODES.TARGET_NOT_FOUND, `fixture not found: ${text}`, { fixture: text, directory: FIXTURE_DIR })
}

/**
 * Read a fixture from FIXTURE_DIR (also exported so tests can build expectations
 * from the same bytes the device parses).
 *
 * @param {string} name fixture file name, for example 'form.html'
 * @param {object} [options]
 * @param {string} [options.url] URL to report for the fixture
 * @returns {{name: string, path: string, html: string, url: string}}
 */
function loadFixture(name, options = {}) {
  const file = path.isAbsolute(String(name)) ? String(name) : path.join(FIXTURE_DIR, String(name))
  if (!fs.existsSync(file)) throw fail(CODES.TARGET_NOT_FOUND, `fixture not found: ${name}`, { fixture: name, directory: FIXTURE_DIR })
  const html = fs.readFileSync(file, 'utf8')
  return {
    name: path.basename(file),
    path: file,
    html,
    url: options.url || `https://device.test/${path.basename(file)}`
  }
}

// ------------------------------------------------------------------ waiting ---

async function waitForCondition(page, spec) {
  const state = page.__state
  const clock = page.__ctx.clock
  const condition = String(spec.condition || '').toLowerCase()
  if (!WAIT_CONDITIONS.has(condition)) {
    throw fail(CODES.ACTION_INVALID, `unknown waitFor condition: ${spec.condition}`, {
      condition: spec.condition,
      supported: [...WAIT_CONDITIONS]
    })
  }
  const timeoutMs = Number.isFinite(spec.timeoutMs) ? Number(spec.timeoutMs) : 5000
  const start = clock.now()
  const startRevision = page.document.revision
  const startUrl = state.url
  const deadline = start + Math.max(0, timeoutMs)
  const ready = () => {
    switch (condition) {
      case 'selector': {
        const el = spec.selector ? page.document.querySelector(spec.selector) : null
        if (!el) return false
        return spec.visible ? el.visible : true
      }
      case 'mutation': {
        if (page.document.revision <= startRevision) return false
        if (!spec.selector) return true
        return page.document.mutationsSince(startRevision).some((record) => (record.selector || '').includes(spec.selector))
      }
      case 'navigation':
        return state.url !== startUrl
      case 'load':
        return !isPageLoading(page)
      case 'idle':
        return !isPageLoading(page) && state.timers.size === 0
      default:
        return false
    }
  }
  const finish = () => ({
    condition,
    matched: true,
    selector: spec.selector || null,
    waitedMs: clock.now() - start,
    at: clock.now(),
    revision: page.document.revision,
    url: state.url
  })
  if (ready()) return finish()
  if (clock.kind === 'realtime') {
    while (clock.now() < deadline) {
      await clock.sleep(10)
      if (ready()) return finish()
    }
    throw waitTimeout(condition, spec, timeoutMs, clock.now() - start)
  }
  for (let pump = 0; pump < MAX_WAIT_PUMPS; pump += 1) {
    await yieldTurn()
    if (ready()) return finish()
    const next = clock.nextDeadline()
    if (next !== null && next <= deadline) {
      clock.advance(next - clock.now())
      continue
    }
    if (clock.now() < deadline) clock.advance(deadline - clock.now())
    await yieldTurn()
    if (ready()) return finish()
    throw waitTimeout(condition, spec, timeoutMs, clock.now() - start)
  }
  throw waitTimeout(condition, spec, timeoutMs, clock.now() - start)
}

function waitTimeout(condition, spec, timeoutMs, waitedMs) {
  return fail(CODES.ACTION_TIMEOUT, `waitFor(${condition}) timed out after ${timeoutMs} ms`, {
    condition,
    selector: spec.selector || null,
    timeoutMs,
    waitedMs
  })
}

/** Yield to the event loop without spending wall-clock time. */
function yieldTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

// -------------------------------------------------------------- page shots ---

function screenshotPage(page, spec) {
  const state = page.__state
  const host = state.hostRect
  let rect = { x: host.x, y: host.y, width: host.width, height: host.height }
  let source = 'page'
  if (spec.ref || spec.selector) {
    const el = resolveTarget(page, spec.ref || spec.selector)
    rect = toScreenRect(host, el.bbox)
    source = 'element'
  } else if (spec.clip) {
    rect = toScreenRect(host, spec.clip)
    source = 'clip'
  }
  const shot = page.__ctx.screenshotPort.captureRegion(rect)
  return { ...shot, pageId: state.id, source, clip: spec.clip || null, ref: spec.ref || null }
}

function closePage(page) {
  const state = page.__state
  if (state.closed) return
  state.closed = true
  cancelPageTimers(page)
  while (state.modals.length) closeModal(page)
  page.__ctx.browser.removePage(page)
}

// ----------------------------------------------------------------- browser ---

/**
 * The virtual browser: its tabs (pages) and the blocking JS dialog slot.
 *
 * @param {object} ctx device context
 */
function createBrowser(ctx) {
  const pages = []
  let activePageId = null
  let pageSeq = 0
  const browser = {
    pages,
    dialog: null,
    tabs() {
      return pages.map((page) => ({
        id: page.id,
        url: page.url,
        title: page.document ? page.document.title : '',
        active: page.id === activePageId
      }))
    },
    openPage(fixture, options = {}) {
      guardDevice(ctx)
      pageSeq += 1
      const id = options.id || `p${pageSeq}`
      const source = resolveSource(fixture, options)
      const viewport = options.viewport || DEFAULT_VIEWPORT
      const hostRect = options.hostRect || { x: 0, y: 0, width: viewport.width, height: viewport.height }
      const page = createPage(ctx, {
        id,
        source,
        url: options.url || source.url,
        title: source.title,
        hostRect,
        windowHandle: options.windowHandle || null,
        defer: options.defer
      })
      if (options.viewport) page.document.setViewport(viewport)
      pages.push(page)
      if (options.activate !== false) activePageId = id
      ctx.events.push({
        type: 'page_opened',
        pageId: id,
        windowId: page.__state.windowHandle,
        detail: { url: page.url, title: page.document.title, fixture: source.fixture, tabs: pages.length }
      })
      return page
    },
    page(id) {
      if (!id) return pages.find((page) => page.id === activePageId) || pages[0] || null
      return pages.find((page) => page.id === id) || null
    },
    removePage(page) {
      const index = pages.indexOf(page)
      if (index >= 0) pages.splice(index, 1)
      if (activePageId === page.id) activePageId = pages.length ? pages[pages.length - 1].id : null
      ctx.events.push({ type: 'page_closed', pageId: page.id, detail: { tabs: pages.length } })
      if (browser.dialog && browser.dialog.pageId === page.id) browser.dialog = null
    },
    dialogs(pageId) {
      if (!browser.dialog) return []
      if (pageId && browser.dialog.pageId !== pageId) return []
      return [{ type: browser.dialog.type, message: browser.dialog.message, open: true, pageId: browser.dialog.pageId }]
    },
    /** Open a blocking JS dialog; only one can be open at a time. */
    openDialog(page, spec) {
      if (browser.dialog) {
        ctx.events.push({ type: 'dialog_dropped', pageId: page.id, detail: { type: spec.type, message: spec.message } })
        return null
      }
      browser.dialog = {
        id: `d${ctx.events.all().length + 1}`,
        type: spec.type,
        message: spec.message,
        pageId: page.id,
        elementRef: spec.element ? spec.element.ref : null,
        accepted: null,
        value: null
      }
      ctx.events.push({
        type: 'dialog_opened',
        pageId: page.id,
        detail: { type: spec.type, message: spec.message, ref: browser.dialog.elementRef }
      })
      ctx.events.push({ type: 'load_state_changed', pageId: page.id, detail: { loading: true, reason: 'dialog' } })
      return browser.dialog
    },
    answerDialog(page, answer = {}) {
      guardDevice(ctx)
      const dialog = browser.dialog
      if (!dialog) return { ok: false, detail: { reason: 'NO_DIALOG' } }
      const accept = answer.accept !== false
      dialog.accepted = accept
      dialog.value = answer.value === undefined ? null : String(answer.value)
      const element = dialog.elementRef ? page.document.byRef(dialog.elementRef) : null
      browser.dialog = null
      ctx.events.push({
        type: 'dialog_answered',
        pageId: dialog.pageId,
        detail: { type: dialog.type, accepted: accept, value: dialog.value }
      })
      ctx.events.push({ type: 'load_state_changed', pageId: dialog.pageId, detail: { loading: false, reason: 'dialog' } })
      const runsAcceptScript = Boolean(accept && element && element.cu.scripts.accept)
      if (runsAcceptScript) {
        const owner = browser.page(dialog.pageId)
        if (owner) runScript(owner, element, element.cu.scripts.accept, { context: { prompt: dialog.value } })
      }
      return {
        ok: true,
        detail: { type: dialog.type, accepted: accept, value: dialog.value, ranAcceptScript: runsAcceptScript }
      }
    },
    dismissDialogs(page, reason) {
      if (!browser.dialog) return false
      ctx.events.push({
        type: 'dialog_dismissed',
        pageId: browser.dialog.pageId,
        detail: { type: browser.dialog.type, reason, page: page ? page.id : null }
      })
      browser.dialog = null
      return true
    }
  }
  return browser
}

// ----------------------------------------------------------------- windows ---

function contentBounds(window) {
  return {
    x: window.bounds.x,
    y: window.bounds.y + TITLE_BAR_HEIGHT,
    width: Math.max(0, window.bounds.width),
    height: Math.max(0, window.bounds.height - TITLE_BAR_HEIGHT)
  }
}

/** A window frame colour: `#rrggbb`, a colour name, or a `label|#rrggbb|w|h` paint spec. */
function windowPaint(spec) {
  if (spec === undefined || spec === null) return DEFAULT_WINDOW_PAINT.slice()
  const paint = md.parsePaint(spec)
  if (paint) return paint.color
  return md.parseColor(spec) || DEFAULT_WINDOW_PAINT.slice()
}

function findWindow(ctx, handle) {
  return ctx.windows.find((window) => window.handle === handle) || null
}

function describeWindow(ctx, window, foreground) {
  return {
    handle: window.handle,
    title: window.title,
    className: window.className,
    processId: window.processId,
    bounds: { ...window.bounds },
    contentBounds: contentBounds(window),
    visible: window.visible,
    minimized: window.minimized,
    foreground,
    pageId: window.pageId
  }
}

/** Topmost window containing a screen point. */
function windowAt(ctx, x, y) {
  for (let index = ctx.order.length - 1; index >= 0; index -= 1) {
    const window = findWindow(ctx, ctx.order[index])
    if (!window || !window.visible || window.minimized) continue
    const bounds = window.bounds
    if (x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height) return window
  }
  return null
}

/** Accept 'Ctrl+S', {key:'s',modifiers:['ctrl']} or ['Ctrl','S']. */
function normalizeKeySpec(spec) {
  if (typeof spec === 'string') {
    const parts = spec.split('+').map((part) => part.trim()).filter(Boolean)
    return { key: parts.length ? parts[parts.length - 1] : '', modifiers: parts.slice(0, -1).map((part) => part.toLowerCase()) }
  }
  if (Array.isArray(spec)) return normalizeKeySpec(spec.join('+'))
  if (spec && typeof spec === 'object') {
    return {
      key: String(spec.key === undefined || spec.key === null ? '' : spec.key),
      modifiers: (spec.modifiers || []).map((item) => String(item).toLowerCase())
    }
  }
  return { key: '', modifiers: [] }
}

// ----------------------------------------------------------------- desktop ---

/**
 * The virtual window manager, mouse and keyboard.
 *
 * @param {object} ctx device context
 */
function createDesktop(ctx) {
  let handleSeq = 0
  const state = { cursor: { x: 0, y: 0 } }
  const foreground = () => (ctx.order.length ? findWindow(ctx, ctx.order[ctx.order.length - 1]) : null)
  const port = {
    probe: () => probePort('desktop', null),
    listWindows() {
      guardDevice(ctx)
      const top = ctx.order[ctx.order.length - 1] || null
      return ctx.order
        .slice()
        .reverse()
        .map((handle) => describeWindow(ctx, findWindow(ctx, handle), handle === top))
    },
    foregroundWindow() {
      guardDevice(ctx)
      return ctx.order.length ? ctx.order[ctx.order.length - 1] : null
    },
    focusWindow(handle) {
      guardDevice(ctx)
      const window = findWindow(ctx, handle)
      if (!window) throw fail(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle })
      // Focusing a window also restores it, exactly as a taskbar click does.
      const restored = window.minimized
      window.minimized = false
      if (ctx.order[ctx.order.length - 1] !== handle) {
        ctx.order.splice(ctx.order.indexOf(handle), 1)
        ctx.order.push(handle)
        ctx.events.push({ type: 'window_focused', windowId: handle, detail: { handle, title: window.title } })
        ctx.events.push({ type: 'focus_changed', windowId: handle, detail: { scope: 'desktop', to: handle } })
      }
      return { ok: true, detail: { handle, foreground: true, title: window.title, restored } }
    },
    closeWindow(handle) {
      guardDevice(ctx)
      const window = findWindow(ctx, handle)
      if (!window) throw fail(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle })
      ctx.order.splice(ctx.order.indexOf(handle), 1)
      ctx.windows.splice(ctx.windows.indexOf(window), 1)
      if (window.pageId) {
        const page = ctx.browser.page(window.pageId)
        if (page) closePage(page)
      }
      ctx.events.push({ type: 'window_closed', windowId: handle, detail: { handle, title: window.title } })
      return { ok: true, detail: { handle, remaining: ctx.windows.length } }
    },
    moveWindow(handle, bounds) {
      guardDevice(ctx)
      const window = findWindow(ctx, handle)
      if (!window) throw fail(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle })
      const next = {
        x: bounds && bounds.x !== undefined ? Number(bounds.x) : window.bounds.x,
        y: bounds && bounds.y !== undefined ? Number(bounds.y) : window.bounds.y,
        width: bounds && bounds.width !== undefined ? Number(bounds.width) : window.bounds.width,
        height: bounds && bounds.height !== undefined ? Number(bounds.height) : window.bounds.height
      }
      window.bounds = next
      if (window.pageId) {
        const page = ctx.browser.page(window.pageId)
        if (page) {
          const content = contentBounds(window)
          page.__state.hostRect = content
          page.document.setViewport({ width: content.width, height: content.height })
        }
      }
      ctx.events.push({ type: 'window_moved', windowId: handle, detail: { handle, bounds: next } })
      return { ok: true, detail: { handle, bounds: next, contentBounds: contentBounds(window) } }
    },
    openApplication(options = {}) {
      guardDevice(ctx)
      handleSeq += 1
      const handle = options.handle || `w${handleSeq}`
      const bounds = { ...DEFAULT_WINDOW_BOUNDS, ...(options.bounds || {}) }
      const window = {
        handle,
        title: options.title || 'Untitled',
        className: options.className || 'VirtualWindow',
        processId: Number.isFinite(options.processId) ? options.processId : 4000 + handleSeq,
        bounds,
        paint: windowPaint(options.paint),
        pageId: null,
        minimized: false,
        visible: options.visible !== false
      }
      ctx.windows.push(window)
      ctx.order.push(handle)
      if (options.fixture || options.html || options.url) {
        const content = contentBounds(window)
        const page = ctx.browser.openPage(options.html ? { html: options.html, url: options.url } : options.fixture || options.url, {
          viewport: { width: content.width, height: content.height },
          hostRect: content,
          windowHandle: handle,
          id: options.pageId
        })
        window.pageId = page.id
      }
      ctx.events.push({
        type: 'window_opened',
        windowId: handle,
        pageId: window.pageId,
        detail: { handle, title: window.title, className: window.className, bounds, pageId: window.pageId }
      })
      ctx.events.push({ type: 'focus_changed', windowId: handle, detail: { scope: 'desktop', to: handle } })
      return { ok: true, detail: describeWindow(ctx, window, true) }
    },
    cursorPosition() {
      guardDevice(ctx)
      return { ...state.cursor }
    },
    moveMouse(point = {}) {
      guardDevice(ctx)
      state.cursor = { x: Number(point.x) || 0, y: Number(point.y) || 0 }
      return { ok: true, detail: { cursor: { ...state.cursor } } }
    },
    click(point = {}) {
      guardDevice(ctx)
      const x = Number(point.x) || 0
      const y = Number(point.y) || 0
      state.cursor = { x, y }
      const window = windowAt(ctx, x, y)
      if (!window) {
        ctx.events.push({ type: 'mouse_clicked', detail: { x, y, hit: 'desktop' } })
        return { ok: false, detail: { reason: 'NO_WINDOW', point: { x, y } } }
      }
      const wasForeground = ctx.order[ctx.order.length - 1] === window.handle
      if (!wasForeground) port.focusWindow(window.handle)
      const content = contentBounds(window)
      if (y < content.y) {
        ctx.events.push({ type: 'mouse_clicked', windowId: window.handle, detail: { x, y, hit: 'titlebar' } })
        return { ok: true, detail: { window: window.handle, hit: 'titlebar', focused: !wasForeground } }
      }
      const page = window.pageId ? ctx.browser.page(window.pageId) : null
      if (!page) {
        ctx.events.push({ type: 'mouse_clicked', windowId: window.handle, detail: { x, y, hit: 'window-body' } })
        return { ok: true, detail: { window: window.handle, hit: 'window-body', focused: !wasForeground } }
      }
      if (x < content.x || x >= content.x + content.width || y >= content.y + content.height) {
        ctx.events.push({ type: 'mouse_clicked', windowId: window.handle, detail: { x, y, hit: 'frame' } })
        return { ok: true, detail: { window: window.handle, hit: 'frame' } }
      }
      const viewportX = x - content.x
      const viewportY = y - content.y
      const hit = page.document.hitTest(viewportX, viewportY)
      const pagePoint = { x: viewportX + page.document.scrollX, y: viewportY + page.document.scrollY }
      if (!hit) {
        ctx.events.push({ type: 'mouse_clicked', windowId: window.handle, pageId: page.id, detail: { x, y, hit: 'page-background' } })
        return { ok: true, detail: { window: window.handle, page: page.id, hit: 'page-background', focused: !wasForeground, pagePoint } }
      }
      const result = performClick(page, hit, { button: point.button || 'left', double: Boolean(point.double), via: 'desktop' })
      ctx.events.push({
        type: 'mouse_clicked',
        windowId: window.handle,
        pageId: page.id,
        detail: {
          x,
          y,
          pagePoint,
          hit: 'element',
          ref: hit.ref,
          selector: page.document.cssPath(hit),
          tag: hit.tagName,
          name: md.accessibleName(hit),
          swallowed: result.eaten
        }
      })
      return {
        ok: true,
        detail: {
          window: window.handle,
          page: page.id,
          hit: 'element',
          ref: hit.ref,
          selector: page.document.cssPath(hit),
          tag: hit.tagName,
          name: md.accessibleName(hit),
          pagePoint,
          focused: !wasForeground,
          swallowed: result.eaten,
          prevented: result.prevented
        }
      }
    },
    drag(spec = {}) {
      guardDevice(ctx)
      const from = spec.from || { x: 0, y: 0 }
      const to = spec.to || from
      const start = port.click({ x: Number(from.x) || 0, y: Number(from.y) || 0, button: spec.button || 'left' })
      const target = windowAt(ctx, Number(to.x) || 0, Number(to.y) || 0)
      let end = null
      if (target && target.pageId) {
        const page = ctx.browser.page(target.pageId)
        const content = contentBounds(target)
        const hit = page.document.hitTest((Number(to.x) || 0) - content.x, (Number(to.y) || 0) - content.y)
        end = hit ? { ref: hit.ref, selector: page.document.cssPath(hit), tag: hit.tagName } : null
      }
      state.cursor = { x: Number(to.x) || 0, y: Number(to.y) || 0 }
      ctx.events.push({ type: 'mouse_dragged', detail: { from: { ...from }, to: { ...to } } })
      return { ok: Boolean(start.ok), detail: { from: { ...from }, to: { ...to }, start: start.detail || null, end } }
    },
    scroll(point = {}) {
      guardDevice(ctx)
      const x = Number(point.x) || 0
      const y = Number(point.y) || 0
      state.cursor = { x, y }
      const window = windowAt(ctx, x, y)
      if (!window) return { ok: false, detail: { reason: 'NO_WINDOW', point: { x, y } } }
      const page = window.pageId ? ctx.browser.page(window.pageId) : null
      if (!page) return { ok: false, detail: { reason: 'NO_PAGE', window: window.handle } }
      const result = scrollPage(page, { deltaX: point.deltaX || 0, deltaY: point.deltaY || 0 })
      ctx.events.push({ type: 'mouse_scrolled', windowId: window.handle, pageId: page.id, detail: { x, y, deltaY: point.deltaY || 0 } })
      return { ok: true, detail: { window: window.handle, page: page.id, ...result.detail } }
    },
    keyPress(spec) {
      guardDevice(ctx)
      const normalized = normalizeKeySpec(spec)
      const window = foreground()
      if (!window) return { ok: false, detail: { reason: 'NO_FOREGROUND_WINDOW' } }
      if (!window.pageId) {
        ctx.events.push({ type: 'key_pressed', windowId: window.handle, detail: { key: normalized.key, modifiers: normalized.modifiers } })
        return { ok: true, detail: { window: window.handle, key: normalized.key, delivered: false, reason: 'NO_PAGE' } }
      }
      const page = ctx.browser.page(window.pageId)
      const result = page.handleKey(normalized)
      ctx.events.push({
        type: 'key_pressed',
        windowId: window.handle,
        pageId: page.id,
        detail: { key: normalized.key, modifiers: normalized.modifiers }
      })
      return { ok: Boolean(result.ok), detail: { window: window.handle, page: page.id, ...result.detail } }
    },
    hotkey(keys, options = {}) {
      guardDevice(ctx)
      const normalized = normalizeKeySpec(Array.isArray(keys) ? keys.join('+') : keys)
      if (!normalized.modifiers.length) {
        throw fail(CODES.ACTION_INVALID, `hotkey needs at least one modifier: ${String(keys)}`, { keys })
      }
      return port.keyPress({ key: normalized.key, modifiers: normalized.modifiers, ...options })
    },
    typeText(text, options = {}) {
      guardDevice(ctx)
      const window = foreground()
      if (!window || !window.pageId) return { ok: false, detail: { reason: 'NO_FOREGROUND_PAGE' } }
      const page = ctx.browser.page(window.pageId)
      if (options.clear) {
        const active = page.document.activeElement
        if (active && md.isTextInput(active)) active.setSelectionRange(0, active.value.length)
      }
      const characters = String(text === null || text === undefined ? '' : text).split('')
      let inserted = 0
      let last = null
      for (const character of characters) {
        last = page.handleKey({ key: character })
        if (last.ok && last.detail && last.detail.inserted) inserted += 1
        else if (!last.ok) break
      }
      return {
        ok: characters.length === 0 || inserted > 0,
        detail: {
          window: window.handle,
          page: page.id,
          requested: characters.length,
          inserted,
          reason: inserted === 0 ? 'NO_TEXT_TARGET' : null,
          last: last ? last.detail : null
        }
      }
    },
    clipboardRead() {
      guardDevice(ctx)
      return ctx.clipboard.read()
    },
    clipboardWrite(text) {
      guardDevice(ctx)
      ctx.clipboard.write(text)
      return { ok: true, detail: { length: ctx.clipboard.read().length } }
    },
    screenMetrics() {
      guardDevice(ctx)
      return { ...ctx.screen }
    }
  }
  return port
}

// ------------------------------------------------------------ keyboard (page) ---

/** Apply one key to a page: a real keydown, then the browser default action. */
function handleKey(page, spec) {
  const state = page.__state
  const doc = page.document
  const key = String(spec.key === undefined || spec.key === null ? '' : spec.key)
  const modifiers = (spec.modifiers || []).map((item) => String(item).toLowerCase())
  const control = modifiers.includes('ctrl') || modifiers.includes('meta')
  const normalized = key === 'Space' ? ' ' : key
  const dialog = pageDialog(page)
  if (dialog) {
    if (normalized === 'Escape') {
      const answer = page.__ctx.browser.answerDialog(page, { accept: false })
      return { ok: true, detail: { key: 'Escape', dialog: dialog.type, ...answer.detail } }
    }
    if (normalized === 'Enter' || normalized === ' ') {
      const answer = page.__ctx.browser.answerDialog(page, { accept: true })
      return { ok: true, detail: { key: normalized, dialog: dialog.type, ...answer.detail } }
    }
    return { ok: true, detail: { key: normalized, blocked: true, reason: 'dialog', inserted: 0 } }
  }
  const target = doc.activeElement || doc.body
  const keyEvent = md.createEvent('keydown', { key: normalized, modifiers })
  const allowed = target ? target.dispatchEvent(keyEvent) : true
  if (!allowed) return { ok: true, detail: { key: normalized, prevented: true, inserted: 0 } }

  if (control) {
    switch (normalized.toLowerCase()) {
      case 'a': {
        const active = doc.activeElement
        if (active && md.isTextInput(active)) {
          active.setSelectionRange(0, active.value.length)
          return { ok: true, detail: { key: normalized, selected: active.value.length } }
        }
        return { ok: true, detail: { key: normalized, selected: 'page' } }
      }
      case 'c': {
        const active = doc.activeElement
        if (active && md.isTextInput(active)) {
          const selected = active.value.slice(active.selectionStart, active.selectionEnd)
          if (!selected) return { ok: false, detail: { key: normalized, reason: 'EMPTY_SELECTION' } }
          page.__ctx.clipboard.write(selected)
          return { ok: true, detail: { key: normalized, copied: selected.length } }
        }
        const text = active ? md.normalizeText(md.innerTextOf(active)) : ''
        if (!text) return { ok: false, detail: { key: normalized, reason: 'NOTHING_TO_COPY' } }
        page.__ctx.clipboard.write(text)
        return { ok: true, detail: { key: normalized, copied: text.length } }
      }
      case 'v': {
        const active = doc.activeElement
        if (!active || !md.isTextInput(active)) return { ok: false, detail: { key: normalized, reason: 'NO_TEXT_TARGET' } }
        const text = page.__ctx.clipboard.read()
        if (!text) return { ok: false, detail: { key: normalized, reason: 'CLIPBOARD_EMPTY' } }
        active.insertText(text)
        active.dispatchEvent(md.createEvent('input', { detail: { value: active.value } }))
        return { ok: true, detail: { key: normalized, pasted: text.length, value: active.value } }
      }
      case 's': {
        const bound = findFileBinding(doc.activeElement)
        if (!bound) return { ok: true, detail: { key: normalized, saved: false, reason: 'NO_FILE_BINDING' } }
        const written = page.__ctx.files.write(bound.element.cu.file, bound.element.value)
        const applied = runScript(page, bound.element, bound.element.cu.scripts.save, { context: { file: bound.element.cu.file } })
        page.__ctx.events.push({
          type: 'file_saved',
          pageId: state.id,
          detail: { path: written.path, size: written.size, mtime: written.mtime, scriptStatements: applied }
        })
        return { ok: true, detail: { key: normalized, saved: true, path: written.path, size: written.size } }
      }
      default:
        return { ok: false, detail: { key: normalized, reason: 'UNSUPPORTED_HOTKEY', modifiers } }
    }
  }

  if (normalized === 'Tab') {
    const focusable = doc.focusable()
    if (!focusable.length) return { ok: false, detail: { key: 'Tab', reason: 'NO_FOCUSABLE' } }
    const current = focusable.indexOf(doc.activeElement)
    const step = modifiers.includes('shift') ? -1 : 1
    const next = current < 0 ? (step > 0 ? 0 : focusable.length - 1) : (current + step + focusable.length) % focusable.length
    doc.focusElement(focusable[next])
    return { ok: true, detail: { key: 'Tab', focused: focusable[next].ref, selector: doc.cssPath(focusable[next]), index: next } }
  }
  if (normalized === 'Escape') {
    const closed = closeModal(page)
    return { ok: true, detail: { key: 'Escape', closedModal: closed ? closed.id : null } }
  }
  if (normalized === 'Enter') {
    const active = doc.activeElement
    if (!active) return { ok: false, detail: { key: 'Enter', reason: 'NO_FOCUS' } }
    if (md.isSubmitter(active) || active.tagName === 'button' || (active.tagName === 'a' && active.hasAttribute('href'))) {
      performClick(page, active, { via: 'keyboard' })
      return { ok: true, detail: { key: 'Enter', activated: active.ref, selector: doc.cssPath(active) } }
    }
    if (md.isTextInput(active)) {
      const form = md.formOf(active)
      if (!form) return { ok: false, detail: { key: 'Enter', reason: 'NO_FORM' } }
      const submitted = form.dispatchEvent(md.createEvent('submit', { detail: { submitter: active.ref } }))
      return { ok: true, detail: { key: 'Enter', submitted: Boolean(submitted), form: form.ref } }
    }
    return { ok: false, detail: { key: 'Enter', reason: 'NO_DEFAULT_ACTION' } }
  }
  if (normalized === 'Backspace' || normalized === 'Delete') {
    const active = doc.activeElement
    if (!active || !md.isTextInput(active)) return { ok: false, detail: { key: normalized, reason: 'NO_TEXT_TARGET' } }
    const before = active.value
    const after = normalized === 'Backspace' ? active.deleteBackward() : active.deleteForward()
    if (before !== after) active.dispatchEvent(md.createEvent('input', { detail: { value: after } }))
    return { ok: true, detail: { key: normalized, value: after, changed: before !== after } }
  }
  if (normalized === 'ArrowLeft' || normalized === 'ArrowRight' || normalized === 'Home' || normalized === 'End') {
    const active = doc.activeElement
    if (!active || !md.isTextInput(active)) return { ok: false, detail: { key: normalized, reason: 'NO_TEXT_TARGET' } }
    const length = active.value.length
    if (normalized === 'Home') active.setSelectionRange(0, 0)
    else if (normalized === 'End') active.setSelectionRange(length, length)
    else if (normalized === 'ArrowLeft') active.setSelectionRange(Math.max(0, active.selectionStart - 1), Math.max(0, active.selectionStart - 1))
    else active.setSelectionRange(Math.min(length, active.selectionEnd + 1), Math.min(length, active.selectionEnd + 1))
    return { ok: true, detail: { key: normalized, caret: active.selectionStart } }
  }
  if (normalized === ' ' && doc.activeElement && doc.activeElement.tagName === 'input' && md.inputType(doc.activeElement) === 'checkbox') {
    doc.activeElement.checked = !doc.activeElement.checked
    md.fireValueEvents(doc, doc.activeElement)
    return { ok: true, detail: { key: ' ', toggled: doc.activeElement.ref, checked: doc.activeElement.checked } }
  }
  if (PRINTABLE_KEY.test(normalized) && !modifiers.includes('alt')) {
    const active = doc.activeElement
    if (!active || !md.isTextInput(active)) return { ok: false, detail: { key: normalized, reason: 'NO_TEXT_TARGET' } }
    active.insertText(normalized)
    active.dispatchEvent(md.createEvent('input', { detail: { value: active.value } }))
    return { ok: true, detail: { key: normalized, inserted: 1, value: active.value } }
  }
  return { ok: false, detail: { key: normalized, reason: 'UNSUPPORTED_KEY' } }
}

/** Nearest `data-cu-file` binding of the focused control. */
function findFileBinding(element) {
  let node = element
  while (node) {
    if (node.cu && node.cu.file) return { element: node, file: node.cu.file }
    node = node.parentNode
  }
  return null
}

// ------------------------------------------------------------------ vision ---

/** Fill an axis-aligned rect of an RGBA buffer. */
function fillRect(buffer, screen, rect, color, alpha = 1) {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(screen.width, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(screen.height, Math.ceil(rect.y + rect.height))
  for (let y = y0; y < y1; y += 1) {
    let offset = (y * screen.width + x0) * 4
    for (let x = x0; x < x1; x += 1) {
      buffer[offset] = alpha >= 1 ? color[0] : Math.round(color[0] * alpha + buffer[offset] * (1 - alpha))
      buffer[offset + 1] = alpha >= 1 ? color[1] : Math.round(color[1] * alpha + buffer[offset + 1] * (1 - alpha))
      buffer[offset + 2] = alpha >= 1 ? color[2] : Math.round(color[2] * alpha + buffer[offset + 2] * (1 - alpha))
      buffer[offset + 3] = 255
      offset += 4
    }
  }
}

/** Mix a colour towards white, for the title bar. */
function lighten(color, amount) {
  return [
    Math.round(color[0] + (255 - color[0]) * amount),
    Math.round(color[1] + (255 - color[1]) * amount),
    Math.round(color[2] + (255 - color[2]) * amount)
  ]
}

function cropBuffer(source, screen, rect) {
  const width = Math.max(0, Math.round(rect.width))
  const height = Math.max(0, Math.round(rect.height))
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.round(rect.y) + y
    if (sourceY < 0 || sourceY >= screen.height) continue
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.round(rect.x) + x
      if (sourceX < 0 || sourceX >= screen.width) continue
      const from = (sourceY * screen.width + sourceX) * 4
      const to = (y * width + x) * 4
      out[to] = source[from]
      out[to + 1] = source[from + 1]
      out[to + 2] = source[from + 2]
      out[to + 3] = source[from + 3]
    }
  }
  return out
}

/**
 * Render the virtual screen into an RGBA buffer: desktop, pages that are not
 * hosted by a window, then every window back to front.
 */
function renderScreen(ctx) {
  const screen = ctx.screen
  const buffer = Buffer.alloc(screen.width * screen.height * 4)
  fillRect(buffer, screen, screen, DESKTOP_PAINT)
  for (const page of ctx.browser.pages) {
    if (page.windowHandle || page.__state.closed) continue
    drawPageInto(ctx, buffer, page, page.hostRect())
  }
  for (const handle of ctx.order) {
    drawWindow(ctx, buffer, findWindow(ctx, handle))
  }
  return buffer
}

/** Paint one page's shapes, clipped to its host rect. */
function drawPageInto(ctx, buffer, page, content) {
  const screen = ctx.screen
  fillRect(buffer, screen, content, PAGE_PAINT)
  for (const shape of pageShapes(page, content)) {
    const rect = clipRect(shape.rect, content)
    if (rect.width <= 0 || rect.height <= 0) continue
    fillRect(buffer, screen, rect, shape.color, shape.alpha === undefined ? 1 : shape.alpha)
  }
}

function drawWindow(ctx, buffer, window) {
  if (!window || !window.visible || window.minimized) return
  const screen = ctx.screen
  fillRect(buffer, screen, window.bounds, window.paint)
  fillRect(buffer, screen, { x: window.bounds.x, y: window.bounds.y, width: window.bounds.width, height: TITLE_BAR_HEIGHT }, lighten(window.paint, 0.3))
  const page = window.pageId ? ctx.browser.page(window.pageId) : null
  if (!page) return
  drawPageInto(ctx, buffer, page, contentBounds(window))
}

/** Painted boxes of one page, in painter order, in screen coordinates. */
function pageShapes(page, content) {
  const doc = page.document
  doc.ensureLayout()
  const shapes = []
  const background = doc.body && doc.body.style.background ? doc.body.style.background : PAGE_PAINT
  shapes.push({ rect: { ...content }, color: background })
  for (const el of doc.elements()) {
    if (!el.visible) continue
    const box = el.bbox
    if (box.width <= 0 || box.height <= 0) continue
    const color = el.style.background || ROLE_PALETTE[md.roleOf(el)] || ROLE_PALETTE.generic
    const opacity = el.style.opacity === null || el.style.opacity === undefined ? 1 : Math.max(0, Math.min(1, el.style.opacity))
    shapes.push({ rect: toScreenRect(content, box), color, alpha: opacity })
    const paint = el.cu ? el.cu.paint : null
    if (paint && el.tagName === 'canvas') {
      shapes.push({
        rect: {
          x: content.x + box.x,
          y: content.y + box.y,
          width: paint.width === null ? box.width : paint.width,
          height: paint.height === null ? box.height : paint.height
        },
        color: paint.color,
        alpha: 1
      })
    }
  }
  if (pageDialog(page)) {
    shapes.push({ rect: { ...content }, color: OVERLAY_PAINT, alpha: 0.45 })
    shapes.push({
      rect: {
        x: content.x + Math.round((content.width - MODAL_WIDTH) / 2),
        y: content.y + Math.round((content.height - MODAL_HEIGHT) / 2),
        width: MODAL_WIDTH,
        height: MODAL_HEIGHT
      },
      color: ROLE_PALETTE.dialog,
      alpha: 1
    })
  }
  return shapes
}

/**
 * The screenshot port: a real PNG of the virtual screen.
 *
 * @param {object} ctx device context
 */
function createScreenshot(ctx) {
  const screen = ctx.screen
  const capture = (rect) => {
    guardDevice(ctx)
    const clamped = clipRect(
      { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      screen
    )
    const full = renderScreen(ctx)
    const data = cropBuffer(full, screen, clamped)
    const buffer = png.encodePng({
      width: Math.max(1, clamped.width),
      height: Math.max(1, clamped.height),
      data,
      channels: 4
    })
    return {
      png: buffer,
      width: clamped.width,
      height: clamped.height,
      rect: clamped,
      backend: 'device',
      capturedAt: ctx.clock.now()
    }
  }
  return {
    probe: () => ({
      available: true,
      reason: null,
      detail: { port: 'screenshot', backend: 'device', renderer: 'virtual-buffer', screen: { ...screen } }
    }),
    captureRegion(rect) {
      if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
        throw fail(CODES.SCREENSHOT_FAILED, 'captureRegion needs a rect', { rect })
      }
      return capture(rect)
    },
    captureWindow(handle) {
      const window = findWindow(ctx, handle)
      if (!window) throw fail(CODES.TARGET_NOT_FOUND, `no such window: ${handle}`, { handle })
      return { ...capture(window.bounds), window: handle }
    },
    captureFull() {
      return capture(screen)
    }
  }
}

// ---------------------------------------------------------- accessibility ---

/**
 * The accessibility driver: window nodes plus the page AX trees, with bounds in
 * screen coordinates (as a real UI Automation client sees them).
 *
 * @param {object} ctx device context
 */
function createAccessibility(ctx) {
  const desktopNode = () => ({
    ref: 'display:root',
    role: 'desktop',
    name: 'Virtual desktop',
    enabled: true,
    focusable: false,
    focused: false,
    offscreen: false,
    bounds: { ...ctx.screen },
    patterns: [],
    children: ctx.order
      .slice()
      .reverse()
      .map((handle) => windowAxNode(ctx, findWindow(ctx, handle), handle === ctx.order[ctx.order.length - 1]))
  })
  const port = {
    probe: () => ({ available: true, reason: null, detail: { port: 'accessibility', backend: 'device', screen: { ...ctx.screen } } }),
    root() {
      guardDevice(ctx)
      return desktopNode()
    },
    children(ref) {
      guardDevice(ctx)
      const node = findInTree(desktopNode(), ref)
      return node && node.children ? node.children : []
    },
    /**
     * Find accessibility nodes.
     *
     * @param {{ref?: string, role?: string, name?: string|RegExp, window?: string, pageId?: string, max?: number}|string} query
     */
    find(query = {}) {
      guardDevice(ctx)
      const spec = typeof query === 'string' ? { role: query } : query
      const max = Number.isFinite(spec.max) ? spec.max : 200
      if (spec.ref) {
        const found = findInTree(desktopNode(), spec.ref)
        return found ? [found] : []
      }
      const roots = []
      for (const window of desktopNode().children) {
        if (spec.window && window.ref !== spec.window) continue
        if (spec.pageId && window.pageId !== spec.pageId) continue
        roots.push(window)
      }
      for (const page of ctx.browser.pages) {
        if (page.windowHandle) continue
        if (spec.pageId && page.id !== spec.pageId) continue
        const content = page.hostRect()
        for (const el of page.document.controls()) roots.push(axNode(page, el, content, 0))
      }
      const out = []
      const visit = (node) => {
        if (out.length >= max) return
        if (matchesAxQuery(node, spec)) out.push(node)
        for (const child of node.children || []) visit(child)
      }
      for (const root of roots) visit(root)
      return out
    },
    invoke(ref) {
      guardDevice(ctx)
      const resolved = resolveAxRef(ctx, ref)
      if (!resolved) throw fail(CODES.TARGET_STALE, `accessibility ref is stale: ${ref}`, { ref })
      if (resolved.kind === 'window') return ctx.desktop.focusWindow(resolved.handle)
      if (resolved.kind === 'desktop') return { ok: false, detail: { reason: 'NOT_INVOKABLE', ref } }
      const role = md.roleOf(resolved.element)
      if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'option') {
        const receipt = resolved.page.clickElement(resolved.element.ref)
        return { ok: true, detail: { action: 'invoke', role, ...receipt.detail } }
      }
      const receipt = port.focus(ref)
      return { ok: true, detail: { action: 'focus', role, ...receipt.detail } }
    },
    setValue(ref, value) {
      guardDevice(ctx)
      const resolved = resolveAxRef(ctx, ref)
      if (!resolved) throw fail(CODES.TARGET_STALE, `accessibility ref is stale: ${ref}`, { ref })
      if (resolved.kind !== 'element') throw fail(CODES.ACTION_UNSUPPORTED, 'setValue needs an element node', { ref })
      const receipt = resolved.page.setValue(resolved.element.ref, value)
      return { ok: true, detail: receipt.detail }
    },
    focus(ref) {
      guardDevice(ctx)
      const resolved = resolveAxRef(ctx, ref)
      if (!resolved) throw fail(CODES.TARGET_STALE, `accessibility ref is stale: ${ref}`, { ref })
      if (resolved.kind === 'window') return ctx.desktop.focusWindow(resolved.handle)
      if (resolved.kind === 'desktop') return { ok: false, detail: { reason: 'NOT_FOCUSABLE', ref } }
      const receipt = resolved.page.focusElement(resolved.element.ref)
      return { ok: true, detail: receipt.detail }
    },
    value(ref) {
      guardDevice(ctx)
      const resolved = resolveAxRef(ctx, ref)
      if (!resolved) throw fail(CODES.TARGET_STALE, `accessibility ref is stale: ${ref}`, { ref })
      if (resolved.kind !== 'element') return null
      return resolved.element.value
    }
  }
  return port
}

function windowAxNode(ctx, window, foreground) {
  const page = window.pageId ? ctx.browser.page(window.pageId) : null
  const children = []
  if (page) {
    const content = contentBounds(window)
    for (const el of page.document.controls()) children.push(axNode(page, el, content, 0))
  }
  return {
    ref: window.handle,
    handle: window.handle,
    role: 'window',
    name: window.title,
    className: window.className,
    processId: window.processId,
    enabled: true,
    focusable: true,
    focused: Boolean(foreground),
    offscreen: false,
    bounds: { ...window.bounds },
    contentBounds: contentBounds(window),
    pageId: window.pageId,
    patterns: ['focus', 'window'],
    children
  }
}

function matchesAxQuery(node, spec) {
  if (spec.role && String(node.role) !== String(spec.role)) return false
  if (spec.name !== undefined && spec.name !== null) {
    if (spec.name instanceof RegExp) {
      if (!spec.name.test(node.name || '')) return false
    } else if (String(node.name || '') !== String(spec.name)) {
      return false
    }
  }
  return true
}

function findInTree(node, ref) {
  if (!node) return null
  if (node.ref === ref || node.handle === ref) return node
  for (const child of node.children || []) {
    const found = findInTree(child, ref)
    if (found) return found
  }
  return null
}

/** Resolve an AX ref to a window, the desktop, or a live page element. */
function resolveAxRef(ctx, ref) {
  if (ref === 'display:root') return { kind: 'desktop' }
  if (typeof ref !== 'string') return null
  if (/^w\d+$/.test(ref)) {
    const window = findWindow(ctx, ref)
    return window ? { kind: 'window', handle: ref, window } : null
  }
  if (/^e\d+$/.test(ref)) {
    for (const page of ctx.browser.pages) {
      const element = page.document.byRef(ref)
      if (element) return { kind: 'element', page, element }
    }
    return null
  }
  return null
}

// ------------------------------------------------------------------ device ---

/**
 * Create a virtual computer.
 *
 * @param {object} [options]
 * @param {number} [options.startTime] virtual clock start (default 0)
 * @param {() => number} [options.now] inject to switch the clock to realtime mode
 * @param {(ms:number) => Promise<void>} [options.sleep]
 * @param {{x?:number,y?:number,width?:number,height?:number}} [options.screen]
 * @param {string} [options.fsRoot] virtual filesystem root (default '/workspace')
 * @returns {object} device
 */
function createDevice(options = {}) {
  const clock = createDeviceClock(options)
  const events = createEventLog({ clock })
  const files = createVirtualFs({ clock, root: options.fsRoot || '/workspace' })
  const clipboard = createClipboard({ events })
  const ctx = {
    options,
    clock,
    events,
    files,
    clipboard,
    screen: { ...DEFAULT_SCREEN, ...(options.screen || {}) },
    windows: [],
    order: [],
    disposed: false,
    browser: null,
    desktop: null,
    accessibility: null,
    screenshotPort: null
  }
  ctx.browser = createBrowser(ctx)
  ctx.desktop = createDesktop(ctx)
  ctx.accessibility = createAccessibility(ctx)
  ctx.screenshotPort = createScreenshot(ctx)

  const device = {
    clock,
    screen: { ...ctx.screen },
    pages: ctx.browser.pages,
    page: (id) => ctx.browser.page(id),
    openPage: (fixture, pageOptions) => ctx.browser.openPage(fixture, pageOptions),
    desktop: ctx.desktop,
    accessibility: ctx.accessibility,
    screenshot: ctx.screenshotPort,
    files,
    clipboard: {
      read: () => clipboard.read(),
      write: (text) => clipboard.write(text),
      get text() {
        return clipboard.read()
      }
    },
    events,
    /** Virtual windows, in z-order (foreground first). */
    get windows() {
      return ctx.desktop.listWindows()
    },
    /** One virtual process per window; there is no real process behind them. */
    get processes() {
      return ctx.windows.map((window) => ({
        processId: window.processId,
        name: window.className,
        title: window.title,
        windowHandle: window.handle,
        alive: true
      }))
    },
    /** Close the window owned by a virtual process. */
    killProcess(processId) {
      const window = ctx.windows.find((item) => item.processId === Number(processId))
      if (!window) return { ok: false, detail: { reason: 'NO_SUCH_PROCESS', processId } }
      return ctx.desktop.closeWindow(window.handle)
    },
    /** A whole-machine observation, useful for assertions and debugging. */
    snapshot() {
      guardDevice(ctx)
      return {
        at: clock.now(),
        screen: { ...ctx.screen },
        cursor: ctx.desktop.cursorPosition(),
        foregroundWindow: ctx.desktop.foregroundWindow(),
        windows: ctx.desktop.listWindows(),
        pages: ctx.browser.pages.map((page) => page.snapshot()),
        clipboard: clipboard.read(),
        files: files.list('/'),
        pendingTimers: clock.pendingCount(),
        disposed: ctx.disposed
      }
    },
    dispose() {
      if (ctx.disposed) return
      for (const page of ctx.browser.pages.slice()) {
        cancelPageTimers(page)
        page.__state.closed = true
      }
      ctx.disposed = true
      ctx.order.length = 0
      ctx.windows.length = 0
      events.push({ type: 'device_disposed', detail: { pages: ctx.browser.pages.length } })
    }
  }
  ctx.device = device
  return device
}

module.exports = {
  createDevice,
  loadFixture,
  FIXTURE_DIR,
  TITLE_BAR_HEIGHT,
  DEFAULT_SCREEN,
  DEFAULT_VIEWPORT,
  DEFAULT_WINDOW_BOUNDS,
  ROLE_PALETTE
}
