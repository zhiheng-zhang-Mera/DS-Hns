'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

test('Harness temp resolution stays on the repository volume and outside the workspace', () => {
  const { resolveCommandTemp } = require('../../app/runtime/temp-root.cjs')
  const external = path.join(path.dirname(ROOT), 'temp')
  assert.equal(resolveCommandTemp(ROOT, { DSH_TEMP_ROOT: external }), external)
  assert.equal(resolveCommandTemp(ROOT, { TMP: path.join(ROOT, 'temp'), TEMP: path.join(ROOT, 'cache', 'temp') }), external)
  assert.equal(resolveCommandTemp(ROOT, { TMP: 'C:\\Windows\\Temp', TEMP: 'C:\\Temp' }), external)
})

test('both Harness launch paths use the shared external temp resolver', () => {
  const desktop = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
  const service = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'harness-service.cjs'), 'utf8')
  const instance = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'instance.cjs'), 'utf8')
  for (const source of [desktop, service, instance]) assert.match(source, /resolveCommandTemp/)
  for (const source of [desktop, service]) {
    assert.doesNotMatch(source, /TEMP:\s*path\.join\(ROOT, 'temp'\)/)
    assert.doesNotMatch(source, /TMP:\s*path\.join\(ROOT, 'temp'\)/)
  }
  assert.match(service, /commandTemp \|\| resolveCommandTemp\(root, process\.env\)/, 'the Runtime Host directory preflight must remain callable before the Harness service exists')
})
