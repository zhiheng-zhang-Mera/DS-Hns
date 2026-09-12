'use strict'

/**
 * Test helper: a compact, dependency-free DOM subset for the in-process
 * computer-use device (see computer-use-device.cjs).
 *
 * Scope, deliberately:
 *
 *  - It parses the fixture documents and models *real* state: a tree, attributes,
 *    control values, focus, a mutation revision and a resolved layout. Actions
 *    change that state, and every observation is derived from it. Nothing here
 *    answers a question from a canned table.
 *  - It is not a browser. There is no CSS cascade (only the `style` attribute),
 *    no capturing listeners, no user-agent stylesheet (no default margins), no
 *    timers and no I/O. Those omissions are what keep it deterministic.
 *
 * Layout metrics (fixtures are authored against these numbers; 8 px per
 * character is the font metric):
 *
 *  - CHAR_WIDTH = 8 px per character of collapsed text.
 *  - LINE_HEIGHT = 20 px per line box.
 *  - Block elements are as wide as their parent's content box unless `style`
 *    sets `width`; their children stack vertically. Inline elements and form
 *    controls flow left to right on a line box and wrap at the content edge.
 *  - Content boxes have no padding or border. Form controls reserve
 *    CONTROL_PADDING = 8 px on each side for their own text.
 *  - Default sizes: input = 20 chars x 1 line, textarea = 20 chars x 2 rows,
 *    checkbox/radio = 16 x 16, button = label + 2 * CONTROL_PADDING,
 *    select = longest option + 2 * CONTROL_PADDING, canvas/img = the
 *    `width`/`height` attributes (or 0).
 *  - `position: absolute|fixed` places the element at its containing block's
 *    origin plus `left`/`top` in px; it does not take part in the normal flow.
 *    The containing block is the nearest ancestor with a non-static position,
 *    otherwise the document origin (0, 0).
 *  - `getBoundingClientRect()`/`bbox` are viewport coordinates: the page
 *    position minus `scrollX`/`scrollY`.
 *
 * Visibility: an element is not visible when it (or an ancestor) is
 * `display: none`, has the `hidden` attribute, or combines `opacity: 0` with
 * `visibility: hidden`. `opacity: 0` alone stays visible, exactly as a browser
 * keeps it hit-testable.
 */

const CHAR_WIDTH = 8
const LINE_HEIGHT = 20
const CONTROL_PADDING = 8
const CHECKBOX_SIZE = 16
const DEFAULT_COLS = 20
const DEFAULT_ROWS = 2
const MAX_MUTATIONS = 1000

/** Tags that never have children in HTML. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])

/** Tags whose content is raw text, not markup. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea'])

/** Tags a browser never renders; they take no space and are not visible. */
const NON_RENDERED_TAGS = new Set([
  'head', 'title', 'meta', 'link', 'base', 'script', 'style', 'template', 'param', 'source', 'track', 'datalist', 'noscript'
])

const BLOCK_TAGS = new Set([
  'html', 'body', 'div', 'p', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'form',
  'fieldset', 'legend', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'blockquote', 'pre', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dialog', 'address',
  'details', 'summary', 'canvas', 'video', 'audio', 'hr', 'output'
])

const TEXT_INPUT_TYPES = new Set(['text', 'password', 'email', 'search', 'tel', 'url', 'number', 'date', 'time'])

const NAMED_COLORS = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192]
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

let SERIAL = 0

/** Monotonic element serial. Refs are never reused, so a stale ref cannot rebind. */
function nextSerial() {
  SERIAL += 1
  return SERIAL
}

/** Collapse whitespace the way a browser collapses it inside a text run. */
function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, ' ')
}

/** Collapse + trim + drop newlines; the browser's innerText shape for one node. */
function normalizeText(text) {
  return String(text)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Decode the five named entities plus numeric references. */
function decodeEntities(text) {
  return String(text).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      if (code >= 0xd800 && code <= 0xdfff) return match
      return String.fromCodePoint(code)
    }
    const named = ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

/** Parse `#rgb`, `#rrggbb`, `rgb(r,g,b)` or a small set of colour names. */
function parseColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  if (text[0] === '#') {
    const hex = text.slice(1)
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)]
    }
    if (hex.length === 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    }
    return null
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return NAMED_COLORS[text] ? NAMED_COLORS[text].slice() : null
}

/** Parse a px length; unit-less numbers and `px` are accepted, anything else is null. */
function parseLength(value) {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  const match = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(text)
  if (!match) return null
  return Number(match[1])
}

/** Parse the `style` attribute into the hints the layout engine needs. */
function parseStyle(text) {
  const out = {
    cssText: typeof text === 'string' ? text : '',
    display: null,
    visibility: null,
    opacity: null,
    position: null,
    width: null,
    height: null,
    left: null,
    top: null,
    background: null,
    color: null,
    pointerEvents: null
  }
  for (const declaration of out.cssText.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    switch (name) {
      case 'display': out.display = value.toLowerCase(); break
      case 'visibility': out.visibility = value.toLowerCase(); break
      case 'opacity': out.opacity = Number(value); break
      case 'position': out.position = value.toLowerCase(); break
      case 'width': out.width = parseLength(value); break
      case 'height': out.height = parseLength(value); break
      case 'left': out.left = parseLength(value); break
      case 'top': out.top = parseLength(value); break
      case 'background':
      case 'background-color': out.background = parseColor(value); break
      case 'color': out.color = parseColor(value); break
      case 'pointer-events': out.pointerEvents = value.toLowerCase(); break
      default: break
    }
  }
  return out
}

/** Parse `data-cu-paint="label|color|width|height"` into a paint instruction. */
function parsePaint(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return null
  const parts = spec.split('|').map((part) => part.trim())
  const color = parseColor(parts.length > 1 ? parts[1] : parts[0])
  if (!color) return null
  const width = parts.length > 2 ? parseLength(parts[2]) : null
  const height = parts.length > 3 ? parseLength(parts[3]) : null
  return {
    label: parts.length > 1 ? parts[0] : '',
    color,
    width: width === null ? null : Math.max(0, width),
    height: height === null ? null : Math.max(0, height),
    spec
  }
}

function isElement(node) {
  return Boolean(node) && node.nodeType === 1
}

function isTextNode(node) {
  return Boolean(node) && node.nodeType === 3
}

function isBlockTag(tagName) {
  return BLOCK_TAGS.has(tagName)
}

function isTextInput(el) {
  if (el.tagName === 'textarea') return true
  if (el.tagName !== 'input') return false
  return TEXT_INPUT_TYPES.has(inputType(el))
}

function inputType(el) {
  return String(el.getAttribute('type') || 'text').toLowerCase()
}

/** The `<form>` an element belongs to (nearest ancestor form). */
function formOf(el) {
  let node = el
  while (node) {
    if (isElement(node) && node.tagName === 'form') return node
    node = node.parentNode
  }
  return null
}

/** The control a `<label>` points at, by `for` or by nesting. */
function labelControl(label) {
  const target = label.getAttribute('for')
  if (target) {
    const found = label.ownerDocument.getElementById(target)
    if (found) return found
  }
  let node = label.firstElementChild
  while (node) {
    if (node.tagName === 'input' || node.tagName === 'textarea' || node.tagName === 'select' || node.tagName === 'button') return node
    const nested = node.querySelector('input, textarea, select, button')
    if (nested) return nested
    node = node.nextElementSibling
  }
  return null
}

/** True when the element is a button that submits the surrounding form. */
function isSubmitter(el) {
  const tag = el.tagName
  if (tag === 'button') {
    const type = String(el.getAttribute('type') || 'submit').toLowerCase()
    return type === 'submit'
  }
  if (tag === 'input') {
    const type = inputType(el)
    return type === 'submit' || type === 'image'
  }
  return false
}

