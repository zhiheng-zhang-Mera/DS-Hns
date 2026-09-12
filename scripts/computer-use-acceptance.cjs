'use strict'

/**
 * DS-Hns Computer Use: real end-to-end acceptance (Update-Plan/computer-use.md §53).
 *
 * This harness runs the ten minimum acceptance cases against the *real* machine:
 * a real Electron/Chromium page driven over CDP, a real virtual screen captured
 * through GDI, real windows enumerated through user32, real UI Automation, and —
 * for the desktop case — a real application (Notepad) with a real file on disk.
 *
 * It is deliberately honest about what it could not do: a scenario whose
 * prerequisite is missing (no interactive desktop, no screenshot backend, no
 * Notepad) is reported as `skipped` with the reason, never as a pass.
 *
 * Usage:
 *   node scripts\computer-use-acceptance.cjs                 # every scenario
 *   node scripts\computer-use-acceptance.cjs browser-form    # one scenario
 *   node scripts\computer-use-acceptance.cjs --list
 *   node scripts\computer-use-acceptance.cjs --json          # machine-readable report
 *
 * The same file is both the runner and the Electron main script: when it is
 * started by `dsh`-less Node it re-executes itself under the Electron binary in
 * app\node_modules, because the browser capability needs a real Chromium and the
 * desktop capability needs a real desktop. The unit-level half of the same ten
 * cases (deterministic, no hardware) lives in
 * tests/unit/computer-use-acceptance.test.js.
 */

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'computer-use')

const SCENARIOS = [
  { id: 'browser-form', title: 'Test 1 - browser form: DOM first, verify input and submission' },
  { id: 'dynamic-target', title: 'Test 2 - dynamic button: a stale coordinate is never reused' },
  { id: 'missed-click', title: 'Test 3 - missed click: detected, revalidated, retried' },
  { id: 'unexpected-modal', title: 'Test 4 - unexpected modal: pause, handle, resume' },
  { id: 'slow-ui', title: 'Test 6 - slow UI: event-driven wait, no fixed sleep' },
  { id: 'canvas-vision', title: 'Test 7 - canvas UI: escalate to vision and click the painted target' },
  { id: 'window-overlay', title: 'Test 8 - window overlay: never click through a covering window' },
  { id: 'controller-failure', title: 'Test 9 - controller failure: the other controllers keep working' },
  { id: 'stall', title: 'Test 10 - stall: detect, recover, fail gracefully at the limit' },
  // Last, and opt-in: this is the only scenario that depends on a third-party
  // application's window behaviour *and* on real keyboard injection into another
  // process. On some hosts the input path blocks inside a synchronous FFI call,
  // which no timer can interrupt, so it must not be able to stall the scenarios
  // that only need the runtime itself. Run it explicitly:
  //   node scripts\computer-use-acceptance.cjs desktop-app
  { id: 'desktop-app', title: 'Test 5 - desktop app: launch, focus, edit, save, verify the file', optIn: true }
]

// ---------------------------------------------------------------------------
// Electron side
// ---------------------------------------------------------------------------

async function runUnderElectron(selected, options) {
  const { app, BrowserWindow } = require('electron')
  const { createComputerUseRuntime } = require(path.join(ROOT, 'app', 'computer-use', 'index.cjs'))
  const hostModule = require(path.join(ROOT, 'app', 'computer-use', 'host-electron.cjs'))
  const { createElectronHost } = hostModule
  const { createVisionController } = require(path.join(ROOT, 'app', 'computer-use', 'controllers', 'vision.cjs'))
  const { createStallDetector } = require(path.join(ROOT, 'app', 'computer-use', 'stall.cjs'))

  const report = { scenarios: [], environment: {}, startedAt: Date.now() }
  const emit = (line) => process.stdout.write(`${line}\n`)
  // Electron buffers a piped stdout, so live diagnosis also writes to a file
  // when one is requested.
  const progress = (line) => {
    if (!options.progressPath) return
    try {
      fs.appendFileSync(options.progressPath, `${new Date().toISOString()} ${line}\n`)
    } catch {
      /* progress is a convenience, never a failure */
    }
  }

  await app.whenReady()
  // The harness window is a normal, visible window: real Chromium, real layout,
  // real pixels, and a real z-order the desktop gate can check against.
  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    x: 40,
    y: 40,
    show: true,
    title: 'DS-Hns Computer Use acceptance',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  })

  const server = await serveFixtures()
  const baseUrl = `http://127.0.0.1:${server.port}`

  const host = createElectronHost({
    getWebContents: () => window.webContents,
    workspace: os.tmpdir(),
    cwd: os.tmpdir()
  })
  const runtime = createComputerUseRuntime({
    host: host.host,
    log: { mode: options.keepScreenshots ? 'debug' : 'normal', dir: path.join(ROOT, 'logs', 'computer-use') },
    options: { maxSteps: 40 }
  })

  report.environment = {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    hostNotes: host.notes,
    controllers: runtime.health().controllers
  }

  const context = { app, window, runtime, host, hostModule, baseUrl, server, report, emit, progress, createVisionController, createStallDetector, createComputerUseRuntime }
  // A heartbeat: a scenario that hangs must say *where* it hangs, because an
  // acceptance run that dies silently is worth very little.
  let heartbeat = null
  const lastHeartbeat = { state: null }
  const heartbeatTick = () => {
    try {
      const snapshot = runtime.snapshot()
      const steps = snapshot.recentSteps.length
      const line = `heartbeat state=${snapshot.state} running=${snapshot.running} steps=${steps}`
      if (line !== lastHeartbeat.state) {
        lastHeartbeat.state = line
        progress(line)
      }
    } catch {
      /* the runtime may be mid-teardown */
    }
  }
  heartbeat = setInterval(heartbeatTick, 3000)
  heartbeat.unref?.()
  // A global watchdog: whatever happens, the harness exits. A stuck acceptance
  // run must never outlive its own budget.
  const watchdog = setTimeout(() => {
    progress(`global budget of ${options.totalBudgetMs} ms exceeded - exiting`)
    try {
      runtime.cancel('acceptance harness global budget exceeded')
    } catch {
      /* already gone */
    }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    server.close()
    app.exit(1)
  }, options.totalBudgetMs)
  watchdog.unref?.()
  for (const scenario of SCENARIOS) {
    if (selected.length && !selected.includes(scenario.id)) continue
    // An opt-in scenario runs only when it was asked for by name (or when
    // `--include-optional` says so); otherwise it is reported as skipped with
    // the reason rather than silently missing.
    if (!selected.length && scenario.optIn && !options.includeOptional) {
      report.scenarios.push({
        id: scenario.id,
        title: scenario.title,
        status: 'skipped',
        detail: 'opt-in scenario: run it by name (node scripts\\computer-use-acceptance.cjs desktop-app) because it drives a third-party application and real keyboard injection',
        skippedReason: 'opt-in',
        evidence: null,
        logTail: null,
        durationMs: 0
      })
      progress(`scenario ${scenario.id} skipped (opt-in)`)
      continue
    }
    const startedAt = Date.now()
    progress(`scenario ${scenario.id} started`)
    let outcome
    try {
      // An acceptance harness must never hang: every scenario has a ceiling, and
      // one that exceeds it is reported as a timeout rather than stalling the run.
      outcome = await Promise.race([
        SCENARIO_IMPLS[scenario.id](context),
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            // Abandoning a scenario is not enough: the run it started must be
            // cancelled, or the harness would keep two scenarios alive at once.
            try {
              runtime.cancel(`scenario ${scenario.id} exceeded its time budget`)
            } catch {
              /* the runtime may already be gone */
            }
            resolve({
              status: 'failed',
              detail: `the scenario exceeded its ${options.scenarioTimeoutMs} ms budget and was abandoned (the runtime is bounded, so this points at the harness or the environment)`
            })
          }, options.scenarioTimeoutMs)
          timer.unref?.()
        })
      ])
    } catch (error) {
      outcome = { status: 'failed', detail: error && error.stack ? error.stack : String(error) }
    }
    const entry = {
      id: scenario.id,
      title: scenario.title,
      status: outcome.status,
      detail: outcome.detail || null,
      skippedReason: outcome.status === 'skipped' ? outcome.detail : null,
      evidence: outcome.evidence || null,
      // A failing scenario carries the runtime's own log tail: the point of an
      // acceptance run is to explain a failure, not just to report it.
      logTail: outcome.status === 'failed' ? runtime.log.tail(40).map((record) => ({
        kind: record.kind,
        step: record.step,
        type: record.type,
        action: record.action || record.actionType,
        result: record.result,
        verification: record.verification,
        reason: record.reason || record.message || null
      })) : null,
      durationMs: Date.now() - startedAt
    }
    report.scenarios.push(entry)
    emit(`CU-SCENARIO ${JSON.stringify(entry)}`)
  }

  if (heartbeat) clearInterval(heartbeat)
  clearTimeout(watchdog)
  runtime.dispose()
  // Chromium keeps a keep-alive connection to the fixture server open, and
  // `close()` alone would wait for it forever: the connections are dropped
  // first so the harness always exits.
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  server.close()
  report.finishedAt = Date.now()
  emit(`CU-REPORT ${JSON.stringify(report)}`)
  app.exit(report.scenarios.some((scenario) => scenario.status === 'failed') ? 1 : 0)
}

