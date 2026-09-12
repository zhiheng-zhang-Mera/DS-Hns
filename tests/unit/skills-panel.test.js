'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Skills panel (renderer level).
 *
 * Executes the real `ui/skills-panel.js` against a minimal DOM stub with a fake
 * `window.megaTools.skills` bridge, and asserts the behaviours a user actually
 * depends on: quick search, install from a link, one-at-a-time delete, and bulk
 * delete — plus the two properties that keep it honest: a failed operation is
 * reported rather than swallowed, and the panel joins the shared theme bridge so a
 * theme can restyle it and validation can see it.
 */
const BRIDGE = path.resolve(__dirname, '..', '..', 'app', 'extensions', 'mega', 'ui', 'theme-bridge.js')
const PANEL = path.resolve(__dirname, '..', '..', 'app', 'extensions', 'mega', 'ui', 'skills-panel.js')

function makeElement(id) {
  const classes = new Set()
  const handlers = new Map()
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    indeterminate: false,
    hidden: false,
    disabled: false,
    className: '',
    dataset: {},
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, String(value)) }, removeProperty(name) { this.values.delete(name) } },
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
    focus: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 60 }),
    closest: () => null,
    querySelector: () => null
  }
}

const PANEL_IDS = [
  'skillsPanel', 'skillsStatus', 'skillsRefresh', 'skillsPickDir', 'skillSource', 'skillInstallSource',
  'skillQuery', 'skillLiveSearch', 'skillsTags', 'skillsTabBrowse', 'skillsTabInstalled', 'skillsCount',
  'skillSelectAll', 'skillSelectedCount', 'skillDeleteSelected', 'skillsList', 'skillDetail',
  'skillDetailName', 'skillDetailMeta', 'skillDetailBody', 'skillDetailClose', 'skillsMessage'
]

function installDom() {
  const elements = new Map()
  for (const id of PANEL_IDS) elements.set(id, makeElement(id))
  const html = makeElement('html')
  const body = makeElement('body')
  elements.set('html', html)
  elements.set('body', body)
  global.document = {
    body,
    documentElement: html,
    head: { appendChild: () => {} },
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    querySelector: (selector) => {
      // The panel's own selectors resolve to its real elements.
      const map = {
        '#skillsList': elements.get('skillsList'),
        '#skillQuery': elements.get('skillQuery'),
        '#skillsStatus': elements.get('skillsStatus'),
        '#skillsTags': elements.get('skillsTags'),
        '#skillDeleteSelected': elements.get('skillDeleteSelected'),
        '#skillsPanel .panel-head': elements.get('skillsPanel')
      }
      return map[selector] || null
    },
    addEventListener: () => {}
  }
  global.window = globalThis
  return { elements, html, body, element: (id) => elements.get(id) || document.getElementById(id) }
}

function skillRecord(overrides = {}) {
  return {
    name: 'commit-message',
    kind: 'bundle',
    valid: true,
    reason: null,
    description: '按仓库既有风格撰写提交信息',
    origin: 'bundled',
    modelInvocable: true,
    userInvocable: true,
    collection: null,
    ...overrides
  }
}

function snapshot(overrides = {}) {
  const skills = overrides.skills || [skillRecord(), skillRecord({ name: 'repo-tour', origin: 'github', collection: 'anthropics-skills' })]
  return {
    ok: true,
    root: 'C:\\data\\skills',
    skills,
    collections: overrides.collections || [{ id: 'anthropics-skills', skills: ['repo-tour'], count: 1 }],
    counts: overrides.counts || {
      total: skills.length,
      valid: skills.filter((skill) => skill.valid).length,
      invalid: skills.filter((skill) => !skill.valid).length,
      modelInvocable: skills.filter((skill) => skill.modelInvocable !== false).length,
      userInvocable: skills.filter((skill) => skill.userInvocable !== false).length
    },
    catalog: { bundled: 5, curated: 2 }
  }
}

