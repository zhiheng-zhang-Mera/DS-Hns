'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { countChecks, countFailures, validateQualification } = require('./evidence-consistency.cjs')

const ROOT = path.resolve(__dirname, '..')
const NODE = process.execPath
const POWERSHELL = process.platform === 'win32' ? (process.env.DSH_POWERSHELL_EXE || 'powershell.exe') : 'pwsh'

function git(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return String(result.stdout).trim()
}

function definitions(runDir, startedAt) {
  const report = (name) => path.join(runDir, 'reports', `${name}.json`)
  const ps = (file, ...args) => ({ command: POWERSHELL, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', file), ...args] })
  const node = (file, ...args) => ({ command: NODE, args: [path.join(ROOT, 'scripts', file), ...args] })
  return [
    { id: 'syntax-check', mandatory: true, ...node('check-syntax.cjs') },
    { id: 'all-unit-tests', mandatory: true, ...ps('test-all.ps1') },
    { id: 'architecture-verifier', mandatory: true, ...ps('verify.ps1') },
    { id: 'install-pipeline', mandatory: true, ...node('install-pipeline-acceptance.cjs', '--json') },
    { id: 'cordis-adapter', mandatory: true, ...node('cordis-adapter-acceptance.cjs', '--json') },
    { id: 'process-adapter', mandatory: true, ...node('process-adapter-acceptance.cjs', '--json') },
    { id: 'native-hns-adapter', mandatory: true, command: NODE, args: ['--test', path.join(ROOT, 'tests', 'unit', 'plugin-hns-native.test.js')] },
    { id: 'health-restart-continuity', mandatory: true, command: NODE, args: ['--test', path.join(ROOT, 'tests', 'unit', 'restart-supervisor-authority.test.js'), path.join(ROOT, 'tests', 'unit', 'longhost-continuity.test.js')] },
    { id: 'community-installer', mandatory: true, report: report('community-installer'), ...node('installer-community-acceptance.cjs', '--json', `--report=${report('community-installer')}`) },
    { id: 'electron-ui-acceptance', mandatory: true, report: report('electron-ui-acceptance'), command: NODE, args: [path.join(ROOT, 'scripts', 'acceptance.mjs'), '--root', ROOT, '--port', '3091', '--cdp', '9331', '--user-data-dir', path.join(runDir, 'runtime', 'electron-user-data'), '--report', report('electron-ui-acceptance')] },
    { id: 'computer-use-longrun', mandatory: true, report: report('computer-use-longrun'), ...node('computer-use-longrun-acceptance.cjs', '--out', report('computer-use-longrun')) },
    { id: 'longhost-chaos', mandatory: true, report: report('longhost-chaos'), ...node('longhost-chaos.cjs', `--out=${report('longhost-chaos')}`) },
    { id: 'synthetic-soak', mandatory: true, report: report('synthetic-soak'), ...node('longhost-soak.cjs', `--out=${report('synthetic-soak')}`) },
    { id: 'combined-acceptance', mandatory: true, report: report('combined-acceptance'), ...node('combined-acceptance.cjs', '--out', report('combined-acceptance')) },
    { id: 'post-test-audit', mandatory: true, report: report('post-test-audit'), ...ps('post-test-audit.ps1', '-Root', ROOT, '-StartedAtUtc', startedAt, '-ReportPath', report('post-test-audit')) }
  ]
}

function parseArgs(argv) {
  const args = { outRoot: process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts'), only: null, allowDirty: false, list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index])
    if (value === '--allow-dirty') args.allowDirty = true
    else if (value === '--list') args.list = true
    else if (value === '--out-root') args.outRoot = path.resolve(String(argv[++index]))
    else if (value.startsWith('--out-root=')) args.outRoot = path.resolve(value.slice(11))
    else if (value === '--only') args.only = new Set(String(argv[++index] || '').split(',').filter(Boolean))
    else if (value.startsWith('--only=')) args.only = new Set(value.slice(7).split(',').filter(Boolean))
    else throw new Error(`unknown argument: ${value}`)
  }
  return args
}

function readReport(file) {
  if (!file || !fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function runOne(definition, context) {
  const startedAt = new Date().toISOString()
  const rawDir = path.join(context.runDir, 'raw')
  const stdoutFile = path.join(rawDir, `${definition.id}.stdout.txt`)
  const stderrFile = path.join(rawDir, `${definition.id}.stderr.txt`)
  process.stdout.write(`[qualification] START ${definition.id}\n`)
  const result = spawnSync(definition.command, definition.args, {
    cwd: ROOT,
    env: context.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024
  })
  fs.writeFileSync(stdoutFile, result.stdout || '', 'utf8')
  fs.writeFileSync(stderrFile, result.stderr || '', 'utf8')
  const exitCode = Number.isInteger(result.status) ? result.status : 1
  const childReport = readReport(definition.report)
  const wrapper = {
    id: definition.id,
    runId: context.runId,
    gitSha: context.gitSha,
    gitTree: context.gitTree,
    branch: context.branch,
    mandatory: definition.mandatory !== false,
    startedAt,
    completedAt: new Date().toISOString(),
    command: [definition.command, ...definition.args],
    exitCode,
    passed: exitCode === 0,
    checks: childReport ? countChecks(childReport) : null,
    failures: childReport ? countFailures(childReport) : null,
    report: definition.report || null,
    rawEvidence: { stdout: stdoutFile, stderr: stderrFile },
    spawnError: result.error ? String(result.error.message || result.error) : null
  }
  fs.writeFileSync(path.join(context.runDir, 'results', `${definition.id}.json`), `${JSON.stringify(wrapper, null, 2)}\n`)
  process.stdout.write(`[qualification] ${wrapper.passed ? 'PASS' : 'FAIL'} ${definition.id} exit=${exitCode}\n`)
  return wrapper
}

function hashFiles(runDir) {
  const entries = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name !== 'artifact-index.json') {
        entries.push({ path: path.relative(runDir, file).replaceAll('\\', '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size })
      }
    }
  }
  walk(runDir)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

function main(argv) {
  const args = parseArgs(argv)
  if (!args.allowDirty && git('status', '--porcelain', '--untracked-files=no')) throw new Error('tracked working tree is dirty; qualification refuses a moving candidate')
  const gitSha = git('rev-parse', 'HEAD')
  const gitTree = git('rev-parse', 'HEAD^{tree}')
  const branch = git('branch', '--show-current')
  const startedAt = new Date().toISOString()
  const runId = `${startedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`
  const runDir = path.join(path.resolve(args.outRoot), 'qualification-runs', runId)
  const allDefinitions = definitions(runDir, startedAt)
  if (args.list) {
    process.stdout.write(`${allDefinitions.map((entry) => entry.id).join('\n')}\n`)
    return 0
  }
  const selected = args.only ? allDefinitions.filter((entry) => args.only.has(entry.id)) : allDefinitions
  if (!selected.length) throw new Error('no qualification gates selected')
  if (fs.existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`)
  for (const dir of ['raw', 'reports', 'results', 'runtime']) fs.mkdirSync(path.join(runDir, dir), { recursive: true })

  const env = {
    ...process.env,
    PATH: `${path.dirname(NODE)};${process.env.PATH || ''}`,
    DSH_QUALIFICATION_RUN_ID: runId,
    DSH_QUALIFICATION_GIT_SHA: gitSha,
    DSH_QUALIFICATION_GIT_TREE: gitTree,
    DSH_TEST_ROOT: path.join(runDir, 'runtime', 'test'),
    DSH_TEMP_ROOT: path.join(runDir, 'runtime', 'temp'),
    DSH_RUNTIME_ROOT: path.join(runDir, 'runtime', 'state'),
    TEMP: path.join(runDir, 'runtime', 'temp'),
    TMP: path.join(runDir, 'runtime', 'temp'),
    LOCALAPPDATA: path.join(runDir, 'runtime', 'localappdata'),
    APPDATA: path.join(runDir, 'runtime', 'appdata')
  }
  for (const key of ['DSH_TEST_ROOT', 'DSH_TEMP_ROOT', 'DSH_RUNTIME_ROOT', 'TEMP', 'LOCALAPPDATA', 'APPDATA']) fs.mkdirSync(env[key], { recursive: true })
  const context = { runId, runDir, gitSha, gitTree, branch, env }
  const results = selected.map((entry) => runOne(entry, context))
  let summary = {
    schema: 1,
    runId,
    gitSha,
    gitTree,
    branch,
    host: { hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch, cpus: os.cpus().length, totalMemory: os.totalmem() },
    toolchain: { node: process.version, nodeExecutable: NODE, powershell: POWERSHELL },
    startedAt,
    completedAt: new Date().toISOString(),
    results,
    mandatoryFailures: results.filter((entry) => entry.mandatory && !entry.passed).length,
    passed: results.every((entry) => !entry.mandatory || entry.passed)
  }
  const initial = validateQualification(summary, { runDir })
  const consistencyFile = path.join(runDir, 'reports', 'evidence-consistency.json')
  fs.writeFileSync(consistencyFile, `${JSON.stringify({ passed: initial.ok, checks: 1, failures: initial.ok ? 0 : 1, ...initial }, null, 2)}\n`)
  const consistencyAt = new Date().toISOString()
  results.push({
    id: 'evidence-consistency', runId, gitSha, gitTree, branch, mandatory: true,
    startedAt: consistencyAt, completedAt: consistencyAt,
    command: [NODE, path.join(ROOT, 'scripts', 'evidence-consistency.cjs'), '<summary.json>'],
    exitCode: initial.ok ? 0 : 1, passed: initial.ok, checks: 1, failures: initial.ok ? 0 : 1,
    report: consistencyFile, rawEvidence: { stdout: consistencyFile, stderr: null }, spawnError: null
  })
  summary.completedAt = new Date().toISOString()
  summary.mandatoryFailures = results.filter((entry) => entry.mandatory && !entry.passed).length
  summary.passed = summary.mandatoryFailures === 0
  summary.results = results
  const summaryFile = path.join(runDir, 'qualification-summary.json')
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
  const finalConsistency = validateQualification(summary, { runDir })
  summary.evidenceConsistency = finalConsistency
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(path.join(runDir, 'artifact-index.json'), `${JSON.stringify({ runId, gitSha, gitTree, files: hashFiles(runDir) }, null, 2)}\n`)
  process.stdout.write(`[qualification] runId=${runId}\n[qualification] summary=${summaryFile}\n[qualification] verdict=${summary.passed && finalConsistency.ok ? 'PASS' : 'FAIL'}\n`)
  return summary.passed && finalConsistency.ok ? 0 : 1
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  }
}

module.exports = { parseArgs, definitions, hashFiles }