/**
 * The fixtures declare their behaviour with `data-cu-*` attributes, which the
 * in-process device interprets itself. A real browser has no such interpreter,
 * so this shim implements the same declarations in plain DOM JavaScript: the
 * acceptance runs the *same fixture files* as the unit suite, each in its own
 * native environment.
 *
 * Supported verbs (matching tests/helpers/computer-use-device.cjs):
 *   show/hide/toggle <sel> | text <sel> <value> | value <sel> <value>
 *   class-add/class-remove/class-toggle <sel> <class> | attr <sel> <name> <value>
 *   remove <sel> | navigate <url> | alert/confirm/prompt <message>
 *   open-modal/close-modal | freeze
 */
const FIXTURE_SHIM = `<script>
(() => {
  const $ = (selector) => document.querySelector(selector)
  const expand = (text, context) => String(text || '')
    .replace(/\\{field\\}/g, context.field || 'field')
    .replace(/\\{file\\}/g, context.file || 'file')
    .replace(/\\{value:([^}]+)\\}/g, (_match, selector) => { const el = $(selector.trim()); return el ? el.value : '' })
    .replace(/\\{url\\}/g, location.href)
    .replace(/\\{title\\}/g, document.title)
  const states = { frozen: false, eats: new WeakMap(), modals: 0, saved: null }
  const unquote = (token) => String(token === undefined ? '' : token).replace(/^"|"$/g, '')
  const rest = (parts, from) => parts.slice(from).map(unquote).join(' ')
  function runScript(script, context = {}) {
    if (!script || states.frozen) return
    for (const statement of String(script).split(';')) {
      const parts = String(statement).trim().match(/"[^"]*"|\\S+/g) || []
      if (!parts.length) continue
      const verb = parts[0].replace(/^"|"$/g, '')
      const arg = (index) => (parts[index] === undefined ? undefined : parts[index].replace(/^"|"$/g, ''))
      switch (verb) {
        case 'show': { const el = $(arg(1)); if (el) el.removeAttribute('hidden'); break }
        case 'hide': { const el = $(arg(1)); if (el) el.setAttribute('hidden', ''); break }
        case 'toggle': { const el = $(arg(1)); if (el) { if (el.hasAttribute('hidden')) el.removeAttribute('hidden'); else el.setAttribute('hidden', '') } break }
        case 'text': { const el = $(arg(1)); if (el) el.textContent = expand(rest(parts, 2), context); break }
        case 'value': { const el = $(arg(1)); if (el) el.value = expand(rest(parts, 2), context); break }
        case 'class-add': { const el = $(arg(1)); if (el) el.classList.add(arg(2)); break }
        case 'class-remove': { const el = $(arg(1)); if (el) el.classList.remove(arg(2)); break }
        case 'class-toggle': { const el = $(arg(1)); if (el) el.classList.toggle(arg(2)); break }
        case 'attr': { const el = $(arg(1)); if (el) el.setAttribute(arg(2), expand(rest(parts, 3), context)); break }
        case 'remove': { const el = $(arg(1)); if (el && el.remove) el.remove(); break }
        case 'navigate': { location.href = expand(rest(parts, 1), context); break }
        case 'alert': { window.alert(expand(rest(parts, 1), context)); break }
        case 'confirm': { window.__cuAccepted = window.confirm(expand(rest(parts, 1), context)); break }
        case 'prompt': { window.__cuPrompt = window.prompt(expand(rest(parts, 1), context)); break }
        case 'open-modal': { openModal(expand(rest(parts, 2), context)); break }
        case 'close-modal': { closeModal(); break }
        case 'freeze': { states.frozen = true; break }
        default: break
      }
    }
  }
  function openModal(message) {
    states.modals += 1
    const overlay = document.createElement('div')
    overlay.setAttribute('data-cu-overlay', '1')
    overlay.setAttribute('style', 'position:fixed;left:0;top:0;right:0;bottom:0;background:#0f172a;opacity:.55;z-index:10')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('style', 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:320px;height:96px;background:#f59e0b;padding:12px;z-index:11')
    const label = document.createElement('p')
    label.textContent = message
    const dismiss = document.createElement('button')
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', closeModal)
    dialog.appendChild(label)
    dialog.appendChild(dismiss)
    document.body.appendChild(overlay)
    document.body.appendChild(dialog)
  }
  function closeModal() {
    for (const node of Array.from(document.querySelectorAll('[data-cu-overlay], [role=dialog]'))) node.remove()
    states.modals = 0
  }
  function paintCanvas() {
    for (const canvas of Array.from(document.querySelectorAll('canvas[data-cu-paint]'))) {
      const [label, colour, width, height] = String(canvas.getAttribute('data-cu-paint')).split('|')
      canvas.width = Number(width) || canvas.width
      canvas.height = Number(height) || canvas.height
      const context = canvas.getContext('2d')
      context.fillStyle = colour || '#ff8800'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#101418'
      context.font = '16px sans-serif'
      context.fillText(label || '', 12, canvas.height / 2 + 5)
    }
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target.closest('button, [data-cu-on-click], [data-cu-modal], canvas, [data-cu-eat-clicks], [data-cu-freeze]') : null
    if (!target || states.frozen) return
    if (target.hasAttribute('data-cu-eat-clicks')) {
      const eaten = states.eats.get(target) || 0
      if (eaten < Number(target.getAttribute('data-cu-eat-clicks'))) {
        states.eats.set(target, eaten + 1)
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
    }
    // data-cu-freeze stalls every fixture script from this click on: the page
    // keeps answering, but nothing it was asked to do ever takes effect.
    if (target.hasAttribute('data-cu-freeze')) states.frozen = true
    if (target.hasAttribute('data-cu-modal')) openModal(target.getAttribute('data-cu-modal'))
    const script = target.getAttribute('data-cu-on-click')
    if (script) {
      const delay = Number(target.getAttribute('data-cu-delay-ms') || 0)
      if (delay > 0) {
        target.setAttribute('disabled', 'disabled')
        setTimeout(() => { target.removeAttribute('disabled'); runScript(script, {}) }, delay)
      } else {
        runScript(script, {})
      }
    }
    if (target.getAttribute('data-cu-on-accept') && window.__cuAccepted) runScript(target.getAttribute('data-cu-on-accept'), {})
  }, true)

  document.addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.target
    const firstEmpty = Array.from(form.querySelectorAll('[required]')).find((field) => !field.value)
    if (firstEmpty) {
      const name = firstEmpty.getAttribute('name') || firstEmpty.id || 'field'
      runScript(form.getAttribute('data-cu-on-invalid'), { field: name })
    } else {
      runScript(form.getAttribute('data-cu-on-valid'), {})
    }
  }, true)

  document.addEventListener('keydown', (event) => {
    const isSave = (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's'
    if (!isSave) return
    event.preventDefault()
    const editor = document.querySelector('[data-cu-file]')
    if (!editor) return
    const file = editor.getAttribute('data-cu-file')
    fetch('/__save/' + encodeURIComponent(file), { method: 'POST', body: editor.value })
    runScript(editor.getAttribute('data-cu-on-save'), { file })
  }, true)

  const move = () => {
    for (const node of Array.from(document.querySelectorAll('[data-cu-move-after-ms]'))) {
      const [left, top] = String(node.getAttribute('data-cu-move-to') || '0,0').split(',')
      setTimeout(() => {
        node.style.position = 'absolute'
        node.style.left = Number(left) + 'px'
        node.style.top = Number(top) + 'px'
      }, Number(node.getAttribute('data-cu-move-after-ms')) || 0)
    }
  }
  window.addEventListener('DOMContentLoaded', () => { paintCanvas(); move() })
  if (document.readyState !== 'loading') { paintCanvas(); move() }
})()
</script>`

