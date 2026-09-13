'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The dock's scripts must load the way the dock loads them.
 *
 * This suite exists because of a real bug: `'use strict'` followed by a newline and
 * `(function(){})()` is parsed as a *call* of the string — a `(` continues the expression,
 * so automatic semicolon insertion does not happen — and the script throws before it
 * defines anything. The Computer Use panel and the Engineering panel were therefore dead in
 * the shipped dock: their wiring tests were static analysis, and a panel that never runs
 * satisfies every static check ever written.
 *
 * So the check is the browser's own: evaluate each script, in the dock's own order, into one
 * shared `window`, and assert that every panel actually publishes its global.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const UI_DIR = path.join(ROOT, 'app', 'extensions', 'mega', 'ui')

/** The globals each script is expected to publish, and the element its panel needs. */
const EXPECTED_GLOBALS = Object.freeze({
  'balance-module.js': 'megaBalanceModule',
  'theme-bridge.js': 'megaThemeBridge',
  'theme-panel.js': 'megaThemePanel',
  'skills-panel.js': 'megaSkillsPanel',
  'computer-use-panel.js': 'megaComputerUsePanel',
  'bilingual.js': 'hnsBilingual',
  'engineering-panel.js': 'megaEngineeringPanel',
  'plugin-panel.js': 'megaPluginPanel'
})

function stubElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    type: '',
    checked: false,
    disabled: false,
    hidden: false,
    dataset: {},
    style: {},
    children: [],
    childElementCount: 0,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false
      }
    },
    appendChild(child) {
      this.children.push(child)
      this.childElementCount = this.children.length
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
      this.childElementCount = this.children.length
      return child
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null
    },
    remove() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
    }
  }
  return element
}

/** Enough of a document for a panel script to initialise without a real renderer. */
function stubDom() {
  const elements = new Map()
  const document = {
    readyState: 'complete',
    hidden: false,
    createElement: stubElement,
    createTextNode: (text) => ({ textContent: String(text) }),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, stubElement('div'))
      return elements.get(id)
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: stubElement('body'),
    documentElement: stubElement('html'),
    head: stubElement('head')
  }
  return { document, elements }
}

function stubWindow(document, timers) {
  const window = {
    document,
    location: { href: 'file:///dock.html', search: '', hash: '' },
    navigator: { userAgent: 'node' },
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null
      },
      setItem(key, value) {
        this.store.set(key, String(value))
      },
      removeItem(key) {
        this.store.delete(key)
      }
    },
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (id) => timers.clearTimeout(id),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (id) => timers.clearInterval(id),
    requestAnimationFrame: (fn) => timers.setTimeout(fn, 0),
    cancelAnimationFrame: (id) => timers.clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1600,
    innerHeight: 900
  }
  window.window = window
  return window
}

/** The scripts dock.html loads, in the order it loads them. */
function dockScripts() {
  const html = fs.readFileSync(path.join(UI_DIR, 'dock.html'), 'utf8')
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1])
}

test('every dock script loads in the dock\'s order and publishes its global', () => {
  const scripts = dockScripts()
  assert.deepEqual(scripts, [
    'balance-module.js',
    'theme-bridge.js',
    'theme-panel.js',
    'skills-panel.js',
    'computer-use-panel.js',
    'bilingual.js',
    'engineering-panel.js',
    'plugin-panel.js',
    'dock.js'
  ], 'the dock script order changed: this test loads them in exactly this order')

  const { document } = stubDom()
  // Inert timers on purpose: the scripts only need the functions to exist, and a real
  // interval here would keep the test process alive forever.
  const timers = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {}
  }
  const window = stubWindow(document, timers)
  // `dock.js` is the application entry point: its load-time body calls the preload bridge.
  // The stub provides the bridge's shape with inert methods, and `snapshot()` returns an
  // empty object — enough to get past the bridge and prove the file is not broken at load.
  window.megaTools = {
    onChanged() {},
    snapshot: async () => ({}),
    skills: { onChanged() {} },
    mode: { onChanged() {} },
    setDockExpanded() {},
    toggleDock() {},
    updateSettings: async () => ({}),
    fetchBalance: async () => ({}),
    refreshHardware: async () => ({}),
    clearPending: async () => ({}),
    pickWorkspace: async () => null,
    pickSound: async () => null,
    addTask: async () => ({}),
    reorderTask: async () => ({}),
    cancelTask: async () => ({}),
    removeTasks: async () => ({}),
    updateScheduler: async () => ({}),
    checkHarnessUpdate: async () => ({}),
    applyHarnessUpdate: async () => ({})
  }

  for (const script of scripts) {
    const source = fs.readFileSync(path.join(UI_DIR, script), 'utf8')
    // A classic script, evaluated exactly as the renderer would: one shared global. The
    // timer functions are shadowed as parameters because a script's bare `setInterval` is
    // the *global* one — in a browser that is `window.setInterval`, and here it would be
    // Node's, which is how a real timer keeps the test process alive forever.
    // eslint-disable-next-line no-new-func
    const run = new Function(
      'window',
      'document',
      'globalThis',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      source
    )
    try {
      run(window, document, window, timers.setTimeout, timers.clearTimeout, timers.setInterval, timers.clearInterval, timers.requestAnimationFrame, timers.cancelAnimationFrame)
    } catch (error) {
      // The application entry point is allowed to need the preload bridge; the panels are
      // not, and the assertion below is what caught three of them being dead.
      if (script !== 'dock.js') assert.fail(`${script} threw while loading: ${error.name}: ${error.message}`)
      assert.match(String(error.message), /megaTools|undefined/, `dock.js failed for a reason other than the absent preload bridge: ${error.message}`)
    }
    const expected = EXPECTED_GLOBALS[script]
    if (expected) {
      assert.ok(window[expected], `${script} did not publish window.${expected}`)
    }
  }
  // The panels are functions, not values: the dock's `attach()` calls must exist.
  for (const [script, name] of Object.entries(EXPECTED_GLOBALS)) {
    if (name === 'megaBalanceModule' || name === 'megaThemeBridge' || name === 'hnsBilingual') continue
    assert.equal(typeof window[name].attach, 'function', `${script} published ${name} without an attach()`)
  }
  assert.equal(typeof window.hnsBilingual.title, 'function')
})

test('no dock script relies on automatic semicolon insertion after a directive', () => {
  // The specific hazard, so a future panel cannot reintroduce it: a script that opens with
  // the strict directive and then a parenthesised IIFE must lead it with `;`.
  for (const script of dockScripts()) {
    const source = fs.readFileSync(path.join(UI_DIR, script), 'utf8')
    const head = source.split('\n').slice(0, 40).join('\n')
    if (!/^'use strict'/.test(source)) continue
    const iife = head.match(/^\s*(;?)\(function/m)
    if (!iife) continue
    assert.equal(iife[1], ';', `${script} starts an IIFE without a leading semicolon, which throws at load`)
  }
})
