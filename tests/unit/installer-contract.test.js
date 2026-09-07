'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('one-click installer entry exists', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'Install-DS-Harness.cmd')), true)
  assert.match(read('Install-DS-Harness.cmd'), /scripts\\install\.ps1/i)
})

test('normal launcher delegates incomplete installations to the one-click installer', () => {
  const text = read('Start-DeepSeek-Harness.cmd')
  assert.match(text, /INSTALL_REQUIRED/)
  assert.match(text, /Install-DS-Harness\.cmd/i)
  assert.doesNotMatch(text, /npm ci/i)
})

test('installer checks environment key before prompting and supports deferral', () => {
  const text = read('scripts/install.ps1')
  assert.match(text, /GetEnvironmentVariable\('DEEPSEEK_API_KEY', 'User'\)/)
  assert.match(text, /GetEnvironmentVariable\('DEEPSEEK_API_KEY', 'Machine'\)/)
  assert.match(text, /Configure later/i)
  assert.match(text, /Ctrl\+Shift\+M/)
})

test('dependency installer skips matching local dependencies and prefers offline reuse', () => {
  const text = read('scripts/install-deps.ps1')
  assert.match(text, /depsReady/)
  assert.match(text, /npm install skipped/i)
  assert.match(text, /--prefer-offline/)
  assert.match(text, /Reuse npm cache/i)
  assert.match(text, /Reuse Electron cache/i)
})

test('node bootstrap reuses compatible runtimes and cached archive', () => {
  const text = read('scripts/ensure-node.ps1')
  assert.match(text, /Test-CompatibleNode/)
  assert.match(text, /reuse cached archive/i)
  assert.match(text, /Node >= \$minMajor/)
  assert.doesNotMatch(text, /exit\s+[01]/i)
})

test('env template does not contain a fake configured API key', () => {
  const text = read('config/.env.example')
  assert.match(text, /DEEPSEEK_API_KEY=\s*(?:\r?\n|$)/)
  assert.doesNotMatch(text, /DEEPSEEK_API_KEY=sk-\.\.\./)
})

test('direct Electron launch loads project env without overriding system env', () => {
  const text = read('app/desktop-main.cjs')
  assert.match(text, /function loadProjectEnv/)
  assert.match(text, /if \(!process\.env\[key\]\) process\.env\[key\] = value/)
  const createWindow = text.split('async function startExtensions')[0]
  assert.doesNotMatch(createWindow, /preload\s*:/)
})
