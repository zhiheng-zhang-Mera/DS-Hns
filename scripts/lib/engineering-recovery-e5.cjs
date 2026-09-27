'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const evidence = require('./engineering-recovery-evidence.cjs')
const { createCrossVolumeTempRegistry, OWNER_MARKER } = require('../../app/engineering/cross-volume-cleanup.cjs')

const E5_SCENARIOS = new Map([
  [80, { count: 3, expectedOutcome: 'PRESERVE_SOURCE_AND_CLEAN_DERIVATIVE', kind: 'preserve-source-sentinel' }],
  [81, { count: 3, expectedOutcome: 'REGENERATE_OR_REVALIDATE', kind: 'missing-scratch-after-crash' }],
  [82, { count: 3, expectedOutcome: 'REUSE_AFTER_OWNERSHIP_VERIFICATION', kind: 'surviving-scratch-after-crash' }],
  [83, { count: 3, expectedOutcome: 'CLEANUP_BLOCKED_PRESERVE_FOREIGN_CHILD', kind: 'foreign-child' }],
  [84, { count: 2, expectedOutcome: 'CLEANUP_BLOCKED_LOCKED_FILE', kind: 'locked-file-retry' }],
  [85, { count: 2, expectedOutcome: 'RETRY_CLEANUP_DEBT', kind: 'interrupted-cleanup-debt' }],
  [86, { count: 2, expectedOutcome: 'CLEANUP_BLOCKED_PRESERVE_PATH', kind: 'marker-mismatch' }],
  [87, { count: 2, expectedOutcome: 'CLEANUP_BLOCKED_PRESERVE_TARGET', kind: 'reparse-escape' }]
])

const E5_LOCK_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

function buildE5Plan(seed) {
  const base = []
  for (const [faultId, scenario] of E5_SCENARIOS) {
    for (let index = 0; index < scenario.count; index += 1) base.push({ faultId, ...scenario })
  }
  if (base.length !== 20) throw new Error('the frozen E5 plan must contain exactly 20 observations')
  return evidence.seededShuffle(base, seed).map((entry, index) => ({
    ...entry,
    ordinal: index + 1,
    runId: `E5-W2-fault${String(entry.faultId).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`,
    seed: (Number(seed) + index) >>> 0
  }))
}

function safeAppend(run, event) {
  const result = run.appendEvent(event)
  if (!result.ok) throw Object.assign(new Error(`evidence event rejected (${result.code})`), { code: result.code })
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, file)
}

function abstractId(prefix, runId) {
  return `${prefix}-${runId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`
}

function waitForFile(file, child, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve()
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('locked-file helper exited before acquiring the handle'))
      if (Date.now() >= deadline) return reject(new Error('locked-file helper did not acquire its handle before the deadline'))
      setTimeout(poll, 25)
    }
    poll()
  })
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('locked-file helper did not exit after releasing its handle')), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function exactOwnedRemove(target, markerPath, expectedMarker) {
  if (!fs.existsSync(target)) return
  if (!fs.existsSync(markerPath) || fs.readFileSync(markerPath, 'utf8') !== expectedMarker) {
    throw new Error(`refusing cleanup without matching task ownership marker: ${target}`)
  }
  fs.rmSync(target, { recursive: true, force: false })
}

function makePersistence(candidateRoot) {
  const recoveryRoot = path.join(candidateRoot, 'runtime', 'engineering', 'recovery')
  fs.mkdirSync(recoveryRoot, { recursive: true })
  const file = path.join(recoveryRoot, 'cross-volume-temp.json')
  return (entries) => atomicWriteJson(file, { schemaVersion: 1, entries })
}

function eventPathIds(entries, runId) {
  return new Map(entries.map((entry, index) => [entry.path, `scratch-${index + 1}-${runId.toLowerCase()}`]))
}

function appendRegistrations(run, entries, runId) {
  const ids = eventPathIds(entries, runId)
  for (const entry of entries) {
    safeAppend(run, {
      type: 'cross_volume_temp_registered',
      pathId: ids.get(entry.path),
      entryType: entry.type
    })
  }
  return ids
}

