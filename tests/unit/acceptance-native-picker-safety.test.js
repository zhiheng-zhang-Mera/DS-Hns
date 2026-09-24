'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ROOT = path.resolve(__dirname, '..', '..')
const { resolveTestRoot } = require('../../app/runtime/storage-roots.cjs')

// Keep real file effects; replace only the OS-input boundary so a regression
// cannot type into the developer's foreground application during this test.
function loadPicker(dataDir) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/acceptance.mjs'), 'utf8')
  const start = source.indexOf('async function pickLocalDirectory(')
  const end = source.indexOf('\n// ---------------------------------------------------------------------------', start)
  assert.ok(start > 0 && end > start)
  return vm.runInNewContext(`${source.slice(start, end)}; pickLocalDirectory`, {
    fs, path, process, Date,
    OPTIONS: { dataDir, root: ROOT, appName: 'Qualification picker fixture', port: 3091 },
    note() {},
    resolvePowerShell: () => 'powershell.exe',
    spawn() { throw new Error('UNSCOPED_DESKTOP_INPUT_FORBIDDEN') },
    setTimeout, clearTimeout
  })
}

function scratch(t) {
  const base = resolveTestRoot(ROOT)
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.mkdtempSync(path.join(base, 'native-picker-contract-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('native picker requests targeted input without spawning global input', async (t) => {
  const dataDir = scratch(t)
  const sourceDirectory = path.join(dataDir, 'skill-source')
  fs.mkdirSync(sourceDirectory)
  let clicked = false
  const page = { async evaluate(script) {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'native-picker-request.json'), 'utf8'))
    assert.equal(record.directory, sourceDirectory)
    assert.equal(record.root, ROOT)
    assert.equal(record.status, 'AWAITING_TARGETED_NATIVE_INPUT')
    assert.equal(record.port, 3091)
    assert.ok(Number.isFinite(Date.parse(record.startedAt)))
    assert.match(script, /skillsPickDir/)
    clicked = true
    return true
  } }
  await assert.doesNotReject(loadPicker(dataDir)(page, sourceDirectory))
  assert.equal(clicked, true)
})

test('stale picker request fails before opening another dialog or overwriting evidence', async (t) => {
  const dataDir = scratch(t)
  const requestFile = path.join(dataDir, 'native-picker-request.json')
  fs.writeFileSync(requestFile, 'prior evidence')
  let clicked = false
  await assert.rejects(loadPicker(dataDir)({ async evaluate() { clicked = true } }, dataDir), { code: 'EEXIST' })
  assert.equal(clicked, false)
  assert.equal(fs.readFileSync(requestFile, 'utf8'), 'prior evidence')
})

test('picker request does not report installation when the renderer refuses to open it', async (t) => {
  const dataDir = scratch(t)
  await assert.rejects(loadPicker(dataDir)({ async evaluate() { throw new Error('renderer disconnected') } }, dataDir), /renderer disconnected/)
  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'native-picker-request.json'), 'utf8'))
  assert.equal(record.status, 'AWAITING_TARGETED_NATIVE_INPUT')
  assert.equal(Object.hasOwn(record, 'passed'), false)
})