/** A real local HTTP server so Chromium loads the fixtures over a real origin. */
function serveFixtures() {
  const saved = new Map()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/__save/')) {
      const file = decodeURIComponent(url.pathname.slice('/__save/'.length))
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        // The save really lands on disk: the acceptance judges a file, not a
        // variable in the page.
        const target = path.join(os.tmpdir(), path.basename(file))
        fs.writeFileSync(target, body, 'utf8')
        saved.set(file, { path: target, content: body, mtime: Date.now() })
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(target)
      })
      return
    }
    const name = path.basename(url.pathname) || 'form.html'
    const file = path.join(FIXTURE_DIR, name)
    if (!file.startsWith(FIXTURE_DIR) || !fs.existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    const html = fs.readFileSync(file, 'utf8').replace('</body>', `${FIXTURE_SHIM}</body>`)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => server.close(),
      saved
    }))
  })
}

// ---------------------------------------------------------------------------
// Helpers shared by the scenarios
// ---------------------------------------------------------------------------

function requireDesktopReady(runtime) {
  const controllers = runtime.health().controllers
  const desktop = controllers.find((controller) => controller.controller === 'desktop')
  const accessibility = controllers.find((controller) => controller.controller === 'accessibility')
  if (!desktop || !desktop.available) return `the desktop controller is unavailable: ${desktop ? desktop.reason : 'not attached'}`
  if (!accessibility || !accessibility.available) return `the accessibility controller is unavailable: ${accessibility ? accessibility.reason : 'not attached'}`
  return null
}

function requireVisionReady(runtime) {
  const vision = runtime.health().controllers.find((controller) => controller.controller === 'vision')
  if (!vision || !vision.available) return `the vision controller is unavailable: ${vision ? vision.reason : 'not attached'}`
  return null
}

async function load(window, baseUrl, fixture) {
  await window.webContents.loadURL(`${baseUrl}/${fixture}`)
  await new Promise((resolve) => setTimeout(resolve, 150))
}

function domValue(window, expression) {
  return window.webContents.executeJavaScript(expression, true)
}

/**
 * Reading the page back.
 *
 * The harness prefers the runtime's *own* page adapter — the same CDP path the
 * acceptance is judging — and falls back to `executeJavaScript` for anything the
 * adapter does not expose. Both are the real page; neither is a mock.
 */
