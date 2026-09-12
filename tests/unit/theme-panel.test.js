'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Appearance panel (renderer level).
 *
 * Executes the real `ui/theme-panel.js` against a minimal DOM stub, with a fake
 * `window.megaTools.theme` bridge, and asserts the properties that matter to the
 * user-experience contract: the user only ever types language, protected themes
 * cannot be deleted, a generated theme is previewed before it can be installed,
 * and the dock surface is actually repainted from the engine payload.
 */

/**
 * The bridge every dock UI module joins. This panel is a bridge module like the
 * Skills panel, so the test loads the real bridge rather than stubbing it.
 */
const BRIDGE = path.resolve(__dirname, '..', '..', 'app', 'extensions', 'mega', 'ui', 'theme-bridge.js')
const PANEL = path.resolve(__dirname, '..', '..', 'app', 'extensions', 'mega', 'ui', 'theme-panel.js')

function makeElement(id) {
  const classes = new Set()
  const handlers = new Map()
  const attributes = new Map()
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    title: '',
    className: '',
    dataset: {},
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, String(value)) },
      removeProperty(name) { this.values.delete(name) }
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => {
        const next = on === undefined ? !classes.has(name) : Boolean(on)
        if (next) classes.add(name)
        else classes.delete(name)
        return next
      }
    },
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
    },
    fire(name, event = {}) {
      for (const handler of handlers.get(name) || []) handler(event)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    focus: () => {},
    blur: () => {},
    closest: () => null,
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 120 })
  }
}

function installDom({ presentIds = [] } = {}) {
  const elements = new Map()
  for (const id of presentIds) elements.set(id, makeElement(id))
  const documentHandlers = new Map()
  // `document.documentElement` and `document.body` must be the SAME objects that
  // `getElementById` returns: the panel writes theme variables on documentElement
  // and reads state from body, and a duplicate element would hide both.
  const htmlElement = makeElement('html')
  const bodyElement = makeElement('body')
  elements.set('html', htmlElement)
  elements.set('body', bodyElement)

  global.document = {
    body: bodyElement,
    documentElement: htmlElement,
    head: { appendChild: () => {} },
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    querySelector: () => null,
    addEventListener: (name, handler) => {
      if (!documentHandlers.has(name)) documentHandlers.set(name, [])
      documentHandlers.get(name).push(handler)
    }
  }
  global.window = globalThis
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  return {
    elements,
    element: (id) => elements.get(id) || document.getElementById(id),
    /** Set by `loadPanel` once the panel is attached. */
    attached: null,
    panel: null
  }
}

/** Minimal theme record, matching what the engine's registry produces. */
function themeRecord(overrides = {}) {
  return {
    id: 'hns.system.dark',
    name: 'Dark',
    source: 'system',
    protected: true,
    deletable: false,
    editable: false,
    system_theme: true,
    broken: false,
    active: false,
    validation: { ok: true, errors: 0, warnings: 0, issues: [] },
    slotCount: 33,
    tokenCount: 42,
    persona: { enabled: false, prominence: 0, character: null },
    animation: { type: 'none', intensity: 0 },
    ...overrides
  }
}

function makeStatus(overrides = {}) {
  return {
    themeApiVersion: '1.0',
    active: 'hns.system.dark',
    activeName: 'Dark',
    previewing: false,
    previewDraftId: null,
    effect: { label: 'full' },
    effectLevel: 0,
    degraded: false,
    load: null,
    animation: { type: 'none', intensity: 0 },
    recovery: [],
    revisionHistory: [],
    quickPrompts: ['银发角色，黑灰蓝色调', '赛博全息 HUD'],
    themes: [
      themeRecord({ id: 'hns.system.dark', name: 'Dark', active: true }),
      themeRecord({ id: 'hns.system.light', name: 'Light' }),
      themeRecord({ id: 'hns.demo.cyber-hud', name: 'Cyber HUD Demo', source: 'builtin-demo', protected: false, deletable: true, editable: true, system_theme: false }),
      themeRecord({ id: 'hns.user.mine', name: 'My Theme', source: 'generated', protected: false, deletable: true, editable: true, system_theme: false, generated_prompt: '赛博 HUD' })
    ],
    ...overrides
  }
}

