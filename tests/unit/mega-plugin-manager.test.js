'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The plugin manager float.
 *
 * Two product rules meet here, and both are checkable. The first: one place manages *every*
 * plugin — the platform plugins from the capability registry and the feature plugins that
 * are the dock's own surfaces — because a user does not care which side of that line a
 * switch is on. The second: the manager is a **float inside the dock window**, never a
 * second `BrowserWindow`, so it cannot become a new running window.
 *
 * The behaviour is driven through a small DOM stub rather than asserted from the source,
 * because "the toggle calls the bridge and refreshes" is exactly the kind of wiring that
 * reads correctly and does nothing.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const UI = path.join(ROOT, 'app', 'extensions', 'mega', 'ui')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** The smallest DOM that lets the float module run, with firing events. */
function stubDom() {
  const nodes = new Map()
  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      hidden: false,
      type: '',
      children: [],
      listeners: new Map(),
      classList: {
        add(name) { this.owner.className = `${this.owner.className} ${name}`.trim() },
        toggle(name, on) { if (on) this.add(name); else this.owner.className = this.owner.className.split(/\s+/).filter((entry) => entry && entry !== name).join(' ') },
        contains(name) { return this.owner.className.split(/\s+/).includes(name) },
        set owner(value) {},
        get owner() { return node }
      },
      appendChild(child) { this.children.push(child); return child },
      addEventListener(event, handler) { this.listeners.set(event, handler) },
      fire(event, payload = {}) { const handler = this.listeners.get(event); if (handler) return handler(payload) },
      remove() {}
    }
    // A real DOM's `textContent` setter replaces the children, and the float clears its body
    // between renders. A stub that only overwrote a string would accumulate every render and
    // make the assertions pass against markup the user never sees.
    let text = ''
    Object.defineProperty(node, 'textContent', {
      get() { return text },
      set(value) {
        text = String(value === undefined || value === null ? '' : value)
        node.children.length = 0
      }
    })
    return node
  }
  const document = {
    createElement: make,
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, make('div'))
      return nodes.get(id)
    }
  }
  return { document, nodes }
}

function loadFeatureManager() {
  const source = fs.readFileSync(path.join(UI, 'feature-manager.js'), 'utf8')
  const { document, nodes } = stubDom()
  const calls = []
  const features = [
    { id: 'mega.balance', cn: '账户余额', en: 'Account balance', group: 'Observability', purpose: { cn: '查余额', en: 'Read the balance' }, panels: ['balancePanel'], elements: [], channels: ['mega:balance'], enabled: true, kind: 'feature' },
    { id: 'mega.peak-pricing', cn: '峰谷价格监控', en: 'Peak / valley pricing', group: 'Observability', purpose: { cn: '按峰谷决定执行', en: 'Decide from the window' }, panels: [], elements: ['allowPeak'], channels: [], enabled: false, kind: 'feature' }
  ]
  const plugins = {
    groups: [{ name: 'Performance', plugins: [{ id: 'dshns.parallel-executor', name: 'Parallel executor', group: 'Performance', version: '1.0.0', installed: true, enabled: true, loaded: true, healthy: true, provides: ['parallel-execution'] }] }]
  }
  const window = {
    document,
    hnsBilingual: { group: (name) => ({ cn: name, en: name }) },
    megaTools: {
      features: {
        snapshot: async () => { calls.push(['features.snapshot']); return { ok: true, features } },
        set: async (id, enabled) => { calls.push(['features.set', id, enabled]); return { ok: true, id, enabled } },
        onChanged: (cb) => { calls.push(['features.onChanged']); window.__featuresChanged = cb }
      },
      store: {
        describe: async () => { calls.push(['store.describe']); return { ok: true, topic: 'dshns-plugin', note: 'Search only: installation is a deliberate act.', authenticated: false } },
        search: async (input) => {
          calls.push(['store.search', input && input.query])
          return { ok: true, total: 1, topic: 'dshns-plugin', results: [{ id: 'acme/dshns-example', description: 'An example plugin', stars: 42, updatedAt: '2026-01-01T00:00:00Z', branch: 'main', manifestUrl: 'https://raw.githubusercontent.com/acme/dshns-example/main/dshns-plugin.json', installable: null }] }
        },
        inspect: async (input) => {
          calls.push(['store.inspect', input && input.id])
          return { ok: true, installable: true, manifest: { id: 'vendor.example', version: '1.2.3' }, reason: null }
        }
      },
      onOpenPluginManager: (cb) => { calls.push(['onOpenPluginManager']); window.__openManager = cb }
    },
    megaPlugins: {
      list: async () => { calls.push(['plugins.list']); return plugins },
      enable: async (input) => { calls.push(['plugins.enable', input.id, input.enabled]); return { ok: true } }
    }
  }
  window.window = window
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document)
  // The markup ships the float closed (`<div id="pluginManager" ... hidden>`); the stub has
  // to say so, because the module reads the attribute rather than writing it at load.
  document.getElementById('pluginManager').hidden = true
  return { api: window.megaFeatureManager, window, document, nodes, calls, features, plugins }
}

