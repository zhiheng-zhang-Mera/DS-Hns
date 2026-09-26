'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const readline = require('node:readline')

const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_ROOT = path.join(ROOT, 'runtime', 'engineering', 'evidence', 'recovery')
const CANDIDATE_ROOT = path.join(ROOT, 'runtime', 'engineering', 'evidence', 'candidates')
const WORKER = path.join(ROOT, 'tests', 'fixtures', 'engineering-recovery', 'episode-worker.cjs')
const WORKLOAD_TEST = path.join(ROOT, 'tests', 'fixtures', 'engineering-recovery', 'workloads', 'w0.test.cjs')
const CHECKPOINTS_RELATIVE = path.join('runtime', 'engineering', 'recovery', 'checkpoints')
const PILOT_RUN_ID = 'E1-W0-fault04'
const FINAL_RUN_ID = 'E2-W0-fault04'

const evidence = require('./lib/engineering-recovery-evidence.cjs')
const { createCheckpointStore } = require('../app/engineering/checkpoint.cjs')
const { createRecoveryStore } = require('../app/engineering/recovery-store.cjs')
const { probeProcessOwner } = require('../app/engineering/process-identity.cjs')

function parseArgs(argv) {
  const output = { mode: null, seed: null, batchId: null, e0Gate: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!['--mode', '--seed', '--batch-id', '--e0-gate'].includes(arg)) throw new Error(`unsupported argument: ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    output[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  if (!['pilot', 'final-w0-fault04'].includes(output.mode)) throw new Error('unsupported evidence mode')
  if (output.mode === 'final-w0-fault04' && !output.e0Gate) {
    throw Object.assign(new Error('--e0-gate is required for FINAL mode'), { code: 'FINAL_E0_GATE_REQUIRED' })
  }
  if (output.mode === 'pilot' && output.e0Gate) throw new Error('--e0-gate is valid only for FINAL mode')
  const seed = Number(output.seed)
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('--seed must be an unsigned 32-bit integer')
  output.seed = seed
  const prefix = output.mode === 'pilot' ? 'E1-W0-pilot' : 'E2-W0-final'
  output.batchId = output.batchId || `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
  return output
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertDPath(target, label) {
  const resolved = path.resolve(target)
  if (process.platform === 'win32' && !/^D:\\/i.test(resolved)) throw new Error(`${label} is outside D:`)
  return resolved
}

function mkdirD(target) {
  const absolute = assertDPath(target, 'generated directory')
  fs.mkdirSync(absolute, { recursive: true })
  return absolute
}

function loadPassingE0Gate(file, branch, implementationSha) {
  let gate
  try {
    const lexicalPath = assertDPath(file, 'E0 gate')
    const realPath = assertDPath(fs.realpathSync(lexicalPath), 'E0 gate target')
    gate = JSON.parse(fs.readFileSync(realPath, 'utf8'))
  } catch (error) {
    throw Object.assign(new Error('the requested D: E0 gate cannot be read'), { code: 'FINAL_E0_GATE_UNAVAILABLE' })
  }
  const schema = evidence.validateEvidenceDocument('e0Gate', gate)
  if (!schema.ok || !evidence.passesE0Gate(gate)) {
    throw Object.assign(new Error('E0 gate is not a complete passing repository gate'), { code: 'FINAL_E0_GATE_INVALID' })
  }
  if (gate.branch !== branch || gate.implementationSha !== implementationSha.toLowerCase()) {
    throw Object.assign(new Error('E0 gate branch or implementation SHA differs from this checkout'), { code: 'FINAL_E0_GATE_IDENTITY_MISMATCH' })
  }
  return gate
}

function git(candidateRoot, args) {
  const result = spawnSync('git', args, { cwd: candidateRoot, encoding: 'utf8', timeout: 20_000, windowsHide: true })
  if (result.error || result.status !== 0) {
    const error = new Error(`candidate git setup failed (${result.status === null ? 'spawn' : result.status})`)
    error.code = 'CANDIDATE_GIT_SETUP_FAILED'
    throw error
  }
}

function createCandidate(runId) {
  const base = mkdirD(CANDIDATE_ROOT)
  const candidateRoot = assertDPath(path.join(base, runId), 'candidate root')
  if (!inside(base, candidateRoot) || fs.existsSync(candidateRoot)) throw new Error('candidate path is not fresh and exclusively owned')
  fs.mkdirSync(candidateRoot, { recursive: false })
  const ownership = { schemaVersion: 1, runId, root: candidateRoot, createdByPid: process.pid }
  fs.writeFileSync(path.join(candidateRoot, '.hns-evidence-owner.json'), `${JSON.stringify(ownership)}\n`, { flag: 'wx' })
  fs.mkdirSync(path.join(candidateRoot, 'artifacts'), { recursive: false })
  git(candidateRoot, ['-c', 'init.defaultBranch=harness-baseline', 'init', '--quiet'])
  git(candidateRoot, ['config', '--local', 'user.name', 'DS-Hns Evidence Harness'])
  git(candidateRoot, ['config', '--local', 'user.email', 'evidence-harness@invalid'])
  git(candidateRoot, ['add', '.hns-evidence-owner.json'])
  git(candidateRoot, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'W0 isolated baseline'])
  return { candidateRoot, ownership }
}

function removeOwnedCandidate(candidateRoot, expectedRunId) {
  const base = fs.realpathSync(CANDIDATE_ROOT)
  const target = path.resolve(candidateRoot)
  if (!inside(base, target)) throw new Error('candidate cleanup target escaped the evidence candidate root')
  const real = fs.realpathSync(target)
  if (real !== target || !inside(base, real) || path.parse(real).root.toLowerCase() !== path.parse(base).root.toLowerCase()) {
    throw new Error('candidate cleanup target is not a canonical owned D: directory')
  }
  const marker = JSON.parse(fs.readFileSync(path.join(real, '.hns-evidence-owner.json'), 'utf8'))
  if (marker.runId !== expectedRunId || path.resolve(marker.root) !== real) throw new Error('candidate ownership marker does not match this run')
  fs.rmSync(real, { recursive: true, force: false })
  return !fs.existsSync(real)
}

function workerConfig(candidateRoot, batchDir, runId) {
  const checkpointRoot = assertDPath(path.join(candidateRoot, CHECKPOINTS_RELATIVE), 'checkpoint root')
  const recoveryRoot = assertDPath(path.join(candidateRoot, 'runtime', 'engineering', 'recovery'), 'recovery root')
  const tempRoot = mkdirD(path.join(batchDir, 'scratch', runId))
  return {
    candidateRoot,
    checkpointRoot,
    recoveryRoot,
    workloadTest: WORKLOAD_TEST,
    tempRoot,
    workloadStepIds: evidence.loadWorkloads().workloads[0].stepIds
  }
}

function createControllerStores(config) {
  const checkpoints = createCheckpointStore({ dir: config.checkpointRoot })
  const recovery = createRecoveryStore({ root: config.recoveryRoot, checkpointDir: config.checkpointRoot, isOwnerAlive: probeProcessOwner })
  return { checkpoints, recovery }
}

function ownerSnapshot(recovery, episodeId, phase) {
  const entry = recovery.get(episodeId)
  if (!entry || !Number.isSafeInteger(entry.ownerPid) || !entry.ownerProcessIdentity) return { phase, liveOwnerCount: 0, ownerId: null }
  const live = probeProcessOwner({ pid: entry.ownerPid, processIdentity: entry.ownerProcessIdentity, instanceId: entry.ownerInstanceId })
  return {
    phase,
    liveOwnerCount: live === true ? 1 : 0,
    ownerId: live === true ? 'execution-owner-1' : null
  }
}

function waitForMessage(child, queue, predicate, timeoutMs = 30_000) {
  const existing = queue.findIndex(predicate)
  if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0])
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Object.assign(new Error('worker event deadline elapsed'), { code: 'WORKER_EVENT_TIMEOUT' })), timeoutMs)
    const check = (message) => {
      if (!predicate(message)) return
      clearTimeout(timeout)
      child.off('worker-message', check)
      resolve(message)
    }
    child.on('worker-message', check)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      child.off('worker-message', check)
      reject(Object.assign(new Error(`worker exited before required evidence (${signal || code}); queued=${queue.map((entry) => entry.kind).join(',') || 'none'}; stderr=${child._stderrDiagnostics || 'none'}`), { code: 'WORKER_EXIT_EARLY' }))
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      child.off('worker-message', check)
      reject(error)
    })
  })
}

