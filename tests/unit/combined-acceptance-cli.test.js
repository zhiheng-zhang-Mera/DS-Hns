'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')

test('combined acceptance help exits before phases, fixtures, or report writes', () => {
  const reportRelative = path.join('runtime', `combined-acceptance-help-${process.pid}.json`)
  const reportAbsolute = path.resolve(ROOT, reportRelative)
  const tempRoot = path.resolve(ROOT, 'runtime', `combined-acceptance-help-temp-${process.pid}`)
  assert.equal(path.relative(ROOT, reportAbsolute).startsWith('..'), false)
  assert.equal(fs.existsSync(reportAbsolute), false, 'test report path must start absent')

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'combined-acceptance.cjs'),
      '--help', '--phase', '', '--out', reportRelative
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        TEMP: tempRoot,
        TMP: tempRoot,
        DSH_TEMP_ROOT: tempRoot,
        DSH_TEST_ROOT: tempRoot
      }
    })

    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage:/i)
    assert.equal(fs.existsSync(reportAbsolute), false, 'help must not write an acceptance report')
  } finally {
    if (fs.existsSync(reportAbsolute)) fs.rmSync(reportAbsolute)
  }
})

test('combined acceptance rejects unknown options before any acceptance side effect', () => {
  const reportRelative = path.join('runtime', `combined-acceptance-unknown-${process.pid}.json`)
  const reportAbsolute = path.resolve(ROOT, reportRelative)
  const tempRoot = path.resolve(ROOT, 'runtime', `combined-acceptance-unknown-temp-${process.pid}`)
  assert.equal(path.relative(ROOT, reportAbsolute).startsWith('..'), false)
  assert.equal(fs.existsSync(reportAbsolute), false, 'test report path must start absent')

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'combined-acceptance.cjs'),
      '--not-a-supported-option', '--phase', '', '--out', reportRelative
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        TEMP: tempRoot,
        TMP: tempRoot,
        DSH_TEMP_ROOT: tempRoot,
        DSH_TEST_ROOT: tempRoot
      }
    })

    assert.ifError(result.error)
    assert.equal(result.status, 2, result.stderr || result.stdout)
    assert.match(result.stderr, /unknown option.*--not-a-supported-option/i)
    assert.equal(fs.existsSync(reportAbsolute), false, 'invalid options must not write an acceptance report')
  } finally {
    if (fs.existsSync(reportAbsolute)) fs.rmSync(reportAbsolute)
  }
})