/** Tag + ARIA derived accessibility role (documented mapping). */
function roleOf(el) {
  const explicit = el.getAttribute('role')
  if (explicit) return String(explicit).toLowerCase()
  const tag = el.tagName
  switch (tag) {
    case 'a': return el.hasAttribute('href') ? 'link' : 'generic'
    case 'button': return 'button'
    case 'textarea': return 'textbox'
    case 'select': return el.getAttribute('multiple') !== null ? 'listbox' : 'combobox'
    case 'option': return 'option'
    case 'form': return 'form'
    case 'nav': return 'navigation'
    case 'main': return 'main'
    case 'header': return 'banner'
    case 'footer': return 'contentinfo'
    case 'ul':
    case 'ol': return 'list'
    case 'li': return 'listitem'
    case 'table': return 'table'
    case 'img': return 'img'
    case 'canvas': return 'canvas'
    case 'dialog': return 'dialog'
    case 'output': return 'status'
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': return 'heading'
    case 'label': return 'label'
    case 'p': return 'paragraph'
    case 'input': {
      const type = inputType(el)
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button'
      if (type === 'range') return 'slider'
      if (type === 'hidden') return 'generic'
      return 'textbox'
    }
    default: return isBlockTag(tag) ? 'generic' : 'text'
  }
}

function isInteractive(el) {
  const tag = el.tagName
  if (tag === 'a') return el.hasAttribute('href')
  if (tag === 'button' || tag === 'textarea' || tag === 'select') return true
  if (tag === 'input') return inputType(el) !== 'hidden'
  if (el.hasAttribute('tabindex')) return true
  const role = el.getAttribute('role')
  return role === 'button' || role === 'link' || role === 'textbox' || role === 'checkbox' || role === 'radio' || role === 'combobox'
}

/**
 * Create a document from an HTML string.
 *
 * @param {object} [options]
 * @param {string} [options.html]        markup to parse (a fragment is fine)
 * @param {string} [options.url]         document URL
 * @param {string|null} [options.title]  override the `<title>` text
 * @param {{width:number,height:number}} [options.viewport]
 * @param {number} [options.revision]    first revision counter value
 * @returns {object} document
 */
function createDocument(options = {}) {
  const doc = new MiniDocument(options)
  return doc
}

class MiniTextNode {
  constructor(doc, text) {
    this.ownerDocument = doc
    this.nodeType = 3
    this.nodeValue = String(text)
    this.parentNode = null
    this.__rect = { x: 0, y: 0, width: 0, height: 0 }
  }

  get textContent() {
    return this.nodeValue
  }

  set textContent(value) {
    this.nodeValue = String(value)
    this.ownerDocument.touch({ type: 'text', target: this })
  }

  get parentElement() {
    return isElement(this.parentNode) ? this.parentNode : null
  }

  /** Text nodes report their laid-out box once the document has been laid out. */
  get bbox() {
    this.ownerDocument.ensureLayout()
    return { ...this.__rect }
  }
}

class MiniElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc
    this.nodeType = 1
    this.tagName = String(tagName).toLowerCase()
    this.parentNode = null
    this.__attrs = Object.create(null)
    this.__children = []
    this.__listeners = new Map()
    this.__rect = { x: 0, y: 0, width: 0, height: 0 }
    this.__style = null
    this.__cu = null
    this.__value = undefined
    this.__valueDirty = false
    this.__selectionStart = 0
    this.__selectionEnd = 0
    this.__ref = `e${nextSerial()}`
    doc.__registry.set(this.__ref, this)
  }

  // ------------------------------------------------------------- identity ---

  get ref() {
    return this.__ref
  }

  get nodeName() {
    return this.tagName.toUpperCase()
  }

  get id() {
    return this.getAttribute('id') || ''
  }

  set id(value) {
    this.setAttribute('id', value)
  }

  get className() {
    return this.getAttribute('class') || ''
  }

  set className(value) {
    this.setAttribute('class', value)
  }

  get classList() {
    return createClassList(this)
  }

  /** A copy of the attribute map; writes go through setAttribute/removeAttribute. */
  get attributes() {
    return { ...this.__attrs }
  }

  getAttribute(name) {
    const key = String(name).toLowerCase()
    return Object.prototype.hasOwnProperty.call(this.__attrs, key) ? this.__attrs[key] : null
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.__attrs, String(name).toLowerCase())
  }

  setAttribute(name, value) {
    const key = String(name).toLowerCase()
    if (value === null || value === undefined) {
      this.removeAttribute(key)
      return
    }
    const text = String(value)
    this.__attrs[key] = text
    this.__style = null
    this.__cu = null
    this.ownerDocument.invalidateLayout()
    if (key === 'value' && !this.__valueDirty && (this.tagName === 'input' || this.tagName === 'textarea')) {
      this.__value = text
    }
    this.ownerDocument.touch({ type: 'attribute', target: this, name: key, value: text })
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(this.__attrs, key)) return
    delete this.__attrs[key]
    this.__style = null
    this.__cu = null
    this.ownerDocument.invalidateLayout()
    this.ownerDocument.touch({ type: 'attribute', target: this, name: key, value: null })
  }

  // --------------------------------------------------------------- tree ----

  get childNodes() {
    return this.__children.slice()
  }

  get children() {
    return this.__children.filter(isElement)
  }

  get parent() {
    return isElement(this.parentNode) ? this.parentNode : null
  }

  get parentElement() {
    return this.parent
  }

  get firstChild() {
    return this.__children.length ? this.__children[0] : null
  }

  get lastChild() {
    return this.__children.length ? this.__children[this.__children.length - 1] : null
  }

  get firstElementChild() {
    return this.children.length ? this.children[0] : null
  }

  get nextElementSibling() {
    const parent = this.parentNode
    if (!parent) return null
    const list = parent.__children.filter(isElement)
    const index = list.indexOf(this)
    return index >= 0 && index + 1 < list.length ? list[index + 1] : null
  }

  appendChild(child) {
    if (!child) return child
    if (isElement(child) && this.tagName !== 'html' && this.tagName !== 'body') {
      // A device-created overlay must be able to cover the page; nesting is
      // otherwise free-form, so only self-nesting is rejected.
      if (child === this) throw new Error('cannot append an element to itself')
    }
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.__children.push(child)
    this.ownerDocument.invalidateLayout()
    this.ownerDocument.touch({ type: 'childList', target: this, name: 'append', value: isElement(child) ? child.tagName : '#text' })
    return child
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child)
    const index = this.__children.indexOf(reference)
    if (index < 0) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.__children.splice(index, 0, child)
    this.ownerDocument.invalidateLayout()
    this.ownerDocument.touch({ type: 'childList', target: this, name: 'insertBefore', value: isElement(child) ? child.tagName : '#text' })
    return child
  }

  removeChild(child) {
    const index = this.__children.indexOf(child)
    if (index < 0) return child
    this.__children.splice(index, 1)
    child.parentNode = null
    if (isElement(child)) this.ownerDocument.unregister(child)
    this.ownerDocument.invalidateLayout()
    this.ownerDocument.touch({ type: 'childList', target: this, name: 'remove', value: isElement(child) ? child.tagName : '#text' })
    return child
  }

  /** Detach this element from its parent. */
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  /** Replace every child with one text node. */
  setText(text) {
    const doc = this.ownerDocument
    for (const child of this.__children) {
      child.parentNode = null
      if (isElement(child)) doc.unregister(child)
    }
    this.__children = []
    if (text !== undefined && text !== null && String(text) !== '') {
      const node = new MiniTextNode(doc, text)
      node.parentNode = this
      this.__children.push(node)
    }
    doc.invalidateLayout()
    doc.touch({ type: 'text', target: this, name: 'setText', value: text === undefined ? null : String(text) })
  }

  get textContent() {
    let out = ''
    for (const child of this.__children) {
      out += isTextNode(child) ? child.nodeValue : child.textContent
    }
    return out
  }

  set textContent(value) {
    this.setText(value)
  }

  /**
   * Browser-shaped innerText: rendered text only, block children separated by a
   * newline, whitespace collapsed, result trimmed.
   */
  get innerText() {
    if (!this.visible) return ''
    return normalizeText(innerTextOf(this))
  }

  set innerText(value) {
    this.setText(value)
  }

  // ---------------------------------------------------------- form state ---

  get value() {
    const tag = this.tagName
    if (tag === 'textarea') return this.__value === undefined ? this.textContent : String(this.__value)
    if (tag === 'select') {
      const option = selectedOption(this)
      return option ? optionValue(option) : ''
    }
    if (tag === 'option') return optionValue(this)
    if (tag === 'input') {
      const type = inputType(this)
      if (type === 'checkbox' || type === 'radio') return this.getAttribute('value') === null ? 'on' : this.getAttribute('value')
      if (type === 'submit' || type === 'button' || type === 'reset') return this.getAttribute('value') || ''
      return this.__value === undefined ? (this.getAttribute('value') || '') : String(this.__value)
    }
    return this.getAttribute('value') || ''
  }

  set value(next) {
    const text = next === null || next === undefined ? '' : String(next)
    const tag = this.tagName
    if (tag === 'select') {
      selectValue(this, text)
      return
    }
    if (tag === 'option') {
      this.setAttribute('value', text)
      return
    }
    if (tag === 'input' && (inputType(this) === 'checkbox' || inputType(this) === 'radio')) {
      this.setAttribute('value', text)
      return
    }
    this.__value = text
    this.__valueDirty = true
    this.__selectionStart = text.length
    this.__selectionEnd = text.length
    this.ownerDocument.touch({ type: 'value', target: this, name: 'value', value: text })
  }

  get checked() {
    return this.hasAttribute('checked')
  }

  set checked(next) {
    if (next) this.setAttribute('checked', 'checked')
    else this.removeAttribute('checked')
    this.ownerDocument.touch({ type: 'checked', target: this, name: 'checked', value: Boolean(next) })
  }

  get disabled() {
    return this.hasAttribute('disabled') || String(this.getAttribute('aria-disabled') || '') === 'true'
  }

  set disabled(next) {
    if (next) this.setAttribute('disabled', 'disabled')
    else this.removeAttribute('disabled')
  }

  get hidden() {
    return this.hasAttribute('hidden')
  }

  set hidden(next) {
    if (next) this.setAttribute('hidden', 'hidden')
    else this.removeAttribute('hidden')
  }

  setSelectionRange(start, end) {
    const length = this.value.length
    const from = Math.max(0, Math.min(length, Number(start) || 0))
    const to = Math.max(from, Math.min(length, end === undefined ? from : Number(end) || 0))
    this.__selectionStart = from
    this.__selectionEnd = to
  }

  get selectionStart() {
    return Math.min(this.__selectionStart, this.value.length)
  }

  set selectionStart(value) {
    this.setSelectionRange(value, Math.max(Number(value) || 0, this.__selectionEnd))
  }

  get selectionEnd() {
    return Math.min(this.__selectionEnd, this.value.length)
  }

  set selectionEnd(value) {
    this.setSelectionRange(Math.min(this.__selectionStart, Number(value) || 0), value)
  }

  /** Insert text at the caret, replacing the selection (a real value change). */
  insertText(text) {
    const current = this.value
    const start = this.selectionStart
    const end = this.selectionEnd
    const next = current.slice(0, start) + text + current.slice(end)
    this.__value = next
    this.__valueDirty = true
    this.__selectionStart = start + text.length
    this.__selectionEnd = this.__selectionStart
    this.ownerDocument.touch({ type: 'value', target: this, name: 'insertText', value: next })
    return next
  }

  /** Delete the selection, or one character backwards from the caret. */
  deleteBackward() {
    const current = this.value
    const start = this.selectionStart
    const end = this.selectionEnd
    if (start === end && start === 0) return current
    const from = start === end ? start - 1 : start
    const next = current.slice(0, from) + current.slice(end)
    this.__value = next
    this.__valueDirty = true
    this.__selectionStart = from
    this.__selectionEnd = from
    this.ownerDocument.touch({ type: 'value', target: this, name: 'deleteBackward', value: next })
    return next
  }

  /** Delete the selection, or one character forwards from the caret. */
  deleteForward() {
    const current = this.value
    const start = this.selectionStart
    const end = this.selectionEnd
    if (start === end && start >= current.length) return current
    const to = start === end ? start + 1 : end
    const next = current.slice(0, start) + current.slice(to)
    this.__value = next
    this.__valueDirty = true
    this.__selectionStart = start
    this.__selectionEnd = start
    this.ownerDocument.touch({ type: 'value', target: this, name: 'deleteForward', value: next })
    return next
  }

  // -------------------------------------------------------------- style ----

  /** Parsed `style` hints (display/visibility/opacity/position/size/left/top/colour). */
  get style() {
    if (!this.__style) this.__style = parseStyle(this.getAttribute('style'))
    return this.__style
  }

  set style(value) {
    if (value === null || value === undefined) this.removeAttribute('style')
    else this.setAttribute('style', String(value))
  }

  /** `data-cu-*` behaviour bag understood by the device (plus an `onclick` alias). */
  get cu() {
    if (!this.__cu) this.__cu = parseBehaviour(this)
    return this.__cu
  }

  // ------------------------------------------------------------- layout ----

  /** Viewport coordinates (page rect minus scroll offset). */
  get bbox() {
    const doc = this.ownerDocument
    doc.ensureLayout()
    const rect = this.__rect
    return {
      x: rect.x - (this.isFixed() ? 0 : doc.scrollX),
      y: rect.y - (this.isFixed() ? 0 : doc.scrollY),
      width: rect.width,
      height: rect.height
    }
  }

  /** Page coordinates, ignoring scroll. */
  get layoutRect() {
    this.ownerDocument.ensureLayout()
    return { ...this.__rect }
  }

  /** Rendered and not hidden by `display: none`, `hidden`, or opacity 0 + visibility hidden. */
  get visible() {
    return isElementVisible(this)
  }

  isFixed() {
    return this.style.position === 'fixed'
  }

  // ------------------------------------------------------------ queries ----

  matches(selector) {
    return matchesSelector(this, selector)
  }

  querySelector(selector) {
    const found = queryAll(this, selector, true)
    return found.length ? found[0] : null
  }

  querySelectorAll(selector) {
    return queryAll(this, selector, false)
  }

  getElementsByTagName(tagName) {
    const want = String(tagName).toLowerCase()
    return descendants(this).filter((el) => want === '*' || el.tagName === want)
  }

  // ------------------------------------------------------------- events ----

  addEventListener(type, listener, options = {}) {
    if (typeof listener !== 'function') return
    const key = String(type)
    if (!this.__listeners.has(key)) this.__listeners.set(key, [])
    this.__listeners.get(key).push({ listener, once: Boolean(options.once) })
  }

  removeEventListener(type, listener) {
    const list = this.__listeners.get(String(type))
    if (!list) return
    const index = list.findIndex((entry) => entry.listener === listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatchEvent(event) {
    return dispatchEventOn(this.ownerDocument, this, event)
  }

  /** Synthesise and dispatch a real click. */
  click() {
    return this.dispatchEvent(createEvent('click', { detail: { clickCount: 1 } }))
  }

  focus() {
    return this.ownerDocument.focusElement(this)
  }

  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.focusElement(null)
  }

  /** Is this element connected to a document (root reached)? */
  get isConnected() {
    let node = this
    while (node) {
      if (node === this.ownerDocument.root) return true
      node = node.parentNode
    }
    return false
  }
}