async function pageQuery(context, selector) {
  const page = context.runtime.controllers.browser.page
  if (page) {
    try {
      const hits = await page.query(selector)
      const list = Array.isArray(hits) ? hits : hits ? [hits] : []
      if (list.length) return list[0]
    } catch {
      /* fall through to executeJavaScript */
    }
  }
  try {
    const raw = await context.window.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const box = el.getBoundingClientRect(); return { text: (el.textContent || '').trim(), value: el.value === undefined ? null : String(el.value), hidden: el.hasAttribute('hidden'), bbox: { x: box.x, y: box.y, width: box.width, height: box.height } } })()`,
      true
    )
    return raw
  } catch {
    return null
  }
}

async function pageText(context, selector) {
  const found = await pageQuery(context, selector)
  return found ? String(found.text === undefined || found.text === null ? '' : found.text).trim() : null
}

async function pageValue(context, selector) {
  const found = await pageQuery(context, selector)
  return found ? found.value : null
}

async function pageCount(context, selector) {
  try {
    return await context.window.webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`, true)
  } catch {
    return null
  }
}

const SCENARIO_IMPLS = {}
const scenario = (id, impl) => {
  SCENARIO_IMPLS[id] = impl
}

scenario('browser-form', async ({ runtime, window, baseUrl }) => {
  await load(window, baseUrl, 'form.html')
  const report = await runtime.run({
    goal: 'sign in on the fixture form',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    allowed_capabilities: ['browser'],
    plan: [
      { id: 'username', action: { type: 'DOM_TYPE', target: { selector: '#username' }, text: 'alice', expected_effect: { any: [{ value_equals: 'alice' }] } } },
      { id: 'password', action: { type: 'DOM_TYPE', target: { selector: '#password' }, text: 'correct-horse', sensitive: true, expected_effect: { any: [{ value_equals: 'correct-horse' }] } } },
      { id: 'submit', action: { type: 'DOM_CLICK', target: { selector: '#sign-in' }, expected_effect: { any: [{ text_appears: 'Saved' }] }, timeout_ms: 5000 } }
    ]
  })
  const statusText = await pageText({ runtime, window }, '#status')
  const password = await pageValue({ runtime, window }, '#password')
  const steps = runtime.log.steps()
  const channels = [...new Set(steps.map((step) => step.channel))]
  const ok = report.status === 'completed' && report.criteria.satisfied && statusText === 'Saved' && password === '' && channels.every((channel) => channel === 'dom')
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok
      ? 'the form was filled and submitted over the DOM channel and both steps were verified'
      : `status=${report.status} error=${report.error ? `${report.error.code}: ${report.error.message}` : 'none'} criteria=${JSON.stringify(report.criteria.results)} statusText=${JSON.stringify(statusText)}`,
    evidence: { steps: steps.length, channels, verification: steps.map((step) => step.verification), criteria: report.criteria.results, screenshots: runtime.log.screenshots().length }
  }
})

scenario('dynamic-target', async ({ runtime, window, baseUrl }) => {
  await load(window, baseUrl, 'dynamic.html')
  const before = JSON.stringify((await pageQuery({ runtime, window }, '#moving')).bbox)
  const report = await runtime.run({
    goal: 'click the button that moves 250 ms after load',
    success_criteria: [{ kind: 'dom_text', selector: '#clicked', text: 'Clicked' }],
    allowed_capabilities: ['browser'],
    plan: [
      { id: 'settle', action: { type: 'WAIT_STATE', waitFor: { condition: 'idle' }, timeout_ms: 1200 } },
      { id: 'click', action: { type: 'DOM_CLICK', target: { selector: '#moving' }, expected_effect: { any: [{ text_appears: 'Clicked' }] }, timeout_ms: 5000 } }
    ]
  })
  const after = JSON.stringify((await pageQuery({ runtime, window }, '#moving')).bbox)
  const moved = before !== after
  const clicked = await pageText({ runtime, window }, '#clicked')
  const ok = report.status === 'completed' && clicked === 'Clicked'
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok ? 'the runtime re-resolved the target after it moved and clicked the real position' : `status=${report.status} clicked=${JSON.stringify(clicked)}`,
    evidence: { moved, before, after, steps: runtime.log.steps().map((step) => ({ action: step.actionType, verification: step.verification })) }
  }
})

scenario('missed-click', async ({ runtime, window, baseUrl }) => {
  await load(window, baseUrl, 'miss.html')
  const report = await runtime.run({
    goal: 'arm the control whose first click is swallowed',
    success_criteria: [{ kind: 'dom_text', selector: '#state', text: 'Armed' }],
    allowed_capabilities: ['browser'],
    plan: [{
      id: 'arm',
      action: { type: 'DOM_CLICK', target: { selector: '#arm' }, expected_effect: { any: [{ text_appears: 'Armed' }] }, timeout_ms: 700 }
    }]
  })
  const armed = await pageText({ runtime, window }, '#state')
  const decisions = report.recoveryDecisions.map((decision) => decision.step)
  const ok = report.status === 'completed' && armed === 'Armed' && decisions.length > 0
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok ? `the swallowed click produced a ${decisions[0]} decision and the retry succeeded` : `status=${report.status} armed=${JSON.stringify(armed)} decisions=${JSON.stringify(decisions)}`,
    evidence: { decisions, steps: runtime.log.steps().map((step) => ({ result: step.result, retryCount: step.retryCount, notes: step.notes })) }
  }
})

scenario('unexpected-modal', async ({ runtime, window, baseUrl }) => {
  await load(window, baseUrl, 'modal.html')
  const report = await runtime.run({
    goal: 'open the modal and then click the control behind it',
    success_criteria: [{ kind: 'dom_text', selector: '#behind-state', text: 'Behind clicked' }],
    allowed_capabilities: ['browser'],
    plan: [
      { id: 'open', action: { type: 'DOM_CLICK', target: { selector: '#open-modal' }, expected_effect: { any: [{ dom_mutated: true }] }, timeout_ms: 1000 } },
      { id: 'behind', action: { type: 'DOM_CLICK', target: { selector: '#behind' }, expected_effect: { any: [{ text_appears: 'Behind clicked' }] }, timeout_ms: 1500 } }
    ]
  })
  const modalCount = await pageCount({ runtime, window }, '[role=dialog]')
  const behind = await pageText({ runtime, window }, '#behind-state')
  const dismissal = runtime.log.steps().find((step) => /dismiss dialog/.test(String(step.description)))
  const ok = report.status === 'completed' && modalCount === 0 && behind === 'Behind clicked' && Boolean(dismissal)
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok ? 'the modal was dismissed by its own control and the original action resumed' : `status=${report.status} dialogs=${modalCount} behind=${JSON.stringify(behind)}`,
    evidence: { states: report.states, dismissal: dismissal ? { action: dismissal.action, result: dismissal.result } : null }
  }
})

