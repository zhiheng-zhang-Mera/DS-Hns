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

test('installer checks canonical and legacy API environment names before prompting', () => {
  const text = read('scripts/install.ps1')
  assert.match(text, /GetEnvironmentVariable\('DEEPSEEK_API_KEY', 'User'\)/)
  assert.match(text, /GetEnvironmentVariable\('DEEPSEEK_API_KEY', 'Machine'\)/)
  assert.match(text, /GetEnvironmentVariable\('DeepSeek_API', 'User'\)/)
  assert.match(text, /GetEnvironmentVariable\('DeepSeek_API', 'Machine'\)/)
  assert.match(text, /Reusing it as DEEPSEEK_API_KEY/)
  assert.match(text, /Configure later/i)
  assert.match(text, /Ctrl\+Shift\+M/)
})

test('shared environment maps DeepSeek_API alias without changing system scope', () => {
  const text = read('scripts/env.ps1')
  assert.match(text, /DeepSeek_API/)
  assert.match(text, /\$env:DEEPSEEK_API_KEY = \[string\]\$legacyApi/)
  assert.doesNotMatch(text, /SetEnvironmentVariable\('DeepSeek_API'/)
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

test('direct Electron launch normalizes DeepSeek_API before project env loading', () => {
  const text = read('app/desktop-main.cjs')
  assert.match(text, /function normalizeApiKeyEnv/)
  assert.match(text, /key\.toUpperCase\(\) === 'DEEPSEEK_API'/)
  assert.match(text, /process\.env\.DEEPSEEK_API_KEY = value/)
  assert.ok(text.indexOf('normalizeApiKeyEnv()') < text.indexOf('loadProjectEnv()'))
  assert.match(text, /if \(!process\.env\[key\]\) process\.env\[key\] = value/)
})

test('official harness renderer stays untouched: only the dock carries a preload', () => {
  const text = read('app/desktop-main.cjs')
  // The official renderer is never given a preload (the protected-renderer rule). One
  // sanctioned preload user remains — the integrated Mega dock — and the second one that
  // used to exist here was the Dual-UI native frontend, which was removed with Daily.
  const officialSection = text.split('function createOfficialHarnessView')[1].split('function createIntegratedMegaDock')[0]
  assert.doesNotMatch(officialSection, /preload\s*:/)
  const megaDockSection = text.split('function createIntegratedMegaDock')[1]
  assert.match(megaDockSection, /preload:\s*path\.join\(__dirname, 'extensions', 'mega', 'ui', 'preload\.cjs'\)/)
  // Nothing creates a view with the removed native preload any more.
  assert.equal(/native-ui/.test(text), false)
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
  const deps = text.indexOf("2/8 Resolve/reuse dependencies")
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
    'scripts/install-profile-plugin.ps1',
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
  assert.ok(text.indexOf("0/8 PowerShell parser preflight") < text.indexOf("2/8 Resolve/reuse dependencies"))
})

test('installer signs the shipped orb plugin into the Harness profile before the tests', () => {
  const text = read('scripts/install.ps1')
  // The ball in the official UI is drawn by the client plugin DS-Hns ships, and only a profile that
  // has it installed mounts it. That install lives outside the repository (`data\*` is git-ignored
  // and the dependency is an absolute `file:` path), so it is a step of the installation: every host
  // installed without it shows no ball at all.
  assert.match(text, /install-profile-plugin\.ps1/)
  const deps = text.indexOf('2/8 Resolve/reuse dependencies')
  const step = text.indexOf('4/8 Sign the shipped client plugin into the Harness profile')
  const tests = text.indexOf('5/8 Unit and architecture tests')
  assert.ok(step > deps && step < tests, 'the profile step runs after dependencies and before the tests')
  // An enhancement never fails an installation: the step warns, and the install carries on.
  assert.match(text, /The orb plugin is not in the Harness profile/)
  assert.doesNotMatch(text, /throw 'The orb plugin/)
})

test('the orb plugin is installed by the Harness own CLI, never by writing the profile', () => {
  const text = read('scripts/install-profile-plugin.ps1')
  // Installing into the profile is the Harness' own CLI's business (`dsh plugin ... add`), which is
  // also what the manual install used: this script resolves Node and pnpm and calls it.
  assert.match(text, /@deepseek-ai\\dsh\\lib\\bin\.js/)
  assert.match(text, /'plugin' '--profile' \$profileName 'add' \$spec/)
  assert.match(text, /corepack/)
  // Reuse-first: a satisfied profile is reported and left alone.
  assert.match(text, /already-installed/)
  // The profile manifest is read, never written.
  assert.doesNotMatch(text, /ConvertTo-Json/)
  assert.doesNotMatch(text, /Set-Content/)
})