class MiniDocument {
  constructor(options = {}) {
    this.nodeType = 9
    this.__registry = new Map()
    this.__listeners = new Map()
    this.__mutations = []
    this.__mutationSeq = 0
    this.__mutationListeners = []
    this.__focusListeners = []
    this.__hooks = {}
    this.revision = Number(options.revision || 0)
    this.layoutRevision = -1
    this.url = options.url || 'about:blank'
    this.title = ''
    this.activeElement = null
    this.scrollX = 0
    this.scrollY = 0
    this.contentHeight = 0
    this.viewport = {
      x: 0,
      y: 0,
      width: (options.viewport && options.viewport.width) || 1024,
      height: (options.viewport && options.viewport.height) || 768
    }
    this.root = new MiniElement(this, '#document')
    this.root.nodeType = 9
    this.documentElement = null
    this.body = null
    this.head = null
    this.titleElement = null
    parseMarkup(this, options.html || '')
    if (!this.documentElement) this.documentElement = this.root
    if (!this.body) this.body = this.documentElement
    if (options.title !== undefined && options.title !== null) this.title = String(options.title)
  }

  get refCount() {
    return this.__registry.size
  }

  // ------------------------------------------------------------ mutation ---

  /** Record one real state change: bump the revision, keep the log, notify. */
  touch(mutation) {
    this.revision += 1
    this.__mutationSeq += 1
    const record = {
      seq: this.__mutationSeq,
      revision: this.revision,
      type: mutation.type,
      target: mutation.target && mutation.target.ref ? mutation.target.ref : null,
      selector: mutation.target ? this.cssPath(mutation.target) : null,
      name: mutation.name === undefined ? null : mutation.name,
      value: mutation.value === undefined ? null : mutation.value
    }
    this.__mutations.push(record)
    if (this.__mutations.length > MAX_MUTATIONS) this.__mutations.splice(0, this.__mutations.length - MAX_MUTATIONS)
    for (const listener of this.__mutationListeners.slice()) {
      try {
        listener(record)
      } catch {
        // A listener must never be able to corrupt the document.
      }
    }
    return record
  }

  /** Subscribe to mutation records; returns an unsubscribe function. */
  onMutation(listener) {
    if (typeof listener !== 'function') return () => {}
    this.__mutationListeners.push(listener)
    return () => {
      const index = this.__mutationListeners.indexOf(listener)
      if (index >= 0) this.__mutationListeners.splice(index, 1)
    }
  }

  get mutations() {
    return this.__mutations.slice()
  }

  /** Every mutation recorded after the given revision. */
  mutationsSince(revision) {
    const from = Number(revision) || 0
    return this.__mutations.filter((record) => record.revision > from).map((record) => ({ ...record }))
  }

  // -------------------------------------------------------------- lookup ---

  getElementById(id) {
    const want = String(id)
    for (const el of descendants(this.documentElement)) {
      if (el.getAttribute('id') === want) return el
    }
    if (isElement(this.documentElement) && this.documentElement.getAttribute('id') === want) return this.documentElement
    return null
  }

  querySelector(selector) {
    const found = queryAll(this.documentElement, selector, true)
    return found.length ? found[0] : null
  }

  querySelectorAll(selector) {
    return queryAll(this.documentElement, selector, false)
  }

  createElement(tagName) {
    return new MiniElement(this, tagName)
  }

  /** Child elements in document order. */
  elements() {
    return descendants(this.documentElement)
  }

  /** Interactive elements in document order. */
  controls() {
    return this.elements().filter(isInteractive)
  }

  /** Elements a Tab press can reach, in document order. */
  focusable() {
    return this.controls().filter((el) => {
      if (el.getAttribute('tabindex') === '-1') return false
      if (!el.visible) return false
      if (el.disabled) return false
      if (el.getAttribute('tabindex') !== null) return true
      return true
    })
  }

  /** Resolve a ref minted by this document; null when detached or foreign. */
  byRef(ref) {
    if (typeof ref !== 'string') return null
    const el = this.__registry.get(ref)
    if (!el) return null
    return el.isConnected ? el : null
  }

  unregister(el) {
    this.__registry.delete(el.ref)
    for (const child of el.__children) {
      child.parentNode = null
      if (isElement(child)) this.unregister(child)
    }
  }

  /** A selector that resolves back to this element, or null. */
  cssPath(el) {
    if (!isElement(el)) return null
    if (el === this.documentElement) return 'html'
    if (el === this.root) return null
    const id = el.getAttribute('id')
    if (id) return `#${id}`
    const parts = []
    let node = el
    while (node && node !== this.root) {
      const tag = node.tagName
      if (node === this.documentElement) {
        parts.unshift('html')
      } else {
        const parent = node.parentNode
        const siblings = parent ? parent.__children.filter((child) => isElement(child) && child.tagName === tag) : [node]
        const index = siblings.indexOf(node) + 1
        parts.unshift(siblings.length > 1 ? `${tag}:nth-child(${index})` : tag)
      }
      if (node === this.documentElement) break
      node = node.parentNode
    }
    const selector = parts.join(' > ')
    return selector || null
  }

  // -------------------------------------------------------------- layout ---

  invalidateLayout() {
    this.layoutRevision = -1
  }

  setViewport(viewport) {
    const width = Math.max(0, Number(viewport.width) || 0)
    const height = Math.max(0, Number(viewport.height) || 0)
    if (width === this.viewport.width && height === this.viewport.height) return
    this.viewport = { x: 0, y: 0, width, height }
    this.invalidateLayout()
  }

  /** Move the viewport offset; the scroll position is clamped to the content. */
  setScroll(x, y) {
    const maxX = Math.max(0, this.maxScrollX())
    const maxY = Math.max(0, this.maxScrollY())
    const nextX = Math.max(0, Math.min(maxX, Number(x) || 0))
    const nextY = Math.max(0, Math.min(maxY, Number(y) || 0))
    if (nextX === this.scrollX && nextY === this.scrollY) return false
    this.scrollX = nextX
    this.scrollY = nextY
    this.touch({ type: 'scroll', target: this.body, name: 'scroll', value: `${nextX},${nextY}` })
    return true
  }

  maxScrollX() {
    return Math.max(0, this.contentWidth() - this.viewport.width)
  }

  maxScrollY() {
    return Math.max(0, this.contentHeight - this.viewport.height)
  }

  contentWidth() {
    this.ensureLayout()
    return Math.max(this.viewport.width, this.documentElement.__rect.width)
  }

  ensureLayout() {
    if (this.layoutRevision === this.revision) return
    layoutDocument(this)
    this.layoutRevision = this.revision
  }

  /** Force a layout pass (used by fixtures that move a control after load). */
  relayout() {
    layoutDocument(this)
    this.layoutRevision = this.revision
    return this.contentHeight
  }

  /**
   * Topmost visible element at a viewport point (deepest, latest in DOM order),
   * skipping pointer-events:none and disabled form controls.
   */
  hitTest(x, y) {
    this.ensureLayout()
    let found = null
    for (const el of this.elements()) {
      if (!el.visible) continue
      if (el.style.pointerEvents === 'none') continue
      const rect = el.bbox
      if (rect.width <= 0 || rect.height <= 0) continue
      if (x < rect.x || y < rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) continue
      found = el
    }
    let node = found
    while (node && node.disabled) node = node.parentElement
    return node
  }

  // --------------------------------------------------------- focus/events ---

  /** Move focus (null clears it). Returns true when the focus moved. */
  focusElement(el) {
    if (el && !isElement(el)) return false
    if (el && (!el.isConnected || el.disabled || !el.visible)) return false
    const from = this.activeElement
    if (from === el) return false
    this.activeElement = el || null
    if (from) dispatchEventOn(this, from, createEvent('blur', { bubbles: false }))
    if (el) dispatchEventOn(this, el, createEvent('focus', { bubbles: false }))
    for (const listener of this.__focusListeners.slice()) {
      try {
        listener({ from, to: el || null })
      } catch {
        // focus listeners are advisory
      }
    }
    return true
  }

