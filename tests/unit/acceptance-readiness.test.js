'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

test('Electron acceptance waits for both attached renderer documents before reading styles', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  assert.match(source, /async function waitForDocumentReady/)
  assert.match(source, /document\.documentElement && document\.body/)
  assert.match(source, /await waitForDocumentReady\(dock\.page/)
  assert.match(source, /await waitForDocumentReady\(official\.page/)
})

test('expanded-dock acceptance measures the actual renderer viewports after requesting expansion', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  const geometryStart = source.indexOf("'the native dock child begins at or beyond the official child right edge'")
  const expansionRequest = source.lastIndexOf('await expandViaRail()', geometryStart)
  const geometryEnd = source.indexOf("'the first-run Continue control fits within the reserved official viewport'", geometryStart)
  const geometry = source.slice(geometryStart, geometryEnd)

  assert.ok(expansionRequest >= 0 && expansionRequest < geometryStart, 'the acceptance run measures before asking the dock to expand')
  assert.match(source, /viewportWidth:\s*window\.innerWidth/)
  assert.doesNotMatch(geometry, /document\.documentElement\.getBoundingClientRect\(\)\.width/)
})

test('theme surface diagnostics publish bounds from the integrated native-view adapters', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs'), 'utf8')
  const start = source.indexOf("ipcMain.handle('mega:theme-surfaces'")
  const end = source.indexOf("ipcMain.handle('mega:theme-detail'", start)
  const handler = source.slice(start, end)

  assert.match(handler, /official_bounds:\s*officialSurfaceTarget\.bounds\(\)/)
  assert.match(handler, /dock_bounds:\s*ctx\?\.dockAdapter\?\.bounds\?\.\(\)\s*\|\|\s*null/)
})

test('acceptance desktop logs are isolated under the current D-run data directory', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
  const acceptance = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')

  assert.match(main, /function logPath\(\)\s*\{\s*return path\.join\(process\.env\.DSH_LOG_DIR \|\| path\.join\(ROOT, 'logs'\), 'desktop-runtime\.log'\)/)
  assert.match(main, /fs\.mkdirSync\(path\.dirname\(logPath\(\)\), \{ recursive: true \}\)/)
  assert.match(acceptance, /DSH_LOG_DIR:\s*path\.join\(OPTIONS\.dataDir, 'logs'\)/)
})

test('acceptance reopens a hidden dock through the public toggle bridge', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  const collapse = source.indexOf("'the dock collapses through its own control'")
  const reopen = source.indexOf('reopenDockFromBridge()', collapse)

  assert.ok(collapse >= 0, 'the dock collapse interaction is exercised')
  assert.ok(reopen > collapse, 'the hidden dock is reopened after the collapse interaction')
  assert.match(source, /const reopenDockFromBridge = async \(\) =>/)
  assert.match(source, /window\.megaTools\.toggleDock\(\)/)
})

test('failed dock re-entry returns bridge and renderer diagnostics instead of crashing acceptance', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  const start = source.indexOf('const reopenDockFromBridge = async () =>')
  const end = source.indexOf('\n  try {', start)
  const helper = source.slice(start, end)

  assert.match(helper, /window\.megaTools\.toggleDock\(\)/)
  assert.match(helper, /catch \(error\)/)
  assert.match(helper, /reopenBridgeResult: bridgeResult/)
  assert.match(helper, /reopenError,/)
})

test('dock acceptance helpers remain in run scope for later theme checks', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  const runStart = source.indexOf('async function run()')
  const firstTry = source.indexOf('\n  try {', runStart)
  const helper = source.indexOf('const expandViaRail = async () =>', runStart)
  const theme = source.indexOf('const themeDockExpanded = await reopenDockFromBridge()', runStart)

  assert.ok(runStart >= 0 && firstTry > runStart, 'run has a first acceptance phase')
  assert.ok(helper > runStart && helper < firstTry, 'expandViaRail is declared outside the first phase block')
  assert.ok(theme > helper, 'the later theme phase can reuse the same helper')
})

test('theme acceptance reopens a shell-hidden dock through its public bridge', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  const theme = source.indexOf('const themeDockExpanded = await reopenDockFromBridge()')
  const nextOperation = source.indexOf('const themeFlow =', theme)
  const request = source.slice(theme, nextOperation)

  assert.ok(theme >= 0 && nextOperation > theme, 'the theme precondition is checked')
  assert.match(request, /const themeDockExpanded = await reopenDockFromBridge\(\)/)
  assert.match(request, /themeDockExpanded\?\.expanded === true && themeDockExpanded\?\.viewportWidth === 440 && themeDockExpanded\?\.detailWidth >= 400/)
  assert.doesNotMatch(request, /await expandViaRail\(\)/, 'a fully hidden view has no visible rail to click')
})

test('dock re-entry is idempotent when the dock is already expanded', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'acceptance.mjs'), 'utf8')
  const start = source.indexOf('const reopenDockFromBridge = async () =>')
  const end = source.indexOf('\n  try {', start)
  const helper = source.slice(start, end)

  assert.match(helper, /const alreadyExpanded = await dock\.page\.evaluate/)
  assert.match(helper, /bridgeResult = alreadyExpanded\s*\?[\s\S]*:\s*await dock\.page\.evaluate\(`return window\.megaTools\.toggleDock\(\)`\)/)
})
