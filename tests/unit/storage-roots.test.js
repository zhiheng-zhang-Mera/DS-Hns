'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const TEST_ROOT = process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts')

test('direct instance tests use project scratch even when caller TEMP points elsewhere', () => {
  const scratchRoot = require('../../app/runtime/storage-roots.cjs').resolveTestRoot(ROOT)
  fs.mkdirSync(scratchRoot, { recursive: true })
  const probeRoot = fs.mkdtempSync(path.join(scratchRoot, 'instance-root-probe-'))
  const callerTemp = path.join(probeRoot, 'caller-temp')
  const projectTemp = path.join(probeRoot, 'project-temp')
  fs.mkdirSync(callerTemp)
  const env = { ...process.env, TEMP: callerTemp, TMP: callerTemp, TMPDIR: callerTemp, DSH_TEST_ROOT: projectTemp }
  delete env.NODE_TEST_CONTEXT
  const probe = spawnSync(process.execPath, ['--test', path.join(ROOT, 'tests/unit/instance-isolation.test.js')], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
    env
  })
  assert.equal(probe.status, 0, probe.stderr || probe.stdout)
  assert.deepEqual(fs.readdirSync(callerTemp), [], 'instance tests wrote outside project scratch')
  assert.ok(fs.readdirSync(projectTemp).some(name => name.startsWith('dshns-instance-')))
})

test('the live storage audit recognizes instance scratch names without matching unrelated applications', { skip: process.platform !== 'win32' }, () => {
  const script = path.join(ROOT, 'scripts', 'post-test-audit.ps1').replaceAll("'", "''")
  const root = path.join(TEST_ROOT, 'audit-name-probe').replaceAll("'", "''")
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `. '${script}' -Root '${root}' -StartedAtUtc '9999-01-01T00:00:00Z' -ExcludeProcessId ${process.pid}; @('dshns-instance-425ZOx','dsh-test','ds-hns','ds-harness-cache','hns-data','unrelated-app','friendship') | ForEach-Object { [bool]($_ -match $projectPattern) } | ConvertTo-Json -Compress`
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(probe.status, 0, probe.stderr)
  const actual = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1))
  assert.deepEqual(actual, [true, true, true, true, true, false, false])
})

test('one storage contract resolves temp, runtime and test roots on the repository volume outside the checkout', () => {
  const { resolveStorageRoots } = require('../../app/runtime/storage-roots.cjs')
  const taskRoot = path.dirname(ROOT)
  const expected = {
    temp: path.join(taskRoot, 'temp'),
    runtime: path.join(taskRoot, 'runtime-data'),
    test: path.join(taskRoot, 'test-artifacts')
  }
  assert.deepEqual(resolveStorageRoots(ROOT, {
    DSH_TEMP_ROOT: expected.temp,
    DSH_RUNTIME_ROOT: expected.runtime,
    DSH_TEST_ROOT: expected.test
  }), expected)
  assert.deepEqual(resolveStorageRoots(ROOT, {
    DSH_TEMP_ROOT: 'C:\\Users\\example\\AppData\\Local\\Temp',
    DSH_RUNTIME_ROOT: 'C:\\Users\\example\\AppData\\Local\\Temp\\runtime',
    DSH_TEST_ROOT: 'C:\\Users\\example\\AppData\\Local\\Temp\\tests'
  }), expected)
})

test('the shared PowerShell environment exports every project root and redirects LOCALAPPDATA process-locally', () => {
  const env = fs.readFileSync(path.join(ROOT, 'scripts', 'env.ps1'), 'utf8')
  assert.match(env, /DSH_RUNTIME_ROOT/)
  assert.match(env, /DSH_TEST_ROOT/)
  assert.match(env, /LOCALAPPDATA/)
  assert.match(env, /runtime-data/)
  assert.match(env, /test-artifacts/)
  assert.match(env, /\.localappdata/)
})

test('tests and runtime helpers no longer choose the user LOCALAPPDATA temp tree', () => {
  const subWorker = fs.readFileSync(path.join(ROOT, 'tests', 'unit', 'sub-worker-manager.test.js'), 'utf8')
  const instance = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'instance.cjs'), 'utf8')
  assert.doesNotMatch(subWorker, /process\.env\.LOCALAPPDATA\s*\|\|/)
  assert.match(subWorker, /process\.env\.DSH_TEST_ROOT/)
  assert.match(instance, /resolveRuntimeRoot/)
})

test('qualification runs named post-test process and C-drive write gates', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'install-tests.ps1'), 'utf8')
  const auditPath = path.join(ROOT, 'scripts', 'post-test-audit.ps1')
  assert.equal(fs.existsSync(auditPath), true, 'post-test audit script is missing')
  const audit = fs.readFileSync(auditPath, 'utf8')
  assert.match(audit, /POST_TEST_PROCESS_LEAK_GATE/)
  assert.match(audit, /C_DRIVE_WRITE_AUDIT/)
  assert.match(audit, /Win32_Process/)
  assert.match(audit, /ExcludeProcessId/)
  assert.match(audit, /LocalApplicationData/)
  assert.match(runner, /post-test-audit\.ps1/)
  assert.match(runner, /-StartedAtUtc/)
  assert.match(runner, /\$Tier -eq 'Qualification'/)
})

test('Mega mutable paths and Harness children honor the isolated DSH_HOME contract', () => {
  const isolated = path.join(TEST_ROOT, 'isolated-home')
  const probe = spawnSync(process.execPath, ['-e', "const {PATHS}=require('./app/extensions/mega/utils/paths.js'); process.stdout.write(JSON.stringify(PATHS))"], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: isolated, DSH_RUNTIME_ROOT: path.join(TEST_ROOT, 'runtime-root'), DSH_TEMP_ROOT: path.join(TEST_ROOT, 'temp-root') },
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(probe.status, 0, probe.stderr)
  const paths = JSON.parse(probe.stdout)
  assert.equal(paths.DSH_HOME, isolated)
  assert.equal(paths.DATA, isolated)
  assert.equal(paths.STATE, path.join(isolated, 'state'))
  const shell = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
  assert.match(shell, /DSH_HOME: process\.env\.DSH_HOME/)
  assert.doesNotMatch(shell, /DSH_HOME: path\.join\(ROOT, 'data'\)/)
})