function makePaintPayload(overrides = {}) {
  return {
    id: 'hns.system.dark',
    name: 'Dark',
    preview: false,
    draftId: null,
    css: '--hns-color-bg-base: #0f1115;\n--hns-color-label-primary: #e8ecf3;',
    tokens: { 'color.bg.base': '#0f1115' },
    slots: {
      'hns.window.shell': { background: '#151922', border: '1px solid #252d3d', radius: '8px' },
      'hns.process.panel': { background: '#151922', border: '1px solid #252d3d', radius: '8px', shadow: 'none' },
      'hns.worker.card': { background: '#151922', border: '1px solid #252d3d', radius: '8px' },
      'hns.process.queue': { background: '#1b2130', border: '1px solid #252d3d' },
      'hns.status.badge': { background: '#1b2130', border: '1px solid #252d3d', radius: '4px' },
      'common.button.primary': { background: '#4d93f8', label: '#0d1016', radius: '8px' },
      'common.input.default': { background: '#1b2130', border: '1px solid #252d3d', radius: '4px' },
      'hns.worker.header': { background: '#1b2130' },
      'hns.operator.widget': { position: 'corner-bottom-right' },
      'hns.persona.decoration': { asset: 'data:image/png;base64,AAAA', opacity: 0.2 }
    },
    animation: { type: 'fade', intensity: 0.3 },
    persona: {
      enabled: true,
      prominence: 0.2,
      character: 'silver_hair_assistant',
      decorationOpacity: 0.2,
      bannerOpacity: 0.1,
      widgetOpacity: 0.9,
      avatarAsset: 'data:image/png;base64,BBBB',
      bannerAsset: 'none'
    },
    officialPalette: 'dark',
    effectLevel: 0,
    effectLabel: 'full',
    ...overrides
  }
}

/**
 * Load the panel with a fake bridge.
 *
 * @param {object} options
 * @param {object} [options.status]
 * @param {object} [options.paint]
 * @param {Function} [options.handlers]  per-channel overrides
 */
function loadPanel({ status = makeStatus(), paint = makePaintPayload(), handlers = {} } = {}) {
  const dom = installDom({
    presentIds: [
      'appearancePanel', 'themeList', 'themeActive', 'themeActiveMarker', 'themeCapability',
      'themePrompt', 'themeCreate', 'themeQuick', 'themePreview', 'themePreviewBody',
      'themeApprove', 'themeModify', 'themeModifyBox', 'themeModifyPrompt', 'themeModifySend',
      'themeDiscard', 'themeMessage', 'themeBusy', 'themeDetail', 'themeDetailBody',
      'themeDetailClose', 'themeImport', 'themeObserve', 'error', 'rail', 'railToggle',
      'railRunning', 'railQueued', 'railWorkers', 'railPeak', 'settingsOverlay', 'settingsStatus',
      'apiKey', 'detail', 'summary', 'queue', 'hardware', 'taskForm', 'clearPending', 'prompt',
      'nextValleyValue'
    ]
  })

  const calls = {
    apply: [], remove: [], duplicate: [], restore: [], import: [], observe: [], detail: [],
    create: [], revise: [], approve: [], discard: [], reportRegions: []
  }
  const listeners = { apply: null, changed: null, probe: null }
  global.confirm = () => true

  global.window.megaTools = {
    theme: {
      snapshot: async () => ({ ok: true, status }),
      capabilities: async () => ({ ok: true, capability: { theme_api_version: '1.0', slots: { a: { permission: 'SAFE' }, b: { permission: 'STRUCTURAL' } }, states: new Array(10).fill('x'), capabilities: { can_theme_official_ui: false } } }),
      paint: async () => ({ ok: true, payload: paint }),
      create: async (payload) => {
        calls.create.push(payload)
        return handlers.create ? handlers.create(payload) : { ok: true }
      },
      revise: async (payload) => {
        calls.revise.push(payload)
        return handlers.revise ? handlers.revise(payload) : { ok: true }
      },
      approve: async (payload) => {
        calls.approve.push(payload)
        return handlers.approve ? handlers.approve(payload) : { ok: true, id: 'hns.user.mine', name: 'My Theme' }
      },
      discard: async (payload) => {
        calls.discard.push(payload)
        return handlers.discard ? handlers.discard(payload) : { ok: true }
      },
      apply: async (id) => {
        calls.apply.push(id)
        return handlers.apply ? handlers.apply(id) : { ok: true, status: { name: 'Dark' } }
      },
      remove: async (id) => {
        calls.remove.push(id)
        return handlers.remove ? handlers.remove(id) : { ok: true }
      },
      duplicate: async (id, name) => {
        calls.duplicate.push({ id, name })
        return handlers.duplicate ? handlers.duplicate(id) : { ok: true, id: 'hns.user.copy' }
      },
      restore: async (id) => {
        calls.restore.push(id)
        return handlers.restore ? handlers.restore(id) : { ok: true, id }
      },
      importPackage: async () => {
        calls.import.push(true)
        return handlers.import ? handlers.import() : { ok: true, id: 'hns.user.imported' }
      },
      observe: async (pages) => {
        calls.observe.push(pages)
        return { ok: true, snapshot: { visual: true, page_names: ['Main Dashboard', 'Worker View'] } }
      },
      detail: async (id) => {
        calls.detail.push(id)
        return {
          ok: true,
          manifest: { id, source: 'generated', version: '1.0.1', theme_api_version: '1.0', protected: false, derived_from: null, official_palette: 'dark', generated_prompt: 'x', revision_history: [] },
          persona: { enabled: false, prominence: 0 },
          tokens: { 'color.bg.base': '#000' },
          slotCount: 31,
          animation: { type: 'fade', intensity: 0.3 }
        }
      },
      onApply: (handler) => { listeners.apply = handler },
      onChanged: (handler) => { listeners.changed = handler },
      onProbeRegions: (handler) => { listeners.probe = handler },
      reportRegions: (payload) => { calls.reportRegions.push(payload) }
    }
  }

  delete require.cache[require.resolve(BRIDGE)]
  delete require.cache[require.resolve(PANEL)]
  require(BRIDGE)
  require(PANEL)
  const attached = window.megaThemePanel.attach()
  dom.attached = attached
  dom.panel = window.megaThemePanel
  return { dom, calls, attached, listeners, panel: window.megaThemePanel }
}

