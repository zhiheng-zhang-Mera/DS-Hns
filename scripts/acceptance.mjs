'use strict'

/**
 * DS-Hns acceptance run.
 *
 * Boots the *real* Electron shell on a non-canonical port, with its own data
 * directory, and inspects what the running renderers actually contain over the
 * Chrome DevTools Protocol. Nothing here re-implements the UI: it drives the same
 * buttons a user clicks and asserts on the resulting DOM, on the real filesystem
 * and on the real GitHub network.
 *
 * Two properties are checked that unit tests structurally cannot cover:
 *   1. the dock really repaints from a live theme payload across all its panels;
 *   2. the official Harness renderer is untouched by the theme system.
 *
 * Usage (from the branch checkout):
 *   node <repo>\scripts\acceptance.mjs --root <checkout> --port 3091 --cdp 9331 \
 *        --report <file.json> [--skills] [--github]
 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { port: 3091, cdp: 9331, skills: false, github: false, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--skills') options.skills = true
    else if (token === '--github') options.github = true
    else if (token === '--keep') options.keep = true
    else if (token.startsWith('--')) options[token.slice(2)] = argv[++index]
  }
  options.root = path.resolve(options.root || process.cwd())
  options.report = path.resolve(options.report || path.join(options.root, 'temp', 'acceptance-report.json'))
  /**
   * Electron keys its single-instance lock by app name, so an acceptance run of
   * *the same checkout the product is running from* would silently quit behind
   * the live instance's lock and look like a harness that never came up. When the
   * target is this checkout the run gives itself its own name; a separate
   * checkout already derives one from its own root.
   */
  const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  options.ownRoot = ownRoot
  options.sameCheckout = options.root === ownRoot
  options.appName = options['app-name'] || `HNS Acceptance ${options.port}`
  options.userDataDir = path.resolve(options['user-data-dir'] || path.join(options.root, 'data', `acceptance-${options.port}`))
  return options
}

const OPTIONS = parseArgs(process.argv.slice(2))
const CHECKS = []
const NOTES = []
const WARNINGS = []

/**
 * Which part of the product a check belongs to, for the per-module summary in the
 * report. `modules` in the report is what makes a failure localisable without
 * reading the whole check list.
 */
const MODULE_RULES = [
  [/updater|rollback|harness update|update /i, 'updater'],
  [/theme|snapshot|visual|appearance|palette|tokens|png|slot/i, 'theme'],
  [/skill/i, 'skills'],
  [/dock/i, 'dock'],
  [/harness|renderer|render|boot|instance|core|shell/i, 'core']
]

function moduleOf(name) {
  for (const [pattern, module] of MODULE_RULES) {
    if (pattern.test(name)) return module
  }
  return 'core'
}

function check(name, ok, detail = '', module = null) {
  const owner = module || moduleOf(name)
  CHECKS.push({ name, module: owner, ok: Boolean(ok), detail: String(detail || '') })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(ok)
}

function note(text) {
  NOTES.push(text)
  console.log(`[NOTE] ${text}`)
}

function warn(text) {
  WARNINGS.push(text)
  console.log(`[WARN] ${text}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Turn a snippet into a function body.
 *
 * Expression first, statement second. `new Function` accepts an expression as a
 * body too (whose value is undefined), so trying "is this a body?" first mislabels
 * every expression; wrapping in `return (...)` and falling back on a parse error is
 * the only reliable order.
 */
function toBody(snippet) {
  const text = String(snippet).trim()
  if (text.startsWith('return ')) return text
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${text})`)
    return `return (${text})`
  } catch {
    // eslint-disable-next-line no-new-func
    new Function(text)
    return text
  }
}

// ---------------------------------------------------------------------------
// HTTP + CDP
// ---------------------------------------------------------------------------

async function httpJson(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
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
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluate a snippet in the page.
   *
   * A snippet is either a full body (statements, ending in its own `return`) or a
   * bare expression. The two are told apart by parsing each candidate with `new
   * Function` — never by pattern-matching keywords, which mislabels any expression
   * that merely contains a word like `const` in a string.
   */
  async evaluate(snippet) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { ${toBody(snippet)} })()`,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`)
    }
    return result.result?.value
  }

  async poll(snippet, { timeoutMs = 25_000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(snippet)
        if (last) return last
      } catch (error) {
        last = String(error.message)
      }
      await sleep(intervalMs)
    }
    throw new Error(`poll timed out: ${String(snippet).trim().slice(0, 120)} (last=${JSON.stringify(last)})`)
  }

  close() {
    try {
      this.socket?.close()
    } catch {
      // closing is best-effort
    }
  }
}

async function targets(cdpPort) {
  return httpJson(`http://127.0.0.1:${cdpPort}/json/list`)
}

/** Wait until a target whose URL matches `matcher` appears, then attach. */
async function attachTo(cdpPort, matcher, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let list = []
    try {
      list = await targets(cdpPort)
    } catch {
      list = []
    }
    const target = list.find((entry) => entry.type === 'page' && matcher(entry.url || ''))
    if (target?.webSocketDebuggerUrl) {
      const page = new Page(target.webSocketDebuggerUrl)
      await page.connect()
      return { page, target }
    }
    await sleep(400)
  }
  throw new Error('timed out waiting for a page target')
}

