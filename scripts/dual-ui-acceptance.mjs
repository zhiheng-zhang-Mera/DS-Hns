'use strict'

/**
 * Dual-UI acceptance run (Update-Plan/Dual-UI.md Gate A / C / D / E / G / H).
 *
 * Boots the real Electron shell on a non-canonical port with its own data
 * directory and its own app name, then drives the *real* Mega dock and native
 * frontend over the Chrome DevTools Protocol:
 *
 *   Gate A  the shell, the Harness, the dock and the native frontend all start
 *   Gate C  the official renderer is present and was never reloaded or navigated
 *   Gate D  Daily -> Work -> Daily repeated N times: no crash, no session loss,
 *           no Harness restart, no renderer re-creation
 *   Gate E  the active session survives every switch (what the frontends can
 *           guarantee; see docs/dual-ui.md for the documented limitation about
 *           steering the official renderer's own selection)
 *   Gate G  the collapsed rail switch and the expanded selector agree, and both
 *           agree with the native renderer's real mode
 *   Gate H  the active theme reaches the native surface (tokens + asset layers)
 *
 * Usage:
 *   node scripts\dual-ui-acceptance.mjs --root <checkout> --port 3097 --cdp 9337 \
 *        --switches 20 --report temp\dual-ui-acceptance.json [--keep]
 *
 * Gate B (send a message and receive a reply) needs a configured DeepSeek API key
 * and is intentionally out of scope: this script never spends model tokens.
 * Gate F (switching while a task runs) and Gate J (forcing a renderer crash) are
 * recorded in docs/dual-ui.md instead.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

function parseArgs(argv) {
  const options = { port: 3097, cdp: 9337, switches: 20, keep: false, bootTimeoutMs: 180_000, 'frontend-mode': null }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--keep') options.keep = true
    else if (token.startsWith('--')) options[token.slice(2)] = argv[++index]
  }
  options.root = path.resolve(options.root || process.cwd())
  options.switches = Math.max(1, Number(options.switches) || 20)
  options.report = path.resolve(options.report || path.join(options.root, 'temp', 'dual-ui-acceptance.json'))
  options.appName = options['app-name'] || `HNS Dual-UI ${options.port}`
  options.userDataDir = path.resolve(options['user-data-dir'] || path.join(options.root, 'data', `dual-ui-${options.port}`))
  return options
}

const OPTIONS = parseArgs(process.argv.slice(2))
const CHECKS = []
const NOTES = []

function check(id, name, ok, detail = '') {
  CHECKS.push({ id, name, ok: Boolean(ok), detail: String(detail) })
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ` - ${detail}` : ''}\n`)
  return Boolean(ok)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}

/** Minimal CDP client: attach to one target and evaluate expressions in it. */
class Page {
  constructor(webSocketDebuggerUrl) {
    this.url = webSocketDebuggerUrl
    this.nextId = 1
    this.pending = new Map()
    this.socket = null
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP socket timeout')), 10_000)
      this.socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`CDP socket error: ${event?.message || 'unknown'}`))
      })
    })
    this.socket.addEventListener('message', (event) => {
      let payload = null
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.id && this.pending.has(payload.id)) {
        const { resolve, reject } = this.pending.get(payload.id)
        this.pending.delete(payload.id)
        if (payload.error) reject(new Error(payload.error.message || 'CDP error'))
        else resolve(payload.result)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 20_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { return (${expression}); })()`,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    }
    return result.result?.value
  }

  close() {
    try { this.socket?.close() } catch { /* best effort */ }
  }
}

async function targets() {
  try {
    return await httpJson(`http://127.0.0.1:${OPTIONS.cdp}/json/list`)
  } catch {
    return []
  }
}

async function attach(matcher, { timeoutMs = OPTIONS.bootTimeoutMs } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await targets()
    const target = list.find((entry) => entry.type === 'page' && matcher(String(entry.url || '')))
    if (target?.webSocketDebuggerUrl) {
      const page = new Page(target.webSocketDebuggerUrl)
      await page.connect()
      return { page, target }
    }
    await sleep(500)
  }
  throw new Error('timed out waiting for a renderer target')
}