/**
 * Await a value that may be a promise (the panel's click handlers return their
 * tracked work), then let any chained microtasks run.
 */
const flush = async (value) => {
  if (value && typeof value.then === 'function') await value
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Await whatever the panel is currently doing (first paint, create, approve...).
 *
 * `settled()` is re-read each round: an action triggered during the wait installs a
 * *new* closure, and awaiting the one captured earlier would return too soon.
 */
const settle = async (harness) => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve))
  for (let round = 0; round < 6; round += 1) {
    const target = harness && (harness.attached || harness.panel)
    if (!target || typeof target.settled !== 'function') break
    await target.settled()
    await new Promise((resolve) => setImmediate(resolve))
  }
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Convenience: load the panel and wait for its first paint. */
async function loaded(options) {
  const harness = loadPanel(options)
  await settle(harness)
  return harness
}

test('the Appearance panel renders the theme list with locks for protected themes', async () => {
  const { dom, calls, attached } = loadPanel()
  await settle(dom)

  const markup = dom.element('themeList').innerHTML
  assert.match(markup, /Dark/)
  assert.match(markup, /Light/)
  assert.match(markup, /Cyber HUD Demo/)
  // Protected themes are badged with a lock and have a disabled delete button.
  assert.match(markup, /theme-lock/)
  const darkRow = markup.split('<div class="theme-item')[1]
  assert.match(darkRow, /disabled/)
  // Non-protected themes carry no lock.
  const demoRow = markup.split('hns.demo.cyber-hud')[1] || ''
  assert.ok(!/theme-lock/.test(demoRow.split('theme-item')[0] || ''))

  // The active theme is highlighted.
  assert.match(markup, /theme-item active/)
  // The capability line never exposes slot internals to the user.
  const capability = dom.element('themeCapability').innerHTML
  assert.match(capability, /Theme API/)
  assert.ok(!/tokens\.json|manifest|slot id/i.test(capability))
  assert.ok(dom.element('themeQuick').innerHTML.includes('赛博全息 HUD'), 'quick prompts come from the engine')
})

