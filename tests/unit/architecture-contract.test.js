'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')

test('official main BrowserWindow has no preload injection', () => {
  const createWindowBody = main.slice(main.indexOf('function createWindow()'), main.indexOf('async function startExtensions'))
  assert.equal(/preload\s*:/.test(createWindowBody), false)
})

test('legacy monitor app is removed from core', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'monitor')), false)
})

test('Mega lives under optional extensions and has a kill switch', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs')), true)
  assert.match(main, /DSH_DISABLE_MEGA/)
})

test('startup detects any listener on 3080 instead of treating authenticated 401 as free', () => {
  assert.match(main, /function isHarnessPortListening/)
  assert.match(main, /net\.createConnection/)
  assert.match(main, /if \(await isHarnessPortListening\(\)\)/)
  assert.doesNotMatch(main, /if \(await requestHarness\(HARNESS_URL\)\)/)
})

test('startup token capture tolerates chunk boundaries and either output stream', () => {
  assert.match(main, /STARTUP_BUFFER_LIMIT/)
  assert.match(main, /startupOutput = `\$\{startupOutput\}\$\{clean\}`/)
  assert.match(main, /observeStartupOutput\('stdout'/)
  assert.match(main, /observeStartupOutput\('stderr'/)
  assert.match(main, /localhost/)
})

test('startup failures expose the runtime log tail', () => {
  assert.match(main, /function readLogTail/)
  assert.match(main, /desktop-runtime\.log \(tail\)/)
  assert.match(main, /Log: \$\{logPath\(\)\}/)
})