function startWorker(mode, config) {
  const tempRoot = assertDPath(config.tempRoot, 'worker TEMP')
  const env = {
    ...process.env,
    TEMP: tempRoot,
    TMP: tempRoot,
    HNS_ENGINEERING_RECOVERY_WORKER_CONFIG: JSON.stringify(config)
  }
  const child = spawn(process.execPath, [WORKER, mode], {
    cwd: ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const queue = []
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    if (!line.startsWith('HNS_RECOVERY_WORKER ')) return
    let message
    try { message = JSON.parse(line.slice('HNS_RECOVERY_WORKER '.length)) } catch { return }
    queue.push(message)
    child.emit('worker-message', message)
  })
  child._stderrDiagnostics = ''
  child.stderr.on('data', (chunk) => {
    child._stderrDiagnostics = `${child._stderrDiagnostics}${chunk.toString('utf8')}`.slice(-2000)
  })
  return { child, queue }
}

function checkpointEvent(run, checkpoint) {
  if (!checkpoint || !Number.isSafeInteger(checkpoint.checkpointSeq)) throw new Error('worker did not expose a valid checkpoint sequence')
  const result = run.appendEvent({
    type: 'checkpoint_observed',
    checkpointSeq: checkpoint.checkpointSeq,
    cursor: checkpoint.cursor,
    verifiedStepIds: checkpoint.cursor.verifiedStepIds || [],
    verifiedMutationIds: checkpoint.verifiedMutations
      .filter((entry) => entry.result === 'applied' || entry.result === 'already_complete')
      .map((entry) => entry.id)
  })
  if (!result.ok) throw new Error(`checkpoint evidence rejected (${result.code})`)
}