test('the panel joins the shared theme bridge as a themable module', async () => {
  const { dom, listeners, attached } = loadPanel()
  await settle(dom)

  // Painting is the bridge's job (covered by theme-bridge.test.js); this panel's
  // contract is that it registers with the bridge and hands over its slots, so a
  // theme can restyle it and theme validation can see its geometry.
  assert.ok(window.megaThemeBridge, 'the panel loads the shared theme bridge')
  assert.deepEqual(window.megaThemeBridge.modules, ['appearance'])
  assert.equal(typeof listeners.apply, 'function', 'the bridge subscribes to engine paint pushes')

  listeners.apply(makePaintPayload({ id: 'hns.demo.cyber-hud', name: 'Cyber HUD Demo', preview: true }))
  assert.equal(dom.element('themeActiveMarker').textContent, 'Cyber HUD Demo · 预览中')
  assert.equal(dom.element('body').dataset.themeId, 'hns.demo.cyber-hud')

  const measured = window.megaThemeBridge.reportRegions()
  assert.ok(measured, 'geometry is reported to the engine')
  assert.ok(Object.keys(measured).length > 0)
})

test('applying a theme calls the engine and reports the outcome', async () => {
  const { dom, calls, attached } = loadPanel()
  await settle(dom)

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { apply: 'hns.demo.cyber-hud' } }) } })
  await settle(dom)

  assert.deepEqual(calls.apply, ['hns.demo.cyber-hud'])
  assert.match(dom.element('themeMessage').textContent, /已应用/)
})

test('a theme that fails to apply is reported as a Dark recovery, not as a crash', async () => {
  const { dom, attached } = loadPanel({
    handlers: { apply: async () => ({ ok: false, reason: 'validation_failed', recovered: true }) }
  })
  await settle(dom)

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { apply: 'hns.user.mine' } }) } })
  await settle(dom)

  assert.match(dom.element('themeMessage').textContent, /回退 Dark/)
  assert.equal(dom.element('themeMessage').className.includes('warn'), true)
})

test('protected themes cannot be deleted from the panel', async () => {
  const { dom, calls, attached } = loadPanel()
  await settle(dom)

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { delete: 'hns.system.dark' } }) } })
  await settle(dom)

  assert.deepEqual(calls.remove, [], 'no delete request is issued for a protected theme')
  assert.match(dom.element('themeMessage').textContent, /受保护/)
})

test('deleting a user theme asks once and reports the Dark switch', async () => {
  const { dom, calls, attached } = loadPanel({
    handlers: { remove: async () => ({ ok: true, id: 'hns.user.mine', switchedTo: 'hns.system.dark' }) }
  })
  await settle(dom)

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { delete: 'hns.user.mine' } }) } })
  await settle(dom)

  assert.deepEqual(calls.remove, ['hns.user.mine'])
  assert.match(dom.element('themeMessage').textContent, /切换到 Dark/)
})

test('a generated theme is previewed before it can be installed', async () => {
  const draft = {
    ok: true,
    draftId: 'draft-1',
    themeId: 'hns.user.theme',
    name: '深炭黑 compact',
    stage: 'preview',
    designSummary: 'design_language=future_research_workstation · palette=charcoal',
    engine: 'local',
    intent: { density: 'compact' },
    validation: {
      ok: true,
      passed: 10,
      total: 11,
      checks: [
        { id: 'contrast', label: 'text contrast', ok: true, detail: 'ok' },
        { id: 'critical_controls_present', label: 'critical regions present', ok: false, severity: 'warning', detail: 'not measured' }
      ],
      failures: [],
      warnings: [{ id: 'critical_controls_present' }]
    },
    contrastAdjustments: []
  }
  const { dom, calls, attached } = loadPanel({ handlers: { create: async () => draft } })
  await settle(dom)

  dom.element('themePrompt').value = '银发角色，黑灰蓝色调'
  await flush(dom.element('themeCreate').onclick())
  await settle(dom)
  assert.deepEqual(calls.create, [{ prompt: '银发角色，黑灰蓝色调' }], 'the user only supplies natural language')
  assert.equal(dom.element('themePreview').hidden, false, 'the preview panel is shown')
  const bodyNode = dom.element('themePreviewBody')
  assert.ok(
    bodyNode.innerHTML.length > 0,
    `the preview body was written (previewError=${dom.panel.state.previewError}; error=${dom.element('themeMessage').textContent})`
  )
  assert.match(bodyNode.innerHTML, /校验通过/)
  assert.match(bodyNode.innerHTML, /text contrast/)
  assert.equal(dom.element('themeApprove').disabled, false)
  assert.deepEqual(calls.approve, [], 'nothing is installed by generating')
})

