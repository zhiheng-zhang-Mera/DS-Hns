'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_ROOT = path.join(ROOT, 'runtime', 'engineering', 'evidence', 'recovery')
const evidence = require('./lib/engineering-recovery-evidence.cjs')
const evidenceCli = require('./engineering-recovery-evidence.cjs')
const { runE5Campaign, validateE5Environment } = require('./lib/engineering-recovery-e5.cjs')

function parseArgs(argv) {
  const options = { seed: null, batchId: null, e0Gate: null }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--seed', '--batch-id', '--e0-gate'].includes(key)) throw new Error(`unsupported argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}`)
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  options.seed = Number(options.seed)
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
    throw new Error('--seed must be an unsigned 32-bit integer')
  }
  if (!options.e0Gate) throw Object.assign(new Error('--e0-gate is required for E5 FINAL mode'), { code: 'FINAL_E0_GATE_REQUIRED' })
  options.batchId = options.batchId || `E5-W2-final-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
  return options
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 20_000, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed while binding E5 evidence identity`)
  return String(result.stdout || '').trim()
}

function readPassingE0(file, sourceRef, implementationSha) {
  const absolute = path.resolve(file)
  if (process.platform === 'win32' && !/^D:\\/i.test(absolute)) throw new Error('E0 gate must be on D:')
  const gate = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  if (!evidence.validateEvidenceDocument('e0Gate', gate).ok || !evidence.passesE0Gate(gate)) {
    throw Object.assign(new Error('E0 gate is not a complete passing repository gate'), { code: 'FINAL_E0_GATE_INVALID' })
  }
  if (gate.branch !== sourceRef || gate.implementationSha !== implementationSha) {
    throw Object.assign(new Error('E0 gate branch or code SHA differs from this clean checkout'), { code: 'FINAL_E0_GATE_IDENTITY_MISMATCH' })
  }
  return gate
}

async function runE5(options, worktreeRoot = ROOT) {
  if (!options || !Number.isSafeInteger(options.seed) || !options.e0Gate) throw new Error('runE5 requires a parsed seed and E0 gate path')
  evidenceCli.assertCleanWorktree(worktreeRoot)
  const sourceRef = git(['branch', '--show-current'])
  const implementationSha = git(['rev-parse', 'HEAD']).toLowerCase()
  if (sourceRef !== 'dev/crash-resume-recovery-v1') throw new Error('E5 FINAL must run from dev/crash-resume-recovery-v1')
  const e0Gate = readPassingE0(options.e0Gate, sourceRef, implementationSha)
  const scratchRoot = os.tmpdir()
  const volumes = validateE5Environment(scratchRoot)
  fs.mkdirSync(EVIDENCE_ROOT, { recursive: true })
  const batch = evidence.createBatch({
    root: EVIDENCE_ROOT,
    batchId: options.batchId,
    phase: 'FINAL',
    seed: options.seed,
    implementationSha,
    harnessSha: implementationSha,
    sourceRef,
    e0Gate
  })
  const dedicatedTemp = path.join(batch.batchDir, 'harness-temp')
  fs.mkdirSync(dedicatedTemp, { recursive: true })
  process.env.TEMP = dedicatedTemp
  process.env.TMP = dedicatedTemp

  const outcome = await runE5Campaign({
    batch,
    seed: options.seed,
    scratchRoot,
    onProgress(result, completed, total) {
      process.stdout.write(`${JSON.stringify({ completed, total, runId: result.runId, faultId: result.faultId, classification: result.classification, ...(result.reason ? { reason: result.reason } : {}) })}\n`)
    }
  })
  process.stdout.write(`${JSON.stringify({
    accepted: outcome.accepted,
    batchDir: batch.batchDir,
    batchId: batch.batchId,
    codeAndHarnessSha: implementationSha,
    sourceRef,
    volumes,
    a5: outcome.derived.analysis.acceptanceGates && outcome.derived.analysis.acceptanceGates.A5,
    counts: outcome.derived.analysis.counts,
    integrity: outcome.derived.integrity
  })}\n`)
  return outcome.accepted ? 0 : 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  process.exitCode = await runE5(options)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.code ? error.code : 'E5_CAMPAIGN_FAILED'}: ${error && error.message ? error.message : 'E5 campaign failed'}\n`)
    process.exitCode = 1
  })
}

module.exports = { parseArgs, readPassingE0, runE5 }
