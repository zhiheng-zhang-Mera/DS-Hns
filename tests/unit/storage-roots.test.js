'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

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
  assert.match(audit, /LocalApplicationData/)
  assert.match(runner, /post-test-audit\.ps1/)
  assert.match(runner, /-StartedAtUtc/)
  assert.match(runner, /\$Tier -eq 'Qualification'/)
})
