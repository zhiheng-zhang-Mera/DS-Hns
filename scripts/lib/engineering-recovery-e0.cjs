'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const evidence = require('./engineering-recovery-evidence.cjs')

const ROOT = path.resolve(__dirname, '../..')
const EXPECTED_BRANCH = 'dev/crash-resume-recovery-v1'
const REQUIRED_GATE_IDS = ['syntax', 'full-unit', 'focused-recovery', 'test-all']
const FOCUSED_SUITES = [
  'tests/unit/engineering-checkpoint.test.js',
  'tests/unit/engineering-host-resume.test.js',
  'tests/unit/engineering-cross-volume-cleanup.test.js',
  'tests/unit/engineering-recovery-store.test.js',
  'tests/unit/engineering-recovery-schema.test.js',
  'tests/unit/engineering-evidence-harness.test.js'
]

function summarizeTestOutput(output) {
  const value = String(output || '')
  const read = (name) => {
    const match = value.match(new RegExp(`(?:^|\\n)\\s*[#ℹ]\\s*${name}\\s+(\\d+)(?:\\s|$)`, 'm'))
    return match ? Number(match[1]) : null
  }
  const tests = read('tests')
  if (tests === null) return { tests: null, passed: null, failed: null, skipped: null }
  return {
    tests,
    passed: read('pass'),
    failed: read('fail'),
    skipped: read('skipped') ?? 0
  }
}

function makeGateRecord({ id, exitCode, durationMs, logSha256, output }) {
  const counts = summarizeTestOutput(output)
  const syntaxOnly = id === 'syntax'
  const validTestSummary = syntaxOnly || (
    counts.tests !== null && counts.passed !== null && counts.failed !== null &&
    counts.failed === 0 && counts.passed + counts.skipped === counts.tests
  )
  return {
    id,
    status: exitCode === 0 && validTestSummary ? 'PASS' : 'FAIL',
    exitCode: Number.isInteger(exitCode) ? exitCode : 1,
    durationMs: Math.max(0, Number(durationMs) || 0),
    logSha256,
    tests: counts.tests,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped
  }
}

function makeGateDocument({ runId, branch, implementationSha, runtime, osName, startedAt, finishedAt, gates }) {
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  const passed = REQUIRED_GATE_IDS.every((id) => {
    const gate = byId.get(id)
    return gate && gate.status === 'PASS' && gate.exitCode === 0
  }) && gates.length === REQUIRED_GATE_IDS.length
  return {
    schemaVersion: 1,
    runId,
    branch,
    implementationSha,
    runtime,
    os: osName,
    tempVolume: 'D:',
    startedAt,
    finishedAt,
    gates,
    passed
  }
}

