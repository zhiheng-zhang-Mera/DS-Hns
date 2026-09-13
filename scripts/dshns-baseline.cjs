'use strict'

/**
 * DS-Hns: the Phase 0 baseline and performance report.
 *
 * Every acceleration claim in this project is relative to a baseline, so the
 * baseline has to be a *measurement*, not a memory. This harness records the state
 * of the repository and the timings the plan names, and writes them as a
 * comparable artifact:
 *
 *   frozen      branch, commit, dirty files, node version, platform
 *   measured    total wall time, per-suite time, tool time, test time, model time
 *   computed    Time To Accepted Patch and LLM Calls Per Accepted Patch
 *
 * The two headline metrics are the ones the plan measures success by, and the
 * harness is honest about when they cannot be computed: without a model adapter
 * attached, there are no model calls to count, so it reports `null` with the
 * reason rather than inventing a zero.
 *
 * Usage:
 *   node scripts/dshns-baseline.cjs               # record a baseline
 *   node scripts/dshns-baseline.cjs --compare a.json b.json
 *   node scripts/dshns-baseline.cjs --out temp/baseline.json
 *   node scripts/dshns-baseline.cjs --list        # the metric vocabulary
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

/** The metrics the plan names, so a report cannot silently omit one. */
const METRICS = Object.freeze([
  { key: 'total_wall_time_ms', label: 'Time To Accepted Patch (wall)', source: 'measured' },
  { key: 'model_time_ms', label: 'Model time', source: 'telemetry' },
  { key: 'model_calls', label: 'LLM Calls Per Accepted Patch', source: 'telemetry' },
  { key: 'input_tokens', label: 'Input tokens', source: 'telemetry' },
  { key: 'output_tokens', label: 'Output tokens', source: 'telemetry' },
  { key: 'tool_time_ms', label: 'Tool time', source: 'measured' },
  { key: 'shell_time_ms', label: 'Shell time', source: 'measured' },
  { key: 'test_time_ms', label: 'Test time', source: 'measured' },
  { key: 'computer_use_time_ms', label: 'Computer Use time', source: 'telemetry' },
  { key: 'retry_count', label: 'Retries', source: 'measured' },
  { key: 'rollback_count', label: 'Rollbacks', source: 'measured' },
  { key: 'idle_time_ms', label: 'Idle time', source: 'telemetry' },
  { key: 'cache_hit_rate', label: 'Cache hit rate', source: 'telemetry' },
  { key: 'parallel_efficiency', label: 'Parallel Efficiency', source: 'measured' }
])

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  return result.status === 0 ? (result.stdout || '').trim() : null
}