test('a preview that fails validation blocks installation', async () => {
  const draft = {
    ok: true,
    draftId: 'draft-2',
    themeId: 'hns.user.bad',
    name: 'bad',
    validation: {
      ok: false,
      passed: 8,
      total: 11,
      checks: [{ id: 'contrast', label: 'text contrast', ok: false, detail: 'too low' }],
      failures: [{ id: 'contrast', label: 'text contrast', ok: false, detail: 'too low' }],
      warnings: []
    }
  }
  const { dom, calls, attached } = loadPanel({ handlers: { create: async () => draft } })
  await settle(dom)

  dom.element('themePrompt').value = '随便'
  await flush(dom.element('themeCreate').onclick())
  await settle(dom)

  assert.ok(
    dom.element('themePreviewBody').innerHTML.includes('校验未通过'),
    `body=${dom.element('themePreviewBody').innerHTML.slice(0, 200)} err=${dom.panel.state.previewError}`
  )
  assert.equal(dom.element('themeApprove').disabled, true, 'Looks Good is disabled while the preview fails')
  await flush(dom.element('themeApprove').onclick())
  await settle(dom)
  assert.deepEqual(calls.approve, [], 'no install request is made')
  assert.match(dom.element('themePreviewBody').innerHTML, /校验未通过/)
})

test('modification is a natural-language revision of the same draft', async () => {
  const created = {
    ok: true,
    draftId: 'draft-3',
    themeId: 'hns.user.theme',
    name: 'theme',
    validation: { ok: true, passed: 11, total: 11, checks: [], failures: [], warnings: [] }
  }
  const revised = {
    ok: true,
    draftId: 'draft-3',
    themeId: 'hns.user.theme',
    name: 'theme',
    revision: 1,
    changed: ['persona'],
    designSummary: 'design_language=future_research_workstation',
    validation: { ok: true, passed: 11, total: 11, checks: [], failures: [], warnings: [] }
  }
  const { dom, calls, attached } = loadPanel({ handlers: { create: async () => created, revise: async () => revised } })
  await settle(dom)

  dom.element('themePrompt').value = '银发角色'
  await flush(dom.element('themeCreate').onclick())
  await settle(dom)

  // `Modify` toggles the revision input; it starts hidden in the shipped markup.
  const modifyBox = dom.element('themeModifyBox')
  modifyBox.hidden = true
  dom.element('themeModify').onclick()
  assert.equal(modifyBox.hidden, false, 'Modify reveals the revision input')
  dom.element('themeModifyPrompt').value = '人物再小一点'
  await flush(dom.element('themeModifySend').onclick())
  await settle(dom)

  assert.deepEqual(calls.revise, [{ draftId: 'draft-3', prompt: '人物再小一点' }])
  assert.match(dom.element('themeMessage').textContent, /已按你的意见调整/)
  assert.match(dom.element('themePreviewBody').innerHTML, /修改记录/)
})

test('approval installs the previewed theme and clears the preview', async () => {
  const created = {
    ok: true,
    draftId: 'draft-4',
    themeId: 'hns.user.theme',
    name: 'theme',
    validation: { ok: true, passed: 11, total: 11, checks: [], failures: [], warnings: [] }
  }
  const { dom, calls, attached } = loadPanel({
    handlers: { create: async () => created, approve: async () => ({ ok: true, id: 'hns.user.theme', name: 'theme' }) }
  })
  await settle(dom)

  dom.element('themePrompt').value = '赛博 HUD'
  dom.element('themeCreate').onclick()
  await settle(dom)

  dom.element('themeApprove').onclick()
  await settle(dom)

  assert.deepEqual(calls.approve, [{ draftId: 'draft-4' }])
  assert.equal(dom.element('themePreview').hidden, true, 'the preview closes after installation')
  assert.match(dom.element('themeMessage').textContent, /已安装并启用/)
})

test('discarding a draft installs nothing', async () => {
  const created = {
    ok: true,
    draftId: 'draft-5',
    themeId: 'hns.user.theme',
    name: 'theme',
    validation: { ok: true, passed: 11, total: 11, checks: [], failures: [], warnings: [] }
  }
  const { dom, calls, attached } = loadPanel({ handlers: { create: async () => created } })
  await settle(dom)

  dom.element('themePrompt').value = '赛博 HUD'
  dom.element('themeCreate').onclick()
  await settle(dom)
  dom.element('themeDiscard').onclick()
  await settle(dom)

  assert.deepEqual(calls.discard, [{ draftId: 'draft-5' }])
  assert.deepEqual(calls.approve, [])
  assert.match(dom.element('themeMessage').textContent, /未安装任何内容/)
})

