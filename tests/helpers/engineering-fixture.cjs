'use strict'

/**
 * A scratch repository for engineering-runtime tests.
 *
 * The acceptance scenario the plan describes is "fix a failing unit test in a
 * repository the runtime has never seen", so the fixture is a real, tiny Node
 * project on disk with a real failing test and a real regression suite — not a
 * mock. Tests point the runtime at a copy of it, let it work, and then check what
 * is actually on disk afterwards.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/** The broken implementation: `add` subtracts. */
const BROKEN_LIB = `'use strict'

function add(a, b) {
  return a - b
}

module.exports = { add }
`

/** The fix. */
const FIXED_LIB = `'use strict'

function add(a, b) {
  return a + b
}

module.exports = { add }
`

/** A second, deliberately wrong fix: used to prove a failed hypothesis is not repeated. */
const STILL_WRONG_LIB = `'use strict'

function add(a, b) {
  return a * b
}

module.exports = { add }
`

const TEST_FILE = `'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { add } = require('../src/math.cjs')

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('add handles zero', () => {
  assert.equal(add(0, 7), 7)
})
`

const PACKAGE_JSON = `{
  "name": "engineering-fixture",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "node --test tests/unit"
  }
}
`

const README = `# engineering fixture

A scratch repository: \`src/math.cjs\` implements \`add\`, \`tests/unit/math.test.cjs\`
checks it. Run the tests with \`npm test\`.

Engineering instructions for this repository: the suite must pass before a change
is considered done.
`

/**
 * Create a scratch repository.
 *
 * @param {object} [options]
 * @param {boolean} [options.broken] start with the buggy implementation (default true)
 * @param {boolean} [options.git] initialise a git repository with a first commit
 * @param {string} [options.prefix] the temp-dir prefix
 * @param {boolean} [options.dirty] leave an uncommitted user change behind
 */
function createFixtureRepo(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || 'engineering-fixture-'))
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'math.cjs'), options.broken === false ? FIXED_LIB : BROKEN_LIB)
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'math.test.cjs'), TEST_FILE)
  fs.writeFileSync(path.join(dir, 'package.json'), PACKAGE_JSON)
  fs.writeFileSync(path.join(dir, 'README.md'), README)
  if (options.git !== false) {
    spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true })
    spawnSync('git', ['config', 'user.email', 'engineering@test.invalid'], { cwd: dir, windowsHide: true })
    spawnSync('git', ['config', 'user.name', 'Engineering Fixture'], { cwd: dir, windowsHide: true })
    spawnSync('git', ['add', '.'], { cwd: dir, windowsHide: true })
    spawnSync('git', ['commit', '-q', '-m', 'fixture: initial'], { cwd: dir, windowsHide: true })
  }
  if (options.dirty === true) {
    fs.writeFileSync(path.join(dir, 'NOTES-user.txt'), 'the user was working on this\n')
  }
  return dir
}

/** Remove a scratch repository. */
function removeFixtureRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** Run the fixture's own suite directly, for the test's own baseline. */
function runFixtureTests(dir) {
  const result = spawnSync(process.execPath, ['--test', 'tests/unit'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000
  })
  return { exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

module.exports = {
  createFixtureRepo,
  removeFixtureRepo,
  runFixtureTests,
  BROKEN_LIB,
  FIXED_LIB,
  STILL_WRONG_LIB,
  TEST_FILE,
  PACKAGE_JSON,
  README
}