const W0_MUTATIONS = new Map([
  ['artifacts/one.txt', 'verified-mutation-one\n'],
  ['artifacts/two.txt', 'verified-mutation-two\n'],
  ['artifacts/three.txt', 'verified-mutation-three\n']
])

function mutationState(candidateRoot, checkpoint) {
  const observed = new Map()
  for (const entry of checkpoint.verifiedMutations) {
    if (!['applied', 'already_complete'].includes(entry.result) || !entry.id) continue
    const relative = String(entry.relative || '').replace(/\\/g, '/')
    const expected = W0_MUTATIONS.get(relative)
    if (expected === undefined || observed.has(entry.id)) throw new Error('mutation journal does not match the frozen W0 mutation set')
    const target = path.join(candidateRoot, ...relative.split('/'))
    const bytes = fs.readFileSync(target)
    if (!bytes.equals(Buffer.from(expected, 'utf8'))) throw new Error('independent W0 file oracle rejected a mutation byte sequence')
    const fullHash = evidence.sha256(bytes)
    if (typeof entry.after !== 'string' || !fullHash.startsWith(entry.after)) throw new Error('W0 full SHA-256 does not agree with the product mutation digest')
    observed.set(entry.id, fullHash)
  }
  if (observed.size !== W0_MUTATIONS.size) throw new Error('W0 checkpoint does not contain all three verified mutations')
  return observed
}

function appendMutationEffects(run, candidateRoot, checkpoint, phase) {
  const independentHashes = mutationState(candidateRoot, checkpoint)
  const seen = new Set()
  for (const entry of checkpoint.verifiedMutations) {
    if (!['applied', 'already_complete'].includes(entry.result) || !entry.id || seen.has(entry.id)) continue
    seen.add(entry.id)
    const fullHash = independentHashes.get(entry.id)
    const result = run.appendEvent({
      type: 'mutation_effect',
      mutationId: entry.id,
      effectId: `${entry.id}:${fullHash}`,
      effect: 'applied',
      phase,
      sha256: fullHash
    })
    if (!result.ok) throw new Error(`mutation evidence rejected (${result.code})`)
  }
}