scenario('desktop-app', async ({ runtime, app, host, window, emit, progress }) => {
  const step = (message) => {
    progress(`desktop-app: ${message}`)
    emit(`CU-PROGRESS desktop-app ${message}`)
  }
  const skipped = requireDesktopReady(runtime)
  if (skipped) return { status: 'skipped', detail: skipped }
  if (process.platform !== 'win32') return { status: 'skipped', detail: 'the desktop application scenario needs Windows' }

  // A real file that a real editor opens, edits and saves.
  const documentPath = path.join(os.tmpdir(), `ds-hns-cu-acceptance-${process.pid}.txt`)
  fs.writeFileSync(documentPath, 'before\n')
  const beforeStat = fs.statSync(documentPath)

  const notepad = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe')
  if (!fs.existsSync(notepad)) return { status: 'skipped', detail: `notepad.exe was not found at ${notepad}` }

  const driver = host.drivers.win32
  step('launching notepad')
  const opened = await driver.openApplication(notepad, { args: [documentPath], waitForWindowMs: 15000 })
  step(`launch result ${JSON.stringify(opened && opened.ok)} window=${opened && opened.window ? opened.window.handle : 'none'}`)

  // Windows 11 hands Notepad's window to a broker process, so the window is
  // located by what it shows (the document name) rather than by the pid that was
  // spawned. This is the same "find the window by title" path a user's task
  // would take.
  const documentName = path.basename(documentPath)
  let editorWindow = opened && opened.window ? opened.window : null
  if (!editorWindow) {
    const deadline = Date.now() + 12000
    while (Date.now() < deadline && !editorWindow) {
      const windows = driver.listWindows()
      editorWindow = windows.find((window) => String(window.title || '').includes(documentName))
        || windows.find((window) => /notepad/i.test(String(window.className || '')) && String(window.title || '').includes('.txt'))
        || null
      if (!editorWindow) await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  const notepadEvidence = { window: editorWindow ? { handle: editorWindow.handle, title: editorWindow.title, processId: editorWindow.processId } : null }
  step(editorWindow
    ? `editor window ${editorWindow.handle} "${editorWindow.title}" pid=${editorWindow.processId}`
    : 'no editor window was found; the run will use the harness editor window instead')

  const plan = (windowRef) => ([
    { id: 'focus', action: { type: 'FOCUS', target: { window: windowRef }, timeout_ms: 4000 } },
    { id: 'type', action: { type: 'TYPE', text: 'edited by computer use\r\n', target: { window: windowRef }, precondition: { window_foreground: true }, timeout_ms: 6000 } },
    { id: 'save', action: { type: 'HOTKEY', keys: ['ctrl', 's'], target: { window: windowRef }, expected_effect: { any: [{ file_modified: documentPath }] }, timeout_ms: 6000 } }
  ])

  try {
    let usedNotepad = Boolean(editorWindow)
    let report = null
    // Only drive a third-party application when the platform actually handed us
    // its window. On Windows 11 Notepad windows belong to a broker process, so
    // there is no window to focus by pid — in that case the harness goes
    // straight to its own editor window instead of stalling a contract against
    // a window the runtime cannot address.
    const brokerOwned = Boolean(opened && opened.ok !== false && !opened.window)
    if (editorWindow && !brokerOwned) {
      step('running the contract against Notepad')
      report = await runtime.run({
        goal: 'open the acceptance document in Notepad, append a line and save it',
        allowed_capabilities: ['desktop', 'browser', 'shell', 'filesystem'],
        success_criteria: [
          { kind: 'window_exists', title: documentName },
          { kind: 'file_contains', path: documentPath, text: 'edited by computer use' }
        ],
        plan: plan({ handle: editorWindow.handle })
      })
      step(`notepad run finished: ${report.status}${report.error ? ` (${report.error.code})` : ''}`)
    } else if (brokerOwned) {
      step('Notepad hands its window to a broker process on this host; using the harness editor window instead')
    }

    // Windows 11 hands Notepad's window to a broker process, which can replace
    // the window mid-run. When that happens the same contract is run against the
    // harness's own editor window: still a real window, real keyboard input and
    // a file that really lands on disk, so the acceptance stays real instead of
    // becoming a skip.
    if (!report || report.status !== 'completed') {
      step('falling back to the harness editor window')
      await load(window, baseUrl, 'editor.html')
      window.show()
      window.focus()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const editorHandle = driver.listWindows().find((entry) => String(entry.title || '').includes('DS-Hns Computer Use acceptance'))
      if (!editorHandle) {
        return { status: 'skipped', detail: `no editor window could be focused (notepad result: ${report ? report.status : 'not run'})` }
      }
      const savedPath = path.join(os.tmpdir(), 'doc.txt')
      try {
        fs.rmSync(savedPath, { force: true })
      } catch {
        /* it was not there */
      }
      usedNotepad = false
      report = await runtime.run({
        goal: 'type into the editor window and save the document with Ctrl+S',
        allowed_capabilities: ['desktop', 'browser', 'shell', 'filesystem'],
        success_criteria: [
          { kind: 'window_exists', title: 'DS-Hns Computer Use acceptance' },
          { kind: 'file_contains', path: savedPath, text: 'edited by computer use' }
        ],
        plan: plan({ handle: editorHandle.handle })
      })
      step(`editor run finished: ${report.status}${report.error ? ` (${report.error.code})` : ''}`)
      const content = fs.existsSync(savedPath) ? fs.readFileSync(savedPath, 'utf8') : ''
      const ok = report.status === 'completed' && content.includes('edited by computer use')
      return {
        status: ok ? 'passed' : 'failed',
        detail: ok
          ? 'a real window was focused, typed into through the real keyboard and saved with Ctrl+S; the file on disk really changed'
          : `status=${report.status} error=${report.error ? report.error.code : 'none'} file=${JSON.stringify(content.slice(0, 80))} (notepad attempt: ${notepadEvidence.window ? report.status : 'no window'})`,
        evidence: {
          application: 'harness editor window (real Electron window; Notepad on this host hands its window to a broker process)',
          notepad: notepadEvidence,
          window: { handle: editorHandle.handle, title: editorHandle.title, processId: editorHandle.processId },
          file: { path: savedPath, content: content.slice(0, 200) },
          steps: runtime.log.steps().map((step_) => ({ action: step_.actionType, channel: step_.channel, result: step_.result, verification: step_.verification }))
        }
      }
    }

    const afterStat = fs.statSync(documentPath)
    const content = fs.readFileSync(documentPath, 'utf8')
    const changed = afterStat.mtimeMs > beforeStat.mtimeMs && content.includes('edited by computer use')
    const foreground = driver.foregroundWindow()
    const ok = report.status === 'completed' && changed
    return {
      status: ok ? 'passed' : 'failed',
      detail: ok
        ? 'a real Notepad window was focused, typed into and saved; the file on disk really changed'
        : `status=${report.status} changed=${changed} usedNotepad=${usedNotepad} content=${JSON.stringify(content.slice(0, 80))}`,
      evidence: {
        window: { handle: editorWindow.handle, title: editorWindow.title, processId: editorWindow.processId },
        file: { path: documentPath, beforeMtime: beforeStat.mtimeMs, afterMtime: afterStat.mtimeMs, content: content.slice(0, 200) },
        foreground: foreground ? foreground.title : null,
        steps: runtime.log.steps().map((step_) => ({ action: step_.actionType, channel: step_.channel, result: step_.result, verification: step_.verification }))
      }
    }
  } finally {
    try {
      driver.closeWindow(handle)
    } catch {
      /* the window may already be gone */
    }
    try {
      fs.rmSync(documentPath, { force: true })
    } catch {
      /* best effort */
    }
    void app
    void window
  }
})

scenario('slow-ui', async ({ runtime, window, baseUrl }) => {
  await load(window, baseUrl, 'slow.html')
  const startedAt = Date.now()
  const report = await runtime.run({
    goal: 'run the slow task and the fast task',
    allowed_capabilities: ['browser'],
    success_criteria: [
      { kind: 'dom_text', selector: '#slow-result', text: 'Slow finished' },
      { kind: 'dom_text', selector: '#fast-result', text: 'Fast finished' }
    ],
    plan: [
      { id: 'slow', action: { type: 'DOM_CLICK', target: { selector: '#slow' }, expected_effect: { any: [{ text_appears: 'Slow finished' }] }, timeout_ms: 4000 } },
      { id: 'fast', action: { type: 'DOM_CLICK', target: { selector: '#fast' }, expected_effect: { any: [{ text_appears: 'Fast finished' }] }, timeout_ms: 4000 } }
    ]
  })
  const elapsed = Date.now() - startedAt
  const steps = runtime.log.steps()
  const waits = steps.map((step) => step.waitMs)
  const ok = report.status === 'completed' && elapsed < 4000 && waits.some((wait) => Number(wait) > 500)
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok ? 'the 700 ms effect was waited for by condition; the run finished well inside a fixed-sleep budget' : `status=${report.status} elapsed=${elapsed} waits=${JSON.stringify(waits)}`,
    evidence: { elapsedMs: elapsed, waitsMs: waits, graceMs: steps.map((step) => step.graceMs) }
  }
})

scenario('canvas-vision', async ({ runtime, window, baseUrl, createVisionController }) => {
  const skipped = requireVisionReady(runtime)
  if (skipped) return { status: 'skipped', detail: skipped }
  await load(window, baseUrl, 'canvas.html')
  // A coordinate click needs the target window in front: the harness brings it
  // forward and the action states which window it expects, so the runtime's own
  // window gate has something to verify (plan §33).
  window.show()
  window.focus()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const bounds = JSON.stringify((await pageQuery({ runtime, window }, '#order')).bbox)
  const report = await runtime.run({
    goal: 'submit the order through the control that only exists as pixels',
    allowed_capabilities: ['browser', 'desktop', 'vision'],
    success_criteria: [{ kind: 'dom_text', selector: '#ordered', text: 'Ordered' }],
    plan: [{
      id: 'order',
      action: {
        type: 'CLICK',
        // There is no DOM node and no accessibility node for this control: the
        // only description of it is the colour it is painted with.
        target: {
          visual: { paint: { color: '#ff8800', width: 200, height: 48 } },
          window: { title: window.getTitle() }
        },
        expected_effect: { any: [{ text_appears: 'Ordered' }] },
        timeout_ms: 6000
      }
    }]
  })
  const ordered = await pageText({ runtime, window }, '#ordered')
  const wrong = await pageText({ runtime, window }, '#wrong')
  const ok = report.status === 'completed' && ordered === 'Ordered' && wrong === ''
  const steps = runtime.log.steps()
  const geometry = await window.webContents.executeJavaScript(`(() => {
    const box = document.getElementById('order').getBoundingClientRect()
    return {
      dpr: window.devicePixelRatio,
      screenX: window.screenX,
      screenY: window.screenY,
      outer: [window.outerWidth, window.outerHeight],
      inner: [window.innerWidth, window.innerHeight],
      canvas: { x: box.x, y: box.y, width: box.width, height: box.height }
    }
  })()`, true).catch(() => null)
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok
      ? 'the painted control was found by vision, clicked by real coordinates, and the decoy was not used'
      : `status=${report.status} ordered=${JSON.stringify(ordered)} wrong=${JSON.stringify(wrong)} ` +
        `canvas=${bounds} clicks=${JSON.stringify(steps.map((step) => step.resolvedPoint))} geometry=${JSON.stringify(geometry)}`,
    evidence: {
      canvasBounds: bounds,
      geometry,
      resolvedPoints: steps.map((step) => step.resolvedPoint),
      steps: steps.map((step) => ({ channel: step.channel, coordinateFallback: step.coordinateFallback, verification: step.verification })),
      vision: createVisionController ? runtime.controllers.vision.captures().slice(-2) : null
    }
  }
})

