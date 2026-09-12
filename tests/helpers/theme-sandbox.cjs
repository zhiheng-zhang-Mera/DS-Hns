'use strict'

/**
 * Test helper: run theme-engine code inside a child process whose DSH_ROOT points
 * at a scratch project directory.
 *
 * The theme registry resolves `PATHS.DATA` from `DSH_ROOT` at require time, so an
 * in-process test would write theme files into the developer's real `data`
 * directory. Every test that installs, deletes or duplicates a theme therefore
 * runs in a child process against a temporary root — this is a correctness
 * requirement, not a convenience.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Absolute path to the repository's `app` directory. */
const APP_DIR = path.resolve(__dirname, '..', '..', 'app')

/**
 * Create a throwaway project root containing a copy of the built-in theme
 * packages, so a child process can build/install/delete without touching the
 * real installation.
 */
function makeSandboxRoot({ copyBuiltins = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hns-theme-test-'))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data', 'state'), { recursive: true })
  if (copyBuiltins) {
    const source = path.join(APP_DIR, 'extensions', 'mega', 'theme', 'builtin')
    fs.cpSync(source, path.join(root, 'builtin'), { recursive: true, force: true })
  }
  return root
}

function removeSandboxRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is harmless; never fail a test over cleanup.
  }
}

/**
 * Run a snippet inside a sandboxed child process.
 *
 * The snippet receives `require` rooted at the real `app` directory and must
 * `return` (or set `module.exports =`) a JSON-serialisable value; it is executed
 * as an async function body so `await` is available.
 *
 * @param {string} body      async function body
 * @param {object} [options]
 * @returns {{ok: boolean, value: any, stdout: string, stderr: string, status: number|null}}
 */
function runInSandbox(body, { root = null, timeoutMs = 120_000, env = {} } = {}) {
  const sandboxRoot = root || makeSandboxRoot()
  const ownsRoot = !root
  const wrapped = `
'use strict'
const APP = ${JSON.stringify(APP_DIR)}
const requireApp = (id) => require(require('node:path').join(APP, id))
module.exports = (async () => {
${body}
})()
`
  try {
    const result = spawnSync(process.execPath, ['-e', wrapped], {
      cwd: APP_DIR,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        DSH_ROOT: sandboxRoot,
        DSH_HOME: path.join(sandboxRoot, 'data'),
        ...env
      }
    })
    const stdout = result.stdout || ''
    const stderr = result.stderr || ''
    // The child prints its payload as a single JSON line prefixed with a marker so
    // incidental console output never corrupts the result.
    const marker = '__HNS_TEST_RESULT__'
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(marker))
    let value = null
    let parseError = null
    if (line) {
      try {
        value = JSON.parse(line.slice(marker.length))
      } catch (error) {
        parseError = error
      }
    }
    return {
      ok: result.status === 0 && Boolean(line) && !parseError,
      value,
      stdout,
      stderr,
      status: result.status,
      parseError: parseError ? String(parseError.message) : null,
      sandboxRoot
    }
  } finally {
    if (ownsRoot) removeSandboxRoot(sandboxRoot)
  }
}

/**
 * Build the child-process script for a scenario expressed as a list of steps.
 * Each step is `{ id, code }` where `code` is an async function body whose return
 * value is recorded under `id`. `prelude` is shared setup injected into the same
 * scope (so `requireApp`, an engine instance or shared helpers are visible).
 */
function stepsScript(steps, prelude = '') {
  const list = Array.isArray(steps) ? steps : []
  const blocks = list.map((step) => `
  results[${JSON.stringify(step.id)}] = await (async () => { ${step.code} })()`).join('\n')
  return `
  const results = {}
${prelude}
${blocks}
  console.log('__HNS_TEST_RESULT__' + JSON.stringify(results))
  return results
`
}

/**
 * Run one scenario per throwaway project root.
 *
 * Each scenario gets its own sandbox: installing a theme is a filesystem side
 * effect, and sharing a root would let an earlier scenario's installed theme leak
 * into a later one's assertions. Results are flattened by step id, so a test reads
 * `value.import.ok`.
 *
 * A scenario is either a flat `{ stepId: code }` map or a grouped
 * `{ group: { stepId: code } }` map; both are accepted because a scenario with a
 * single step reads better flat while a multi-step scenario reads better grouped.
 *
 * @param {Record<string, object>} scenarios
 * @param {string} prelude  shared child-process setup
 * @returns {Record<string, any>} `{ [stepId]: value }`
 */
function runScenarios(scenarios, prelude = '') {
  const out = {}
  for (const name of Object.keys(scenarios)) {
    const group = scenarios[name] || {}
    const stepList = []
    for (const key of Object.keys(group)) {
      const entry = group[key]
      if (typeof entry === 'string') {
        stepList.push({ id: key, code: entry })
        continue
      }
      if (entry && typeof entry === 'object') {
        for (const innerId of Object.keys(entry)) {
          const inner = entry[innerId]
          stepList.push({ id: innerId, code: typeof inner === 'string' ? inner : String((inner && inner.code) || '') })
        }
      }
    }
    const result = runInSandbox(stepsScript(stepList, prelude))
    if (!result.ok) {
      throw new Error(
        `sandbox scenario "${name}" failed (status ${result.status})\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`
      )
    }
    for (const stepId of Object.keys(result.value || {})) out[stepId] = result.value[stepId]
  }
  return out
}

module.exports = {
  APP_DIR,
  makeSandboxRoot,
  removeSandboxRoot,
  runInSandbox,
  stepsScript,
  runScenarios
}