/** Evaluate `expression` until `ready(value)` is true, or the deadline passes. */
async function poll(page, expression, ready, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(expression)
      if (ready(last)) return last
    } catch (error) {
      last = { error: String(error?.message || error) }
    }
    await sleep(intervalMs)
  }
  return last
}

function electronBinary() {
  const candidates = [
    path.join(OPTIONS.root, 'app', 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(OPTIONS.root, 'app', 'node_modules', 'electron', 'dist', 'electron')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return 'electron'
}

function bootShell() {
  const env = { ...process.env }
  env.DSH_APP_NAME = OPTIONS.appName
  env.DSH_USER_DATA_DIR = OPTIONS.userDataDir
  env.DSH_HARNESS_PORT = String(OPTIONS.port)
  // The product's own startup mode is checked by default (its build default is the
  // official Work UI). `--frontend-mode=daily` forces Daily for a run, and the last
  // mode the user chose never decides which frontend this run mounts.
  if (OPTIONS['frontend-mode']) env.DSH_FRONTEND_MODE = OPTIONS['frontend-mode']
  const entry = path.join(OPTIONS.root, 'app')
  return spawn(electronBinary(), [entry, `--remote-debugging-port=${OPTIONS.cdp}`, '--no-sandbox'], {
    cwd: entry,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  })
}

function killShell(child) {
  if (!child) return
  try {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    try { child.kill('SIGKILL') } catch { /* best effort */ }
  }
}

/** What the native renderer reports about itself. */
const NATIVE_STATE = `(() => {
  const app = window.hnsNativeApp
  if (!app) return null
  const state = app.store.get()
  const banner = document.getElementById('banner')
  const layerImage = (id) => {
    const el = document.getElementById(id)
    if (!el) return null
    const image = getComputedStyle(el).backgroundImage || ''
    return { set: image !== 'none', inline: image.includes('data:image'), head: image.slice(0, 24) }
  }
  return {
    mode: state.mode,
    modeState: state.modeState,
    activeSessionId: state.activeSessionId,
    sessions: (state.sessions || []).length,
    messages: (state.messages || []).length,
    tasks: (state.tasks || []).length,
    backend: state.backend && state.backend.state,
    themeId: document.body.dataset.themeId || null,
    layers: {
      wallpaper: layerImage('backgroundLayer'),
      character: layerImage('characterLayer'),
      decoration: layerImage('decorationLayer'),
      personaBanner: layerImage('personaBannerLayer'),
      personaAvatar: layerImage('personaAvatarLayer')
    },
    wallpaperToken: (document.documentElement.style.getPropertyValue('--hns-asset-wallpaper') || '').trim().slice(0, 24),
    degraded: state.degraded ? state.degraded.reason : null,
    banner: banner && !banner.hidden ? banner.textContent : null
  }
})()`

/** What the Mega dock shows for the same mode. */
/** The Daily workspace layout, as the plan's Gate A describes it. */
const DAILY_LAYOUT = `(() => {
  const box = (id) => {
    const element = document.getElementById(id)
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      hidden: element.hidden === true || style.display === 'none'
    }
  }
  return {
    topbar: box('topbar'),
    sidebar: box('sidebar'),
    conversation: box('conversation'),
    composer: box('composer'),
    context: box('contextPanel'),
    settings: box('settingsPage')
  }
})()`

const DOCK_STATE = `(() => {
  const rail = document.getElementById('railMode')
  const snapshot = (typeof latestSnapshot !== 'undefined' ? latestSnapshot : null)
  return {
    rail: rail ? { letter: rail.textContent, mode: rail.dataset.mode, disabled: Boolean(rail.disabled) } : null,
    chip: document.getElementById('modeStatus') ? document.getElementById('modeStatus').textContent : null,
    daily: Boolean(document.getElementById('modeDaily') && document.getElementById('modeDaily').classList.contains('active')),
    work: Boolean(document.getElementById('modeWork') && document.getElementById('modeWork').classList.contains('active')),
    note: document.getElementById('modeNote') ? document.getElementById('modeNote').textContent : null,
    snapshotMode: snapshot && snapshot.frontend ? snapshot.frontend.mode : null,
    hasModeApi: Boolean(window.megaTools && window.megaTools.mode)
  }
})()`

async function main() {
  const child = bootShell()
  let native = null
  let dock = null
  let official = null
  try {
    native = await attach((url) => url.includes('native-ui/index.html'))
    check('GateA.native', 'the native frontend renderer is up', true, native.target.url)
    dock = await attach((url) => url.includes('mega/ui/dock.html'))
    check('GateA.dock', 'the Mega dock renderer is up', true, dock.target.url)
    official = await attach((url) => /^http:\/\/127\.0\.0\.1:/.test(url) && !url.includes('/api/'))
    check('GateA.official', 'the official Harness renderer is up', true, official.target.url)

    const first = await native.page.evaluate(NATIVE_STATE)
    const expectedStart = OPTIONS['frontend-mode'] || 'work'
    check(
      'GateA.startMode',
      `the product starts on the configured frontend (${expectedStart})`,
      first?.mode === expectedStart,
      `mode=${first?.mode} expected=${expectedStart}`
    )
    // Gate A (Daily refactor): the workspace is what is on screen, with all four
    // regions laid out at the widths the plan asks for.
    const layout = await native.page.evaluate(DAILY_LAYOUT)
    check('GateA.layout.sidebar', 'the session sidebar is 220-300px', layout?.sidebar?.w >= 220 && layout?.sidebar?.w <= 300, JSON.stringify(layout?.sidebar))
    check('GateA.layout.conversation', 'the conversation takes the remaining width', layout?.conversation?.w > 400, JSON.stringify(layout?.conversation))
    check('GateA.layout.context', 'the context panel is 300-460px', layout?.context?.w >= 300 && layout?.context?.w <= 460, JSON.stringify(layout?.context))
    check('GateA.layout.composer', 'the composer is present in the workspace', layout?.composer?.w > 0 && layout?.composer?.h > 0, JSON.stringify(layout?.composer))
    check('GateA.layout.topbar', 'the top bar is present', layout?.topbar?.h > 0, JSON.stringify(layout?.topbar))
    check('GateA.notSettings', 'Daily does not open on a Settings page', layout?.settings?.hidden === true, JSON.stringify(layout?.settings))
    const collapsedWidth = await native.page.evaluate(`(() => {
      const toggle = document.getElementById('collapseContext')
      const panel = document.getElementById('contextPanel')
      const width = () => Math.round(panel.getBoundingClientRect().width)
      toggle.click()
      const collapsed = width()
      toggle.click()
      return { collapsed, restored: width() }
    })()`)
    check('GateA.context.foldable', 'the context panel folds and unfolds', collapsedWidth?.collapsed < 80 && collapsedWidth?.restored >= 300, JSON.stringify(collapsedWidth))
    check('GateH.theme', 'the active theme reached the native surface', Boolean(first?.themeId), `themeId=${first?.themeId}`)
    const paintedLayers = Object.entries(first?.layers || {}).filter(([, value]) => value?.inline).map(([key]) => key)
    check(
      'GateH.assets',
      'the theme paints real imagery on the native surface, not just colours',
      paintedLayers.length >= 1,
      `inline image layers: ${paintedLayers.join(', ') || 'none'}`
    )
    check('GateA.backend', 'the native frontend reports a backend', Boolean(first?.backend), `backend=${first?.backend} sessions=${first?.sessions}`)
    const startSession = first?.activeSessionId || null
    const officialUrlAtStart = official.target.url
    const nativeIdsAtStart = (await targets()).filter((entry) => String(entry.url).includes('native-ui/index.html')).map((entry) => entry.id).sort().join(',')

    // The dock target can exist a beat before its script has rendered anything,
    // so the first state is polled rather than assumed.
    const dockStart = await poll(dock.page, DOCK_STATE, (value) => Boolean(value?.rail?.letter))
    check('GateG.api', 'the dock exposes the mode API', dockStart?.hasModeApi === true)
    const expectedLetter = first?.mode === 'daily' ? 'H' : 'D'
    check(
      'GateG.rail',
      'the collapsed rail shows the current mode',
      dockStart?.rail?.letter === expectedLetter && dockStart?.rail?.mode === first?.mode,
      `${JSON.stringify(dockStart?.rail)} expected ${expectedLetter}`
    )
    check(
      'GateG.selector',
      'the expanded selector shows the current mode',
      (first?.mode === 'daily' && dockStart?.daily === true && dockStart?.work === false) ||
        (first?.mode === 'work' && dockStart?.work === true && dockStart?.daily === false),
      JSON.stringify({ daily: dockStart?.daily, work: dockStart?.work })
    )
    check('GateG.snapshot', 'the dock snapshot and the native model agree', dockStart?.snapshotMode === first?.mode, `${dockStart?.snapshotMode} vs ${first?.mode}`)

    const observed = []
    let failures = 0
    // The first toggle always leaves the mode the product actually started in,
    // so the expectation is derived from the observed mode rather than assumed.
    const partner = first?.mode === 'daily' ? 'work' : 'daily'
    for (let index = 0; index < OPTIONS.switches; index += 1) {
      const expected = index % 2 === 0 ? partner : first?.mode
      try {
        await dock.page.evaluate('window.megaTools.mode.toggle()')
        await sleep(400)
        const nativeState = await native.page.evaluate(NATIVE_STATE)
        const dockState = await dock.page.evaluate(DOCK_STATE)
        const consistent = nativeState?.mode === expected && dockState?.snapshotMode === expected
        if (!consistent) failures += 1
        observed.push({
          step: index + 1,
          expected,
          native: nativeState?.mode,
          dock: dockState?.snapshotMode,
          rail: dockState?.rail?.letter,
          session: nativeState?.activeSessionId,
          degraded: nativeState?.degraded || null
        })
      } catch (error) {
        failures += 1
        observed.push({ step: index + 1, expected, error: String(error?.message || error) })
      }
    }
    check('GateD.switches', `${OPTIONS.switches} round trips stay consistent`, failures === 0, `failures=${failures}`)
    const nativeIdsAfter = (await targets()).filter((entry) => String(entry.url).includes('native-ui/index.html')).map((entry) => entry.id).sort().join(',')
    check('GateD.alive', 'the native renderer was never re-created', nativeIdsAfter === nativeIdsAtStart, `${nativeIdsAtStart} -> ${nativeIdsAfter}`)
    const afterSwitches = await native.page.evaluate(NATIVE_STATE)
    check('GateE.session', 'the active session survived every switch', (afterSwitches?.activeSessionId || null) === startSession, `${startSession} -> ${afterSwitches?.activeSessionId}`)
    check('GateD.noDegrade', 'no switch degraded the native frontend', !afterSwitches?.degraded && !observed.some((entry) => entry.degraded), JSON.stringify(observed.find((entry) => entry.degraded) || null))

    // ---- Gate C: the official UI at the width it needs, with the dock aside ----
    await dock.page.evaluate("window.megaTools.mode.set('work')")
    await sleep(900)
    const officialTargets = (await targets()).filter((entry) => /^http:\/\/127\.0\.0\.1:/.test(String(entry.url)) && !String(entry.url).includes('/api/'))
    const officialViewport = await official.page.evaluate('({ w: innerWidth, h: innerHeight })')
    check(
      'GateC.width',
      'Work Mode gives the official UI its full width (the dock steps aside)',
      officialViewport?.w >= 1200,
      `official viewport ${officialViewport?.w}x${officialViewport?.h}`
    )
    const dockCollapsed = await dock.page.evaluate("document.body.classList.contains('collapsed')")
    check('GateC.dock', 'the dock collapsed to its rail for Work Mode', dockCollapsed === true, `collapsed=${dockCollapsed}`)
    await dock.page.evaluate('window.megaTools.setDockExpanded(true)')
    await sleep(700)
    const restoredDock = await dock.page.evaluate("({ collapsed: document.body.classList.contains('collapsed'), w: innerWidth })")
    check('GateC.restore', 'the user can still expand the dock inside Work Mode', restoredDock?.collapsed === false, JSON.stringify(restoredDock))
    // Back to Daily: the dock returns to the user's own preference.
    await dock.page.evaluate("window.megaTools.mode.set('daily')")
    await sleep(900)
    const backToDaily = await dock.page.evaluate("({ collapsed: document.body.classList.contains('collapsed'), mode: (typeof latestSnapshot !== 'undefined' && latestSnapshot.frontend) ? latestSnapshot.frontend.mode : null })")
    check('GateC.preference', 'returning to Daily restores the user dock preference', backToDaily?.mode === 'daily' && backToDaily?.collapsed === false, JSON.stringify(backToDaily))
    check(
      'GateC.identity',
      'the official renderer is still the same document at the same address',
      officialTargets.length === 1 && officialTargets[0].id === official.target.id && officialTargets[0].url === officialUrlAtStart,
      `${officialUrlAtStart} -> ${officialTargets[0]?.url}`
    )
    const officialProbe = await official.page.evaluate('({ title: document.title, ready: document.readyState, hasBody: Boolean(document.body && document.body.children.length) })')
    check('GateC.live', 'the official UI is a live, untouched document', officialProbe?.ready === 'complete' && officialProbe?.hasBody === true, JSON.stringify(officialProbe))

    // ---- Gate J: a native failure falls back to Work Mode without touching the
    // backend, the session or the harness. The failure is forced through the
    // renderer's own report path, which is exactly what a crash would use.
    await native.page.evaluate("window.hnsNative.session.reportFailure('acceptance: forced native failure')")
    await sleep(700)
    const degradedState = await native.page.evaluate(NATIVE_STATE)
    check('GateJ.fallback', 'a native failure falls back to Work Mode', degradedState?.mode === 'work', JSON.stringify(degradedState))
    check('GateJ.reported', 'the degradation is visible, not silent', Boolean(degradedState?.degraded), String(degradedState?.degraded))
    const afterDegrade = await targets()
    check(
      'GateJ.harness',
      'the fallback did not restart or replace any renderer',
      afterDegrade.some((entry) => entry.id === official.target.id) && afterDegrade.filter((entry) => String(entry.url).includes('native-ui/index.html')).map((entry) => entry.id).sort().join(',') === nativeIdsAtStart,
      'official + native targets are the same instances'
    )
    // Recover: the dock switches back, and the degrade flag clears.
    await dock.page.evaluate("window.megaTools.mode.set('daily')")
    await sleep(700)
    const recovered = await native.page.evaluate(NATIVE_STATE)
    check('GateJ.recover', 'the user can return to Daily after a fallback', recovered?.mode === 'daily' && !recovered?.degraded, JSON.stringify(recovered))

    NOTES.push(`switches=${OPTIONS.switches}`)
    NOTES.push(`first=${JSON.stringify(observed[0] || null)}`)
    NOTES.push(`last=${JSON.stringify(observed[observed.length - 1] || null)}`)
  } catch (error) {
    check('run', 'the acceptance run completed', false, String(error?.stack || error))
  } finally {
    try { native?.page?.close() } catch { /* best effort */ }
    try { dock?.page?.close() } catch { /* best effort */ }
    try { official?.page?.close() } catch { /* best effort */ }
    if (!OPTIONS.keep) killShell(child)
  }

  const failed = CHECKS.filter((entry) => !entry.ok)
  const report = {
    plan: 'Update-Plan/Dual-UI.md',
    at: new Date().toISOString(),
    root: OPTIONS.root,
    port: OPTIONS.port,
    cdp: OPTIONS.cdp,
    switches: OPTIONS.switches,
    ok: failed.length === 0,
    passed: CHECKS.length - failed.length,
    total: CHECKS.length,
    checks: CHECKS,
    notes: NOTES
  }
  try {
    fs.mkdirSync(path.dirname(OPTIONS.report), { recursive: true })
    fs.writeFileSync(OPTIONS.report, JSON.stringify(report, null, 2))
    process.stdout.write(`report: ${OPTIONS.report}\n`)
  } catch (error) {
    process.stdout.write(`report write failed: ${error?.message || error}\n`)
  }
  process.stdout.write(`Dual-UI acceptance: ${report.passed}/${report.total} checks passed\n`)
  process.exit(report.ok ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`dual-ui acceptance crashed: ${error?.stack || error}\n`)
  process.exit(2)
})