  onFocusChange(listener) {
    if (typeof listener !== 'function') return () => {}
    this.__focusListeners.push(listener)
    return () => {
      const index = this.__focusListeners.indexOf(listener)
      if (index >= 0) this.__focusListeners.splice(index, 1)
    }
  }

  /**
   * Install the device hooks. `onEventScript(event, path)` runs fixture
   * behaviour attributes during the bubble phase; `onSubmit(form, event)` and
   * `onNavigate(anchor, event)` receive the default actions the DOM cannot
   * perform itself.
   */
  setHooks(hooks = {}) {
    this.__hooks = { ...this.__hooks, ...hooks }
    return this.__hooks
  }

  get hooks() {
    return this.__hooks
  }

  addEventListener(type, listener, options = {}) {
    const key = String(type)
    if (!this.__listeners.has(key)) this.__listeners.set(key, [])
    this.__listeners.get(key).push({ listener, once: Boolean(options.once) })
  }

  removeEventListener(type, listener) {
    const list = this.__listeners.get(String(type))
    if (!list) return
    const index = list.findIndex((entry) => entry.listener === listener)
    if (index >= 0) list.splice(index, 1)
  }

  dispatchEvent(event) {
    return dispatchEventOn(this, this, event)
  }
}

// ------------------------------------------------------------------ events ---

/**
 * Create an event object. Bubbles and cancelable default to true, as they are
 * for the DOM events this subset models.
 */
function createEvent(type, options = {}) {
  const event = {
    type: String(type),
    bubbles: options.bubbles !== false,
    cancelable: options.cancelable !== false,
    defaultPrevented: false,
    stopped: false,
    target: null,
    currentTarget: null,
    detail: options.detail || {},
    key: options.key === undefined ? null : options.key,
    code: options.code === undefined ? null : options.code,
    modifiers: options.modifiers || [],
    button: options.button === undefined ? 'left' : options.button,
    clickCount: options.clickCount === undefined ? 1 : options.clickCount,
    isTrusted: false,
    preventDefault() {
      if (event.cancelable) event.defaultPrevented = true
    },
    stopPropagation() {
      event.stopped = true
    },
    stopImmediatePropagation() {
      event.stopped = true
    }
  }
  return event
}

function listenerList(node, type) {
  const map = node.__listeners
  return map ? map.get(type) : null
}

function callListener(entry, event) {
  if (typeof entry.listener === 'function') entry.listener.call(event.currentTarget, event)
  else if (entry.listener && typeof entry.listener.handleEvent === 'function') entry.listener.handleEvent(event)
}

/** Bubble path: target, its ancestors, the document container, then the document. */
function buildPath(target, doc) {
  const path = []
  let node = target
  while (node) {
    path.push(node)
    node = node.parentNode
  }
  if (doc && path[path.length - 1] !== doc) path.push(doc)
  return path
}

/** Dispatch an event through the bubble path, then run scripts and the default action. */
function dispatchEventOn(doc, target, event) {
  if (!event || typeof event.type !== 'string') throw new Error('dispatchEvent requires an event object')
  event.target = target
  event.stopped = false
  const path = buildPath(target, doc)
  for (const node of path) {
    if (event.stopped) break
    event.currentTarget = node
    const entries = listenerList(node, event.type)
    if (!entries || !entries.length) continue
    for (const entry of entries.slice()) {
      if (event.stopped) break
      if (entry.once) {
        const list = listenerList(node, event.type)
        const index = list ? list.indexOf(entry) : -1
        if (index >= 0) list.splice(index, 1)
      }
      callListener(entry, event)
    }
  }
  event.currentTarget = null
  const hooks = doc.__hooks || {}
  if (!event.defaultPrevented && typeof hooks.onEventScript === 'function') hooks.onEventScript(event, path)
  if (!event.defaultPrevented) applyDefaultAction(doc, event, hooks)
  return !event.defaultPrevented
}

/** The DOM-level consequences of an un-prevented event. */
function applyDefaultAction(doc, event, hooks) {
  const target = event.target
  if (!isElement(target)) return
  if (event.type === 'click') {
    const fromLabel = Boolean(event.detail && event.detail.fromLabel)
    if (target.tagName === 'label' && !fromLabel) {
      const control = labelControl(target)
      if (control) {
        dispatchEventOn(doc, control, createEvent('click', { detail: { fromLabel: true, clickCount: event.clickCount } }))
        return
      }
    }
    const tag = target.tagName
    const type = tag === 'input' ? inputType(target) : null
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      if (type === 'checkbox') {
        target.checked = !target.checked
      } else {
        target.checked = true
        uncheckRadioGroup(target)
      }
      fireValueEvents(doc, target)
      return
    }
    if (isSubmitter(target)) {
      const form = formOf(target)
      if (form) dispatchEventOn(doc, form, createEvent('submit', { detail: { submitter: target.ref } }))
      return
    }
    if (tag === 'a' && target.hasAttribute('href')) {
      if (typeof hooks.onNavigate === 'function') hooks.onNavigate(target, event)
    }
    return
  }
  if (event.type === 'submit') {
    const form = formOf(target) || target
    if (typeof hooks.onSubmit === 'function') hooks.onSubmit(form, event)
  }
}

function uncheckRadioGroup(radio) {
  const name = radio.getAttribute('name')
  if (!name) return
  const form = formOf(radio)
  const scope = form || radio.ownerDocument.documentElement
  for (const el of scope.getElementsByTagName('input')) {
    if (el === radio) continue
    if (inputType(el) !== 'radio') continue
    if (el.getAttribute('name') !== name) continue
    if (el.checked) el.checked = false
  }
}

/** Fire input + change, in that order, for a control whose value really changed. */
function fireValueEvents(doc, el) {
  dispatchEventOn(doc, el, createEvent('input', { detail: { value: el.value, checked: el.checked } }))
  dispatchEventOn(doc, el, createEvent('change', { detail: { value: el.value, checked: el.checked } }))
}

// ------------------------------------------------------------ select state ---

function selectedOption(select) {
  const options = select.getElementsByTagName('option')
  if (!options.length) return null
  const selected = options.find((option) => option.hasAttribute('selected'))
  if (selected) return selected
  return options[0]
}

function optionValue(option) {
  const value = option.getAttribute('value')
  return value === null ? normalizeText(innerTextOf(option)) : value
}

function selectValue(select, text) {
  const options = select.getElementsByTagName('option')
  const match = options.find((option) => optionValue(option) === text)
  for (const option of options) {
    if (option === match) option.setAttribute('selected', 'selected')
    else if (option.hasAttribute('selected')) option.removeAttribute('selected')
  }
  if (match === undefined) select.setAttribute('data-cu-no-option', text)
  return match || null
}

// --------------------------------------------------------- text/visibility ---

function innerTextOf(el) {
  let out = ''
  for (const child of el.__children) {
    if (isTextNode(child)) {
      out += child.nodeValue
      continue
    }
    if (!isElementVisible(child)) continue
    const text = innerTextOf(child)
    if (isBlockTag(child.tagName)) out += `\n${text}\n`
    else out += text
  }
  return out
}

function isElementVisible(el) {
  let node = el
  let opacity = 1
  let visibility = 'visible'
  while (isElement(node)) {
    if (NON_RENDERED_TAGS.has(node.tagName)) return false
    if (node.hasAttribute('hidden')) return false
    const style = node.style
    if (style.display === 'none') return false
    if (style.opacity !== null && Number.isFinite(style.opacity)) opacity *= style.opacity
    if (style.visibility !== null) visibility = style.visibility
    node = node.parentNode
  }
  if (opacity === 0 && visibility === 'hidden') return false
  return true
}