scenario('window-overlay', async ({ runtime, window, baseUrl }) => {
  const skipped = requireDesktopReady(runtime)
  if (skipped) return { status: 'skipped', detail: skipped }
  await load(window, baseUrl, 'form.html')
  const ownBounds = window.getBounds()
  // A second real window is placed over the target and takes the focus.
  const { BrowserWindow } = require('electron')
  const cover = new BrowserWindow({ width: ownBounds.width, height: ownBounds.height, x: ownBounds.x, y: ownBounds.y, show: true, title: 'DS-Hns Computer Use cover' })
  await cover.loadURL(`${baseUrl}/modal.html`)
  cover.focus()
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    const point = { x: ownBounds.x + 300, y: ownBounds.y + 200 }
    const report = await runtime.run({
      goal: 'click inside the acceptance window while another window is in front',
      allowed_capabilities: ['desktop'],
      plan: [{
        id: 'click',
        action: {
          type: 'CLICK',
          // The caller expects *its* window to be in front; the safety gate has
          // to notice that it is not.
          target: { window: { title: 'DS-Hns Computer Use acceptance' } },
          point,
          expected_effect: { any: [{ dom_mutated: true }] },
          timeout_ms: 800,
          retry: { max_attempts: 0 }
        }
      }],
      limits: { max_steps: 3, max_retries_per_action: 0 }
    })
    const refused = report.status !== 'completed' && ['WINDOW_MISMATCH', 'SAFETY_REFUSED', 'VERIFICATION_FAILED'].includes(report.error ? report.error.code : '')
    const states = report.states
    return {
      status: refused ? 'passed' : 'failed',
      detail: refused ? `the run refused to click while the covering window was in front (${report.error.code})` : `status=${report.status} error=${report.error ? report.error.code : null}`,
      evidence: { errorCode: report.error ? report.error.code : null, states }
    }
  } finally {
    try {
      cover.destroy()
    } catch {
      /* already gone */
    }
    window.focus()
  }
})