function searchResult(overrides = {}) {
  return {
    ok: true,
    query: '',
    offline: {
      entries: [
        { id: 'bundled-commit-message', name: 'commit-message', summary: '提交信息', tags: ['git'], origin: 'bundled', installable: true },
        { id: 'anthropic-skills', name: 'Anthropic Agent Skills', owner: 'anthropics', repo: 'skills', subpath: 'skills', summary: '官方合集', tags: ['official'], origin: 'curated', installable: true }
      ],
      total: 2
    },
    live: null,
    liveStatus: 'not-requested',
    notices: [],
    ...overrides
  }
}

function loadPanel({ skills = snapshot(), search = searchResult(), handlers = {} } = {}) {
  const dom = installDom()
  const calls = { search: [], installSource: [], installCatalog: [], remove: [], removeMany: [], removeCollection: [], detail: [], pickLocal: [], tags: 0 }
  const themeListeners = { apply: null, changed: null }

  global.confirm = () => true
  global.window.megaTools = {
    theme: {
      paint: async () => ({ ok: true, payload: { id: 'hns.system.dark', name: 'Dark', preview: false, css: '--hns-color-bg-base: #0f1115;', tokens: {}, slots: {}, persona: { enabled: false }, effectLevel: 0, effectLabel: 'full' } }),
      reportRegions: () => {},
      onApply: (handler) => { themeListeners.apply = handler },
      onChanged: (handler) => { themeListeners.changed = handler },
      onProbeRegions: () => {}
    },
    skills: {
      snapshot: async () => (handlers.snapshot ? handlers.snapshot() : skills),
      tags: async () => {
        calls.tags += 1
        return { ok: true, tags: [{ tag: 'git', count: 2 }, { tag: 'official', count: 1 }] }
      },
      detail: async (name) => {
        calls.detail.push(name)
        return handlers.detail ? handlers.detail(name) : { ok: true, name, kind: 'bundle', body: '# body\nline', meta: { origin: 'bundled' } }
      },
      search: async (payload) => {
        calls.search.push(payload)
        return handlers.search ? handlers.search(payload) : search
      },
      installSource: async (payload) => {
        calls.installSource.push(payload)
        return handlers.installSource ? handlers.installSource(payload) : { ok: true, installed: [{ name: 'remote-skill', requestedName: 'remote-skill' }], skipped: [] }
      },
      installCatalog: async (payload) => {
        calls.installCatalog.push(payload)
        return handlers.installCatalog ? handlers.installCatalog(payload) : { ok: true, installed: [{ name: 'commit-message' }], skipped: [] }
      },
      pickLocal: async () => {
        calls.pickLocal.push(true)
        return handlers.pickLocal ? handlers.pickLocal() : { ok: true, canceled: false, path: 'C:\\incoming', result: { ok: true, installed: [{ name: 'local-skill' }], skipped: [] } }
      },
      remove: async (name) => {
        calls.remove.push(name)
        return handlers.remove ? handlers.remove(name) : { ok: true, name }
      },
      removeMany: async (names) => {
        calls.removeMany.push(names)
        return handlers.removeMany ? handlers.removeMany(names) : { ok: true, deleted: names, failed: [] }
      },
      removeCollection: async (collection) => {
        calls.removeCollection.push(collection)
        return handlers.removeCollection ? handlers.removeCollection(collection) : { ok: true, deleted: ['repo-tour'], failed: [] }
      },
      setInvocation: async () => ({ ok: true }),
      onChanged: () => {}
    }
  }

  delete require.cache[require.resolve(BRIDGE)]
  delete require.cache[require.resolve(PANEL)]
  require(BRIDGE)
  require(PANEL)
  const attached = window.megaSkillsPanel.attach()
  dom.attached = attached
  dom.panel = window.megaSkillsPanel
  return { dom, calls, attached, panel: window.megaSkillsPanel }
}