function runGit(args) {
  const result = require('node:child_process').spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error ? result.error.message : result.stderr}`)
  }
  return String(result.stdout || '').trim()
}

function ensureCleanTargetCheckout() {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const implementationSha = runGit(['rev-parse', 'HEAD']).toLowerCase()
  const status = runGit(['status', '--porcelain', '--untracked-files=normal'])
  if (branch !== EXPECTED_BRANCH) throw new Error(`E0 requires ${EXPECTED_BRANCH}; found ${branch}`)
  if (!/^[a-f0-9]{40}$/.test(implementationSha)) throw new Error('E0 could not resolve a full implementation SHA')
  if (status) throw new Error('E0 requires a clean worktree; commit or remove intentional changes first')
  return { branch, implementationSha }
}

function keepTail(previous, chunk, limit = 96 * 1024) {
  const combined = previous + chunk.toString('utf8')
  return combined.length <= limit ? combined : combined.slice(-limit)
}

function runLogged({ id, command, args, cwd, env, logPath }) {
  return new Promise((resolve) => {
    const began = Date.now()
    const log = fs.createWriteStream(logPath, { flags: 'wx' })
    let tail = ''
    let settled = false
    let child
    const heartbeat = setInterval(() => {
      const seconds = Math.floor((Date.now() - began) / 1000)
      process.stdout.write(`[E0] ${id} still running (${seconds}s)\n`)
    }, 30000)
    const finish = (exitCode, errorText = '') => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      if (errorText) {
        tail = keepTail(tail, `\n[runner-error] ${errorText}\n`)
        log.write(`\n[runner-error] ${errorText}\n`)
      }
      log.end(() => {
        const durationMs = Date.now() - began
        const record = makeGateRecord({
          id,
          exitCode,
          durationMs,
          logSha256: crypto.createHash('sha256').update(fs.readFileSync(logPath)).digest('hex'),
          output: tail
        })
        process.stdout.write(`[E0] ${id}: ${record.status} (exit ${record.exitCode}, ${durationMs} ms)\n`)
        resolve(record)
      })
    }
    try {
      child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk) => { tail = keepTail(tail, chunk); log.write(chunk) })
      child.stderr.on('data', (chunk) => { tail = keepTail(tail, chunk); log.write(chunk) })
      child.on('error', (error) => finish(1, error.message))
      child.on('close', (code) => finish(Number.isInteger(code) ? code : 1))
    } catch (error) {
      finish(1, error.message)
    }
  })
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace(/Z$/, 'Z')
}

async function runE0() {
  evidence.requireDVolume(ROOT)
  const start = new Date()
  const runId = `E0-${timestampSlug(start)}`
  const evidenceRoot = path.join(ROOT, 'runtime', 'engineering', 'evidence', 'recovery', runId)
  fs.mkdirSync(path.join(evidenceRoot, 'logs'), { recursive: true })
  const tmpRoot = path.join(evidenceRoot, 'tmp')
  fs.mkdirSync(tmpRoot, { recursive: true })
  process.env.TEMP = tmpRoot
  process.env.TMP = tmpRoot

  let identity
  try {
    identity = ensureCleanTargetCheckout()
  } catch (error) {
    fs.writeFileSync(path.join(evidenceRoot, 'preflight-failure.txt'), `${error.message}\n`, 'utf8')
    process.stderr.write(`[E0] preflight failed; diagnostics: ${path.join(evidenceRoot, 'preflight-failure.txt')}\n`)
    return { ok: false, evidenceRoot, error }
  }

  const allUnitTests = fs.readdirSync(path.join(ROOT, 'tests', 'unit'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => path.join('tests', 'unit', name))
  if (allUnitTests.length === 0 || FOCUSED_SUITES.some((suite) => !fs.existsSync(path.join(ROOT, suite)))) {
    throw new Error('E0 test inventory is incomplete')
  }

  const node = process.execPath
  const powerShell = 'powershell.exe'
  const gates = []
  const commands = [
    { id: 'syntax', command: node, args: ['scripts/check-syntax.cjs'] },
    { id: 'full-unit', command: node, args: ['--test', '--test-concurrency=2', ...allUnitTests] },
    { id: 'focused-recovery', command: node, args: ['--test', '--test-concurrency=2', ...FOCUSED_SUITES] },
    { id: 'test-all', command: powerShell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/test-all.ps1'] }
  ]
  for (const gate of commands) {
    process.stdout.write(`[E0] starting ${gate.id}\n`)
    const logPath = path.join(evidenceRoot, 'logs', `${gate.id}.log`)
    const record = await runLogged({
      ...gate,
      cwd: ROOT,
      env: { ...process.env, TEMP: tmpRoot, TMP: tmpRoot },
      logPath
    })
    gates.push(record)
  }

  const finishedAt = new Date().toISOString()
  const document = makeGateDocument({
    runId,
    branch: identity.branch,
    implementationSha: identity.implementationSha,
    runtime: process.version,
    osName: `${os.type()} ${os.release()} ${os.arch()}`,
    startedAt: start.toISOString(),
    finishedAt,
    gates
  })
  const validation = evidence.validateEvidenceDocument('e0Gate', document)
  if (!validation.ok) throw new Error(`Generated E0 gate is invalid: ${validation.errors.join('; ')}`)
  const gatePath = path.join(evidenceRoot, 'e0-gate.json')
  const tempGatePath = `${gatePath}.tmp`
  fs.writeFileSync(tempGatePath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(tempGatePath, gatePath)
  process.stdout.write(`[E0] ${document.passed ? 'PASS' : 'FAIL'}; evidence: ${evidenceRoot}\n`)
  return { ok: document.passed, evidenceRoot, gatePath, document }
}

if (require.main === module) {
  runE0().then((result) => { process.exitCode = result.ok ? 0 : 1 }).catch((error) => {
    process.stderr.write(`[E0] fatal: ${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  EXPECTED_BRANCH,
  REQUIRED_GATE_IDS,
  FOCUSED_SUITES,
  summarizeTestOutput,
  makeGateRecord,
  makeGateDocument,
  ensureCleanTargetCheckout,
  runE0
}