function appendDeleted(run, entries, ids, deletedPaths) {
  for (const entry of entries) {
    if (deletedPaths.some((target) => path.resolve(target).toLowerCase() === path.resolve(entry.path).toLowerCase())) {
      safeAppend(run, { type: 'cleanup_entry_deleted', pathId: ids.get(entry.path) })
    }
  }
}

function makeLockHelper(candidateRoot) {
  const script = path.join(candidateRoot, 'hold-file-lock.ps1')
  const text = [
    'param([string]$Target, [string]$Ready, [int]$HoldMs)',
    '$stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    '[System.IO.File]::WriteAllText($Ready, "ready")',
    'Start-Sleep -Milliseconds $HoldMs',
    '$stream.Dispose()'
  ].join('\r\n') + '\r\n'
  fs.writeFileSync(script, text, { flag: 'wx' })
  return script
}

async function acquireLockedFile(candidateRoot, target) {
  if (process.platform !== 'win32') throw Object.assign(new Error('E5 locked-file adapter requires Windows'), { code: 'E5_LOCK_ADAPTER_UNAVAILABLE' })
  const windowsPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!fs.existsSync(windowsPowerShell)) throw Object.assign(new Error('Windows PowerShell lock helper is unavailable'), { code: 'E5_LOCK_ADAPTER_UNAVAILABLE' })
  const helper = makeLockHelper(candidateRoot)
  const ready = path.join(candidateRoot, 'lock-ready.txt')
  const child = spawn(windowsPowerShell, [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', helper,
    '-Target', target, '-Ready', ready, '-HoldMs', '1500'
  ], { windowsHide: true, stdio: 'ignore' })
  try {
    await waitForFile(ready, child)
    return child
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    throw error
  }
}

function validateE5Environment(offVolumeRoot) {
  const workVolume = path.parse(path.resolve('D:\\')).root.toLowerCase()
  const scratchRoot = path.resolve(offVolumeRoot)
  const scratchVolume = path.parse(scratchRoot).root.toLowerCase()
  if (process.platform !== 'win32' || workVolume !== 'd:\\' || !fs.existsSync('D:\\')) {
    throw Object.assign(new Error('E5 requires the declared Windows D: work volume'), { code: 'E5_WORK_VOLUME_UNAVAILABLE' })
  }
  if (!scratchVolume || scratchVolume === workVolume || !fs.existsSync(scratchRoot)) {
    throw Object.assign(new Error('E5 requires an existing scratch root on a distinct volume'), { code: 'E5_SCRATCH_VOLUME_UNAVAILABLE' })
  }
  return { workVolume: 'D:', scratchVolume: scratchVolume.slice(0, 2).toUpperCase() }
}