function appendMutationPresence(run, candidateRoot, checkpoint) {
  const independentHashes = mutationState(candidateRoot, checkpoint)
  for (const [mutationId, fullHash] of independentHashes) {
    const result = run.appendEvent({
      type: 'mutation_effect',
      mutationId,
      effectId: `${mutationId}:${fullHash}`,
      effect: 'present_after_resume',
      phase: 'after_resume',
      sha256: fullHash
    })
    if (!result.ok) throw new Error(`post-resume mutation presence rejected (${result.code})`)
  }
}

function addOwnerSnapshot(run, snapshot) {
  const result = run.appendEvent({
    type: 'owner_snapshot',
    phase: snapshot.phase,
    liveOwnerCount: snapshot.liveOwnerCount,
    ...(snapshot.ownerId ? { ownerId: snapshot.ownerId } : {})
  })
  if (!result.ok) throw new Error(`owner evidence rejected (${result.code})`)
}

function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Object.assign(new Error('owned worker did not exit after exact-handle termination'), { code: 'OWNED_WORKER_EXIT_TIMEOUT' })), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

async function runW0Fault04(options) {
  const runId = options.mode === 'pilot' ? PILOT_RUN_ID : FINAL_RUN_ID
  const phase = options.mode === 'pilot' ? 'PILOT' : 'FINAL'
  const taskTemp = mkdirD(path.join(ROOT, 'runtime', 'engineering', 'test-fixtures', 'tmp'))
  process.env.TEMP = taskTemp
  process.env.TMP = taskTemp
  mkdirD(EVIDENCE_ROOT)
  const catalog = evidence.loadFaultCatalog()
  evidence.loadWorkloads()
  const implementation = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  const sourceRefResult = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  if (implementation.error || implementation.status !== 0 || !/^[a-f0-9]{40}$/i.test(String(implementation.stdout || '').trim())) {
    throw Object.assign(new Error('cannot identify the tested implementation commit'), { code: 'IMPLEMENTATION_SHA_UNAVAILABLE' })
  }
  if (sourceRefResult.error || sourceRefResult.status !== 0 || !String(sourceRefResult.stdout || '').trim()) {
    throw Object.assign(new Error('cannot identify the tested branch/ref'), { code: 'IMPLEMENTATION_REF_UNAVAILABLE' })
  }
  const sourceRef = sourceRefResult.stdout.trim()
  const implementationShaText = implementation.stdout.trim().toLowerCase()
  const e0Gate = phase === 'FINAL'
    ? loadPassingE0Gate(options.e0Gate, sourceRef, implementationShaText)
    : null
  const batch = evidence.createBatch({
    root: EVIDENCE_ROOT,
    batchId: options.batchId,
    phase,
    seed: options.seed,
    implementationSha: implementationShaText,
    sourceRef,
    ...(e0Gate ? { e0Gate } : {})
  })
  let run = null
  const { candidateRoot } = createCandidate(runId)
  const config = workerConfig(candidateRoot, batch.batchDir, runId)
  fs.mkdirSync(config.checkpointRoot, { recursive: true })
  fs.mkdirSync(config.recoveryRoot, { recursive: true })
  const stores = createControllerStores(config)
  let activeWorker = null
  let terminal = false
  const append = (event) => {
    if (!run) throw new Error('raw evidence stream is not initialized')
    const result = run.appendEvent(event)
    if (!result.ok) throw new Error(`evidence event rejected (${result.code || 'unknown'})`)
  }

  try {
    activeWorker = startWorker('start', config)
    const accepted = await waitForMessage(activeWorker.child, activeWorker.queue, (message) => message.kind === 'episode_accepted' || message.kind === 'worker_error')
    if (accepted.kind !== 'episode_accepted') throw new Error(`fresh episode failed before acceptance (${accepted.code})`)
    run = evidence.createRun(batch, {
      runId,
      runOrdinal: 1,
      seed: options.seed,
      implementationSha: batch.manifest.implementationSha,
      workloadId: 'W0',
      faultId: 4,
      expectedOutcome: catalog.faults[3].expectedOutcome,
      episodeId: accepted.episodeId,
      recoveryConfiguration: { attempts: 3, executorCompatibility: 'engineering-v1', hostApi: 'createEngineeringHost' }
    })
    append({ type: 'episode_started', candidateId: runId })
    append({ type: 'fault_armed', faultId: 4 })
    append({ type: 'sentinel_observed', phase: 'before', pathId: 'candidate-baseline', sha256: evidence.sha256File(path.join(candidateRoot, '.git', 'HEAD')) })
    const crashBoundary = await waitForMessage(activeWorker.child, activeWorker.queue, (message) => ['crash_boundary', 'worker_error', 'episode_settled'].includes(message.kind))
    if (crashBoundary.kind !== 'crash_boundary') {
      const details = [crashBoundary.code, crashBoundary.result, ...(crashBoundary.failureClasses || []), ...(crashBoundary.validationReasons || []), ...(crashBoundary.observedActions || []).map((entry) => `${entry.kind}:${entry.step}`)].filter(Boolean).join('|')
      throw new Error(`mutation boundary was not reached (${details || crashBoundary.kind})`)
    }
    const runtimeEpisodeId = crashBoundary.episodeId
    checkpointEvent(run, crashBoundary.checkpoint)
    appendMutationEffects(run, candidateRoot, crashBoundary.checkpoint, 'before_fault')
    const liveBeforeFault = ownerSnapshot(stores.recovery, runtimeEpisodeId, 'before_fault')
    if (liveBeforeFault.liveOwnerCount !== 1) throw new Error('fresh episode did not have exactly one live execution owner')
    addOwnerSnapshot(run, liveBeforeFault)
    append({ type: 'fault_injected', faultId: 4, actualOutcome: 'exact_owned_worker_termination' })
    activeWorker.child.kill('SIGKILL')
    const firstExit = await waitForExit(activeWorker.child)
    activeWorker.child = null
    append({ type: 'target_exit_observed', faultId: 4, actualOutcome: 'owned_worker_exit_observed' })
    const afterCrashOwner = ownerSnapshot(stores.recovery, runtimeEpisodeId, 'after_fault')
    if (afterCrashOwner.liveOwnerCount !== 0) throw new Error('terminated worker remains a live recovery owner')
    addOwnerSnapshot(run, afterCrashOwner)

    const reconciled = stores.recovery.reconcileIndex()
    if (!reconciled.ok) throw new Error(`recovery index reconciliation failed (${reconciled.code || 'unknown'})`)
    const indexed = stores.recovery.get(runtimeEpisodeId)
    const latest = stores.checkpoints.latest(runtimeEpisodeId)
    if (!indexed || indexed.state !== 'ACTIVE' || !latest || indexed.latestCheckpointSeq !== latest.recovery.cursor.checkpointSeq) {
      throw new Error('fresh ACTIVE recovery candidate does not point to the newest checkpoint')
    }
    append({
      type: 'relaunch_started',
      candidateId: runId
    })
    append({
      type: 'recovery_candidate_detected',
      checkpointSeq: latest.recovery.cursor.checkpointSeq,
      cursor: latest.recovery.cursor,
      verifiedStepIds: latest.recovery.cursor.verifiedStepIds,
      verifiedMutationIds: latest.recovery.verifiedMutationIds
    })

    activeWorker = startWorker('resume', config)
    const proof = await waitForMessage(activeWorker.child, activeWorker.queue, (message) => ['resume_proof', 'resume_refused', 'worker_error'].includes(message.kind))
    if (proof.kind !== 'resume_proof') {
      append({ type: 'recovery_blocked', code: proof.code || 'RESUME_PROOF_NOT_REACHED' })
      throw new Error(`resume did not reach the first post-recovery boundary (${proof.code})`)
    }
    if (proof.episodeId !== runtimeEpisodeId || proof.checkpoint.checkpointSeq <= latest.recovery.cursor.checkpointSeq) {
      throw new Error('resume proof refers to a different episode or a non-newer checkpoint')
    }
    append({ type: 'recovery_verified', checkpointSeq: proof.checkpoint.checkpointSeq, cursor: proof.checkpoint.cursor })
    append({ type: 'resume_accepted', checkpointSeq: proof.checkpoint.checkpointSeq, cursor: proof.checkpoint.cursor })
    checkpointEvent(run, proof.checkpoint)
    appendMutationPresence(run, candidateRoot, proof.checkpoint)
    append({ type: 'first_post_resume_checkpoint', checkpointSeq: proof.checkpoint.checkpointSeq, cursor: proof.checkpoint.cursor })
    const liveAfterResume = ownerSnapshot(stores.recovery, runtimeEpisodeId, 'after_resume')
    if (liveAfterResume.liveOwnerCount !== 1) throw new Error('recovered episode does not have exactly one live execution owner')
    addOwnerSnapshot(run, liveAfterResume)

    // The worker signalled from the next step's pre-action callback, before it
    // spawned the command. End this one owned test process at the proof boundary.
    activeWorker.child.kill('SIGKILL')
    const secondExit = await waitForExit(activeWorker.child)
    activeWorker.child = null
    append({ type: 'run_stopped', actualOutcome: 'proof_checkpoint_observed_then_owned_worker_stopped' })
    append({ type: 'sentinel_observed', phase: 'after', pathId: 'candidate-baseline', sha256: evidence.sha256File(path.join(candidateRoot, '.git', 'HEAD')) })
    const result = evidence.finalizeRun(run, { testStopReason: 'first_newer_checkpoint_before_next_command_spawn' })
    terminal = true
    const integrity = evidence.verifyRunIntegrity(run.runDir)
    if (!integrity.ok) throw new Error(`raw evidence integrity failed (${integrity.code})`)
    const derived = evidence.deriveBatch(batch.batchDir)
    if (!derived.ok) throw new Error('derived analysis rejected the raw pilot run')
    const removed = removeOwnedCandidate(candidateRoot, runId)
    if (!removed) throw new Error('owned D: candidate workspace remains after cleanup')
    process.stdout.write(`${JSON.stringify({ status: result.classification, batchDir: batch.batchDir, runDir: run.runDir, checkpointSeqBefore: result.checkpointSeqBeforeFault, checkpointSeqAfter: result.checkpointSeqAfterRecovery, oracles: result.oracle, cleanup: 'candidate_removed' })}\n`)
    return result.classification === 'PASS' ? 0 : 1
  } catch (error) {
    if (activeWorker && activeWorker.child && activeWorker.child.exitCode === null && activeWorker.child.signalCode === null) {
      activeWorker.child.kill('SIGKILL')
      try { await waitForExit(activeWorker.child, 10_000) } catch {}
    }
    if (run && !terminal && !fs.existsSync(path.join(run.runDir, 'SHA256SUMS.txt'))) {
      try {
        append({ type: 'run_stopped', actualOutcome: error.code || 'EVIDENCE_RUN_FAILED' })
        evidence.finalizeRun(run, { testStopReason: error.code || 'evidence_run_failed', invalidReason: `${phase.toLowerCase()} did not reach its acceptance boundary` })
        evidence.deriveBatch(batch.batchDir)
      } catch {}
    }
    try { removeOwnedCandidate(candidateRoot, runId) } catch {}
    process.stderr.write(`${error && error.code ? error.code : 'EVIDENCE_RUN_FAILED'}${error && error.message ? `: ${error.message}` : ''}\n`)
    return 1
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const exitCode = await runW0Fault04(options)
  process.exitCode = exitCode
}

main().catch((error) => {
  process.stderr.write(`${error && error.code ? error.code : 'EVIDENCE_CLI_FAILED'}\n`)
  process.exitCode = 1
})
