'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const fs = require('node:fs')
const { definitions, parseArgs, readReport } = require('../../scripts/qualification-runner.cjs')

test('the qualification matrix names every mandatory gate and gives report producers run-local paths', () => {
  const runDir = path.join(ROOT, 'test-artifacts', 'qualification-fixture')
  const matrix = definitions(runDir, '2026-09-22T00:00:00.000Z')
  const ids = matrix.map((entry) => entry.id)
  for (const id of [
    'syntax-check', 'all-unit-tests', 'architecture-verifier', 'external-fixtures', 'install-pipeline', 'cordis-adapter',
    'process-adapter', 'native-hns-adapter', 'health-restart-continuity', 'community-installer',
    'electron-ui-acceptance', 'computer-use-longrun', 'longhost-chaos', 'synthetic-soak',
    'combined-acceptance', 'post-test-audit'
  ]) assert.ok(ids.includes(id), `missing ${id}`)
  assert.equal(matrix.every((entry) => entry.mandatory === true), true)
  for (const entry of matrix.filter((item) => item.report)) {
    assert.equal(path.relative(runDir, entry.report).startsWith('..'), false, `${entry.id} report escaped the run`)
  }
  for (const id of ['install-pipeline', 'cordis-adapter', 'process-adapter']) {
    const entry = matrix.find((item) => item.id === id)
    assert.equal(entry.stdoutJson, true, `${id} must persist its JSON stdout as a run-local child report`)
  }
  const audit = matrix.find((entry) => entry.id === 'post-test-audit')
  assert.ok(audit.args.includes('-ExcludeProcessId'), 'the post-test gate must exclude only its live qualification orchestrator')
  const ui = matrix.find((entry) => entry.id === 'electron-ui-acceptance')
  assert.ok(ui.args.includes('--skills') && ui.args.includes('--github'), 'final UI acceptance must exercise skills and live GitHub installation')
})

test('selection and output-root arguments are explicit', () => {
  const parsed = parseArgs(['--out-root', 'D:/qualification', '--only=syntax-check,combined-acceptance', '--allow-dirty'])
  assert.equal(parsed.outRoot, path.resolve('D:/qualification'))
  assert.deepEqual([...parsed.only], ['syntax-check', 'combined-acceptance'])
  assert.equal(parsed.allowDirty, true)
})

test('runner report parsing accepts PowerShell UTF-8 BOM files', () => {
  const dir = fs.mkdtempSync(path.join(process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts'), 'runner-bom-'))
  const file = path.join(dir, 'report.json')
  try {
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ passed: true })}`, 'utf8')
    assert.deepEqual(readReport(file), { passed: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