async function runE5Observation(batch, planEntry, options = {}) {
  const { runId, faultId, seed, ordinal, kind } = planEntry
  const volumes = validateE5Environment(options.scratchRoot || os.tmpdir())
  const batchRoot = evidence.requireDVolume(batch.batchDir, 'E5 batch root')
  const candidateParent = path.join(batchRoot, 'candidates')
  fs.mkdirSync(candidateParent, { recursive: true })
  const candidateRoot = path.join(candidateParent, runId)
  if (fs.existsSync(candidateRoot)) throw new Error(`E5 candidate already exists: ${runId}`)
  fs.mkdirSync(candidateRoot, { recursive: false })
  const candidateMarker = JSON.stringify({ runId, candidateRoot })
  const candidateMarkerPath = path.join(candidateRoot, '.e5-candidate-owner.json')
  fs.writeFileSync(candidateMarkerPath, candidateMarker, { flag: 'wx' })

  const offVolumeRoot = fs.mkdtempSync(path.join(path.resolve(options.scratchRoot || os.tmpdir()), `dshns-e5-${runId}-`))
  const sourceRootMarker = JSON.stringify({ runId, offVolumeRoot })
  const sourceRootMarkerPath = path.join(offVolumeRoot, '.e5-source-owner.json')
  fs.writeFileSync(sourceRootMarkerPath, sourceRootMarker, { flag: 'wx' })
  const sentinel = path.join(offVolumeRoot, 'source-sentinel.bin')
  const sentinelBytes = Buffer.from(`pre-existing E5 sentinel:${batch.batchId}:${runId}:${seed}\n`, 'utf8')
  fs.writeFileSync(sentinel, sentinelBytes, { flag: 'wx' })
  const sentinelHash = evidence.sha256(sentinelBytes)
  const scratch = path.join(offVolumeRoot, 'registered-scratch')
  const sentinelPathId = abstractId('source', runId)
  let escapeTargetSentinel = null
  let escapeTargetHash = null
  let escapeTargetPathId = null

  let run
  let registry
  let lockChild = null
  let initialEntries = []
  let scratchFile = null
  let linkPath = null
  let linkTarget = null
  let foreignChild = null
  let invalidReason = null
  let classification = null
  let cleanupResiduals = []
  let firstCleanupCodes = []
  let retryCleanupCodes = []
  let ids = new Map()
  const persist = makePersistence(candidateRoot)

  try {
    run = evidence.createRun(batch, {
      runId,
      runOrdinal: ordinal,
      seed,
      implementationSha: batch.manifest.implementationSha,
      workloadId: 'W2',
      faultId,
      expectedOutcome: planEntry.expectedOutcome,
      expectedBlockCode: faultId === 83 ? 'TEMP_UNREGISTERED_CHILD'
        : faultId === 86 ? 'TEMP_MARKER_MISMATCH'
          : faultId === 87 ? 'TEMP_PATH_REPARSE_BOUNDARY' : null,
      taskScratchVolumes: [volumes.scratchVolume],
      storageVolumeRoles: [`work:${volumes.workVolume.slice(0, 1)}`, `scratch:${volumes.scratchVolume}`],
      selectedWorkVolume: volumes.workVolume,
      recoveryConfiguration: { campaign: 'E5', scenario: kind, cleanupRetries: 2, ownership: 'episode-registry-v1' },
      episodeId: runId
    })

    safeAppend(run, { type: 'episode_started' })
    safeAppend(run, { type: 'fault_armed', faultId })
    safeAppend(run, { type: 'sentinel_observed', phase: 'before', pathId: sentinelPathId, sha256: sentinelHash })

    registry = createCrossVolumeTempRegistry({ episodeId: runId, workRoot: candidateRoot, onChange: persist, maxRetries: 2 })
    if (registry.initializationError) throw Object.assign(new Error(registry.initializationError.reason), { code: registry.initializationError.code })
    const directory = registry.createTaskDirectory({ path: scratch, purposeClass: 'test' })
    if (!directory.ok) throw Object.assign(new Error(directory.reason), { code: directory.code })
    scratchFile = path.join(scratch, 'owned-output.tmp')
    const file = registry.createRegisteredFile({ path: scratchFile, purposeClass: 'test', content: `scratch:${runId}` })
    if (!file.ok) throw Object.assign(new Error(file.reason), { code: file.code })
    initialEntries = registry.list()
    ids = appendRegistrations(run, initialEntries, runId)
    safeAppend(run, { type: 'fault_injected', faultId })

    let restoredEntries = initialEntries
    if ([81, 82, 85].includes(faultId)) {
      safeAppend(run, { type: 'target_exit_observed', faultId })
      if (faultId === 81 && fs.existsSync(scratch)) fs.rmSync(scratch, { recursive: true, force: false })
      if (faultId === 85 && fs.existsSync(scratchFile)) fs.unlinkSync(scratchFile)
      if (faultId === 85) restoredEntries = initialEntries.map((entry) => ({ ...entry, cleanupState: 'DELETE_PENDING' }))
      safeAppend(run, { type: 'relaunch_started' })
      registry = createCrossVolumeTempRegistry({ episodeId: runId, workRoot: candidateRoot, entries: restoredEntries, onChange: persist, maxRetries: 2 })
      if (registry.initializationError) throw Object.assign(new Error(registry.initializationError.reason), { code: registry.initializationError.code })
    } else if (faultId === 83) {
      foreignChild = path.join(scratch, 'foreign.keep')
      fs.writeFileSync(foreignChild, 'harness-owned foreign child\n', { flag: 'wx' })
    } else if (faultId === 84) {
      lockChild = await acquireLockedFile(candidateRoot, scratchFile)
    } else if (faultId === 86) {
      fs.writeFileSync(path.join(scratch, OWNER_MARKER), '{"version":1,"episodeId":"other"}\n', 'utf8')
    } else if (faultId === 87) {
      linkTarget = path.join(offVolumeRoot, 'escape-target')
      linkPath = path.join(scratch, 'escape')
      fs.mkdirSync(linkTarget, { recursive: false })
      escapeTargetSentinel = path.join(linkTarget, 'target-sentinel.bin')
      const targetBytes = Buffer.from('must remain unchanged\n', 'utf8')
      fs.writeFileSync(escapeTargetSentinel, targetBytes, { flag: 'wx' })
      escapeTargetHash = evidence.sha256(targetBytes)
      escapeTargetPathId = abstractId('escape-target', runId)
      safeAppend(run, { type: 'sentinel_observed', phase: 'before', pathId: escapeTargetPathId, sha256: escapeTargetHash })
      try {
        fs.symlinkSync(linkTarget, linkPath, 'junction')
      } catch (error) {
        invalidReason = `reparse adapter unavailable (${error.code || 'unknown'})`
        safeAppend(run, { type: 'fault_not_run', faultId, code: 'E5_REPARSE_ADAPTER_UNAVAILABLE', reason: invalidReason })
      }
    }

    safeAppend(run, { type: 'cleanup_started' })
    let firstCleanup = registry.cleanupTerminal({ terminal: true, reason: kind })
    firstCleanupCodes = (firstCleanup.residuals || []).map((entry) => entry.code)
    if (faultId === 87 && invalidReason) {
      classification = 'INVALID'
    } else if (faultId === 84) {
      if (firstCleanup.ok) {
        invalidReason = 'locked file was not observed as blocked while the exclusive handle was held'
        classification = 'INVALID'
      } else {
        const codes = new Set(firstCleanup.residuals.map((entry) => entry.code))
        if (![...codes].some((code) => E5_LOCK_CODES.has(code))) {
          invalidReason = `locked-file cleanup returned a non-lock error (${[...codes].join(',')})`
          classification = 'INVALID'
        }
      }
    }

    if (!firstCleanup.ok) {
      const blockedCode = firstCleanup.residuals[0] && firstCleanup.residuals[0].code || 'CLEANUP_BLOCKED'
      safeAppend(run, { type: 'recovery_blocked', code: blockedCode })
      safeAppend(run, { type: 'cleanup_verified', residualCount: firstCleanup.residuals.length })
      safeAppend(run, { type: 'product_result_observed', actualOutcome: 'CLEANUP_BLOCKED', result: `cleanup refused with ${blockedCode}` })
      if (faultId === 83) safeAppend(run, { type: 'cleanup_entry_preserved_unowned', pathId: abstractId('foreign', runId) })

      if (faultId === 83 && foreignChild && fs.existsSync(foreignChild)) fs.unlinkSync(foreignChild)
      if (faultId === 86) {
        fs.writeFileSync(path.join(scratch, OWNER_MARKER), `${JSON.stringify({ version: 1, episodeId: runId, workRootIdentity: registry.workRootIdentity })}\n`, 'utf8')
      }
      if (faultId === 87 && linkPath && fs.existsSync(linkPath)) fs.rmdirSync(linkPath)
      if (faultId === 84 && lockChild) {
        await waitForExit(lockChild)
        lockChild = null
      }

      safeAppend(run, { type: 'cleanup_retry', reason: 'task-owned residual retried after the injected blocker was removed' })
      const retried = registry.retryCleanupDebt()
      appendDeleted(run, initialEntries, ids, retried.deleted || [])
      cleanupResiduals = retried.residuals || []
      retryCleanupCodes = cleanupResiduals.map((entry) => entry.code)
      safeAppend(run, { type: 'cleanup_verified', residualCount: cleanupResiduals.length })
      if (retried.ok) safeAppend(run, { type: 'episode_completed' })
      if (!['83', '84', '86', '87'].includes(String(faultId))) {
        invalidReason = `unexpected cleanup block for fault ${faultId}`
        classification = 'FAIL'
      }
    } else {
      appendDeleted(run, initialEntries, ids, firstCleanup.deleted || [])
      cleanupResiduals = firstCleanup.residuals || []
      safeAppend(run, { type: 'cleanup_verified', residualCount: cleanupResiduals.length })
      safeAppend(run, { type: 'episode_completed' })
      safeAppend(run, { type: 'product_result_observed', actualOutcome: 'CLEANUP_COMPLETED', result: 'terminal cleanup returned zero residuals' })
    }

    if (escapeTargetSentinel && fs.existsSync(escapeTargetSentinel)) {
      const targetHash = evidence.sha256File(escapeTargetSentinel)
      if (targetHash !== escapeTargetHash) {
        invalidReason = 'reparse target sentinel changed during cleanup'
        classification = 'FAIL'
      }
      if (escapeTargetPathId) safeAppend(run, { type: 'sentinel_observed', phase: 'after', pathId: escapeTargetPathId, sha256: targetHash })
    }
    const afterHash = evidence.sha256File(sentinel)
    safeAppend(run, { type: 'sentinel_observed', phase: 'after', pathId: sentinelPathId, sha256: afterHash })
    if (afterHash !== sentinelHash) {
      invalidReason = 'pre-existing non-work-volume source sentinel changed during cleanup'
      classification = 'FAIL'
    }
    const final = evidence.finalizeRun(run, {
      testStopReason: 'terminal_cross_volume_cleanup_observed',
      ...(invalidReason ? { invalidReason } : {})
    })
    const integrity = evidence.verifyRunIntegrity(run.runDir)
    if (!integrity.ok) throw Object.assign(new Error(`E5 run integrity failed (${integrity.code})`), { code: 'E5_RUN_INTEGRITY_FAILED' })
    return {
      runId,
      faultId,
      classification: final.classification,
      oracle: final.oracle,
      residualCount: final.offWorkVolumeResidualCount,
      initialCleanupCodes: firstCleanupCodes,
      retryCleanupCodes
    }
  } catch (error) {
    if (run && !fs.existsSync(path.join(run.runDir, 'SHA256SUMS.txt'))) {
      try {
        safeAppend(run, { type: 'fault_not_run', faultId, code: error.code || 'E5_RUN_FAILED', reason: String(error.message || error).slice(0, 240) })
        safeAppend(run, { type: 'product_result_observed', actualOutcome: 'E5_OBSERVATION_FAILED', result: error.code || 'E5_RUN_FAILED' })
        evidence.finalizeRun(run, { invalidReason: String(error.message || error).slice(0, 240), testStopReason: 'e5_observation_failed' })
      } catch {}
    }
    return { runId, faultId, classification: 'INVALID', code: error.code || 'E5_RUN_FAILED', reason: String(error.message || error).slice(0, 240) }
  } finally {
    if (lockChild && lockChild.exitCode === null && lockChild.signalCode === null) {
      try { await waitForExit(lockChild, 5_000) } catch { lockChild.kill() }
    }
    // The harness removes only the exact, marker-owned roots it created.
    try { exactOwnedRemove(offVolumeRoot, sourceRootMarkerPath, sourceRootMarker) } catch {}
    try { exactOwnedRemove(candidateRoot, candidateMarkerPath, candidateMarker) } catch {}
  }
}

async function runE5Campaign(options = {}) {
  const plan = buildE5Plan(options.seed)
  const results = []
  for (const entry of plan) {
    const result = await runE5Observation(options.batch, entry, options)
    results.push(result)
    if (typeof options.onProgress === 'function') options.onProgress(result, results.length, plan.length)
  }
  const derived = evidence.deriveBatch(options.batch.batchDir)
  return { results, derived, accepted: Boolean(derived.ok && derived.analysis.acceptanceGates && derived.analysis.acceptanceGates.A5.status === 'PASS') }
}

module.exports = { E5_SCENARIOS, buildE5Plan, runE5Observation, runE5Campaign, validateE5Environment }