const flush = async (value) => {
  if (value && typeof value.then === 'function') await value
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

async function loaded(options) {
  const harness = loadPanel(options)
  await flush()
  await harness.attached?.settled?.()
  return harness
}

// ---------------------------------------------------------------------------

test('the panel lists discover entries and installed skills on two tabs', async () => {
  const { dom, calls } = await loaded()

  const discover = dom.element('skillsList').innerHTML
  assert.match(discover, /commit-message/)
  assert.match(discover, /Anthropic Agent Skills/)
  assert.match(discover, /精选与内置/)
  assert.equal(dom.element('skillsStatus').textContent, '2 个技能')

  dom.element('skillsTabInstalled').onclick()
  const installed = dom.element('skillsList').innerHTML
  assert.match(installed, /repo-tour/)
  assert.match(installed, /anthropics-skills/, 'collection membership is shown')
  assert.equal(dom.element('skillsCount').textContent, '2 个已安装')

  // The tag chips come from the catalog and are clickable filters.
  assert.match(dom.element('skillsTags').innerHTML, /data-skill-tag="git"/)
  dom.element('skillsTags').fire('click', { target: { dataset: { skillTag: 'git' } } })
  await flush(dom.attached && dom.attached.settled && dom.attached.settled())
  assert.deepEqual(calls.search[calls.search.length - 1].tags, ['git'])
})

test('quick search is debounced and carries the query and filters', async () => {
  const { dom, calls } = await loaded()
  const before = calls.search.length

  dom.element('skillQuery').value = 'hud'
  dom.element('skillQuery').oninput()
  // The debounce means no request has been issued yet.
  assert.equal(calls.search.length, before, 'no request per keystroke')
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flush(dom.attached?.settled?.())
  assert.equal(calls.search.length, before + 1)
  assert.equal(calls.search[calls.search.length - 1].query, 'hud')

  dom.element('skillLiveSearch').checked = true
  dom.element('skillLiveSearch').onchange()
  await flush(dom.attached?.settled?.())
  assert.equal(calls.search[calls.search.length - 1].includeLive, true, 'the GitHub toggle reaches the search')
})

test('installing from a pasted GitHub link goes through the source channel', async () => {
  const { dom, calls } = await loaded()

  dom.element('skillSource').value = 'https://github.com/anthropics/skills/tree/main/skills'
  await flush(dom.element('skillInstallSource').onclick())
  await flush(dom.attached?.settled?.())

  assert.deepEqual(calls.installSource, [{ source: 'https://github.com/anthropics/skills/tree/main/skills' }])
  assert.equal(dom.element('skillSource').value, '', 'the input is cleared after a successful install')
  assert.match(dom.element('skillsMessage').textContent, /已安装 1 个技能/)
  assert.equal(dom.element('skillsTabInstalled').classList.contains('active'), true, 'the view switches to what was installed')
})

test('an empty source is refused before any request', async () => {
  const { dom, calls } = await loaded()
  dom.element('skillSource').value = '   '
  await flush(dom.element('skillInstallSource').onclick())
  assert.deepEqual(calls.installSource, [])
  assert.match(dom.element('skillsMessage').textContent, /请先粘贴/)
})

test('installing a search result uses the catalog channel', async () => {
  const { dom, calls } = await loaded()

  dom.element('skillsList').fire('click', {
    target: { closest: () => ({ dataset: { skillInstall: 'anthropic-skills' } }) }
  })
  await flush(dom.attached?.settled?.())

  assert.deepEqual(calls.installCatalog, [{ id: 'anthropic-skills' }])
  assert.match(dom.element('skillsMessage').textContent, /已安装/)
})

test('a failed install is reported with its reason and installs nothing silently', async () => {
  const { dom } = await loaded({
    handlers: { installSource: async () => ({ ok: false, reason: 'HTTP 404 for archive', installed: [], skipped: [] }) }
  })
  dom.element('skillSource').value = 'owner/missing-repo'
  await flush(dom.element('skillInstallSource').onclick())
  await flush(dom.attached?.settled?.())
  assert.match(dom.element('skillsMessage').textContent, /安装失败：HTTP 404/)
})

test('a partial install reports what was skipped and why', async () => {
  const { dom } = await loaded({
    handlers: {
      installSource: async () => ({
        ok: true,
        installed: [{ name: 'demo-alpha', requestedName: 'alpha' }],
        skipped: [{ name: 'beta', reason: '无法得到合法的技能名' }]
      })
    }
  })
  dom.element('skillSource').value = 'owner/repo'
  await flush(dom.element('skillInstallSource').onclick())
  await flush(dom.attached?.settled?.())

  const message = dom.element('skillsMessage').textContent
  assert.match(message, /已安装 1 个技能/)
  assert.match(message, /demo-alpha/, 'a silent rename is surfaced')
  assert.match(message, /1 个被跳过/)
  assert.match(message, /beta/)
})

test('a local directory pick installs through the picker and reports the outcome', async () => {
  const { dom, calls } = await loaded()
  await flush(dom.element('skillsPickDir').onclick())
  await flush(dom.attached?.settled?.())
  assert.equal(calls.pickLocal.length, 1)
  assert.match(dom.element('skillsMessage').textContent, /local-skill/)
})

test('deleting one skill asks for confirmation and reports success', async () => {
  const { dom, calls } = await loaded()
  dom.element('skillsTabInstalled').onclick()

  dom.element('skillsList').fire('click', { target: { closest: () => ({ dataset: { skillDelete: 'repo-tour' } }) } })
  await flush(dom.attached?.settled?.())

  assert.deepEqual(calls.remove, ['repo-tour'])
  assert.match(dom.element('skillsMessage').textContent, /已删除技能：repo-tour/)
})

test('a refused delete is reported instead of pretending it worked', async () => {
  const { dom } = await loaded({ handlers: { remove: async () => ({ ok: false, reason: 'not_found' }) } })
  dom.element('skillsTabInstalled').onclick()
  dom.element('skillsList').fire('click', { target: { closest: () => ({ dataset: { skillDelete: 'ghost' } }) } })
  await flush(dom.attached?.settled?.())
  assert.match(dom.element('skillsMessage').textContent, /删除失败：not_found/)
})

test('bulk delete sends every selected name and clears the selection', async () => {
  const { dom, calls } = await loaded()
  dom.element('skillsTabInstalled').onclick()

  // Selection starts empty, so the button is inert.
  assert.equal(dom.element('skillDeleteSelected').disabled, true)

  // Select through the card checkbox, as a user would.
  dom.element('skillsList').fire('click', {
    target: { dataset: { skillSelect: 'commit-message' }, checked: true }
  })
  await flush(dom.attached?.settled?.())
  assert.equal(dom.element('skillDeleteSelected').disabled, false)
  assert.match(dom.element('skillSelectedCount').textContent, /已选 1 \/ 2/)

  // Then use select-all, which is the same code path with the derived state.
  dom.element('skillSelectAll').onchange({ target: { checked: true } })
  await flush(dom.attached?.settled?.())
  assert.equal(dom.element('skillDeleteSelected').disabled, false)
  assert.match(dom.element('skillSelectedCount').textContent, /已选 2 \/ 2/)

  await flush(dom.element('skillDeleteSelected').onclick())
  await flush(dom.attached?.settled?.())

  assert.equal(calls.removeMany.length, 1)
  assert.deepEqual(calls.removeMany[0].slice().sort(), ['commit-message', 'repo-tour'])
  assert.equal(dom.element('skillSelectAll').checked, false, 'the selection resets after the batch')
  assert.match(dom.element('skillsMessage').textContent, /已删除 2 个技能/)
})

test('a batch with failures reports both sides of the outcome', async () => {
  const { dom } = await loaded({
    handlers: { removeMany: async (names) => ({ ok: false, requested: names.length, deleted: [names[0]], failed: [{ name: names[1], reason: 'not_found' }] }) }
  })
  dom.element('skillsTabInstalled').onclick()
  dom.element('skillSelectAll').onchange({ target: { checked: true } })
  await flush(dom.attached?.settled?.())
  await flush(dom.element('skillDeleteSelected').onclick())
  await flush(dom.attached?.settled?.())

  const message = dom.element('skillsMessage').textContent
  assert.match(message, /已删除 1 个/)
  assert.match(message, /1 个失败/)
})

test('deleting a whole collection is one action from a member card', async () => {
  const { dom, calls } = await loaded()
  dom.element('skillsTabInstalled').onclick()
  dom.element('skillsList').fire('click', { target: { closest: () => ({ dataset: { skillCollection: 'anthropics-skills' } }) } })
  await flush(dom.attached?.settled?.())
  assert.deepEqual(calls.removeCollection, ['anthropics-skills'])
  assert.match(dom.element('skillsMessage').textContent, /已删除合集/)
})

test('viewing a skill shows its body without interpreting it', async () => {
  const { dom, calls } = await loaded()
  dom.element('skillsTabInstalled').onclick()
  dom.element('skillsList').fire('click', { target: { closest: () => ({ dataset: { skillDetail: 'commit-message' } }) } })
  await flush(dom.attached?.settled?.())

  assert.deepEqual(calls.detail, ['commit-message'])
  assert.equal(dom.element('skillDetail').hidden, false)
  assert.equal(dom.element('skillDetailName').textContent, 'commit-message')
  assert.equal(dom.element('skillDetailBody').textContent, '# body\nline', 'the body is text, never markup')

  dom.element('skillDetailClose').onclick()
  assert.equal(dom.element('skillDetail').hidden, true)
})

test('the panel joins the shared theme bridge as a themable module', async () => {
  const { dom } = await loaded()
  assert.ok(window.megaThemeBridge, 'the panel loads the bridge')
  assert.deepEqual(window.megaThemeBridge.modules, ['skills'])

  const measured = window.megaThemeBridge.reportRegions()
  assert.ok(measured)
  assert.ok(measured['hns.skill.card'], 'the skill list is measured for theme validation')
  assert.ok(measured['skills-search'], 'the search box is a protected region')
  assert.ok(measured['skills-list'])
})

test('the panel is inert when the skills service is unavailable', async () => {
  const dom = installDom()
  global.window.megaTools = { theme: null }
  delete require.cache[require.resolve(BRIDGE)]
  delete require.cache[require.resolve(PANEL)]
  require(BRIDGE)
  require(PANEL)
  const attached = window.megaSkillsPanel.attach()
  assert.equal(attached, null)
  assert.match(dom.element('skillsMessage').textContent, /技能管理不可用/)
})

test('a search that fails to reach GitHub still shows the offline results', async () => {
  const { dom } = await loaded({
    handlers: {
      search: async () => searchResult({ live: null, liveStatus: 'failed', notices: ['GitHub 搜索不可用：rate limited'] })
    }
  })
  await flush(dom.attached?.settled?.())
  assert.match(dom.element('skillsList').innerHTML, /Anthropic Agent Skills/)
  assert.match(dom.element('skillsMessage').textContent, /GitHub 搜索不可用/)
})

test('the panel source never evaluates or injects skill content', () => {
  const source = fs.readFileSync(PANEL, 'utf8')
  assert.ok(!/eval\(/.test(source), 'no eval')
  assert.ok(!/new Function/.test(source), 'no dynamic compilation')
  // Skill text reaches the DOM only through the escaper. The exceptions are values
  // used for control flow (a ternary condition, a count) which never become markup.
  // Only interpolations that sit in a markup position can inject: a text node or an
  // attribute value. Values used in comparisons or counts cannot.
  const markupInterpolations = [...source.matchAll(/([>"'])\s*\$\{([^}]*)\}/g)].map((match) => match[2])
  const unescaped = markupInterpolations.filter((expression) => {
    if (/\?\s*$/.test(expression)) return false
    if (/^\s*(entry|skill|result)\.(reason|installed|skipped|deleted|failed)\b/.test(expression)) return false
    if (!/\b(entry|skill|result)\.[a-zA-Z_]/.test(expression)) return false
    return !/esc\(/.test(expression)
  })
  assert.deepEqual(unescaped, [], `unescaped skill values in markup: ${unescaped.join(' | ')}`)
})
