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
  if (!options.batchId) throw Object.assign(new Error('--batch-id must name an existing FINAL batch containing the W0 fault-04 observation'), { code: 'E5_FINAL_BATCH_REQUIRED' })
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.batchId)) throw new Error('--batch-id must be a bounded filename-safe identifier')
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

function loadExistingFinalBatch({ batchId, batchDir, sourceRef, implementationSha, e0Gate }) {
  const manifestPath = path.join(batchDir, 'batch-manifest.json')
  const freezePath = path.join(batchDir, 'evidence-freeze.json')
  const e0GatePath = path.join(batchDir, 'e0-gate.json')
  if (![manifestPath, freezePath, e0GatePath].every((file) => fs.existsSync(file))) {
    throw Object.assign(new Error('the requested FINAL batch is missing its frozen manifest or E0 gate'), { code: 'E5_FINAL_BATCH_UNAVAILABLE' })
  }
  let manifest
  let freeze
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8'))
  } catch (error) {
    throw Object.assign(new Error(`the requested FINAL batch metadata is unreadable: ${error.message}`), { code: 'E5_FINAL_BATCH_INVALID' })
  }
  const expectedGateSha = evidence.sha256(`${JSON.stringify(e0Gate, null, 2)}\n`)
  const identityMatches = manifest.batchId === batchId && manifest.phase === 'FINAL' &&
    manifest.implementationSha === implementationSha && manifest.harnessSha === implementationSha &&
    manifest.sourceRef === sourceRef && manifest.e0GateSha256 === expectedGateSha &&
    freeze.batchId === batchId && freeze.phase === 'FINAL' && freeze.implementationSha === implementationSha &&
    freeze.harnessSha === implementationSha && freeze.sourceRef === sourceRef && freeze.e0GateSha256 === expectedGateSha &&
    evidence.validateEvidenceDocument('batchManifest', manifest).ok &&
    evidence.validateEvidenceDocument('evidenceFreeze', freeze).ok
  if (!identityMatches) {
    throw Object.assign(new Error('the requested FINAL batch does not match this branch, code/harness SHA, or E0 gate'), { code: 'E5_FINAL_BATCH_IDENTITY_MISMATCH' })
  }
  const hasW0Fault04 = manifest.runs.some((run) => run.workloadId === 'W0' && run.faultId === 4)
  const existingE5 = manifest.runs.some((run) => /^E5-W2-fault/.test(run.runId))
  if (!hasW0Fault04 || existingE5) {
    throw Object.assign(new Error('the FINAL batch must contain a W0 fault-04 run and no earlier E5 campaign runs'), { code: 'E5_FINAL_BATCH_SCOPE_INVALID' })
  }
  const integrity = evidence.verifyBatchIntegrity(batchDir)
  if (!integrity.ok) {
    throw Object.assign(new Error(`the existing FINAL batch failed integrity verification (${integrity.code})`), { code: 'E5_FINAL_BATCH_INTEGRITY_FAILED' })
  }
  return { batchId, phase: manifest.phase, seed: manifest.seed, batchDir, manifest }
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
  const batchDir = path.join(EVIDENCE_ROOT, options.batchId)
  const batch = loadExistingFinalBatch({ batchId: options.batchId, batchDir, sourceRef, implementationSha, e0Gate })
  const dedicatedTemp = path.join(batch.batchDir, 'harness-temp')
  fs.mkdirSync(dedicatedTemp, { recursive: true })
  process.env.TEMP = dedicatedTemp
  process.env.TMP = dedicatedTemp

  const outcome = await runE5Campaign({
    batch,
    seed: options.seed,
    scratchRoot,
    runOrdinalOffset: batch.manifest.runs.length,
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

module.exports = { parseArgs, readPassingE0, loadExistingFinalBatch, runE5 }