/** The frozen part: what this baseline was taken of. */
function freeze() {
  return {
    at: new Date().toISOString(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: git(['rev-parse', 'HEAD']),
    shortCommit: git(['rev-parse', '--short', 'HEAD']),
    dirty: (git(['status', '--porcelain=v1', '--untracked-files=no']) || '').split('\n').filter(Boolean).length,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpus: require('node:os').cpus().length,
    totalRamMb: Math.round(require('node:os').totalmem() / (1024 * 1024))
  }
}

/**
 * Run the suites and time them.
 *
 * Each suite is timed separately because the plan distinguishes test time, tool
 * time and wall time: a suite that got slower while the whole run stayed the same
 * is a fact a single number would hide.
 */
function measureSuites(options = {}) {
  const suites = options.suites || [
    { name: 'syntax', command: 'npm', args: ['run', 'check'], cwd: path.join(ROOT, 'app') },
    { name: 'unit', command: 'npm', args: ['test'], cwd: path.join(ROOT, 'app') },
    { name: 'engineering', command: 'node', args: ['--test', '--test-concurrency=2', 'tests/unit/engineering-scenarios.test.js'], cwd: ROOT },
    { name: 'plugin-core', command: 'node', args: ['--test', '--test-concurrency=2', 'tests/unit/core-plugin-runtime.test.js'], cwd: ROOT }
  ]
  const results = []
  for (const suite of suites) {
    const startedAt = Date.now()
    const result = spawnSync(suite.command, suite.args, {
      cwd: suite.cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32'
    })
    const durationMs = Date.now() - startedAt
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    results.push({
      name: suite.name,
      ok: result.status === 0,
      exitCode: result.status,
      durationMs,
      // The suite's own count, when it reports one, so a baseline shows what ran
      // and not only how long it took.
      tests: numberFrom(output, /^# tests (\d+)/m) || numberFrom(output, /# tests (\d+)/) || null,
      pass: numberFrom(output, /^# pass (\d+)/m) || null,
      fail: numberFrom(output, /^# fail (\d+)/m) || null,
      checked: numberFrom(output, /checked (\d+)\/(\d+) files/) || null
    })
  }
  return results
}

function numberFrom(text, pattern) {
  const match = pattern.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Compute the headline metrics from what a run actually recorded.
 *
 * `telemetry` is the optional block a model/tool adapter supplies. Without it the
 * model-side metrics are `null` **with the reason**, because a baseline that
 * quietly reports zero model calls would make every later comparison meaningless.
 */
function computeMetrics(input = {}) {
  const suites = Array.isArray(input.suites) ? input.suites : []
  const telemetry = input.telemetry && typeof input.telemetry === 'object' ? input.telemetry : null
  const acceptedPatches = Number.isFinite(input.acceptedPatches) ? input.acceptedPatches : null
  const totalWall = suites.reduce((total, suite) => total + (suite.durationMs || 0), 0)
  const testTime = suites.filter((suite) => suite.name === 'unit').reduce((total, suite) => total + suite.durationMs, 0)
  const toolTime = suites.filter((suite) => suite.name !== 'unit').reduce((total, suite) => total + suite.durationMs, 0)
  const modelCalls = telemetry && Number.isFinite(telemetry.model_calls) ? telemetry.model_calls : null
  return {
    total_wall_time_ms: totalWall,
    test_time_ms: testTime,
    tool_time_ms: toolTime,
    shell_time_ms: telemetry && Number.isFinite(telemetry.shell_time_ms) ? telemetry.shell_time_ms : null,
    model_time_ms: telemetry && Number.isFinite(telemetry.model_time_ms) ? telemetry.model_time_ms : null,
    model_calls: modelCalls,
    input_tokens: telemetry && Number.isFinite(telemetry.input_tokens) ? telemetry.input_tokens : null,
    output_tokens: telemetry && Number.isFinite(telemetry.output_tokens) ? telemetry.output_tokens : null,
    computer_use_time_ms: telemetry && Number.isFinite(telemetry.computer_use_time_ms) ? telemetry.computer_use_time_ms : null,
    retry_count: telemetry && Number.isFinite(telemetry.retry_count) ? telemetry.retry_count : null,
    rollback_count: telemetry && Number.isFinite(telemetry.rollback_count) ? telemetry.rollback_count : null,
    idle_time_ms: telemetry && Number.isFinite(telemetry.idle_time_ms) ? telemetry.idle_time_ms : null,
    cache_hit_rate: telemetry && Number.isFinite(telemetry.cache_hit_rate) ? telemetry.cache_hit_rate : null,
    parallel_efficiency: telemetry && Number.isFinite(telemetry.parallel_efficiency) ? telemetry.parallel_efficiency : null,
    /** The two headline numbers, with an explicit reason when they cannot exist. */
    time_to_accepted_patch_ms: acceptedPatches && acceptedPatches > 0 ? Math.round(totalWall / acceptedPatches) : null,
    llm_calls_per_accepted_patch: acceptedPatches && acceptedPatches > 0 && modelCalls !== null ? Number((modelCalls / acceptedPatches).toFixed(2)) : null,
    accepted_patches: acceptedPatches,
    unavailable: unavailable(telemetry, acceptedPatches)
  }
}

function unavailable(telemetry, acceptedPatches) {
  const reasons = []
  if (!telemetry) reasons.push('no model/tool telemetry was attached to this run, so model-side metrics are null rather than zero')
  if (!acceptedPatches) reasons.push('no accepted patch was recorded, so Time To Accepted Patch cannot be computed')
  return reasons
}

/** Compare two baselines, metric by metric. */
function compare(before, after) {
  const rows = []
  for (const metric of METRICS) {
    const a = before && before.metrics ? before.metrics[metric.key] : null
    const b = after && after.metrics ? after.metrics[metric.key] : null
    const delta = Number.isFinite(a) && Number.isFinite(b) ? b - a : null
    const ratio = Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? Number((b / a).toFixed(3)) : null
    rows.push({ metric: metric.key, label: metric.label, before: a, after: b, delta, ratio })
  }
  return rows
}

function parseArgs(argv) {
  const options = { out: null, compare: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--out') options.out = argv[++index]
    else if (argument === '--compare') options.compare = [argv[++index], argv[++index + 1]].filter(Boolean)
    else if (argument === '--json') options.json = true
    else if (argument === '--quick') options.quick = true
  }
  return options
}

function main() {
  const argv = process.argv.slice(2)
  const options = parseArgs(argv)
  if (argv.includes('--list')) {
    for (const metric of METRICS) process.stdout.write(`${metric.key}\t${metric.label}\t(${metric.source})\n`)
    return 0
  }
  if (options.compare && options.compare.length === 2) {
    let before
    let after
    try {
      before = JSON.parse(fs.readFileSync(path.resolve(options.compare[0]), 'utf8'))
      after = JSON.parse(fs.readFileSync(path.resolve(options.compare[1]), 'utf8'))
    } catch (error) {
      process.stderr.write(`could not read a baseline: ${error && error.message ? error.message : error}\n`)
      return 2
    }
    const rows = compare(before, after)
    for (const row of rows) {
      const mark = row.ratio === null ? '  n/a' : row.ratio < 1 ? 'faster' : row.ratio > 1 ? 'slower' : 'equal'
      process.stdout.write(`${row.metric.padEnd(28)} ${String(row.before).padStart(10)} -> ${String(row.after).padStart(10)}  ${row.ratio === null ? '' : `x${row.ratio}`} ${mark}\n`)
    }
    return 0
  }

  const report = {
    harness: 'dshns-baseline',
    plan: 'Update-Plan/accleration.md phase 0',
    frozen: freeze(),
    suites: measureSuites({ quick: options.quick }),
    telemetry: null,
    acceptedPatches: null
  }
  report.metrics = computeMetrics(report)
  report.ok = report.suites.every((suite) => suite.ok)

  const out = options.out ? path.resolve(options.out) : null
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else {
    process.stdout.write(`baseline @ ${report.frozen.shortCommit} (${report.frozen.branch}) node ${report.frozen.node} ${report.frozen.platform}\n`)
    for (const suite of report.suites) {
      process.stdout.write(`  ${suite.ok ? 'PASS' : 'FAIL'} ${suite.name.padEnd(12)} ${String(suite.durationMs).padStart(7)}ms${suite.tests ? `  tests=${suite.tests}` : ''}${suite.checked ? `  files=${suite.checked}` : ''}\n`)
    }
    process.stdout.write(`  total wall   ${report.metrics.total_wall_time_ms}ms\n`)
    process.stdout.write(`  test time    ${report.metrics.test_time_ms}ms\n`)
    process.stdout.write(`  tool time    ${report.metrics.tool_time_ms}ms\n`)
    process.stdout.write(`  Time To Accepted Patch        ${report.metrics.time_to_accepted_patch_ms === null ? 'n/a' : `${report.metrics.time_to_accepted_patch_ms}ms`}\n`)
    process.stdout.write(`  LLM Calls Per Accepted Patch  ${report.metrics.llm_calls_per_accepted_patch === null ? 'n/a' : report.metrics.llm_calls_per_accepted_patch}\n`)
    for (const reason of report.metrics.unavailable) process.stdout.write(`  note: ${reason}\n`)
    if (out) process.stdout.write(`  written to ${out}\n`)
  }
  return report.ok ? 0 : 1
}

if (require.main === module) process.exit(main())

module.exports = { METRICS, freeze, measureSuites, computeMetrics, compare, main }