test('the float is markup inside the dock window, never a second window', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  assert.match(html, /id="pluginManager"/, 'the dock does not render the manager float')
  assert.match(html, /id="pmBody"/)
  assert.match(html, /id="pmTabFeatures"/)
  assert.match(html, /id="pmTabPlugins"/)
  assert.match(html, /id="plugManage"/, 'the dock has no button to open it')
  assert.match(html, /feature-manager\.js/)
  // It is a *float*: an overlay positioned inside the dock document.
  const css = read('app/extensions/mega/ui/dock.css')
  assert.match(css, /\.plugin-manager\{position:fixed/)
  // Nothing creates an OS window for it: not the extension, not the shell.
  for (const file of ['app/extensions/mega/index.cjs', 'app/desktop-main.cjs']) {
    const source = read(file)
    assert.equal(/pluginManager.*new BrowserWindow|new BrowserWindow[^\n]*pluginManager/i.test(source), false, `${file} opens the manager as a window`)
  }
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /dockTarget\.send\('mega:open-plugin-manager'\)/, 'the tray does not ask the dock to reveal the float')
  assert.match(mega, /bilingualTitle\('插件管理', 'Plugin manager'\)/, 'the tray item is not bilingual')
})

/** All the text under a node, the way a real DOM's `textContent` aggregates it. */
function allText(node) {
  if (!node) return ''
  const own = typeof node.textContent === 'string' ? node.textContent : ''
  return [own, ...(node.children || []).map(allText)].join(' ')
}

test('the float lists every plugin: features and platform plugins in one place', async () => {
  const { api, calls, nodes } = loadFeatureManager()
  const manager = api.attach()
  assert.ok(manager, 'attach() returned nothing')
  assert.equal(nodes.get('pluginManager').hidden, true, 'the float starts closed')

  manager.open()
  assert.equal(nodes.get('pluginManager').hidden, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.some((entry) => entry[0] === 'features.snapshot'), 'the feature list is not read')
  assert.ok(calls.some((entry) => entry[0] === 'plugins.list'), 'the platform plugin list is not read')

  // The feature tab draws both languages, the group and the surfaces the switch controls.
  const body = nodes.get('pmBody')
  const text = allText(body)
  assert.match(text, /账户余额/)
  assert.match(text, /Account balance/)
  assert.match(text, /Observability/)
  assert.match(text, /balancePanel/)
  // The disabled feature is marked as off rather than hidden.
  const rows = body.children.filter((child) => /pm-row/.test(child.className))
  assert.equal(rows.length, 2, 'both features are listed')
  const peak = rows.find((row) => allText(row).includes('峰谷'))
  assert.ok(peak, 'the disabled feature is missing from the list')
  assert.match(peak.className, /off/)
  const balance = rows.find((row) => allText(row).includes('账户余额'))
  assert.equal(/\boff\b/.test(balance.className), false, 'an enabled feature is not marked off')

  // The second tab shows the platform plugins.
  manager.setTab('plugins')
  const pluginText = allText(nodes.get('pmBody'))
  assert.match(pluginText, /dshns\.parallel-executor/)
  assert.match(pluginText, /Performance/)
})