/**
 * Accessible name: aria-label, aria-labelledby, associated label, placeholder,
 * alt/title, then the element's own text.
 */
function accessibleName(el) {
  const aria = el.getAttribute('aria-label')
  if (aria) return normalizeText(aria)
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id))
      .filter(Boolean)
      .map((target) => normalizeText(innerTextOf(target)))
      .filter(Boolean)
    if (parts.length) return parts.join(' ')
  }
  const labels = labelTextsFor(el)
  if (labels.length) return labels.join(' ')
  const tag = el.tagName
  if (tag === 'input') {
    const type = inputType(el)
    if (type === 'submit' || type === 'reset' || type === 'button' || type === 'image') {
      const value = el.getAttribute('value')
      if (value) return value
      if (type === 'submit') return 'Submit'
      if (type === 'reset') return 'Reset'
      return ''
    }
    return el.getAttribute('placeholder') || ''
  }
  if (tag === 'textarea') return el.getAttribute('placeholder') || ''
  if (tag === 'select') return ''
  if (tag === 'img') return el.getAttribute('alt') || ''
  if (tag === 'canvas') return ''
  const text = normalizeText(innerTextOf(el))
  if (text) return text
  return el.getAttribute('title') || ''
}

function labelTextsFor(el) {
  const id = el.getAttribute('id')
  const out = []
  const root = el.ownerDocument.documentElement
  if (id) {
    for (const label of root.getElementsByTagName('label')) {
      if (label.getAttribute('for') === id) out.push(normalizeText(innerTextOf(label)))
    }
  }
  let node = el.parentNode
  while (isElement(node)) {
    if (node.tagName === 'label') {
      const text = normalizeText(innerTextOf(node))
      if (text && !out.includes(text)) out.push(text)
    }
    node = node.parentNode
  }
  return out.filter(Boolean)
}

// ---------------------------------------------------------------- classes ---

function createClassList(el) {
  const list = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)
  const write = (items) => {
    if (items.length) el.setAttribute('class', items.join(' '))
    else el.removeAttribute('class')
  }
  return {
    contains(name) {
      return list().includes(String(name))
    },
    add(...names) {
      const items = list()
      for (const name of names) if (!items.includes(String(name))) items.push(String(name))
      write(items)
    },
    remove(...names) {
      const items = list().filter((item) => !names.map(String).includes(item))
      write(items)
    },
    toggle(name, force) {
      const has = list().includes(String(name))
      const want = force === undefined ? !has : Boolean(force)
      if (want && !has) this.add(name)
      if (!want && has) this.remove(name)
      return want
    },
    item(index) {
      return list()[index] || null
    },
    get length() {
      return list().length
    },
    toString() {
      return list().join(' ')
    }
  }
}

// ---------------------------------------------------------------- parsing ---

/** Read one tag, honouring quoted attribute values that contain `>`. */
function readTag(html, start) {
  let index = start + 1
  let quote = null
  while (index < html.length) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      break
    }
    index += 1
  }
  return { raw: html.slice(start + 1, index), end: index + 1 }
}

function parseAttributes(raw) {
  const attrs = Object.create(null)
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let match = re.exec(raw)
  while (match) {
    const name = match[1].toLowerCase()
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : ''
    if (name) attrs[name] = decodeEntities(value)
    match = re.exec(raw)
  }
  return attrs
}

function parseMarkup(doc, html) {
  const stack = [doc.root]
  let index = 0
  const appendText = (text) => {
    if (!text) return
    const node = new MiniTextNode(doc, decodeEntities(text))
    node.parentNode = stack[stack.length - 1]
    node.parentNode.__children.push(node)
  }
  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open < 0) {
      appendText(html.slice(index))
      break
    }
    if (open > index) appendText(html.slice(index, open))
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      index = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', open) || html.startsWith('<?', open)) {
      const end = html.indexOf('>', open)
      index = end < 0 ? html.length : end + 1
      continue
    }
    const tag = readTag(html, open)
    index = tag.end
    const raw = tag.raw
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase()
      for (let depth = stack.length - 1; depth >= 1; depth -= 1) {
        if (stack[depth].tagName === name) {
          stack.length = depth
          break
        }
      }
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const space = body.search(/[\s/]/)
    const name = (space < 0 ? body : body.slice(0, space)).trim().toLowerCase()
    if (!name) continue
    const element = new MiniElement(doc, name)
    const attrs = parseAttributes(space < 0 ? '' : body.slice(space))
    for (const [key, value] of Object.entries(attrs)) element.__attrs[key] = value
    const parent = stack[stack.length - 1]
    element.parentNode = parent
    parent.__children.push(element)
    if (!doc.documentElement && name === 'html') doc.documentElement = element
    if (name === 'head') doc.head = element
    if (name === 'body') doc.body = element
    if (name === 'title') {
      doc.titleElement = element
      // The title text is filled in below, once its raw text child is parsed.
    }
    if (VOID_TAGS.has(name) || selfClosing) {
      if (name === 'title') doc.title = ''
      continue
    }
    if (RAW_TEXT_TAGS.has(name)) {
      const closeTag = `</${name}`
      const closeAt = html.toLowerCase().indexOf(closeTag, index)
      const text = closeAt < 0 ? html.slice(index) : html.slice(index, closeAt)
      index = closeAt < 0 ? html.length : closeAt + closeTag.length
      const end = html.indexOf('>', index)
      index = end < 0 ? html.length : end + 1
      const decoded = decodeEntities(text)
      if (decoded) {
        const node = new MiniTextNode(doc, decoded)
        node.parentNode = element
        element.__children.push(node)
      }
      if (name === 'title') doc.title = normalizeText(decoded)
      continue
    }
    stack.push(element)
  }
  if (!doc.documentElement) doc.documentElement = doc.root
  if (!doc.body) doc.body = doc.documentElement
}

// ---------------------------------------------------------------- queries ---

