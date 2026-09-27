'use strict'

/**
 * Durable lifecycle index and one-owner claim for engineering episode recovery.
 * Checkpoints remain execution truth; this store only points at them and records
 * lifecycle/ownership metadata.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateRecoveryDescriptor } = require('./recovery-schema.cjs')

const RECOVERY_INDEX_VERSION = 1
const RECOVERY_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  RECOVERY_BLOCKED: 'RECOVERY_BLOCKED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
})
const TERMINAL_STATES = new Set([RECOVERY_STATES.COMPLETED, RECOVERY_STATES.CANCELLED])

function cleanupDebtCount(entries) {
  return Array.isArray(entries)
    ? entries.filter((entry) => entry && ['DELETE_PENDING', 'CLEANUP_BLOCKED'].includes(entry.cleanupState)).length
    : 0
}

function renameIndexWithBoundedRetry(source, target) {
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(source, target)
      return
    } catch (error) {
      lastError = error
      if (!error || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 3) throw error
      // Windows scanners/indexers can briefly hold the old index open. Keep the
      // previous durable index intact and retry only this atomic replacement.
      Atomics.wait(waitCell, 0, 0, 10 * (attempt + 1))
    }
  }
  throw lastError || new Error('recovery index replacement failed')
}

function safeEpisodeId(value) {
  const episodeId = value === undefined || value === null ? '' : String(value).trim()
  return episodeId && episodeId.length <= 512 ? episodeId : null
}

function episodeKey(episodeId) {
  return crypto.createHash('sha256').update(episodeId, 'utf8').digest('hex').slice(0, 32)
}

function validOwner(owner) {
  return Boolean(owner && typeof owner === 'object' &&
    typeof owner.instanceId === 'string' && owner.instanceId.trim() &&
    Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
    typeof owner.processIdentity === 'string' && owner.processIdentity.trim())
}

function sameOwner(left, right) {
  return validOwner(left) && validOwner(right) &&
    left.instanceId === right.instanceId &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity
}

function inside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function errorResult(code, reason) {
  return { ok: false, code, reason: String(reason || code) }
}

function createRecoveryStore(options = {}) {
  const root = path.resolve(String(options.root || path.join(__dirname, '..', '..', 'runtime', 'engineering')))
  const checkpointDir = path.resolve(String(options.checkpointDir || path.join(root, 'checkpoints')))
  const indexFile = path.join(root, 'recovery-index.json')
  const claimsDir = path.join(root, 'claims')
  const staleClaimsDir = path.join(root, 'stale-claims')
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const isOwnerAlive = typeof options.isOwnerAlive === 'function' ? options.isOwnerAlive : null

  function emptyIndex() {
    return { version: RECOVERY_INDEX_VERSION, episodes: {} }
  }

  function readIndex() {
    let raw
    try {
      raw = fs.readFileSync(indexFile, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyIndex()
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      const failure = new Error(`the recovery index is not valid JSON: ${error.message}`)
      failure.code = 'RECOVERY_INDEX_CORRUPT'
      throw failure
    }
    if (!parsed || parsed.version !== RECOVERY_INDEX_VERSION || !parsed.episodes || typeof parsed.episodes !== 'object' || Array.isArray(parsed.episodes)) {
      const failure = new Error('the recovery index version or shape is unsupported')
      failure.code = 'RECOVERY_INDEX_CORRUPT'
      throw failure
    }
    return parsed
  }

  function writeIndex(index) {
    fs.mkdirSync(root, { recursive: true })
    const temp = `${indexFile}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
    let fd = null
    try {
      fd = fs.openSync(temp, 'wx')
      fs.writeFileSync(fd, JSON.stringify(index), 'utf8')
      fs.closeSync(fd)
      fd = null
      renameIndexWithBoundedRetry(temp, indexFile)
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd) } catch {}
      }
      try { fs.unlinkSync(temp) } catch {}
      throw error
    }
  }

  function readClaim(episodeId) {
    const file = path.join(claimsDir, `${episodeKey(episodeId)}.json`)
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return { file, claim: null }
      throw error
    }
    let claim
    try {
      claim = JSON.parse(raw)
    } catch {
      return { file, claim: null, corrupt: true }
    }
    if (!claim || claim.version !== 1 || claim.episodeId !== episodeId || !validOwner(claim.owner) || typeof claim.token !== 'string') {
      return { file, claim: null, corrupt: true }
    }
    return { file, claim }
  }

  function writeClaimExclusive(file, claim) {
    fs.mkdirSync(claimsDir, { recursive: true })
    const fd = fs.openSync(file, 'wx')
    try {
      fs.writeFileSync(fd, JSON.stringify(claim), 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  }

  function ownerFields(entry, owner) {
    entry.ownerInstanceId = owner ? owner.instanceId : null
    entry.ownerPid = owner ? owner.pid : null
    entry.ownerProcessIdentity = owner ? owner.processIdentity : null
  }

  function saveEntry(episodeId, entry) {
    const index = readIndex()
    index.episodes[episodeId] = entry
    writeIndex(index)
    return JSON.parse(JSON.stringify(entry))
  }

  function get(episodeIdInput) {
    const episodeId = safeEpisodeId(episodeIdInput)
    if (!episodeId) return null
    const entry = readIndex().episodes[episodeId]
    return entry ? JSON.parse(JSON.stringify(entry)) : null
  }

  function readCheckpointFile(candidatePath) {
    let canonicalDir
    let canonicalFile
    const absoluteCandidate = path.resolve(candidatePath)
    try {
      canonicalFile = fs.realpathSync(absoluteCandidate)
    } catch (error) {
      return errorResult(error && error.code === 'ENOENT' ? 'CHECKPOINT_MISSING' : 'STORAGE_ERROR', error && error.message ? error.message : error)
    }
    try {
      canonicalDir = fs.realpathSync(checkpointDir)
    } catch (error) {
      if (error && error.code === 'ENOENT') canonicalDir = checkpointDir
      else return errorResult('STORAGE_ERROR', error && error.message ? error.message : error)
    }
    if (!inside(canonicalDir, canonicalFile) || canonicalFile === canonicalDir) {
      return errorResult('CHECKPOINT_OUTSIDE_ROOT', 'the checkpoint is outside the configured checkpoint directory')
    }
    try {
      if (fs.lstatSync(absoluteCandidate).isSymbolicLink()) {
        return errorResult('CHECKPOINT_SYMLINK', 'a symlink cannot be used as a checkpoint source')
      }
      if (!fs.lstatSync(absoluteCandidate).isFile()) {
        return errorResult('CHECKPOINT_INVALID', 'the checkpoint source must be a regular file')
      }
    } catch (error) {
      return errorResult('CHECKPOINT_MISSING', error && error.message ? error.message : error)
    }

    let checkpoint
    try {
      checkpoint = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'))
    } catch (error) {
      return errorResult('CHECKPOINT_INVALID', error && error.message ? error.message : error)
    }
    const episodeId = safeEpisodeId(checkpoint && checkpoint.episodeId)
    let descriptor = checkpoint && checkpoint.recovery
    const sequence = descriptor && descriptor.cursor && descriptor.cursor.checkpointSeq
    if (!checkpoint || checkpoint.version !== 2 || !episodeId ||
      !descriptor || descriptor.version !== 1 || descriptor.episodeId !== episodeId ||
      !Number.isSafeInteger(sequence) || sequence < 1) {
      return errorResult('CHECKPOINT_INVALID', 'the checkpoint does not contain a compatible recovery descriptor')
    }
    let lifecycleDiagnostic = null
    const validation = validateRecoveryDescriptor(descriptor, { episodeId })
    if (!validation.ok) {
      lifecycleDiagnostic = `${validation.code}: ${validation.reason}`
      descriptor = { ...descriptor, lifecycleState: RECOVERY_STATES.RECOVERY_BLOCKED, blockedReason: lifecycleDiagnostic }
    } else {
      descriptor = validation.descriptor
    }
    return { ok: true, checkpoint, episodeId, descriptor, sequence, canonicalFile, lifecycleDiagnostic }
  }

  function recordCheckpoint(input = {}) {
    const episodeId = safeEpisodeId(input.episodeId)
    if (!episodeId) return errorResult('EPISODE_REQUIRED', 'a valid episode id is required')
    if (typeof input.checkpointPath !== 'string' || !input.checkpointPath.trim()) {
      return errorResult('CHECKPOINT_REQUIRED', 'a persisted checkpoint path is required')
    }

    const candidate = readCheckpointFile(input.checkpointPath)
    if (!candidate.ok) return candidate
    const { checkpoint, descriptor, sequence, canonicalFile, lifecycleDiagnostic } = candidate
    if (candidate.episodeId !== episodeId) return errorResult('CHECKPOINT_INVALID', 'the checkpoint episode does not match the requested episode')

    try {
      const index = readIndex()
      const prior = index.episodes[episodeId] || null
      if (prior && TERMINAL_STATES.has(prior.state)) {
        return errorResult('EPISODE_TERMINAL', 'a terminal episode cannot be made active by a checkpoint write')
      }
      if (prior && sequence < prior.latestCheckpointSeq) {
        return errorResult('CHECKPOINT_SEQUENCE_REGRESSION', 'the recovery index already references a newer checkpoint sequence')
      }
      if (prior && sequence === prior.latestCheckpointSeq && prior.latestCheckpointFile !== path.basename(canonicalFile)) {
        return errorResult('CHECKPOINT_SEQUENCE_CONFLICT', 'two checkpoint files claim the same episode sequence')
      }
      const lifecycleState = descriptor.lifecycleState || RECOVERY_STATES.ACTIVE
      const blockedReason = lifecycleDiagnostic || (lifecycleState === RECOVERY_STATES.RECOVERY_BLOCKED && descriptor.blockedReason ? String(descriptor.blockedReason) : null)
      if (prior && prior.state === RECOVERY_STATES.RECOVERY_BLOCKED && lifecycleState === RECOVERY_STATES.ACTIVE &&
        (descriptor.repairAuthorized !== true || sequence <= prior.latestCheckpointSeq)) {
        return errorResult('BLOCKED_EPISODE_REQUIRES_REPAIR', 'a blocked episode needs an explicit repair marker and a newer checkpoint before it can become active')
      }
      const progressed = Boolean(prior && sequence > prior.latestCheckpointSeq)
      const entry = {
        episodeId,
        state: lifecycleState,
        updatedAt: now(),
        latestCheckpointSeq: sequence,
        latestCheckpointFile: path.basename(canonicalFile),
        recoveryAttempts: progressed ? 0 : (prior ? prior.recoveryAttempts : 0),
        lastOutcome: progressed ? 'newer_valid_checkpoint_written' : (prior ? prior.lastOutcome : null),
        workRoot: descriptor.workRoot || null,
        cleanupDebtSummary: { total: cleanupDebtCount(descriptor.crossVolumeTemp) },
        blockedReason,
        ownerInstanceId: prior ? prior.ownerInstanceId : null,
        ownerPid: prior ? prior.ownerPid : null,
        ownerProcessIdentity: prior ? prior.ownerProcessIdentity : null
      }
      index.episodes[episodeId] = entry
      writeIndex(index)
      return { ok: true, entry: JSON.parse(JSON.stringify(entry)) }
    } catch (error) {
      return errorResult(error && error.code === 'RECOVERY_INDEX_CORRUPT' ? error.code : 'STORAGE_ERROR', error && error.message ? error.message : error)
    }
  }

  function beginRecoveryAttempt(input = {}) {
    const episodeId = safeEpisodeId(input.episodeId)
    const maxAttempts = Number.isSafeInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : 3
    if (!episodeId) return errorResult('EPISODE_REQUIRED', 'a valid episode id is required')
    try {
      const entry = get(episodeId)
      if (!entry || entry.state !== RECOVERY_STATES.ACTIVE) {
        return errorResult('EPISODE_NOT_RESUMABLE', 'only an active episode may start an automatic recovery attempt')
      }
      if (entry.recoveryAttempts >= maxAttempts) {
        entry.state = RECOVERY_STATES.RECOVERY_BLOCKED
        entry.blockedReason = `${maxAttempts} consecutive automatic recovery attempts failed`
        entry.lastOutcome = 'automatic_recovery_attempt_limit_exhausted'
        entry.updatedAt = now()
        saveEntry(episodeId, entry)
        return { ...errorResult('RECOVERY_ATTEMPTS_EXHAUSTED', entry.blockedReason), entry: get(episodeId) }
      }
      entry.recoveryAttempts += 1
      entry.lastOutcome = 'automatic_recovery_attempt_started'
      entry.updatedAt = now()
      const saved = saveEntry(episodeId, entry)
      return { ok: true, entry: saved, attempt: saved.recoveryAttempts, maxAttempts }
    } catch (error) {
      return errorResult(error && error.code === 'RECOVERY_INDEX_CORRUPT' ? error.code : 'STORAGE_ERROR', error && error.message ? error.message : error)
    }
  }

  function blockEpisode(input = {}) {
    const episodeId = safeEpisodeId(input.episodeId)
    if (!episodeId) return errorResult('EPISODE_REQUIRED', 'a valid episode id is required')
    const reason = String(input.reason || input.code || 'recovery validation refused')
    try {
      const entry = get(episodeId)
      if (!entry) return errorResult('EPISODE_NOT_FOUND', 'the recovery episode is not indexed')
      if (TERMINAL_STATES.has(entry.state)) return errorResult('EPISODE_TERMINAL', 'a terminal episode cannot be changed to blocked')
      entry.state = RECOVERY_STATES.RECOVERY_BLOCKED
      entry.blockedReason = reason
      entry.lastOutcome = String(input.code || 'recovery_validation_blocked')
      entry.updatedAt = now()
      return { ok: true, entry: saveEntry(episodeId, entry) }
    } catch (error) {
      return errorResult(error && error.code === 'RECOVERY_INDEX_CORRUPT' ? error.code : 'STORAGE_ERROR', error && error.message ? error.message : error)
    }
  }

  function reconcileIndex() {
    let priorIndex = emptyIndex()
    try {
      priorIndex = readIndex()
    } catch (error) {
      if (!error || error.code !== 'RECOVERY_INDEX_CORRUPT') {
        return errorResult('STORAGE_ERROR', error && error.message ? error.message : error)
      }
    }

    let names
    try {
      const stat = fs.lstatSync(checkpointDir)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return errorResult('CHECKPOINT_ROOT_INVALID', 'the checkpoint root must be a non-symlink directory')
      }
      names = fs.readdirSync(checkpointDir).filter((name) => name.toLowerCase().endsWith('.json'))
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        if (Object.keys(priorIndex.episodes).length) {
          return errorResult('CHECKPOINT_ROOT_MISSING', 'the configured checkpoint directory is temporarily missing; the recovery index was left untouched')
        }
        names = []
      }
      else return errorResult('STORAGE_ERROR', error && error.message ? error.message : error)
    }

    const grouped = new Map()
    for (const name of names) {
      const candidate = readCheckpointFile(path.join(checkpointDir, name))
      if (!candidate.ok) continue
      if (!grouped.has(candidate.episodeId)) grouped.set(candidate.episodeId, new Map())
      const sequences = grouped.get(candidate.episodeId)
      if (!sequences.has(candidate.sequence)) sequences.set(candidate.sequence, [])
      sequences.get(candidate.sequence).push(candidate)
    }

    const repaired = {}
    const at = now()
    for (const [episodeId, sequences] of grouped) {
      const latestSequence = Math.max(...sequences.keys())
      const latestCandidates = sequences.get(latestSequence)
      const selected = latestCandidates.length === 1 ? latestCandidates[0] : null
      const prior = priorIndex.episodes[episodeId] || null
      const recovery = selected && selected.descriptor
      const markerState = recovery && recovery.lifecycleState
      const oldTerminal = prior && TERMINAL_STATES.has(prior.state) ? prior.state : null
      let state = selected && Object.values(RECOVERY_STATES).includes(markerState)
        ? markerState
        : RECOVERY_STATES.ACTIVE
      let blockedReason = state === RECOVERY_STATES.RECOVERY_BLOCKED && recovery && recovery.blockedReason
        ? String(recovery.blockedReason)
        : null
      if (oldTerminal) state = oldTerminal
      if (latestCandidates.length !== 1) {
        state = RECOVERY_STATES.RECOVERY_BLOCKED
        blockedReason = `duplicate checkpoint files claim sequence ${latestSequence}`
      } else if (markerState !== undefined && !Object.values(RECOVERY_STATES).includes(markerState)) {
        state = RECOVERY_STATES.RECOVERY_BLOCKED
        blockedReason = `unsupported checkpoint lifecycle state: ${String(markerState)}`
      }

      const claimState = selected ? readClaim(episodeId) : { claim: null }
      const matchingClaim = claimState.claim && claimState.claim.checkpointSeq === latestSequence ? claimState.claim : null
      const owner = matchingClaim ? matchingClaim.owner : (
        prior && prior.latestCheckpointSeq === latestSequence && validOwner({
          instanceId: prior.ownerInstanceId,
          pid: prior.ownerPid,
          processIdentity: prior.ownerProcessIdentity
        })
          ? { instanceId: prior.ownerInstanceId, pid: prior.ownerPid, processIdentity: prior.ownerProcessIdentity }
          : null
      )
      const descriptor = selected ? selected.descriptor : latestCandidates[0].descriptor
      const newerCheckpoint = Boolean(prior && latestSequence > prior.latestCheckpointSeq)
      const authorizedRepair = newerCheckpoint && recovery && recovery.repairAuthorized === true
      const priorBlocked = prior && prior.state === RECOVERY_STATES.RECOVERY_BLOCKED && state === RECOVERY_STATES.ACTIVE && !authorizedRepair
      if (priorBlocked) {
        state = RECOVERY_STATES.RECOVERY_BLOCKED
        blockedReason = prior.blockedReason || 'the prior recovery block requires an explicit repair-authorized checkpoint'
      }
      const entry = {
        episodeId,
        state,
        updatedAt: at,
        latestCheckpointSeq: latestSequence,
        latestCheckpointFile: selected ? path.basename(selected.canonicalFile) : null,
        recoveryAttempts: newerCheckpoint ? 0 : (prior && Number.isSafeInteger(prior.recoveryAttempts) && prior.recoveryAttempts >= 0 ? prior.recoveryAttempts : 0),
        lastOutcome: newerCheckpoint ? 'newer_valid_checkpoint_written' : (prior && prior.lastOutcome ? prior.lastOutcome : null),
        workRoot: descriptor.workRoot || null,
        cleanupDebtSummary: { total: cleanupDebtCount(descriptor.crossVolumeTemp) },
        blockedReason,
        ownerInstanceId: null,
        ownerPid: null,
        ownerProcessIdentity: null
      }
      if (owner) ownerFields(entry, owner)
      repaired[episodeId] = entry
    }

    for (const [episodeId, prior] of Object.entries(priorIndex.episodes)) {
      if (Object.prototype.hasOwnProperty.call(repaired, episodeId)) continue
      const priorState = Object.values(RECOVERY_STATES).includes(prior && prior.state) ? prior.state : RECOVERY_STATES.RECOVERY_BLOCKED
      const state = TERMINAL_STATES.has(priorState) ? priorState : RECOVERY_STATES.RECOVERY_BLOCKED
      repaired[episodeId] = {
        ...prior,
        state,
        updatedAt: at,
        blockedReason: TERMINAL_STATES.has(state)
          ? (prior.blockedReason || null)
          : (prior.blockedReason || 'no valid checkpoint remains for this indexed episode'),
        ownerInstanceId: null,
        ownerPid: null,
        ownerProcessIdentity: null
      }
    }

    try {
      writeIndex({ version: RECOVERY_INDEX_VERSION, episodes: repaired })
      return { ok: true, repairedEpisodes: Object.keys(repaired).length, entries: Object.values(repaired).map((entry) => JSON.parse(JSON.stringify(entry))) }
    } catch (error) {
      return errorResult('STORAGE_ERROR', error && error.message ? error.message : error)
    }
  }

  function acquireClaim(input = {}) {
    const episodeId = safeEpisodeId(input.episodeId)
    const owner = input.owner
    const checkpointSeq = input.checkpointSeq
    if (!episodeId) return errorResult('EPISODE_REQUIRED', 'a valid episode id is required')
    if (!validOwner(owner)) return errorResult('CLAIM_OWNER_INVALID', 'owner identity requires instanceId, pid, and processIdentity')
    if (!Number.isSafeInteger(checkpointSeq) || checkpointSeq < 1) return errorResult('CHECKPOINT_SEQUENCE_INVALID', 'a positive checkpoint sequence is required')

    let entry
    try { entry = get(episodeId) } catch (error) { return errorResult(error.code || 'STORAGE_ERROR', error.message) }
    if (!entry || entry.state !== RECOVERY_STATES.ACTIVE || entry.latestCheckpointSeq !== checkpointSeq) {
      return errorResult('CHECKPOINT_NOT_CURRENT', 'the claim must name the active episode current checkpoint')
    }

    const claimFile = path.join(claimsDir, `${episodeKey(episodeId)}.json`)
    const makeClaim = () => ({
      version: 1,
      episodeId,
      owner: { instanceId: owner.instanceId, pid: owner.pid, processIdentity: owner.processIdentity },
      checkpointSeq,
      claimedAt: now(),
      token: crypto.randomBytes(16).toString('hex')
    })
    const persistNew = () => {
      const claim = makeClaim()
      try {
        writeClaimExclusive(claimFile, claim)
      } catch (error) {
        if (error && error.code === 'EEXIST') return null
        throw error
      }
      try {
        const latest = get(episodeId)
        if (!latest || latest.latestCheckpointSeq !== checkpointSeq || latest.state !== RECOVERY_STATES.ACTIVE) {
          fs.unlinkSync(claimFile)
          return errorResult('CHECKPOINT_NOT_CURRENT', 'the episode changed while its claim was being acquired')
        }
        ownerFields(latest, owner)
        latest.updatedAt = now()
        saveEntry(episodeId, latest)
        return { ok: true, claim: JSON.parse(JSON.stringify(claim)), entry: get(episodeId) }
      } catch (error) {
        try { fs.unlinkSync(claimFile) } catch {}
        throw error
      }
    }

    try {
      const first = persistNew()
      if (first) return first

      const existingState = readClaim(episodeId)
      if (existingState.corrupt || !existingState.claim) {
        return errorResult('CLAIM_CORRUPT', 'an existing claim cannot be read safely; automatic recovery is blocked')
      }
      if (!isOwnerAlive) {
        return errorResult('CLAIM_OWNER_UNKNOWN', 'no process-identity probe is available to prove the existing owner is stale')
      }
      const existingOwnerAlive = isOwnerAlive(existingState.claim.owner)
      if (existingOwnerAlive !== false) {
        const code = existingOwnerAlive === true ? 'CLAIM_ALREADY_OWNED' : 'CLAIM_OWNER_UNKNOWN'
        return { ...errorResult(code, code === 'CLAIM_ALREADY_OWNED' ? 'the episode has a live execution owner' : 'the existing claim owner could not be safely classified'), ownerInstanceId: existingState.claim.owner.instanceId }
      }

      const reclaimLock = `${claimFile}.reclaim`
      let lockFd
      try {
        fs.mkdirSync(claimsDir, { recursive: true })
        lockFd = fs.openSync(reclaimLock, 'wx')
      } catch (error) {
        if (error && error.code === 'EEXIST') return errorResult('CLAIM_RECOVERY_IN_PROGRESS', 'another startup is reconciling the stale claim')
        throw error
      }
      try {
        const current = readClaim(episodeId)
        if (current.corrupt || !current.claim) return errorResult('CLAIM_CORRUPT', 'the claim changed into an unreadable state during recovery')
        if (current.claim.token !== existingState.claim.token) {
          return { ...errorResult('CLAIM_ALREADY_OWNED', 'the claim changed while stale-owner recovery was starting'), ownerInstanceId: current.claim.owner.instanceId }
        }
        const currentOwnerAlive = isOwnerAlive(current.claim.owner)
        if (currentOwnerAlive !== false) {
          return errorResult(currentOwnerAlive === true ? 'CLAIM_ALREADY_OWNED' : 'CLAIM_OWNER_UNKNOWN', 'the existing claim is not proven stale')
        }
        fs.mkdirSync(staleClaimsDir, { recursive: true })
        const archive = path.join(staleClaimsDir, `${episodeKey(episodeId)}-${now()}-${crypto.randomBytes(6).toString('hex')}.json`)
        fs.renameSync(claimFile, archive)
        const replacement = persistNew()
        return replacement || errorResult('CLAIM_RECOVERY_IN_PROGRESS', 'another startup acquired the episode while the stale claim was archived')
      } finally {
        try { fs.closeSync(lockFd) } catch {}
        try { fs.unlinkSync(reclaimLock) } catch {}
      }
    } catch (error) {
      return errorResult('STORAGE_ERROR', error && error.message ? error.message : error)
    }
  }

  function releaseClaim(input = {}) {
    const episodeId = safeEpisodeId(input.episodeId)
    if (!episodeId || !validOwner(input.owner)) return errorResult('CLAIM_OWNER_INVALID', 'episode and full owner identity are required')
    try {
      const { file, claim, corrupt } = readClaim(episodeId)
      if (corrupt) return errorResult('CLAIM_CORRUPT', 'the existing claim cannot be released safely')
      if (!claim || !sameOwner(claim.owner, input.owner)) return errorResult('CLAIM_NOT_OWNED', 'only the matching execution owner may release this claim')
      fs.unlinkSync(file)
      const entry = get(episodeId)
      if (entry && entry.ownerInstanceId === input.owner.instanceId && entry.ownerPid === input.owner.pid && entry.ownerProcessIdentity === input.owner.processIdentity) {
        ownerFields(entry, null)
        entry.updatedAt = now()
        saveEntry(episodeId, entry)
      }
      return { ok: true, episodeId }
    } catch (error) {
      return errorResult(error && error.code === 'RECOVERY_INDEX_CORRUPT' ? error.code : 'STORAGE_ERROR', error && error.message ? error.message : error)
    }
  }

  return {
    root,
    checkpointDir,
    indexFile,
    claimsDir,
    get,
    recordCheckpoint,
    reconcileIndex,
    beginRecoveryAttempt,
    blockEpisode,
    acquireClaim,
    releaseClaim
  }
}

module.exports = { createRecoveryStore, RECOVERY_INDEX_VERSION, RECOVERY_STATES }
