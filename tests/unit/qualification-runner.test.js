'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const { definitions, parseArgs } = require('../../scripts/qualification-runner.cjs')

test('the qualification matrix names every mandatory gate and gives report producers run-local paths', () => {
  const runDir = path.join(ROOT, 'test-artifacts', 'qualification-fixture')
  const matrix = definitions(runDir, '2026-09-22T00:00:00.000Z')
  const ids = matrix.map((entry) => entry.id)
  for (const id of [
    'syntax-check', 'all-unit-tests', 'architecture-verifier', 'install-pipeline', 'cordis-adapter',
    'process-adapter', 'native-hns-adapter', 'health-restart-continuity', 'community-installer',
    'electron-ui-acceptance', 'computer-use-longrun', 'longhost-chaos', 'synthetic-soak',
    'combined-acceptance', 'post-test-audit'
  ]) assert.ok(ids.includes(id), `missing ${id}`)
  assert.equal(matrix.every((entry) => entry.mandatory === true), true)
  for (const entry of matrix.filter((item) => item.report)) {
    assert.equal(path.relative(runDir, entry.report).startsWith('..'), false, `${entry.id} report escaped the run`)
  }
})

test('selection and output-root arguments are explicit', () => {
  const parsed = parseArgs(['--out-root', 'D:/qualification', '--only=syntax-check,combined-acceptance', '--allow-dirty'])
  assert.equal(parsed.outRoot, path.resolve('D:/qualification'))
  assert.deepEqual([...parsed.only], ['syntax-check', 'combined-acceptance'])
  assert.equal(parsed.allowDirty, true)
})
