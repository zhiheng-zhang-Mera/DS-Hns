'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Two dock behaviours the user asked for, and the reason each is a rule rather than a tweak.
 *
 *   * **One module open at a time.** The dock is a column of modules in one narrow strip, so two
 *     expanded at once means scrolling past a finished module to reach the one just opened. The
 *     *open* state is singular; the per-module choice is still remembered.
 *   * **Header controls keep their shape.** Expanding a module gave the header more room and the
 *     buttons less: a label broke onto a second line and the padding stopped being symmetric, so the
 *     same button looked like a different control at a different width. A group of controls either
 *     fits beside the title or moves under it whole.
 *
 * The accordion is exercised against a small DOM stub, because "expanding one collapses the others"
 * is exactly the kind of behaviour that reads correctly in the source and does nothing.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** Enough of a document to run `setupCollapsiblePanels` from the real script. */
function dockHarness(panelIds) {
  const storage = new Map()
  const listeners = []
  function makeElement(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      dataset: {},
      textContent: '',
      title: '',
      type: '',
      children: [],
      attributes: new Map(),
      addEventListener(event, handler) {
        listeners.push({ node, event, handler })
      },
      setAttribute(name, value) {
        this.attributes.set(name, value)
      },
      getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null
      },
      appendChild(child) {
        this.children.push(child)
        return child
      },
      querySelector(selector) {
        return this.children.find((child) => `.${child.className}` === selector || child.className === selector.replace('.', '')) || null
      },
      closest() {
        return null
      }
    }
    return node
  }
  const panels = panelIds.map((id) => {
    const panel = makeElement('section')
    panel.id = id
    panel.className = 'panel'
    panel.dataset.collapsed = '1'
    const head = makeElement('div')
    head.className = 'panel-head'
    const title = makeElement('div')
    head.appendChild(title)
    panel.appendChild(head)
    panel.querySelector = (selector) => (selector === '.panel-head' ? head : makeElement('div'))
    return panel
  })
  const document = {
    querySelectorAll: (selector) => (selector === '#detail section.panel' ? panels : []),
    createElement: makeElement,
    getElementById: () => null
  }
  const window = {
    document,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    addEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => 0
  }
  return {
    window,
    document,
    panels,
    handlersFor(node, event) {
      return listeners.filter((entry) => entry.node === node && entry.event === event).map((entry) => entry.handler)
    },
    click(node) {
      for (const handler of this.handlersFor(node, 'click')) handler({ stopPropagation() {}, target: node })
    },
    saved: () => JSON.parse(storage.get('ds-hns.dock.panels') || '{}'),
    collapseButtons: () => panels.map((panel) => panel.querySelector('.panel-head').children.find((child) => child.className === 'panel-collapse'))
  }
}

/** The real script, with its boot body neutralised: only the collapse setup is under test here. */
function loadCollapseSetup(harness) {
  const source = read('app/extensions/mega/ui/dock.js')
  const start = source.indexOf('const PANEL_STATE_KEY')
  const end = source.indexOf('const collapsiblePanels = setupCollapsiblePanels()')
  assert.notEqual(start, -1, 'the panel state helpers are gone from dock.js')
  assert.notEqual(end, -1, 'the collapse setup is gone from dock.js')
  const slice = source.slice(start, end)
  const factory = new Function('window', 'document', `${slice}\nreturn { setupCollapsiblePanels }`)
  return factory(harness.window, harness.document)
}

test('only the module that was opened last stays open', () => {
  const harness = dockHarness(['skillsPanel', 'balancePanel', 'pluginsPanel'])
  const { setupCollapsiblePanels } = loadCollapseSetup(harness)
  const handles = setupCollapsiblePanels()
  assert.equal(handles.length, 3, 'every module must get a collapse handle')

  const [skills, balance, plugins] = harness.panels
  const buttons = harness.collapseButtons()
  // Every module starts collapsed: the dock opens as a short list of what is available.
  assert.equal(harness.panels.every((panel) => panel.dataset.collapsed === '1'), true)
  assert.equal(buttons.every((button) => button.textContent === '▸'), true)

  // Open the skills module through its own button.
  harness.click(buttons[0])
  assert.equal(skills.dataset.collapsed, '', 'the clicked module must open')
  assert.equal(buttons[0].textContent, '▾', 'the handle must say it is open')
  assert.equal(buttons[0].getAttribute('aria-expanded'), 'true')

  // Open the balance module: skills closes, and the scroll position stops being a problem.
  harness.click(buttons[1])
  assert.equal(balance.dataset.collapsed, '', 'the newly opened module must be open')
  assert.equal(skills.dataset.collapsed, '1', 'opening a module must close the previous one')
  assert.equal(plugins.dataset.collapsed, '1')
  assert.equal(buttons[0].textContent, '▸', 'the closed module must say so')
  assert.equal(harness.panels.filter((panel) => panel.dataset.collapsed !== '1').length, 1, 'exactly one module may be open')

  // Open the third: the second closes.
  harness.click(buttons[2])
  assert.equal(plugins.dataset.collapsed, '')
  assert.equal(balance.dataset.collapsed, '1')
  assert.equal(harness.panels.filter((panel) => panel.dataset.collapsed !== '1').length, 1)

  // Closing the open one leaves everything closed — it does not open something else.
  harness.click(buttons[2])
  assert.equal(harness.panels.every((panel) => panel.dataset.collapsed === '1'), true)

  // The per-module choice is remembered, and the open one is the one recorded as open.
  harness.click(buttons[1])
  assert.deepEqual(harness.saved(), { skillsPanel: true, balancePanel: false, pluginsPanel: true })
})

test('the header row keeps a whole control group, and a button keeps its own shape', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  const head = css.slice(css.indexOf('.panel-head{'), css.indexOf('.panel-head > :first-child'))
  // The header itself wraps: the controls move under the title as one group rather than squeezing.
  assert.match(head, /flex-wrap:wrap/, 'the header cannot move its controls as a group')
  assert.match(head, /row-gap:/, 'a wrapped control group needs vertical separation')

  // A control group never wraps inside itself, and never shrinks into its buttons.
  const group = css.slice(css.indexOf('.panel-head .balance-actions'), css.indexOf('.panel-head button{'))
  for (const selector of ['.balance-actions', '.header-actions', '.queue-actions']) {
    assert.match(group, new RegExp(selector.replace('.', '\\.')), `${selector} is not covered by the no-wrap rule`)
  }
  assert.match(group, /flex-wrap:nowrap/, 'a control group may still wrap its own buttons')
  assert.match(group, /flex:0 0 auto/, 'a control group may still be squeezed')

  // A button in a header keeps its intrinsic width and one line of label.
  const buttons = css.slice(css.indexOf('.panel-head button{'), css.indexOf('.panel-head .status-chip'))
  assert.match(buttons, /white-space:nowrap/, 'a header button label may still break onto a second line')
  assert.match(buttons, /flex:0 0 auto/, 'a header button may still be shrunk')
  assert.match(buttons, /min-height:/, 'a header button has no floor on its height')
  // The icon buttons keep a square, which is what stops the ⚙ and › glyphs from deforming.
  const icon = css.slice(css.indexOf('.panel-head .icon-button{'), css.indexOf('.panel-head .status-chip'))
  assert.match(icon, /width:36px/)
  assert.match(icon, /min-width:36px/)

  // The colour still comes from the skin: these rules may not introduce one.
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(`${head}${group}${buttons}${icon}`), false, 'the layout fix hard-codes a colour')
})
