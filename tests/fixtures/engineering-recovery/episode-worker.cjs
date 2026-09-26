'use strict'

const fs = require('node:fs')
const path = require('node:path')

const CONFIG_ENV = 'HNS_ENGINEERING_RECOVERY_WORKER_CONFIG'
const HOLD_MS = 5 * 60 * 1000

function emit(message) {
  fs.writeSync(1, `HNS_RECOVERY_WORKER ${JSON.stringify(message)}\n`)
}

function holdForController() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_MS)
}

function readConfig() {
  const raw = process.env[CONFIG_ENV]
  if (!raw || raw.length > 16_384) throw new Error('worker configuration is missing or too large')
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('worker configuration must be an object')
  for (const key of ['candidateRoot', 'checkpointRoot', 'recoveryRoot', 'workloadTest']) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) throw new Error(`worker configuration lacks an absolute ${key}`)
  }
  if (!Array.isArray(value.workloadStepIds) || value.workloadStepIds.length !== 10) throw new Error('worker configuration lacks the frozen W0 step order')
  return value
}

function checkpointSummary(checkpoint) {
  if (!checkpoint || !checkpoint.recovery || !checkpoint.recovery.cursor) return null
  return {
    checkpointSeq: checkpoint.recovery.cursor.checkpointSeq,
    cursor: checkpoint.recovery.cursor,
    verifiedMutations: Array.isArray(checkpoint.verifiedMutations) ? checkpoint.verifiedMutations : []
  }
}

async function main() {
  const mode = process.argv[2]
  if (!['start', 'resume'].includes(mode)) throw new Error('worker mode must be start or resume')
  const config = readConfig()
  process.chdir(config.candidateRoot)
  process.env.HNS_CANDIDATE_ROOT = config.candidateRoot
  const observedActions = []

  const { createEngineeringHost } = require('../../../app/engineering-host.cjs')
  const host = createEngineeringHost({
    checkpointRoot: config.checkpointRoot,
    recoveryRoot: config.recoveryRoot,
    log(line) {
      if (line.includes('engineering action:')) {
        const stepMatch = /"step":"([^"\\]{1,128})"/.exec(line)
        const kindMatch = /"kind":"([^"\\]{1,64})"/.exec(line)
        observedActions.push({ step: stepMatch ? stepMatch[1] : 'unknown', kind: kindMatch ? kindMatch[1] : 'unknown' })
      }
      if (mode === 'start' && line.includes('engineering progress:') && line.includes('"kind":"mutation"')) {
        const latest = host.supervisor && host.supervisor.checkpoints.latest(host.id)
        const summary = checkpointSummary(latest)
        if (!summary || summary.verifiedMutations.filter((entry) => entry.result === 'applied').length !== 3) {
          emit({ kind: 'worker_error', code: 'MUTATION_BOUNDARY_CHECKPOINT_INVALID' })
          return
        }
        emit({ kind: 'crash_boundary', episodeId: host.id, checkpoint: summary })
        holdForController()
        return
      }

      if (mode === 'resume' && line.includes('engineering action:') && line.includes('"kind":"focused-test"')) {
        const latest = host.supervisor && host.supervisor.checkpoints.latest(host.id)
        const summary = checkpointSummary(latest)
        if (!summary) {
          emit({ kind: 'worker_error', code: 'POST_RESUME_CHECKPOINT_MISSING' })
          return
        }
        const stepMatch = /"step":"([^"\\]{1,128})"/.exec(line)
        emit({
          kind: 'resume_proof',
          episodeId: host.id,
          stepId: stepMatch ? stepMatch[1] : 'focused-test',
          checkpoint: summary
        })
        // The action notification precedes command creation. Holding synchronously
        // here lets the controller stop this exact worker before it starts a child.
        holdForController()
      }
    }
  })

  if (mode === 'start') {
    const testCommand = {
      command: process.execPath,
      args: ['--test', config.workloadTest],
      cwd: config.candidateRoot,
      acceptsFocus: false,
      evidence: 'versioned local W0 fixture'
    }
    const steps = [
      { id: 'w0-report-before-a', kind: 'report' },
      { id: 'w0-report-before-b', kind: 'report' },
      { id: 'w0-three-file-mutation', kind: 'patch' },
      { id: 'w0-focused-test', kind: 'focused-test' },
      { id: 'w0-report-after', kind: 'report' },
      { id: 'w0-affected-test', kind: 'affected-test' },
      { id: 'w0-report-after-tests', kind: 'report' },
      { id: 'w0-full-verify', kind: 'full-verify' },
      { id: 'w0-report-final-a', kind: 'report' },
      { id: 'w0-report-final-b', kind: 'report' }
    ]
    if (JSON.stringify(steps.map((step) => step.id)) !== JSON.stringify(config.workloadStepIds)) {
      throw Object.assign(new Error('worker plan differs from the frozen W0 workload order'), { code: 'W0_STEP_ORDER_MISMATCH' })
    }
    const contract = {
      commands: { test: testCommand, focusedTest: testCommand },
      tests: ['full-verify'],
      success_criteria: ['three deterministic mutation hashes are verified'],
      maxSteps: 10,
      maxRepairRounds: 0,
      stepTimeoutMs: 30_000,
      lockWorkspace: false,
      autonomyEnabled: false,
      patches: [{
        reason: 'W0 deterministic recovery evidence fixture',
        files: [
          { path: 'artifacts/one.txt', content: 'verified-mutation-one\n' },
          { path: 'artifacts/two.txt', content: 'verified-mutation-two\n' },
          { path: 'artifacts/three.txt', content: 'verified-mutation-three\n' }
        ]
      }],
      steps
    }
    const accepted = host.run({
      workspace: config.candidateRoot,
      goal: 'recover deterministic local engineering work after an owned process termination',
      deadlineMs: 120_000,
      contract
    })
    if (!accepted.ok || accepted.accepted !== true) throw Object.assign(new Error('fresh engineering episode was not accepted'), { code: accepted.code || 'EPISODE_NOT_ACCEPTED' })
    emit({ kind: 'episode_accepted', episodeId: accepted.episode })
    const report = await host.settled()
    const latest = host.supervisor && host.supervisor.checkpoints.latest(host.id)
    emit({
      kind: 'episode_settled',
      result: report && report.result ? String(report.result) : 'UNKNOWN',
      failureClasses: Array.isArray(report && report.failures) ? report.failures.map((entry) => String(entry.class || 'unknown').slice(0, 64)) : [],
      validationReasons: Array.isArray(report && report.validation && report.validation.reasons) ? report.validation.reasons.map((entry) => String(entry).slice(0, 100)) : [],
      observedActions,
      checkpointSeq: latest && latest.recovery && latest.recovery.cursor ? latest.recovery.cursor.checkpointSeq : null,
      cursor: latest && latest.recovery ? latest.recovery.cursor : null
    })
  } else {
    const result = await host.resumeLatest({ trigger: 'unclean_exit' })
    if (!result.ok || result.resumed !== true || result.accepted !== true) {
      emit({ kind: 'resume_refused', code: result.code || 'RESUME_REFUSED' })
      process.exitCode = 2
      return
    }
    emit({ kind: 'resume_returned', episodeId: result.episode, checkpointSeq: result.checkpointSeq })
    const report = await host.settled()
    emit({ kind: 'episode_settled', result: report && report.result ? String(report.result) : 'UNKNOWN' })
  }
}

main().catch((error) => {
  emit({ kind: 'worker_error', code: error && error.code ? String(error.code).slice(0, 100) : 'WORKER_FAILED' })
  process.exitCode = 1
})