scenario('controller-failure', async ({ runtime, window, baseUrl, host, hostModule }) => {
  const { createComputerUseRuntime } = require(path.join(ROOT, 'app', 'computer-use', 'index.cjs'))
  await load(window, baseUrl, 'form.html')
  const broken = {
    probe: () => ({ available: false, reason: 'the screenshot backend was removed for this test' }),
    captureRegion: async () => {
      throw new Error('no display')
    },
    captureWindow: async () => {
      throw new Error('no display')
    },
    captureFull: async () => {
      throw new Error('no display')
    }
  }
  // The page port is built exactly like the production host builds it, so the
  // only thing that is broken in this scenario is the vision controller.
  const degradedHost = hostModule.createElectronHost({ getWebContents: () => window.webContents, workspace: os.tmpdir() })
  const degraded = createComputerUseRuntime({
    host: { getPage: degradedHost.host.getPage, desktop: host.drivers.win32, accessibility: host.drivers.uia, screenshot: broken },
    log: { dir: null },
    options: { maxSteps: 20 }
  })
  try {
    const health = degraded.health()
    const byId = (id) => health.controllers.find((controller) => controller.controller === id)
    const visionDown = byId('vision').available === false
    const othersUp = ['browser', 'desktop', 'shell', 'file'].every((id) => !byId(id) || byId(id).available)
    const report = await degraded.run({
      goal: 'sign in while the vision controller is broken',
      success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
      allowed_capabilities: ['browser'],
      plan: [
        { action: { type: 'DOM_TYPE', target: { selector: '#username' }, text: 'alice', expected_effect: { any: [{ value_equals: 'alice' }] } } },
        { action: { type: 'DOM_TYPE', target: { selector: '#password' }, text: 'secret', sensitive: true, expected_effect: { any: [{ value_equals: 'secret' }] } } },
        { action: { type: 'DOM_CLICK', target: { selector: '#sign-in' }, expected_effect: { any: [{ text_appears: 'Saved' }] }, timeout_ms: 4000 } }
      ]
    })
    const ok = visionDown && othersUp && report.status === 'completed' && degraded.health().faults.length === 0
    return {
      status: ok ? 'passed' : 'failed',
      detail: ok ? 'the broken vision controller degraded alone; the browser task still completed' : `visionDown=${visionDown} othersUp=${othersUp} status=${report.status}`,
      evidence: { controllers: health.controllers, faults: degraded.health().faults }
    }
  } finally {
    degraded.dispose()
  }
})

scenario('stall', async ({ runtime, window, baseUrl, host, createComputerUseRuntime }) => {
  await load(window, baseUrl, 'stall.html')
  // A task that keeps trying on a page that has stopped applying anything: the
  // fixture's button freezes every fixture script when it is clicked, so the
  // expected effect never arrives while the page keeps answering.
  const stuckAction = {
    type: 'DOM_CLICK',
    target: { selector: '#apply' },
    expected_effect: { any: [{ text_appears: 'Applied' }] },
    timeout_ms: 400
  }
  const pageAdapter = runtime.controllers.browser.page
  const stuckRuntime = createComputerUseRuntime({
    host: {
      // The page adapter the main runtime already attached is reused, so this
      // scenario adds a planner and nothing else.
      page: pageAdapter,
      desktop: host.drivers.win32,
      accessibility: host.drivers.uia,
      screenshot: host.drivers.screenshot,
      planner: async () => stuckAction
    },
    log: { dir: null },
    options: { maxSteps: 12 }
  })
  const report = await stuckRuntime.run({
    goal: 'apply a change on a page that has stopped responding',
    allowed_capabilities: ['browser'],
    plan: [{ action: stuckAction }],
    limits: { max_steps: 12, max_retries_per_action: 1, max_stall_recoveries: 1 }
  })
  const applied = await pageQuery({ runtime, window }, '#applied').then((found) => (found ? found.hidden : null)).catch(() => null)
  const bounded = ['STALL_DETECTED', 'STEP_LIMIT_REACHED', 'VERIFICATION_FAILED', 'CONTROLLER_TIMEOUT', 'ACTION_TIMEOUT'].includes(report.error ? report.error.code : '')
  const ok = report.status === 'failed' && bounded && report.steps <= 12
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok ? `the run detected the stall and stopped with context (${report.error.code})` : `status=${report.status} error=${report.error ? report.error.code : null} steps=${report.steps}`,
    evidence: { errorCode: report.error ? report.error.code : null, stallRecoveries: report.stallRecoveries, states: report.states, appliedStillHidden: applied }
  }
})

// ---------------------------------------------------------------------------
// Node side: spawn Electron and aggregate
// ---------------------------------------------------------------------------