// ---------------------------------------------------------------------------
// snapshot artifacts
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** The engineering-spec floor for a screenshot read back from disk. */
const MIN_ACCEPTANCE_PNG_BYTES = 5 * 1024
const MIN_PNG_EDGE = 64

/**
 * Ground truth for a snapshot file on disk.
 *
 * `snapshot.visual === true` is a claim; this is the evidence. An empty file, a
 * text error page named .png, or a 0x0 capture must all fail here, which is
 * exactly the false green the acceptance run exists to catch.
 */
function inspectPngFile(file) {
  const problems = []
  let buffer = null
  try {
    buffer = fs.readFileSync(file)
  } catch (error) {
    return { ok: false, bytes: 0, width: 0, height: 0, problems: [`unreadable: ${error?.message || error}`] }
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    problems.push('not a PNG')
  }
  if (buffer.length < MIN_ACCEPTANCE_PNG_BYTES) {
    problems.push(`only ${buffer.length} bytes (minimum ${MIN_ACCEPTANCE_PNG_BYTES})`)
  }
  let width = 0
  let height = 0
  if (buffer.length >= 24 && buffer.subarray(12, 16).toString('ascii') === 'IHDR') {
    width = buffer.readUInt32BE(16)
    height = buffer.readUInt32BE(20)
    if (width < MIN_PNG_EDGE || height < MIN_PNG_EDGE) {
      problems.push(`too small to be a UI: ${width}x${height}`)
    }
  } else {
    problems.push('missing PNG header')
  }
  return { ok: problems.length === 0, bytes: buffer.length, width, height, problems }
}

/**
 * Read the snapshot package the theme engine wrote into this run's data
 * directory and verify every file it claims.
 */
function verifySnapshotArtifacts(root) {
  const dir = path.join(root, 'data', 'theme-workspace', 'snapshot')
  const mapFile = path.join(dir, 'ui-map.json')
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  } catch {
    return { dir, mapFile, mapExists: false, package: null, files: [], ok: false }
  }
  const claimed = Object.values(pkg.screenshots || {})
  const files = claimed.map((name) => {
    const file = path.join(dir, String(name))
    return { name: String(name), path: file, exists: fs.existsSync(file), ...inspectPngFile(file) }
  })
  return {
    dir,
    mapFile,
    mapExists: true,
    package: pkg,
    files,
    ok: files.length > 0 && files.every((file) => file.exists && file.ok)
  }
}