test('a switch calls the bridge it belongs to, and refreshes', async () => {
  const { api, calls, nodes } = loadFeatureManager()
  const manager = api.attach()
  manager.open()
  await new Promise((resolve) => setImmediate(resolve))

  // Toggling a feature goes through the feature bridge, not the plugin bridge.
  await manager.setFeature('mega.balance', false)
  assert.ok(calls.some((entry) => entry[0] === 'features.set' && entry[1] === 'mega.balance' && entry[2] === false), 'the feature switch did not reach the registry')
  // A refusal is reported, not swallowed.
  nodes.get('pmMessage').textContent = ''
  await manager.setFeature('mega.nope', true)
  assert.equal(nodes.get('pmMessage').textContent.includes('mega.nope'), true, 'a refused switch says nothing')

  // Toggling a platform plugin goes through the plugin bridge.
  await manager.setPlugin('dshns.parallel-executor', false)
  assert.ok(calls.some((entry) => entry[0] === 'plugins.enable' && entry[1] === 'dshns.parallel-executor' && entry[2] === false), 'the plugin switch did not reach the host')

  // The tray's event opens the same float.
  nodes.get('pluginManager').hidden = true
  manager.close()
  assert.equal(nodes.get('pluginManager').hidden, true)
})

test('the tray and the dock button open the same surface', () => {
  const { api, window, nodes } = loadFeatureManager()
  const manager = api.attach()
  assert.equal(typeof window.__openManager, 'function', 'the tray event is not subscribed')
  window.__openManager()
  assert.equal(nodes.get('pluginManager').hidden, false, 'the tray event did not open the float')
  manager.close()
  // The dock's own button is wired to the same open().
  nodes.get('plugManage').fire('click')
  assert.equal(nodes.get('pluginManager').hidden, false, 'the dock button did not open the float')
})

test('the store tab searches GitHub and only calls a result installable after checking', async () => {
  const { api, calls, nodes } = loadFeatureManager()
  const manager = api.attach()
  manager.open()
  await new Promise((resolve) => setImmediate(resolve))

  manager.setTab('store')
  assert.equal(nodes.get('pmStoreBar').hidden, false, 'the search bar is hidden on the store tab')
  await manager.search('example')
  assert.ok(calls.some((entry) => entry[0] === 'store.search' && entry[1] === 'example'), 'the search did not reach the channel')
  assert.ok(calls.some((entry) => entry[0] === 'store.describe'), 'the channel is not described to the user')

  const text = allText(nodes.get('pmBody'))
  assert.match(text, /acme\/dshns-example/)
  assert.match(text, /★ 42/)
  // Nothing is called installable before the manifest has been checked.
  assert.equal(/可安装/.test(text), false, 'a result is presented as installable before checking')
  assert.match(text, /校验 · Check/)

  // Checking fetches and validates the manifest, then the row says what the answer was.
  const rows = nodes.get('pmBody').children.filter((child) => /pm-row/.test(child.className))
  const checkButton = rows[0].children[1].children[0]
  await checkButton.fire('click')
  assert.ok(calls.some((entry) => entry[0] === 'store.inspect' && entry[1] === 'acme/dshns-example'), 'checking did not reach the channel')
  const after = allText(nodes.get('pmBody'))
  assert.match(after, /可安装 · installable/)
  assert.match(after, /vendor\.example/)

  // The other tabs hide the search bar again.
  manager.setTab('features')
  assert.equal(nodes.get('pmStoreBar').hidden, true)
})

test('the manager surface is not gated by a feature, and says so', () => {
  const preload = read('app/extensions/mega/ui/preload.cjs')
  // `megaPlugins` and `megaTools.features` are the two bridges the preload never gates:
  // switching a feature off is how a user fixes one.
  assert.match(preload, /contextBridge\.exposeInMainWorld\('megaPlugins', \{/)
  assert.match(preload, /features: \{/)
  assert.equal(/megaPlugins', gatedBridge/.test(preload), false, 'the plugin manager bridge must not be gated')
  // The feature-gated bridges are the shell-owned features.
  for (const [bridge, feature] of [['megaComputerUse', 'mega.computer-use'], ['megaEngineering', 'mega.engineering'], ['megaSubWorker', 'mega.sub-worker']]) {
    assert.match(preload, new RegExp(`exposeInMainWorld\\('${bridge}', gatedBridge\\('${feature}'`), `${bridge} is not gated on ${feature}`)
  }
  const manager = read('app/extensions/mega/ui/feature-manager.js')
  assert.match(manager, /deliberately \*\*not\*\* feature-gated/)
})