test('the panel reports live slot geometry for UI observation', async () => {
  const { calls, listeners, attached } = loadPanel()
  await settle(calls)

  assert.equal(typeof listeners.probe, 'function', 'the engine can ask for a geometry probe')
  calls.reportRegions.length = 0
  listeners.probe()
  assert.ok(calls.reportRegions.length >= 1, 'the panel answers the probe')

  const payload = calls.reportRegions[calls.reportRegions.length - 1]
  assert.ok(Object.keys(payload).length > 0)
  for (const [key, box] of Object.entries(payload)) {
    if (key === 'componentTree') continue
    assert.equal(typeof box.x, 'number', `${key} carries a bounding box`)
    assert.equal(typeof box.width, 'number')
  }
  assert.ok(payload.componentTree, 'the component tree summary is included')
})

test('theme detail exposes the package metadata without internal machinery', async () => {
  const { dom, calls, attached } = loadPanel()
  await settle(dom)

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { detail: 'hns.user.mine' } }) } })
  await settle(dom)

  assert.deepEqual(calls.detail, ['hns.user.mine'])
  assert.equal(dom.element('themeDetail').hidden, false)
  const body = dom.element('themeDetailBody').innerHTML
  assert.match(body, /Theme API/)
  assert.match(body, /受保护/)
  assert.match(body, /槽位/)
})

test('duplicate, restore and import go through their dedicated engine calls', async () => {
  const { dom, calls, attached } = loadPanel()
  await settle(dom)

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { duplicate: 'hns.user.mine' } }) } })
  await settle(dom)
  assert.deepEqual(calls.duplicate, [{ id: 'hns.user.mine', name: null }])

  dom.element('themeList').fire('click', { target: { closest: () => ({ dataset: { restore: 'hns.demo.cyber-hud' } }) } })
  await settle(dom)
  assert.deepEqual(calls.restore, ['hns.demo.cyber-hud'])

  dom.element('themeImport').onclick()
  await settle(dom)
  assert.equal(calls.import.length, 1)
})

test('the panel never renders internal file paths or slot ids to the user', async () => {
  const { dom, attached } = loadPanel()
  await settle(dom)

  for (const id of ['themeList', 'themeActive', 'themeCapability', 'themeMessage']) {
    const text = `${dom.element(id).innerHTML}${dom.element(id).textContent}`
    assert.ok(!/manifest\.json|tokens\.json|data[\\/]themes|hns\.window\./i.test(text), `${id} leaks internal detail`)
  }
})

test('the panel is inert when the theme engine is unavailable', async () => {
  const dom = installDom({ presentIds: ['appearancePanel', 'themeMessage'] })
  global.window.megaTools = { onChanged: () => {} }
  delete require.cache[require.resolve(PANEL)]
  require(PANEL)
  const attached = window.megaThemePanel.attach()
  assert.equal(attached, null)
  assert.match(dom.element('themeMessage').textContent, /主题系统不可用/)
})

test('the panel and the bridge contain no executable theme injection', () => {
  const bridge = fs.readFileSync(BRIDGE, 'utf8')
  const panel = fs.readFileSync(PANEL, 'utf8')
  for (const [name, source] of [['theme-bridge.js', bridge], ['theme-panel.js', panel]]) {
    assert.ok(!/eval\(/.test(source), `${name} never evaluates theme content`)
    assert.ok(!/new Function/.test(source), `${name} never compiles theme content`)
    assert.ok(!/innerHTML[^\n]*\$\{[^}]*payload\.slots/.test(source), `${name} never interpolates slot styles into markup`)
  }
  // Theme payloads become CSS custom properties, and nothing else.
  assert.ok(bridge.includes('--hns-slot-'), 'the bridge writes slot styles as CSS custom properties')
  assert.ok(bridge.includes('--hns-persona-'), 'the bridge writes the personalization layer as CSS custom properties')
  assert.ok(!/innerHTML[^\n]*payload\.css/.test(bridge), 'the token block never becomes markup')
})
