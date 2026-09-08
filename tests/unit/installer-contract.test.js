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

test('dependency installer has package, binary-repair, and fully-ready states', () => {
  const text = read('scripts/install-deps.ps1')
  assert.match(text, /dshPackageReady/)
  assert.match(text, /electronPackageReady/)
  assert.match(text, /electronBinaryReady/)
  assert.match(text, /Repair-ElectronBinary/)
  assert.match(text, /binary is missing/i)
  assert.match(text, /node_modules will not be reinstalled/i)
  assert.match(text, /npm install skipped/i)
  assert.match(text, /--prefer-offline/)
})

test('dependency installer reuses npm and Electron caches using current Electron cache variable', () => {
  const text = read('scripts/install-deps.ps1')
  assert.match(text, /Reuse npm cache/i)
  assert.match(text, /Reuse Electron cache/i)
  assert.match(text, /electron_config_cache/)
  assert.match(text, /ELECTRON_CACHE/)
})

test('dependency verification distinguishes package version mismatch from missing Electron binary', () => {
  const text = read('scripts/install-deps.ps1')
  assert.match(text, /Electron package version mismatch/)
  assert.match(text, /Electron binary missing after repair/)
  assert.doesNotMatch(text, /Electron dependency verification failed: expected/)
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

test('reinstall cleanup kills only repository-owned Electron and DSH processes', () => {
  const cleanup = read('scripts/cleanup-runtime.ps1')
  assert.match(cleanup, /Same-Path/)
  assert.match(cleanup, /repository Electron shell/)
  assert.match(cleanup, /repository DSH web process/)
  assert.match(cleanup, /dsh-process\.json/)
  assert.match(cleanup, /Port 3080 is still occupied by an unrelated process/)
  assert.doesNotMatch(cleanup, /Stop-Process\s+-Name\s+node/i)
})

test('installer runs stale-runtime cleanup before dependency installation', () => {
  const text = read('scripts/install.ps1')
  const cleanup = text.indexOf("cleanup-runtime.ps1")
  const deps = text.indexOf("2/7 Resolve/reuse dependencies")
  assert.ok(cleanup >= 0)
  assert.ok(deps > cleanup)
})

test('stop helper uses the same repository-owned cleanup path', () => {
  const text = read('scripts/stop.ps1')
  assert.match(text, /cleanup-runtime\.ps1/)
  assert.match(text, /AllowForeignPort/)
  assert.doesNotMatch(text, /app\\monitor/i)
})

test('critical installer PowerShell files stay ASCII-only for Windows PowerShell 5.1', () => {
  const files = [
    'scripts/install.ps1',
    'scripts/install-deps.ps1',
    'scripts/ensure-node.ps1',
    'scripts/cleanup-runtime.ps1',
    'scripts/stop.ps1',
    'scripts/env.ps1',
    'scripts/test-all.ps1',
    'scripts/verify.ps1'
  ]
  for (const file of files) {
    const text = read(file).replace(/^\uFEFF/, '')
    assert.equal(/[^\x00-\x7F]/.test(text), false, `${file} contains non-ASCII characters`)
  }
})

test('installer preflights child PowerShell scripts before dependency work', () => {
  const text = read('scripts/install.ps1')
  assert.match(text, /Parser\]::ParseFile/)
  assert.match(text, /PowerShell parser preflight/i)
  assert.match(text, /cleanup-runtime\.ps1/)
  assert.ok(text.indexOf("0/7 PowerShell parser preflight") < text.indexOf("2/7 Resolve/reuse dependencies"))
})