function descendants(root) {
  const out = []
  const walk = (node) => {
    for (const child of node.__children) {
      if (!isElement(child)) continue
      out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

/** Split a selector list on top-level commas. */
function splitSelectorList(selector) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of String(selector)) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** Tokenise a complex selector: compounds joined by ' ' or '>'. */
function parseComplexSelector(selector) {
  const steps = []
  let current = ''
  let childCombinator = false
  const flush = () => {
    if (!current.trim()) return
    steps.push({
      combinator: steps.length === 0 ? null : childCombinator ? '>' : ' ',
      compound: parseCompound(current.trim())
    })
    current = ''
    childCombinator = false
  }
  for (const char of String(selector)) {
    if (char === '>') {
      flush()
      childCombinator = true
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return steps
}

/**
 * Parse one compound selector: tag, #id, .class, [attr], [attr="value"],
 * :nth-child(n). An unsupported pseudo class throws, so a fixture author sees
 * the failure instead of a silent no-match.
 */
function parseCompound(text) {
  const compound = { tag: null, id: null, classes: [], attrs: [], nthChild: null }
  const re = /([#.]?[\w-]+)|(\[[^\]]*\])|(:[\w-]+\([^)]*\))/g
  let match = re.exec(text)
  let consumed = ''
  while (match) {
    consumed += match[0]
    if (match[2]) {
      const body = match[2].slice(1, -1).trim()
      const eq = body.indexOf('=')
      if (eq < 0) {
        compound.attrs.push({ name: body.toLowerCase(), value: null, op: 'exists' })
      } else {
        const name = body.slice(0, eq).trim().toLowerCase()
        let value = body.slice(eq + 1).trim()
        if (value.endsWith(']')) value = value.slice(0, -1)
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        compound.attrs.push({ name, value, op: 'equals' })
      }
    } else if (match[3]) {
      const pseudo = match[3]
      const nth = /^:nth-child\((\d+)\)$/.exec(pseudo)
      if (nth) compound.nthChild = Number(nth[1])
      else throw new Error(`unsupported pseudo class in selector: ${pseudo}`)
    } else {
      const token = match[1]
      if (token[0] === '#') compound.id = token.slice(1)
      else if (token[0] === '.') compound.classes.push(token.slice(1))
      else compound.tag = token.toLowerCase()
    }
    match = re.exec(text)
  }
  if (!consumed || consumed !== text) throw new Error(`unsupported selector: ${text}`)
  return compound
}

function matchCompound(el, compound) {
  if (compound.tag && el.tagName !== compound.tag) return false
  if (compound.id && el.getAttribute('id') !== compound.id) return false
  for (const name of compound.classes) {
    if (!(el.getAttribute('class') || '').split(/\s+/).includes(name)) return false
  }
  for (const attr of compound.attrs) {
    if (!el.hasAttribute(attr.name)) return false
    if (attr.op === 'equals' && el.getAttribute(attr.name) !== attr.value) return false
  }
  if (compound.nthChild !== null) {
    const parent = el.parentNode
    const siblings = parent ? parent.__children.filter((child) => isElement(child) && child.tagName === el.tagName) : [el]
    if (siblings.indexOf(el) + 1 !== compound.nthChild) return false
  }
  return true
}

function matchesSteps(el, steps) {
  const last = steps[steps.length - 1]
  if (!matchCompound(el, last.compound)) return false
  let index = steps.length - 1
  let node = el
  while (index > 0) {
    const step = steps[index]
    const previous = steps[index - 1]
    if (step.combinator === '>') {
      node = node.parentNode
      if (!isElement(node) || !matchCompound(node, previous.compound)) return false
      index -= 1
      continue
    }
    node = node.parentNode
    let matched = false
    while (isElement(node)) {
      if (matchCompound(node, previous.compound)) {
        matched = true
        break
      }
      node = node.parentNode
    }
    if (!matched) return false
    index -= 1
  }
  return true
}

function matchesSelector(el, selector) {
  if (!isElement(el)) return false
  for (const part of splitSelectorList(selector)) {
    if (matchesSteps(el, parseComplexSelector(part))) return true
  }
  return false
}

/** Query descendants of `root` in document order. */
function queryAll(root, selector, firstOnly) {
  const parts = splitSelectorList(selector).map(parseComplexSelector)
  const out = []
  for (const el of descendants(root)) {
    for (const steps of parts) {
      if (matchesSteps(el, steps)) {
        out.push(el)
        break
      }
    }
    if (firstOnly && out.length) return out
  }
  return out
}

// ----------------------------------------------------------------- layout ---

function styleOf(el) {
  return el.style
}

function measureTextWidth(text) {
  const collapsed = collapseWhitespace(text)
  return collapsed.length * CHAR_WIDTH
}

function measureInlineWidth(el) {
  const style = styleOf(el)
  if (style.width !== null) return style.width
  if (el.tagName === 'canvas' || el.tagName === 'img') {
    const attrWidth = parseLength(el.getAttribute('width'))
    return attrWidth === null ? 0 : attrWidth
  }
  if (el.tagName === 'input') {
    if (inputType(el) === 'checkbox' || inputType(el) === 'radio') return CHECKBOX_SIZE
    const size = parseLength(el.getAttribute('size'))
    return (size === null ? DEFAULT_COLS : size) * CHAR_WIDTH
  }
  if (el.tagName === 'textarea') {
    const cols = parseLength(el.getAttribute('cols'))
    return (cols === null ? DEFAULT_COLS : cols) * CHAR_WIDTH
  }
  if (el.tagName === 'select') {
    let widest = 0
    for (const option of el.getElementsByTagName('option')) {
      widest = Math.max(widest, measureTextWidth(option.innerText || option.textContent))
    }
    return widest + CONTROL_PADDING * 2
  }
  if (el.tagName === 'button') {
    return measureTextWidth(el.innerText || el.textContent) + CONTROL_PADDING * 2
  }
  let width = 0
  for (const child of el.__children) {
    if (isTextNode(child)) {
      const collapsed = collapseWhitespace(child.nodeValue)
      if (collapsed.trim()) width += collapsed.length * CHAR_WIDTH
      continue
    }
    if (!isElement(child)) continue
    if (child.style.display === 'none' || child.hasAttribute('hidden') || NON_RENDERED_TAGS.has(child.tagName)) continue
    if (child.tagName === 'br') continue
    width += child.style.width !== null ? child.style.width : measureInlineWidth(child)
  }
  return width
}

function measureBoxHeight(el) {
  const style = styleOf(el)
  if (style.height !== null) return style.height
  if (el.tagName === 'input') {
    if (inputType(el) === 'checkbox' || inputType(el) === 'radio') return CHECKBOX_SIZE
    return LINE_HEIGHT
  }
  if (el.tagName === 'textarea') {
    const rows = parseLength(el.getAttribute('rows'))
    return (rows === null ? DEFAULT_ROWS : rows) * LINE_HEIGHT
  }
  if (el.tagName === 'canvas' || el.tagName === 'img') {
    const attrHeight = parseLength(el.getAttribute('height'))
    return attrHeight === null ? 0 : attrHeight
  }
  if (el.tagName === 'select' || el.tagName === 'button') return LINE_HEIGHT
  return LINE_HEIGHT
}

/** Width of an absolutely positioned element with no explicit width. */
function shrinkToFitWidth(el, available) {
  let width = 0
  for (const child of el.__children) {
    if (isTextNode(child)) {
      const collapsed = collapseWhitespace(child.nodeValue)
      if (collapsed.trim()) width = Math.max(width, collapsed.length * CHAR_WIDTH)
      continue
    }
    if (!isElement(child) || child.style.display === 'none' || NON_RENDERED_TAGS.has(child.tagName)) continue
    const explicit = child.style.width
    if (explicit !== null) {
      width = Math.max(width, explicit)
      continue
    }
    width = Math.max(width, isBlockTag(child.tagName) ? shrinkToFitWidth(child, available) : measureInlineWidth(child))
  }
  return Math.min(available, width)
}

function setRect(el, x, y, width, height) {
  el.__rect = { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}

function hideSubtree(el, x, y) {
  setRect(el, x, y, 0, 0)
  for (const child of el.__children) {
    if (isElement(child)) hideSubtree(child, x, y)
    else child.__rect = { x, y, width: 0, height: 0 }
  }
}

function containingBlockOrigin(el) {
  let node = el.parentNode
  while (isElement(node)) {
    const position = node.style.position
    if (position === 'relative' || position === 'absolute' || position === 'fixed') {
      return { x: node.__rect.x, y: node.__rect.y }
    }
    node = node.parentNode
  }
  return { x: 0, y: 0 }
}

/** Lay out a block element; returns its content height. */
function layoutBlock(el, x, y, availableWidth) {
  const style = styleOf(el)
  const width = style.width !== null ? style.width : availableWidth
  el.__rect = { x, y, width: Math.max(0, width), height: 0 }
  let height
  if (style.height !== null) {
    layoutChildren(el, x, y, width)
    height = style.height
  } else {
    height = layoutChildren(el, x, y, width)
  }
  el.__rect = { x, y, width: Math.max(0, width), height: Math.max(0, height) }
  return el.__rect.height
}

/** Stack block children, flow inline children, then place absolute children. */
function layoutChildren(el, contentX, contentY, contentWidth) {
  let cursorY = contentY
  let lineTop = contentY
  let cursorX = contentX
  let lineOpen = false
  const absolutes = []
  for (const child of el.__children) {
    if (isTextNode(child)) {
      const collapsed = collapseWhitespace(child.nodeValue)
      if (!collapsed.trim()) {
        child.__rect = { x: cursorX, y: lineTop, width: 0, height: 0 }
        continue
      }
      const width = collapsed.length * CHAR_WIDTH
      if (!lineOpen) {
        lineTop = cursorY
        cursorX = contentX
        lineOpen = true
      }
      if (cursorX + width > contentX + contentWidth && cursorX > contentX) {
        cursorY = lineTop + LINE_HEIGHT
        lineTop = cursorY
        cursorX = contentX
      }
      child.__rect = { x: cursorX, y: lineTop, width, height: LINE_HEIGHT }
      cursorX += width
      continue
    }
    if (!isElement(child)) continue
    const style = styleOf(child)
    if (style.display === 'none' || child.hasAttribute('hidden') || NON_RENDERED_TAGS.has(child.tagName)) {
      hideSubtree(child, cursorX, lineOpen ? lineTop : cursorY)
      continue
    }
    if (style.position === 'absolute' || style.position === 'fixed') {
      absolutes.push(child)
      continue
    }
    if (child.tagName === 'br') {
      setRect(child, cursorX, lineTop, 0, LINE_HEIGHT)
      if (lineOpen) {
        cursorY = lineTop + LINE_HEIGHT
        lineOpen = false
      }
      continue
    }
    if (isBlockTag(child.tagName)) {
      if (lineOpen) {
        cursorY = lineTop + LINE_HEIGHT
        lineOpen = false
      }
      cursorY += layoutBlock(child, contentX, cursorY, contentWidth)
      continue
    }
    const width = measureInlineWidth(child)
    const height = measureBoxHeight(child)
    if (!lineOpen) {
      lineTop = cursorY
      cursorX = contentX
      lineOpen = true
    }
    if (cursorX + width > contentX + contentWidth && cursorX > contentX) {
      cursorY = lineTop + LINE_HEIGHT
      lineTop = cursorY
      cursorX = contentX
    }
    placeInline(child, cursorX, lineTop, width, height)
    cursorX += width
  }
  if (lineOpen) cursorY = lineTop + LINE_HEIGHT
  for (const child of absolutes) {
    const origin = child.style.position === 'fixed' ? { x: 0, y: 0 } : containingBlockOrigin(child)
    const style = styleOf(child)
    const x = origin.x + (style.left === null ? 0 : style.left)
    const y = origin.y + (style.top === null ? 0 : style.top)
    layoutAbsolute(child, x, y, contentWidth)
  }
  return Math.max(0, cursorY - contentY)
}

/** Place an inline element and its inline contents. */
function placeInline(el, x, y, width, height) {
  el.__rect = { x, y, width: Math.max(0, width), height: Math.max(0, height) }
  let cursorX = x
  for (const child of el.__children) {
    if (isTextNode(child)) {
      const collapsed = collapseWhitespace(child.nodeValue)
      if (!collapsed.trim()) {
        child.__rect = { x: cursorX, y, width: 0, height: 0 }
        continue
      }
      const childWidth = collapsed.length * CHAR_WIDTH
      child.__rect = { x: cursorX, y, width: childWidth, height: LINE_HEIGHT }
      cursorX += childWidth
      continue
    }
    if (!isElement(child)) continue
    if (child.style.display === 'none' || child.hasAttribute('hidden') || NON_RENDERED_TAGS.has(child.tagName)) {
      hideSubtree(child, cursorX, y)
      continue
    }
    // A block inside an inline box is treated as inline: there is no
    // inline-formatting context to split here, and fixtures do not need one.
    const childWidth = measureInlineWidth(child)
    const childHeight = measureBoxHeight(child)
    placeInline(child, cursorX, y, childWidth, childHeight)
    cursorX += childWidth
  }
}

/** Lay out an absolutely positioned element at an exact point. */
function layoutAbsolute(el, x, y, availableWidth) {
  const style = styleOf(el)
  const isBlock = isBlockTag(el.tagName) && el.tagName !== 'canvas'
  const width = style.width !== null ? style.width : isBlock ? shrinkToFitWidth(el, availableWidth) : measureInlineWidth(el)
  if (isBlock) {
    if (style.height !== null) {
      layoutChildren(el, x, y, width)
      setRect(el, x, y, width, style.height)
    } else {
      const height = layoutChildren(el, x, y, width)
      setRect(el, x, y, width, height)
    }
    return
  }
  const height = measureBoxHeight(el)
  placeInline(el, x, y, width, height)
}

function layoutDocument(doc) {
  const root = doc.documentElement
  if (!root) {
    doc.contentHeight = 0
    return
  }
  const width = doc.viewport.width
  if (root.tagName === 'html') {
    const htmlHeight = layoutBlock(root, 0, 0, width)
    doc.contentHeight = Math.max(htmlHeight, doc.body ? doc.body.__rect.y + doc.body.__rect.height : 0)
  } else {
    // A fragment without <html>: the document container holds the flow.
    const height = layoutChildren(root, 0, 0, width)
    doc.contentHeight = height
    root.__rect = { x: 0, y: 0, width, height }
  }
}

/** Parse the device behaviour bag from `data-cu-*` attributes (plus onclick). */
function parseBehaviour(el) {
  const out = {
    scripts: {},
    delayMs: null,
    eatClicks: 0,
    modal: null,
    freeze: false,
    moveAfterMs: null,
    moveTo: null,
    file: null,
    paint: null,
    loadMs: null,
    raw: {}
  }
  for (const [name, value] of Object.entries(el.__attrs)) {
    if (!name.startsWith('data-cu-')) continue
    const key = name.slice('data-cu-'.length)
    out.raw[key] = value
    switch (key) {
      case 'on-click': out.scripts.click = value; break
      case 'on-dblclick': out.scripts.dblclick = value; break
      case 'on-input': out.scripts.input = value; break
      case 'on-change': out.scripts.change = value; break
      case 'on-submit': out.scripts.submit = value; break
      case 'on-keydown': out.scripts.keydown = value; break
      case 'on-save': out.scripts.save = value; break
      case 'on-accept': out.scripts.accept = value; break
      case 'on-valid': out.scripts.valid = value; break
      case 'on-invalid': out.scripts.invalid = value; break
      case 'delay-ms': out.delayMs = numberOr(value, 0); break
      case 'eat-clicks': out.eatClicks = numberOr(value, 0); break
      case 'modal': out.modal = value; break
      case 'freeze': out.freeze = value === '1' || value === 'true'; break
      case 'move-after-ms': out.moveAfterMs = numberOr(value, null); break
      case 'move-to': out.moveTo = parsePoint(value); break
      case 'file': out.file = value; break
      case 'paint': out.paint = parsePaint(value); break
      case 'load-ms': out.loadMs = numberOr(value, null); break
      default: break
    }
  }
  if (!out.scripts.click && el.__attrs.onclick) out.scripts.click = el.__attrs.onclick
  return out
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function parsePoint(value) {
  const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(String(value).trim())
  if (!match) return null
  return { x: Number(match[1]), y: Number(match[2]) }
}

module.exports = {
  CHAR_WIDTH,
  LINE_HEIGHT,
  CONTROL_PADDING,
  CHECKBOX_SIZE,
  createDocument,
  createEvent,
  // Reusable DOM-derived helpers for the device (kept here so the DOM has one owner).
  isElement,
  isTextNode,
  isBlockTag,
  isInteractive,
  isTextInput,
  inputType,
  formOf,
  labelControl,
  isSubmitter,
  roleOf,
  accessibleName,
  labelTextsFor,
  innerTextOf,
  isElementVisible,
  selectedOption,
  optionValue,
  fireValueEvents,
  dispatchEventOn,
  collapseWhitespace,
  normalizeText,
  decodeEntities,
  parseColor,
  parseLength,
  parseStyle,
  parsePaint,
  measureInlineWidth,
  measureBoxHeight,
  queryAll,
  matchesSelector,
  descendants
}