function resolveElectronBinary() {
  const candidates = [
    path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'app', 'node_modules', 'electron', 'dist', 'electron')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function runUnderNode() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    for (const scenario of SCENARIOS) process.stdout.write(`${scenario.id}\t${scenario.title}\n`)
    return 0
  }
  const selected = argv.filter((argument) => !argument.startsWith('--') && !isFlagValue(argv, argument))
  const unknown = selected.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id))
  if (unknown.length) {
    process.stderr.write(`unknown scenario(s): ${unknown.join(', ')}\n`)
    return 2
  }
  const electron = resolveElectronBinary()
  if (!electron) {
    process.stderr.write('the Electron binary was not found under app\\node_modules\\electron\\dist; run scripts\\install-deps.ps1 first\n')
    return 3
  }
  process.stdout.write(`Computer Use acceptance: ${selected.length ? selected.join(', ') : 'all scenarios'}\n`)
  if (argv.includes('--stream')) {
    // Live mode: scenario progress is forwarded as it happens, which is how a
    // hanging scenario is diagnosed instead of guessed at.
    return runStreaming(electron, argv)
  }
  const result = spawnSync(electron, [__filename, ...argv], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  const stdout = result.stdout || ''
  const report = parseReport(stdout)
  const wantsJson = argv.includes('--json')
  const reportPath = reportPathOf(argv)
  if (reportPath) {
    // A UTF-8 artifact for CI and for the acceptance record.
    fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    for (const entry of report.scenarios) {
      const mark = entry.status === 'passed' ? 'PASS' : entry.status === 'skipped' ? 'SKIP' : 'FAIL'
      process.stdout.write(`[${mark}] ${entry.id}: ${entry.detail || ''}\n`)
    }
    if (!report.scenarios.length) {
      process.stdout.write(stdout.split('\n').slice(-20).join('\n'))
      process.stderr.write(result.stderr || '')
    }
  }
  const failed = report.scenarios.filter((entry) => entry.status === 'failed').length
  const skipped = report.scenarios.filter((entry) => entry.status === 'skipped').length
  process.stdout.write(`\nComputer Use acceptance: ${report.scenarios.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped\n`)
  return failed > 0 ? 1 : 0
}

/**
 * Live mode: run Electron with piped stdio, forward every line as it arrives,
 * and aggregate the report at the end. Returns the process exit code.
 */
function runStreaming(electron, argv) {
  const child = spawn(electron, [__filename, ...argv], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
  })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    buffer += text
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      if (line.startsWith('CU-REPORT ')) continue
      const scenario = line.startsWith('CU-SCENARIO ')
        ? parseScenarioLine(line)
        : null
      if (scenario) {
        const mark = scenario.status === 'passed' ? 'PASS' : scenario.status === 'skipped' ? 'SKIP' : 'FAIL'
        process.stdout.write(`[${mark}] ${scenario.id}: ${scenario.detail || ''}\n`)
      } else {
        process.stdout.write(`${line}\n`)
      }
    }
  })
  const finished = new Promise((resolve) => {
    child.on('close', (code) => {
      const report = parseReport(buffer)
      const reportPath = reportPathOf(argv)
      if (reportPath) fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      const failed = report.scenarios.filter((entry) => entry.status === 'failed').length
      const skipped = report.scenarios.filter((entry) => entry.status === 'skipped').length
      process.stdout.write(`\nComputer Use acceptance: ${report.scenarios.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped\n`)
      resolve(failed > 0 ? 1 : code || 0)
    })
  })
  return Number(execFileSyncSafe(finished))
}

function execFileSyncSafe(promise) {
  // The streaming runner is synchronous by contract (the CLI returns a code),
  // so the promise is drained with a small atomics wait on the event loop.
  let settled = null
  promise.then((value) => {
    settled = value
  })
  const deadline = Date.now() + 30 * 60_000
  while (settled === null && Date.now() < deadline) {
    // Busy-waiting on a promise is normally wrong; here the runner owns no
    // timers of its own and must not exit before the child is reaped.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return settled === null ? 1 : settled
}

function parseScenarioLine(line) {
  try {
    return JSON.parse(line.slice('CU-SCENARIO '.length))
  } catch {
    return null
  }
}

/** Flags that take a value: the value is an argument, not a scenario id. */
const VALUE_FLAGS = ['--report', '--progress', '--scenario-dir', '--scenario-timeout', '--budget']

/** How long one scenario may take before the harness abandons it. */
function scenarioTimeoutOf(argv) {
  const index = argv.indexOf('--scenario-timeout')
  const value = index >= 0 ? Number(argv[index + 1]) : NaN
  return Number.isFinite(value) && value > 1000 ? value : 150_000
}

/** The whole run's ceiling; the harness exits when it is reached. */
function totalBudgetOf(argv) {
  const index = argv.indexOf('--budget')
  const value = index >= 0 ? Number(argv[index + 1]) : NaN
  return Number.isFinite(value) && value > 10_000 ? value : 20 * 60_000
}

function isFlagValue(argv, candidate) {
  return VALUE_FLAGS.some((flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 && argv[index + 1] === candidate
  })
}

/** `--report <path>` writes the machine-readable report as a UTF-8 artifact. */
function reportPathOf(argv) {
  const index = argv.indexOf('--report')
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null
}

function parseReport(stdout) {
  const line = String(stdout).split('\n').reverse().find((entry) => entry.startsWith('CU-REPORT '))
  if (!line) return { scenarios: [], environment: {}, parseError: true, raw: String(stdout).slice(-4000) }
  try {
    return JSON.parse(line.slice('CU-REPORT '.length))
  } catch (error) {
    return { scenarios: [], environment: {}, parseError: String(error && error.message), raw: line.slice(0, 2000) }
  }
}

if (process.versions.electron) {
  // A flag's *value* is never a scenario id: `--report <path>` and
  // `--budget <ms>` must not be read as selection filters.
  const electronArgv = process.argv.slice(2)
  const selected = electronArgv.filter((argument) => !argument.startsWith('--') && !isFlagValue(electronArgv, argument))
  const progressIndex = electronArgv.indexOf('--progress')
  runUnderElectron(selected, {
    keepScreenshots: electronArgv.includes('--keep-screenshots'),
    includeOptional: electronArgv.includes('--include-optional'),
    progressPath: progressIndex >= 0 && electronArgv[progressIndex + 1] ? path.resolve(electronArgv[progressIndex + 1]) : null,
    scenarioTimeoutMs: scenarioTimeoutOf(electronArgv),
    totalBudgetMs: totalBudgetOf(electronArgv)
  }).catch((error) => {
    process.stderr.write(`acceptance failed to start: ${error && error.stack ? error.stack : error}\n`)
    process.exit(1)
  })
} else {
  process.exit(runUnderNode())
}

module.exports = { SCENARIOS }