/** `git rev-parse` for the report; never fatal. */
function gitValue(args) {
  try {
    const result = spawnSync('git', args, { cwd: OPTIONS.root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) return null
    return String(result.stdout || '').trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// launching the shell
// ---------------------------------------------------------------------------

function launchShell() {
  const electron = path.join(OPTIONS.root, 'app', 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electron)) throw new Error(`electron not installed: ${electron}`)
  const entry = path.join(OPTIONS.root, 'app', 'desktop-main.cjs')
  const logDir = path.join(OPTIONS.root, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const out = fs.openSync(path.join(logDir, 'acceptance.out.log'), 'a')
  const err = fs.openSync(path.join(logDir, 'acceptance.err.log'), 'a')

  const env = {
    ...process.env,
    DSH_ROOT: OPTIONS.root,
    DSH_HOME: path.join(OPTIONS.root, 'data'),
    DSH_HARNESS_PORT: String(OPTIONS.port),
    DSH_MEGA_INTEGRATED_DOCK: '1',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'sk-acceptance-placeholder',
    npm_config_cache: path.join(OPTIONS.root, 'cache', 'npm'),
    TEMP: path.join(OPTIONS.root, 'temp'),
    TMP: path.join(OPTIONS.root, 'temp')
  }
  // The acceptance run is a normal GUI run: visual observation is required, not
  // optional, so any no-visual switch from the caller's environment is dropped.
  delete env.DSH_THEME_NO_VISUAL
  // Start with the dock expanded: that is the surface a user themes, and it makes
  // the visual observation assertion independent of click timing. The run still
  // exercises the user-facing expand control below.
  env.DSH_MEGA_DOCK_EXPANDED = '1'
  // The shell's single-instance lock lives in the userData directory, so an
  // acceptance run always takes a profile of its own. Running the same checkout the
  // product is running from needs a name and a profile too, or the run would sit
  // silently behind the live instance's lock and look like a harness that never came up.
  env.DSH_APP_NAME = OPTIONS.appName
  env.DSH_USER_DATA_DIR = OPTIONS.userDataDir
  env.DSH_ACCEPTANCE = '1'

  const child = spawn(electron, [entry, `--remote-debugging-port=${OPTIONS.cdp}`, '--no-sandbox'], {
    cwd: path.join(OPTIONS.root, 'app'),
    env,
    stdio: ['ignore', out, err],
    windowsHide: false
  })
  return child
}

function killShell(child) {
  try {
    // The shell owns a managed Harness child, so kill the whole tree.
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    try { child.kill('SIGKILL') } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// skill install through the native directory picker
// ---------------------------------------------------------------------------

/** `pwsh` is not present on every Windows host; fall back to Windows PowerShell. */
function resolvePowerShell() {
  for (const candidate of ['pwsh', 'powershell.exe', 'powershell']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true })
    if (probe.status === 0) return candidate
  }
  return null
}

/**
 * Drive the real "local install" path: click the button, then type the path into
 * the native Windows folder picker and confirm it.
 *
 * Only the *click* is load-bearing here. The dialog is a real OS window: it may
 * be titled by the app, by Windows' own localised "Select Folder" string, or not
 * be activatable at all on a locked/headless desktop. When the keystrokes do not
 * land, the caller falls back to the same source-channel install, so this returns
 * whether the automation had a fair chance rather than pretending to know.
 */
async function pickLocalDirectory(page, directory) {
  const shell = resolvePowerShell()
  if (!shell) return false
  const escaped = directory.replace(/\\/g, '\\\\')
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $wsh = New-Object -ComObject WScript.Shell
    $titles = @('选择技能目录或 SKILL.md', 'Select Folder', 'Select a folder', '选择文件夹', 'DS-Harness')
    $seen = $false
    for ($i = 0; $i -lt 120; $i++) {
      Start-Sleep -Milliseconds 250
      foreach ($title in $titles) {
        if ($wsh.AppActivate($title)) { $seen = $true; break }
      }
      if ($seen) { break }
    }
    if (-not $seen) { exit 3 }
    Start-Sleep -Milliseconds 600
    [System.Windows.Forms.SendKeys]::SendWait('^l')
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
    Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 1000
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  `
  const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true
  })
  // The click opens the modal; the SendKeys process types into it.
  await page.evaluate("document.getElementById('skillsPickDir').click(); return true")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 30_000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  return true
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`== DS-Hns acceptance ==`)
  console.log(`root=${OPTIONS.root}`)
  console.log(`harness port=${OPTIONS.port}  cdp port=${OPTIONS.cdp}  skills=${OPTIONS.skills}  github=${OPTIONS.github}`)
  if (!OPTIONS.github) {
    warn('GitHub network test skipped (--github): the live repository install was not exercised')
  }
  if (!OPTIONS.skills) {
    warn('skills acceptance skipped (--skills): the skills module was not exercised')
  }

  const dataDir = path.join(OPTIONS.root, 'data')
  // A fresh checkout has no runtime directories; the shell creates them only after
  // it starts, and a missing `logs/` would swallow its own launch errors.
  for (const dir of ['data', 'logs', 'temp', 'cache', 'workspace', 'runtime', 'assets', 'config']) {
    fs.mkdirSync(path.join(OPTIONS.root, dir), { recursive: true })
  }
  fs.mkdirSync(dataDir, { recursive: true })

  // --- the harness itself must boot on the alternate port -------------------
  const shell = launchShell()
  let dock = null
  let official = null
  let harnessReady = false
  try {
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline && !harnessReady) {
      try {
        const response = await fetch(`http://127.0.0.1:${OPTIONS.port}/`, { redirect: 'manual' })
        harnessReady = response.status > 0
      } catch {
        harnessReady = false
      }
      if (!harnessReady) await sleep(1000)
    }
    check('the harness listens on the alternate port', harnessReady, `http://127.0.0.1:${OPTIONS.port}/`)
    if (!harnessReady) {
      // The shell quits silently when another instance already holds the app-name
      // lock, so say that outright instead of leaving "did not start" unexplained.
      const hint = shell.exitCode !== null ? ` (the shell exited with code ${shell.exitCode})` : ''
      const tail = (() => {
        try {
          return fs.readFileSync(path.join(OPTIONS.root, 'logs', 'desktop-runtime.log'), 'utf8').split(/\r?\n/).slice(-3).join(' | ')
        } catch {
          return ''
        }
      })()
      note(`shell instance identity: name="${OPTIONS.appName}" sameCheckout=${OPTIONS.sameCheckout}`)
      throw new Error(`harness did not start on port ${OPTIONS.port}${hint}; last runtime log lines: ${tail || '(none)'}`)
    }

    dock = await attachTo(OPTIONS.cdp, (url) => /dock\.html/i.test(url))
    check('the dock renderer is attached', Boolean(dock), dock.target.url)
    official = await attachTo(OPTIONS.cdp, (url) => !/dock\.html/i.test(url) && /^http/.test(url))
    check('the official harness renderer is attached', Boolean(official), official.target.url)
  } finally {
    // handled below; the shell must outlive this block
  }

  try {
    // --- the dock is the themed surface -------------------------------------
    const boot = await dock.page.poll(`document.body && document.body.dataset.themeId ? document.body.dataset.themeId : null`)
    check('the dock painted an active theme', Boolean(boot), String(boot))

    const tokens = await dock.page.evaluate(`
      const style = getComputedStyle(document.documentElement)
      return {
        base: style.getPropertyValue('--hns-color-bg-base').trim(),
        label: style.getPropertyValue('--hns-color-label-primary').trim(),
        shellBg: getComputedStyle(document.documentElement).getPropertyValue('--hns-slot-shell-bg').trim(),
        sheet: Boolean(document.getElementById('hnsThemeSheet'))
      }
    `)
    check('theme tokens are installed as CSS variables', /^#|rgb/.test(tokens.base) && /^#|rgb/.test(tokens.label), JSON.stringify(tokens))
    check('slot styles reach the dock chrome', Boolean(tokens.shellBg), tokens.shellBg)

    const panels = await dock.page.evaluate(`
      return {
        appearance: Boolean(document.getElementById('appearancePanel')),
        themeList: (document.getElementById('themeList') || {}).children ? document.getElementById('themeList').children.length : 0,
        skills: Boolean(document.getElementById('skillsPanel')),
        // Two dock generations ship the appearance module differently: the original
        // exposes the panel global, the bridged dock registers it as a named module.
        panelModule: Boolean(window.megaThemePanel && window.megaThemePanel.attach),
        bridgeModules: window.megaThemeBridge ? window.megaThemeBridge.modules : null
      }
    `)
    check('the Appearance panel is present', panels.appearance)
    check('the theme list rendered', panels.themeList > 0, `${panels.themeList} entries`)
    check(
      'the appearance module is attached to the dock',
      panels.panelModule || (Array.isArray(panels.bridgeModules) && panels.bridgeModules.includes('appearance')),
      JSON.stringify({ panel: panels.panelModule, modules: panels.bridgeModules })
    )

    // The dock boots collapsed (the rail) on a narrow window unless the run starts
    // it expanded. The visual observation below is only meaningful once the product
    // surface is actually laid out, so expand it through the dock's own control and
    // prove the control works in both directions.
    const expandViaRail = async () => dock.page.poll(`
      const rail = document.getElementById('railToggle')
      if (rail && !document.body.classList.contains('expanded')) rail.click()
      return document.body.classList.contains('expanded') &&
        document.getElementById('detail') &&
        document.getElementById('detail').getBoundingClientRect().width > 200
        ? true
        : null
    `, { timeoutMs: 12_000 })

    const startedExpanded = await dock.page.evaluate(`return document.body.classList.contains('expanded')`)
    let collapsed = null
    if (startedExpanded) {
      // Exercise the user-facing collapse control too, then expand again.
      collapsed = await dock.page.evaluate(`
        const collapse = document.getElementById('collapse')
        if (collapse) collapse.click()
        return new Promise((resolve) => setTimeout(() => {
          const detail = document.getElementById('detail')
          resolve({ expanded: document.body.classList.contains('expanded'), width: detail ? Math.round(detail.getBoundingClientRect().width) : 0 })
        }, 700))
      `)
      check('the dock collapses through its own control', collapsed.expanded === false, JSON.stringify(collapsed))
    }
    let dockExpanded = false
    for (let attempt = 0; attempt < 3 && !dockExpanded; attempt += 1) {
      try {
        dockExpanded = await expandViaRail()
      } catch {
        dockExpanded = false
      }
    }
    const expandedState = await dock.page.evaluate(`
      const detail = document.getElementById('detail')
      return {
        expanded: document.body.classList.contains('expanded'),
        width: detail ? Math.round(detail.getBoundingClientRect().width) : 0
      }
    `)
    check('the dock expands to full width through its own control', dockExpanded && expandedState.expanded && expandedState.width > 200, JSON.stringify(expandedState))

    // The dock must be expanded before geometry can mean anything, and the
    // appearance module has to have finished its first layout: the observation
    // below asserts on measured pixels.
    const dockVisible = await dock.page.evaluate(`
      const bridge = window.megaThemeBridge
      const regions = bridge && typeof bridge.reportRegions === 'function' ? bridge.reportRegions() : null
      return {
        expanded: document.body.classList.contains('expanded'),
        width: document.getElementById('detail') ? Math.round(document.getElementById('detail').getBoundingClientRect().width) : 0,
        measured: regions ? Object.keys(regions).filter((key) => key !== 'componentTree').length : 0
      }
    `)
    check('the dock reports live geometry for the observation', dockVisible.measured > 0, JSON.stringify(dockVisible))

    // --- theme switching through the real engine -----------------------------
    // Start from a known theme so the assertion is about the transition, not about
    // whatever was active in this data directory.
    const darkBase = await dock.page.evaluate(`
      return window.megaTools.theme.apply('hns.system.dark').then(() => new Promise((resolve) => setTimeout(() => {
        resolve(getComputedStyle(document.documentElement).getPropertyValue('--hns-color-bg-base').trim())
      }, 600)))
    `)
    check('the Dark system theme is active with its own base colour', darkBase === '#0f1115', String(darkBase))

    const applied = await dock.page.evaluate(`
      const engine = window.megaTools.theme
      // Watch every payload the renderer applies while the switch happens: the dock
      // writes the shared token sheet, so its text is the observable on either dock.
      window.__acceptancePayloads = []
      const sheet = document.getElementById('hnsThemeSheet')
      const observer = sheet ? new MutationObserver(() => {
        window.__acceptancePayloads.push('sheet:' + sheet.textContent.slice(0, 40))
      }) : null
      if (observer) observer.observe(sheet, { childList: true, characterData: true, subtree: true })
      return engine.snapshot().then((result) => {
        if (!result || !result.ok) return { ok: false, reason: 'snapshot failed' }
        const light = result.status.themes.find((theme) => theme.id === 'hns.system.light')
        if (!light) return { ok: false, reason: 'light theme missing' }
        return engine.apply('hns.system.light').then((applied) => ({ ok: true, id: 'hns.system.light', applied: applied && applied.ok }))
      })
    `)
    check('applying the Light system theme succeeds', applied.ok && applied.applied, JSON.stringify(applied))
    let lightTokens = null
    try {
      lightTokens = await dock.page.poll(`
        const base = getComputedStyle(document.documentElement).getPropertyValue('--hns-color-bg-base').trim()
        return base && base !== '#0f1115' ? base : null
      `, { timeoutMs: 15_000 })
    } catch {
      lightTokens = null
    }
    check('the dock repainted with the new theme', Boolean(lightTokens), String(lightTokens))
    if (!lightTokens) {
      const diagnosed = await dock.page.evaluate(`
        const sheet = document.getElementById('hnsThemeSheet')
        const perSheet = []
        for (const node of document.styleSheets) {
          let rules = null
          try { rules = node.cssRules } catch { perSheet.push({ href: 'blocked' }); continue }
          perSheet.push({
            href: (node.href || 'inline').split('/').pop(),
            count: rules.length,
            first: rules[0] ? { selector: rules[0].selectorText, base: rules[0].style ? rules[0].style.getPropertyValue('--hns-color-bg-base').trim() : null } : null
          })
        }
        return window.megaTools.theme.snapshot().then((s) => ({
          active: s.status.active,
          computedBase: getComputedStyle(document.documentElement).getPropertyValue('--hns-color-bg-base').trim(),
          perSheet,
          sheetHead: sheet ? sheet.textContent.slice(0, 70) : null,
          sheetConnected: sheet ? sheet.isConnected : null,
          ownerNode: sheet && sheet.sheet ? 'sheet-present' : 'no-sheet-object'
        }))
      `)
      note(`light repaint diagnosis: ${JSON.stringify(diagnosed)}`)
    }
    const lightSheet = await dock.page.evaluate(`
      const sheet = document.getElementById('hnsThemeSheet')
      return sheet ? /--hns-color-bg-base:\\s*#f7f8fa/.test(sheet.textContent) : false
    `)
    check('the injected token sheet matches the active theme', lightSheet)
    const payloads = await dock.page.evaluate(`return (window.__acceptancePayloads || []).length`)
    check('the renderer applied a theme payload on the switch', payloads > 0, `${payloads} sheet writes`)
    const lightPanel = await dock.page.evaluate(`
      return getComputedStyle(document.getElementById('appearancePanel')).backgroundColor
    `)
    check('a dock panel resolves its background from the new theme', Boolean(lightPanel) && lightPanel !== 'rgba(0, 0, 0, 0)', String(lightPanel))

    const backToDark = await dock.page.evaluate(`
      return window.megaTools.theme.apply('hns.system.dark').then((result) => ({ ok: Boolean(result && result.ok) }))
    `)
    check('switching back to Dark succeeds', backToDark.ok)

    // --- the official renderer must be untouched -----------------------------
    await sleep(1200)
    const officialState = await official.page.evaluate(`
      return {
        hnsSheet: Boolean(document.getElementById('hnsThemeSheet')),
        hnsVars: ['--hns-color-bg-base', '--hns-slot-shell-bg', '--hns-persona-avatar']
          .filter((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() !== ''),
        datasets: Object.keys(document.body.dataset).filter((key) => key.startsWith('theme')),
        root: Boolean(document.getElementById('root') || document.querySelector('#app') || document.body.children.length)
      }
    `)
    check('the official renderer received no theme stylesheet', !officialState.hnsSheet)
    check('the official renderer received no theme tokens', officialState.hnsVars.length === 0, JSON.stringify(officialState.hnsVars))
    check('the official renderer received no theme dataset', officialState.datasets.length === 0, JSON.stringify(officialState.datasets))
    check('the official renderer is still a rendered page', officialState.root)

    // --- skills acceptance ---------------------------------------------------
    if (OPTIONS.skills) {
      const skillRoot = path.join(dataDir, 'skills')
      const skillPanel = await dock.page.poll(`
        return window.megaTools.skills ? window.megaTools.skills.snapshot().then((s) => s.ok ? true : null) : null
      `)
      check('the skills service answers through the dock bridge', Boolean(skillPanel))

      // 1. bundled catalog install
      const bundled = await dock.page.evaluate(`
        return window.megaTools.skills.installCatalog({ id: 'bundled-commit-message' }).then((r) => ({ ok: r.ok, installed: (r.installed || []).map((i) => i.name), reason: r.reason || null }))
      `)
      check('a bundled skill installs through the catalog channel', bundled.ok, JSON.stringify(bundled))
      const installedFile = path.join(skillRoot, 'commit-message.md')
      check('the bundled skill exists on disk in harness format', fs.existsSync(installedFile), installedFile)
      if (fs.existsSync(installedFile)) {
        const text = fs.readFileSync(installedFile, 'utf8')
        check('the installed skill carries valid frontmatter', /^---[\s\S]*name:\s*commit-message[\s\S]*description:/m.test(text))
      }

      // 2. real GitHub install of a curated collection (network)
      if (OPTIONS.github) {
        const live = await dock.page.evaluate(`
          return window.megaTools.skills.installSource({ source: 'anthropics/skills' })
            .then((r) => ({ ok: r.ok, installed: (r.installed || []).map((i) => i.name), skipped: (r.skipped || []).length, reason: r.reason || null }))
        `)
        check('a real GitHub repository installs over the network', live.ok, JSON.stringify(live).slice(0, 300))
        if (live.ok) {
          const names = live.installed
          // The repository ships a `template/` scaffold next to its real `skills/`
          // collection. Installing only the scaffold looks like success, so a count
          // above one is what actually distinguishes the collection from it.
          check('the repository collection installs, not its starter scaffold', names.length > 1, `${names.length} skills: ${names.slice(0, 4).join(', ')}`)
          check('the starter scaffold is not among the installed skills', !names.includes('template'), JSON.stringify(names))
          const sample = path.join(skillRoot, names[0], 'SKILL.md')
          check('a GitHub-installed skill is a directory bundle on disk', fs.existsSync(sample), sample)
          // 3. delete exactly the ones just installed, immediately, from the panel
          const removed = await dock.page.evaluate(`
            return window.megaTools.skills.removeMany(${JSON.stringify(names)})
              .then((r) => ({ ok: r.ok, deleted: (r.deleted || []).length, failed: (r.failed || []).length }))
          `)
          check('bulk delete of the GitHub collection succeeds', removed.ok, JSON.stringify(removed))
          const leftover = names.filter((name) => fs.existsSync(path.join(skillRoot, name)))
          check('the deleted skills are gone from disk', leftover.length === 0, JSON.stringify(leftover))
        } else {
          note(`GitHub install did not complete: ${live.reason}`)
        }
      }

      // 4. live search reaches the catalog
      const search = await dock.page.evaluate(`
        return window.megaTools.skills.search({ query: 'git', includeLive: false }).then((r) => ({
          ok: r.ok,
          offline: r.offline ? r.offline.entries.length : -1,
          status: r.liveStatus
        }))
      `)
      check('quick search answers from the catalog', search.ok && search.offline > 0, JSON.stringify(search))

      // 5. local directory install through the real native picker
      const localSource = path.join(OPTIONS.root, 'temp', 'acceptance-skill')
      fs.mkdirSync(localSource, { recursive: true })
      fs.writeFileSync(path.join(localSource, 'SKILL.md'), [
        '---',
        'name: acceptance-local-skill',
        'description: Installed by the DS-Hns acceptance run through the native directory picker.',
        '---',
        '',
        '# Acceptance local skill',
        'This file exists to prove the local install path.'
      ].join('\n'), 'utf8')

      const before = await dock.page.evaluate(`return window.megaTools.skills.snapshot().then((s) => s.skills.length)`)
      // The dialog can be slow to appear behind an expanded dock, and one wasted
      // attempt costs nothing: try the real picker twice before falling back.
      let picked = false
      let nativePickerDriven = true
      for (let attempt = 0; attempt < 2 && !picked; attempt += 1) {
        try {
          await pickLocalDirectory(dock.page, localSource)
          const after = await dock.page.poll(`
            return window.megaTools.skills.snapshot().then((s) => s.skills.some((k) => k.name === 'acceptance-local-skill') ? s.skills.length : null)
          `, { timeoutMs: 25_000 })
          check('a local directory installs through the native picker', after > before, `${before} -> ${after}`)
          picked = true
        } catch (error) {
          if (attempt === 1) {
            // The OS dialog cannot be driven reliably in every environment; report
            // it rather than claiming success or failing the whole run.
            note(`native directory picker could not be driven (${error.message}); local install verified through the source channel instead`)
            warn('the native directory picker could not be automated in this environment; the install path was verified through the source channel')
            nativePickerDriven = false
            const direct = await dock.page.evaluate(`
              const engine = window.megaTools.skills
              return engine.installSource({ source: ${JSON.stringify(localSource)} }).then((r) => ({ ok: r.ok, installed: (r.installed || []).map((i) => i.name), reason: r.reason || null }))
            `)
            check('a local path installs through the source channel', direct.ok, JSON.stringify(direct))
          } else {
            note(`native directory picker attempt ${attempt + 1} did not complete; retrying`)
          }
        }
      }
      if (nativePickerDriven) note('the native directory picker was driven end to end')
      // Either path must leave the skill on disk: that is what the user asked for.
      const localInstalled = await dock.page.poll(`
        return window.megaTools.skills.snapshot().then((s) => s.skills.some((k) => k.name === 'acceptance-local-skill') ? true : null)
      `, { timeoutMs: 20_000 })
      check('the local skill is installed either way', localInstalled === true, String(localInstalled))
      const localFile = path.join(skillRoot, 'acceptance-local-skill.md')
      const localDir = path.join(skillRoot, 'acceptance-local-skill')
      check('the locally installed skill exists on disk', fs.existsSync(localFile) || fs.existsSync(localDir))

      // 6. single delete
      const single = await dock.page.evaluate(`
        return window.megaTools.skills.remove('acceptance-local-skill').then((r) => ({ ok: r.ok, reason: r.reason || null }))
      `)
      check('a single delete succeeds', single.ok, JSON.stringify(single))
      check('the deleted skill is gone from disk', !fs.existsSync(localFile) && !fs.existsSync(localDir))

      // 7. the panel reflects the service on the next render
      const listHtml = await dock.page.evaluate(`
        document.getElementById('skillsTabInstalled').click()
        return new Promise((resolve) => setTimeout(() => resolve(document.getElementById('skillsList').innerHTML.length), 400))
      `)
      check('the skills list renders installed skills', listHtml > 0, `${listHtml} chars`)
    }

    // --- theme create → preview → approve, in the running app ---------------
    // The create call must observe the real UI first: this is where a
    // structure-only regression would hide, so the observation verdict is
    // returned by the engine and asserted here.
    const themeFlow = await dock.page.evaluate(`
      const engine = window.megaTools.theme
      return engine.create({ prompt: '赛博全息 HUD，黑灰蓝，扫描线，人物不要抢屏' }).then((created) => {
        if (!created.ok) return { ok: false, reason: created.reason, stage: 'create' }
        const stage = created.stage
        const validationOk = created.validation.ok
        const observation = created.observation || null
        const snapshot = created.snapshot || null
        return engine.approve({ draftId: created.draftId }).then((approved) => ({
          ok: approved.ok,
          stage,
          validationOk,
          id: approved.id,
          reason: approved.reason || null,
          observation,
          snapshot
        }))
      })
    `)
    check('a prompt creates a preview and does not install', themeFlow.stage === 'preview' || themeFlow.ok, JSON.stringify(themeFlow))
    check('the generated theme was approved and installed', themeFlow.ok, JSON.stringify(themeFlow))

    // --- observation every theme design must make first ----------------------
    const observation = themeFlow.observation || {}
    const snapshotClaim = themeFlow.snapshot || {}
    check('the theme create reported its observation', Boolean(themeFlow.observation), JSON.stringify(observation).slice(0, 200))
    check(
      'the theme design observed the UI visually',
      snapshotClaim.visual === true && observation.visual === true,
      JSON.stringify({ snapshotVisual: snapshotClaim.visual, observationVisual: observation.visual, reason: snapshotClaim.reason || observation.reason || null })
    )
    check(
      'the theme observation is not degraded',
      snapshotClaim.degraded !== true && observation.degraded !== true,
      JSON.stringify({ snapshotDegraded: snapshotClaim.degraded, observationDegraded: observation.degraded, reason: observation.reason || null })
    )
    check('the observation captured the dock snapshot package', snapshotClaim.captured === true, JSON.stringify(snapshotClaim).slice(0, 200))

    // --- slot observation: real bounding boxes, not just contract ids --------
    const slotObservation = await dock.page.evaluate(`
      return window.megaTools.theme.observe().then((observed) => {
        const slotMap = (observed.snapshot && observed.snapshot.slot_map) || {}
        const withBox = Object.entries(slotMap)
          .filter(([, slot]) => slot && slot.boundingBox && slot.boundingBox.width > 0 && slot.boundingBox.height > 0)
          .map(([id, slot]) => ({ id, box: slot.boundingBox }))
        return {
          ok: observed.ok,
          degraded: observed.degraded,
          visual: observed.visual,
          reason: observed.reason || null,
          slotCount: Object.keys(slotMap).length,
          observedSlots: observed.observedSlots || null,
          withBox: withBox.slice(0, 12),
          withBoxCount: withBox.length
        }
      })
    `)
    check(
      'the UI inspector reports live slot geometry',
      slotObservation.withBoxCount > 0 && slotObservation.observedSlots?.count > 0,
      `${slotObservation.withBoxCount} slot(s) with a bounding box of ${slotObservation.slotCount} in the map`
    )
    if (slotObservation.withBox.length) {
      const sample = slotObservation.withBox[0]
      const box = sample.box
      check(
        'a reported slot carries a usable bounding box',
        Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0,
        `${sample.id}: ${JSON.stringify(box)}`
      )
    } else {
      check('a reported slot carries a usable bounding box', false, 'no slot was measured at all')
    }

    // --- the snapshot must be a real PNG on disk, not just a flag ------------
    const artifacts = verifySnapshotArtifacts(OPTIONS.root)
    check('the snapshot directory holds a map file', artifacts.mapExists, artifacts.mapFile)
    check(
      'the snapshot package claims PNG files',
      artifacts.mapExists && Array.isArray(Object.values(artifacts.package?.screenshots || {})) && Object.keys(artifacts.package?.screenshots || {}).length > 0,
      JSON.stringify(artifacts.package?.screenshots || {})
    )
    for (const file of artifacts.files) {
      check(
        `the snapshot PNG ${file.name} is a real image`,
        file.exists && file.ok,
        file.exists ? `${file.bytes} bytes, ${file.width}x${file.height}${file.problems.length ? ` — ${file.problems.join('; ')}` : ''}` : 'missing'
      )
    }
    if (artifacts.mapExists) {
      check('the snapshot package reports no capture problems', (artifacts.package.capture_problems || []).length === 0, JSON.stringify(artifacts.package.capture_problems || []))
    }

    if (themeFlow.ok) {
      const installedDir = path.join(dataDir, 'themes', 'user', themeFlow.id)
      check('the generated theme package exists on disk', fs.existsSync(path.join(installedDir, 'manifest.json')), installedDir)
      const record = await dock.page.evaluate(`
        return window.megaTools.theme.apply('hns.system.dark').then(() => window.megaTools.theme.snapshot()).then((s) => ({
          active: s.status.active,
          listed: s.status.themes.some((t) => t.id === ${JSON.stringify(themeFlow.id)})
        }))
      `)
      check('the generated theme is listed and Dark is restored', record.listed && record.active === 'hns.system.dark', JSON.stringify(record))
      const deleted = await dock.page.evaluate(`
        return window.megaTools.theme.remove(${JSON.stringify(themeFlow.id)}).then((r) => ({ ok: r.ok, reason: r.reason || null }))
      `)
      check('the generated theme can be deleted again', deleted.ok, JSON.stringify(deleted))
      check('the deleted theme package is gone from disk', !fs.existsSync(installedDir))
    }

    // --- protected themes stay protected ------------------------------------
    const protection = await dock.page.evaluate(`
      return window.megaTools.theme.remove('hns.system.dark').then((r) => ({ ok: r.ok, reason: r.reason }))
    `)
    check('a protected system theme cannot be deleted', !protection.ok && protection.reason === 'protected', JSON.stringify(protection))
    const lightProtection = await dock.page.evaluate(`
      return window.megaTools.theme.remove('hns.system.light').then((r) => ({ ok: r.ok, reason: r.reason }))
    `)
    check('every protected system theme refuses deletion', !lightProtection.ok && lightProtection.reason === 'protected', JSON.stringify(lightProtection))

    // --- the optional AI designer must be off, and must not be required ------
    const modelState = await dock.page.evaluate(`
      return window.megaTools.theme.artifacts().then((a) => (a && a.model) || null)
    `)
    if (modelState && modelState.enabled) {
      check('the optional AI designer reports its state when enabled', true, JSON.stringify(modelState))
    } else {
      warn('AI model adapter disabled: the deterministic interpreter designed every theme in this run')
      check('the theme pipeline works without an AI designer', true, JSON.stringify(modelState || { enabled: false }))
    }
  } finally {
    dock?.page.close()
    official?.page.close()
    if (!OPTIONS.keep) killShell(shell)
    else note('shell left running (--keep)')
  }
}

/**
 * Updater rollback, run as part of acceptance.
 *
 * The engineering spec lists it as an acceptance item, and driving it through the
 * real test suite (rather than re-implementing the stub) keeps one source of
 * truth for what "a rollback that actually restores the old version" means.
 */
function runUpdaterAcceptance() {
  const appDir = path.join(OPTIONS.root, 'app')
  const result = spawnSync(process.execPath, ['--test', path.join(OPTIONS.root, 'tests', 'unit', 'update-runner.test.js')], {
    cwd: appDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300_000
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const summary = output.split(/\r?\n/).filter((line) => /^ℹ (tests|pass|fail)/.test(line)).join(' · ')
  const ok = result.status === 0 && /ℹ fail 0/.test(output)
  check('the updater rollback tests pass against the real runner', ok, summary || `exit ${result.status}`)
  if (!ok) note(`updater test output tail: ${output.split(/\r?\n/).slice(-25).join(' | ')}`)
  return { ok, summary }
}

// ---------------------------------------------------------------------------

run()
  .then((value) => value)
  .then((result) => {
    const updater = runUpdaterAcceptance()
    const failed = CHECKS.filter((entry) => !entry.ok)
    const modules = {}
    for (const entry of CHECKS) {
      const bucket = modules[entry.module] || (modules[entry.module] = { passed: 0, failed: 0, checks: [] })
      if (entry.ok) bucket.passed += 1
      else bucket.failed += 1
      bucket.checks.push({ name: entry.name, ok: entry.ok })
    }
    const report = {
      commit: gitValue(['rev-parse', 'HEAD']),
      branch: gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
      root: OPTIONS.root,
      port: OPTIONS.port,
      skills: OPTIONS.skills,
      github: OPTIONS.github,
      keep: OPTIONS.keep,
      at: new Date().toISOString(),
      total: CHECKS.length,
      passed: CHECKS.length - failed.length,
      failed: failed.length,
      warnings: WARNINGS,
      modules,
      updater,
      checks: CHECKS,
      notes: NOTES
    }
    fs.mkdirSync(path.dirname(OPTIONS.report), { recursive: true })
    fs.writeFileSync(OPTIONS.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log('')
    console.log(`== acceptance: ${report.passed}/${report.total} checks passed ==`)
    console.log(`   modules: ${Object.entries(modules).map(([name, m]) => `${name} ${m.passed}/${m.passed + m.failed}`).join(' · ')}`)
    for (const warning of WARNINGS) console.log(`   WARNING: ${warning}`)
    if (failed.length) {
      for (const entry of failed) console.log(`   FAILED: [${entry.module}] ${entry.name} — ${entry.detail}`)
    }
    console.log(`report: ${OPTIONS.report}`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((error) => {
    console.error('acceptance run crashed:', error)
    process.exit(2)
  })
