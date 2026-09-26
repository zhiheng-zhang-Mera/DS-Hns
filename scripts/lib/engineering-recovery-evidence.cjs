'use strict'

/** External, test-only evidence tooling. Nothing in this module is imported by the shipped runtime. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCHEMA_VERSION = 1
const ROOT = path.resolve(__dirname, '..', '..')
const EVIDENCE_DATA = path.join(ROOT, 'tests', 'evidence', 'engineering-recovery')
const FAULT_CATALOG_FILE = path.join(EVIDENCE_DATA, 'fault-catalog.json')
const WORKLOADS_FILE = path.join(EVIDENCE_DATA, 'workloads.json')
const SCHEMA_FILE = path.join(EVIDENCE_DATA, 'schema-v1.json')
const SOURCE_SPEC_FILE = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-09-26-engineering-auto-resume-design-v5-icse-evidence-freeze.md')
const RAW_RUN_FILES = Object.freeze(['manifest.json', 'events.jsonl', 'result.json', 'oracle.json'])
const EVENT_TYPES = new Set([
  'episode_started', 'checkpoint_observed', 'fault_armed', 'fault_injected', 'target_exit_observed',
  'relaunch_started', 'windows_session_restored', 'app_relaunched', 'recovery_candidate_detected',
  'recovery_claim_acquired', 'recovery_verified', 'resume_accepted', 'first_post_resume_checkpoint',
  'recovery_blocked', 'cross_volume_temp_registered', 'cleanup_started', 'cleanup_entry_deleted',
  'cleanup_entry_preserved_unowned', 'cleanup_retry', 'cleanup_verified', 'episode_completed',
  'run_stopped', 'mutation_effect', 'sentinel_observed', 'owner_snapshot', 'step_observed',
  'product_result_observed', 'fault_not_run'
])
const EVENT_FIELDS = new Set([
  'type', 'faultId', 'checkpointSeq', 'cursor', 'code', 'reason', 'verifiedStepIds',
  'verifiedMutationIds', 'mutationId', 'effectId', 'effect', 'phase', 'liveOwnerCount',
  'ownerId', 'owners', 'pathId', 'entryType', 'sha256', 'residualCount', 'sameAccount',
  'manualCredentialPromptObserved', 'stepId', 'stepOutcome', 'mutationCount', 'latencyMs',
  'actualOutcome', 'result', 'candidateId'
])
const EVENT_RECORD_FIELDS = new Set(['batchId', 'runId', 'episodeId', 'eventSeq', 'monotonicMs', 'wallTime', ...EVENT_FIELDS])
const CURSOR_FIELDS = new Set(['nextStepIndex', 'lastVerifiedStepId', 'verifiedStepIds', 'skippedStepIds', 'checkpointSeq'])
const ORACLE_IDS = Object.freeze([
  'O1_progress_preservation', 'O2_no_verified_replay', 'O3_no_duplicate_effect', 'O4_cursor_monotonic',
  'O5_fail_closed_correct', 'O6_single_execution_owner', 'O7_cleanup_safety', 'O8_cleanup_completeness', 'O9_reboot_autonomy'
])
let evidenceSchemaCache = null

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!isRecord(value)) return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = stable(value[key])
  }
  return output
}

function stableStringify(value) {
  return JSON.stringify(stable(value))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(file) {
  return sha256(fs.readFileSync(file))
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function validDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function validateSchemaValue(value, schema, schemaRoot, label, errors) {
  if (!isRecord(schema)) {
    errors.push(`${label}: schema definition is not an object`)
    return
  }
  if (typeof schema.$ref === 'string') {
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(schema.$ref)
    const referenced = match && schemaRoot.$defs && schemaRoot.$defs[match[1]]
    if (!referenced) {
      errors.push(`${label}: unsupported or missing schema reference`)
      return
    }
    validateSchemaValue(value, referenced, schemaRoot, label, errors)
    return
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = []
      validateSchemaValue(value, candidate, schemaRoot, label, candidateErrors)
      return candidateErrors.length === 0
    }).length
    if (matches !== 1) errors.push(`${label}: expected exactly one schema alternative, got ${matches}`)
    return
  }
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
  if (types.length && !types.some((type) => schemaTypeMatches(value, type))) {
    errors.push(`${label}: value has the wrong type`)
    return
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) errors.push(`${label}: value does not match const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${label}: value is not in enum`)

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${label}: string is too short`)
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${label}: string is too long`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${label}: string does not match pattern`)
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) errors.push(`${label}: invalid date-time`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${label}: number is below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${label}: number is above maximum`)
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${label}: array has too few items`)
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${label}: array has too many items`)
    if (schema.uniqueItems === true && new Set(value.map(stableStringify)).size !== value.length) errors.push(`${label}: array items are not unique`)
    if (schema.items) value.forEach((item, index) => validateSchemaValue(item, schema.items, schemaRoot, `${label}[${index}]`, errors))
  }
  if (isRecord(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${label}.${key}: required property is missing`)
    }
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateSchemaValue(item, properties[key], schemaRoot, `${label}.${key}`, errors)
      } else if (schema.additionalProperties === false) {
        errors.push(`${label}.${key}: additional property is forbidden`)
      } else if (isRecord(schema.additionalProperties)) {
        validateSchemaValue(item, schema.additionalProperties, schemaRoot, `${label}.${key}`, errors)
      }
    }
  }
}

function validateEvidenceDocument(kind, document) {
  try {
    if (!evidenceSchemaCache) evidenceSchemaCache = readJson(SCHEMA_FILE)
    const definition = evidenceSchemaCache.$defs && evidenceSchemaCache.$defs[kind]
    if (!definition) return { ok: false, code: 'EVIDENCE_SCHEMA_KIND_UNKNOWN', errors: [`unknown schema definition: ${kind}`] }
    const errors = []
    validateSchemaValue(document, definition, evidenceSchemaCache, kind, errors)
    return { ok: errors.length === 0, code: errors.length ? 'EVIDENCE_SCHEMA_INVALID' : null, errors: errors.slice(0, 20) }
  } catch (error) {
    return { ok: false, code: 'EVIDENCE_SCHEMA_UNAVAILABLE', errors: [String(error && error.message ? error.message : error)] }
  }
}

function validateRunManifest(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== SCHEMA_VERSION || !safeId(manifest.batchId, 'batchId') ||
    !safeId(manifest.runId, 'runId') || !safeId(manifest.episodeId, 'episodeId') || !Number.isInteger(manifest.runOrdinal) || manifest.runOrdinal < 1 ||
    !Number.isInteger(manifest.seed) || manifest.seed < 0 || manifest.seed > 0xffffffff ||
    !['DIAGNOSTIC', 'PILOT', 'FINAL'].includes(manifest.classificationPhase) ||
    !validDigest(manifest.workloadSha256) || !validDigest(manifest.faultCatalogSha256) ||
    !validDigest(manifest.evidenceSchemaSha256) || !validDigest(manifest.sourceSpecSha256) ||
    !validDigest(manifest.recoveryConfigurationSha256) || !Array.isArray(manifest.workloadStepIds) ||
    manifest.workloadStepIds.length < 1 || new Set(manifest.workloadStepIds).size !== manifest.workloadStepIds.length ||
    !manifest.workloadStepIds.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/.test(id)) ||
    manifest.faultId < 1 || manifest.faultId > 89 || !Number.isInteger(manifest.faultId) ||
    !['adapter-simulated', 'controlled-owned-process', 'maintenance-window'].includes(manifest.executionMode) ||
    manifest.selectedWorkVolume !== 'D:' || !Array.isArray(manifest.storageVolumeRoles) || !manifest.storageVolumeRoles.includes('work:D') ||
    !Array.isArray(manifest.taskScratchVolumes) || !manifest.taskScratchVolumes.every((volume) => /^[A-Z]:$/.test(volume)) ||
    typeof manifest.candidateRoot !== 'string' || path.isAbsolute(manifest.candidateRoot) || path.win32.isAbsolute(manifest.candidateRoot) ||
    manifest.candidateRoot.split(/[\\/]/).includes('..') || !Number.isFinite(Date.parse(manifest.startedAt))) {
    return { ok: false, code: 'RUN_MANIFEST_INVALID' }
  }
  for (const field of ['implementationSha', 'harnessSha']) {
    if (manifest[field] !== null && manifest[field] !== undefined && !/^[a-f0-9]{40}$/i.test(manifest[field])) return { ok: false, code: 'RUN_MANIFEST_INVALID' }
    if (manifest.classificationPhase === 'FINAL' && !/^[a-f0-9]{40}$/i.test(String(manifest[field] || ''))) return { ok: false, code: 'RUN_SHA_REQUIRED' }
  }
  if (manifest.sourceRef !== null && manifest.sourceRef !== undefined &&
    (typeof manifest.sourceRef !== 'string' || !/^[A-Za-z0-9._/-]{1,160}$/.test(manifest.sourceRef) || manifest.sourceRef.includes('..'))) {
    return { ok: false, code: 'RUN_MANIFEST_INVALID' }
  }
  const schemaCheck = validateEvidenceDocument('runManifest', manifest)
  return schemaCheck.ok ? { ok: true } : { ok: false, code: 'RUN_MANIFEST_SCHEMA_INVALID', errors: schemaCheck.errors }
}

function validateCursor(cursor) {
  if (!isRecord(cursor) || Object.keys(cursor).some((key) => !CURSOR_FIELDS.has(key)) ||
    !Number.isSafeInteger(cursor.nextStepIndex) || cursor.nextStepIndex < 0 ||
    (cursor.checkpointSeq !== undefined && (!Number.isSafeInteger(cursor.checkpointSeq) || cursor.checkpointSeq < 1)) ||
    (cursor.lastVerifiedStepId !== undefined && cursor.lastVerifiedStepId !== null && typeof cursor.lastVerifiedStepId !== 'string')) return false
  for (const field of ['verifiedStepIds', 'skippedStepIds']) {
    if (cursor[field] !== undefined && (!Array.isArray(cursor[field]) || cursor[field].some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/.test(id)))) return false
  }
  if (cursor.lastVerifiedStepId !== undefined && cursor.lastVerifiedStepId !== null && !/^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/.test(cursor.lastVerifiedStepId)) return false
  return true
}

function validateEventRecord(event, expected = null) {
  if (!isRecord(event) || Object.keys(event).some((key) => !EVENT_RECORD_FIELDS.has(key)) || !EVENT_TYPES.has(event.type) ||
    typeof event.batchId !== 'string' || typeof event.runId !== 'string' || typeof event.episodeId !== 'string' ||
    !Number.isSafeInteger(event.eventSeq) || event.eventSeq < 1 || !Number.isFinite(event.monotonicMs) || event.monotonicMs < 0 ||
    typeof event.wallTime !== 'string' || !Number.isFinite(Date.parse(event.wallTime))) return false
  if (expected && (event.batchId !== expected.batchId || event.runId !== expected.runId || event.episodeId !== expected.episodeId)) return false
  if (event.cursor !== undefined && !validateCursor(event.cursor)) return false
  if (event.faultId !== undefined && (!Number.isInteger(event.faultId) || event.faultId < 1 || event.faultId > 89)) return false
  if (event.checkpointSeq !== undefined && (!Number.isSafeInteger(event.checkpointSeq) || event.checkpointSeq < 1)) return false
  if (event.sha256 !== undefined && !validDigest(event.sha256)) return false
  if (event.pathId !== undefined && (typeof event.pathId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(event.pathId))) return false
  if (event.reason !== undefined && (typeof event.reason !== 'string' || event.reason.length > 256 || /(?:[A-Za-z]:\\|\\\\)/.test(event.reason))) return false
  if (event.code !== undefined && (typeof event.code !== 'string' || event.code.length > 100)) return false
  if (event.liveOwnerCount !== undefined && (!Number.isInteger(event.liveOwnerCount) || event.liveOwnerCount < 0)) return false
  if (event.verifiedStepIds !== undefined && (!Array.isArray(event.verifiedStepIds) || event.verifiedStepIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/.test(id)))) return false
  if (event.verifiedMutationIds !== undefined && (!Array.isArray(event.verifiedMutationIds) || event.verifiedMutationIds.some((id) => typeof id !== 'string' || id.length > 256))) return false
  if (event.effectId !== undefined && (typeof event.effectId !== 'string' || event.effectId.length > 256)) return false
  if (event.mutationId !== undefined && (typeof event.mutationId !== 'string' || event.mutationId.length > 256)) return false
  for (const field of ['phase', 'stepId', 'stepOutcome', 'effect', 'ownerId', 'candidateId', 'actualOutcome', 'result']) {
    if (event[field] !== undefined && (typeof event[field] !== 'string' || event[field].length > 256 || /(?:[A-Za-z]:\\|\\\\)/.test(event[field]))) return false
  }
  if (event.stepId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/.test(event.stepId)) return false
  if (event.candidateId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(event.candidateId)) return false
  if (event.owners !== undefined && (!Array.isArray(event.owners) || event.owners.some((owner) => typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner)))) return false
  return validateEvidenceDocument('event', event).ok
}

function validateResultDocument(result, expected = null) {
  if (!isRecord(result) || result.schemaVersion !== SCHEMA_VERSION || !['PASS', 'EXPECTED_BLOCK', 'FAIL', 'INVALID'].includes(result.classification) ||
    typeof result.batchId !== 'string' || typeof result.runId !== 'string' || typeof result.expectedOutcome !== 'string' ||
    typeof result.actualOutcome !== 'string' || !Number.isInteger(result.faultId) || !['W0', 'W1', 'W2', 'W3', 'W4'].includes(result.workloadId) ||
    !Number.isInteger(result.runOrdinal) || !isRecord(result.oracle) || ORACLE_IDS.some((key) => !Object.prototype.hasOwnProperty.call(result.oracle, key)) ||
    ORACLE_IDS.some((key) => result.oracle[key] !== null && typeof result.oracle[key] !== 'boolean')) return false
  if (expected && (result.batchId !== expected.batchId || result.runId !== expected.runId)) return false
  return validateEvidenceDocument('result', result).ok
}

function validateOracleDocument(document, expected = null) {
  if (!isRecord(document) || document.schemaVersion !== SCHEMA_VERSION || typeof document.batchId !== 'string' || typeof document.runId !== 'string' ||
    !isRecord(document.oracle) || ORACLE_IDS.some((key) => !isRecord(document.oracle[key]) ||
      typeof document.oracle[key].applicable !== 'boolean' ||
      document.oracle[key].pass !== null && typeof document.oracle[key].pass !== 'boolean' ||
      !Array.isArray(document.oracle[key].sourceEventSeqs) || typeof document.oracle[key].observations !== 'object' || !isRecord(document.oracle[key].observations))) return false
  if (expected && (document.batchId !== expected.batchId || document.runId !== expected.runId)) return false
  return validateEvidenceDocument('oracleDocument', document).ok
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(temporary, file)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error && error.code) || attempt === 3) break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1))
    }
  }
  try { fs.unlinkSync(temporary) } catch {}
  throw lastError || new Error('atomic JSON write failed')
}

function safeId(value, label) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label} must be a bounded filename-safe identifier`)
  return id
}

function requireDVolume(target, label = 'evidence root') {
  const value = path.resolve(String(target || ''))
  const root = path.parse(value).root
  if (process.platform === 'win32') {
    if (!/^d:\\$/i.test(root)) throw Object.assign(new Error(`${label} must be on D:`), { code: 'EVIDENCE_ROOT_NOT_D' })
  } else if (process.env.HNS_EVIDENCE_TEST_ALLOW_NON_D !== '1') {
    throw Object.assign(new Error(`${label} must be on the configured D: volume`), { code: 'EVIDENCE_ROOT_NOT_D' })
  }
  return value
}

function loadFaultCatalog(file = FAULT_CATALOG_FILE) {
  const source = fs.readFileSync(file)
  const catalog = JSON.parse(source.toString('utf8'))
  if (!isRecord(catalog) || catalog.schemaVersion !== SCHEMA_VERSION || !Array.isArray(catalog.faults) || catalog.faults.length !== 89) {
    throw new Error('fault catalog schema or required 1–89 coverage is invalid')
  }
  const ids = catalog.faults.map((fault, index) => {
    if (!isRecord(fault) || fault.id !== index + 1 || typeof fault.family !== 'string' ||
      typeof fault.label !== 'string' || typeof fault.injectionPoint !== 'string' ||
      typeof fault.expectedOutcome !== 'string' ||
      !['adapter-simulated', 'controlled-owned-process', 'maintenance-window'].includes(fault.executionMode)) {
      throw new Error(`fault catalog entry ${index + 1} is incomplete or out of order`)
    }
    if ((fault.id >= 73 && fault.id <= 78) !== (fault.executionMode === 'maintenance-window')) {
      throw new Error(`fault ${fault.id} has an unsafe execution mode`)
    }
    if ((fault.id === 4) !== (fault.executionMode === 'controlled-owned-process')) {
      throw new Error(`fault ${fault.id} has an inaccurate process-termination mode`)
    }
    return fault.id
  })
  if (new Set(ids).size !== 89) throw new Error('fault catalog identifiers must be unique')
  return { ...catalog, sha256: sha256(source) }
}

function loadWorkloads(file = WORKLOADS_FILE) {
  const source = fs.readFileSync(file)
  const data = JSON.parse(source.toString('utf8'))
  const expectedIds = ['W0', 'W1', 'W2', 'W3', 'W4']
  if (!isRecord(data) || data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.workloads) ||
    data.workloads.map((entry) => entry.id).join(',') !== expectedIds.join(',')) {
    throw new Error('the versioned W0–W4 workload definitions are incomplete')
  }
  const workloads = data.workloads.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.purpose !== 'string' ||
      !Number.isInteger(entry.steps) || !Number.isInteger(entry.verifiedMutations) ||
      !Number.isInteger(entry.commandSteps) || typeof entry.networkRequired !== 'boolean' ||
      typeof entry.template !== 'string' || !Array.isArray(entry.stepIds) || entry.stepIds.length !== entry.steps ||
      entry.stepIds.some((stepId) => typeof stepId !== 'string' || !stepId) || new Set(entry.stepIds).size !== entry.stepIds.length) {
      throw new Error(`workload ${entry && entry.id} is incomplete`)
    }
    const templatePath = path.resolve(ROOT, entry.template)
    const relativeTemplate = path.relative(ROOT, templatePath)
    if (relativeTemplate === '..' || relativeTemplate.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTemplate) || !fs.statSync(templatePath).isFile()) {
      throw new Error(`workload ${entry.id} template is missing or escapes the repository`)
    }
    const templateSha256 = sha256File(templatePath)
    return { ...entry, templateSha256, sha256: sha256(stableStringify({ definition: entry, templateSha256 })) }
  })
  const w0 = workloads[0]
  if (w0.steps < 8 || w0.steps > 12 || w0.verifiedMutations < 3 || w0.commandSteps < 2 || w0.networkRequired) {
    throw new Error('W0 does not satisfy the frozen recovery micro-workload contract')
  }
  return { ...data, workloads, sha256: sha256(source) }
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 0x6d2b79f5
  return function nextRandom() {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function seededShuffle(values, seed) {
  const output = values.slice()
  const random = seededRandom(seed)
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[output[index], output[other]] = [output[other], output[index]]
  }
  return output
}

function hostProfile() {
  const memoryGb = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)))
  const memoryBucketGb = memoryGb <= 4 ? 4 : memoryGb <= 8 ? 8 : memoryGb <= 16 ? 16 : memoryGb <= 32 ? 32 : 64
  return {
    nodeVersion: process.version,
    osPlatform: process.platform,
    osRelease: os.release(),
    logicalCpuCount: os.cpus().length,
    memoryBucketGb,
    hostProfileId: `${process.platform}-${os.release().split('.')[0]}-${os.cpus().length}cpu-${memoryBucketGb}gb`
  }
}

function createBatch(input = {}) {
  const batchId = safeId(input.batchId, 'batchId')
  const phase = ['DIAGNOSTIC', 'PILOT', 'FINAL'].includes(input.phase) ? input.phase : null
  if (!phase) throw new Error('phase must be DIAGNOSTIC, PILOT, or FINAL')
  const parent = requireDVolume(input.root)
  const batchDir = path.join(parent, batchId)
  fs.mkdirSync(batchDir, { recursive: false })
  fs.mkdirSync(path.join(batchDir, 'runs'), { recursive: false })
  fs.mkdirSync(path.join(batchDir, 'derived'), { recursive: false })
  const catalog = loadFaultCatalog()
  const workloads = loadWorkloads()
  const implementationSha = /^[a-f0-9]{40}$/i.test(String(input.implementationSha || '')) ? String(input.implementationSha).toLowerCase() : null
  const harnessSha = /^[a-f0-9]{40}$/i.test(String(input.harnessSha || '')) ? String(input.harnessSha).toLowerCase() : null
  const sourceRef = typeof input.sourceRef === 'string' && /^[A-Za-z0-9._/-]{1,160}$/.test(input.sourceRef) && !input.sourceRef.includes('..') ? input.sourceRef : null
  const createdAt = new Date().toISOString()
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    batchId,
    phase,
    seed: Number(input.seed) >>> 0,
    createdAt,
    implementationSha,
    harnessSha,
    sourceRef,
    evidenceSchemaSha256: sha256File(SCHEMA_FILE),
    sourceSpecSha256: sha256File(SOURCE_SPEC_FILE),
    faultCatalogVersion: catalog.catalogVersion,
    faultCatalogSha256: catalog.sha256,
    workloadVersion: workloads.workloadVersion,
    workloadDefinitionsSha256: workloads.sha256,
    pilotRunsExcludedFromFinalAggregates: phase === 'PILOT',
    runs: []
  }
  const freezeDocument = {
    schemaVersion: SCHEMA_VERSION,
    batchId,
    phase,
    seed: manifest.seed,
    implementationSha,
    harnessSha,
    sourceRef,
    sourceSpecSha256: manifest.sourceSpecSha256,
    evidenceSchemaSha256: manifest.evidenceSchemaSha256,
    faultCatalogVersion: catalog.catalogVersion,
    faultCatalogSha256: catalog.sha256,
    workloadVersion: workloads.workloadVersion,
    workloadDefinitionsSha256: workloads.sha256,
    pilotRunsExcludedFromFinalAggregates: phase === 'PILOT',
    frozenAt: createdAt
  }
  if (!validateEvidenceDocument('evidenceFreeze', freezeDocument).ok || !validateEvidenceDocument('batchManifest', manifest).ok) {
    throw Object.assign(new Error('new batch metadata does not satisfy evidence schema v1'), { code: 'BATCH_SCHEMA_INVALID' })
  }
  writeJsonAtomic(path.join(batchDir, 'evidence-freeze.json'), freezeDocument)
  writeJsonAtomic(path.join(batchDir, 'batch-manifest.json'), manifest)
  return { batchId, phase, seed: manifest.seed, batchDir, manifest }
}

function createRun(batch, input = {}) {
  if (!batch || typeof batch.batchDir !== 'string' || !batch.manifest) throw new Error('createRun needs a batch created by createBatch')
  const runId = safeId(input.runId, 'runId')
  const episodeId = safeId(input.episodeId, 'episodeId')
  const faultId = Number.isInteger(input.faultId) && input.faultId >= 1 && input.faultId <= 89 ? input.faultId : null
  if (!faultId) throw new Error('faultId must be in the frozen 1–89 catalog')
  const workloadCatalog = loadWorkloads()
  const workload = workloadCatalog.workloads.find((entry) => entry.id === input.workloadId)
  if (!workload) throw new Error('workloadId must name W0–W4')
  const catalog = loadFaultCatalog()
  const fault = catalog.faults[faultId - 1]
  const runDir = path.join(batch.batchDir, 'runs', runId)
  fs.mkdirSync(runDir, { recursive: false })
  const profile = hostProfile()
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    batchId: batch.batchId,
    runId,
    runOrdinal: Number.isInteger(input.runOrdinal) && input.runOrdinal > 0 ? input.runOrdinal : batch.manifest.runs.length + 1,
    seed: Number(input.seed === undefined ? batch.seed : input.seed) >>> 0,
    implementationSha: /^[a-f0-9]{40}$/i.test(String(input.implementationSha || '')) ? String(input.implementationSha).toLowerCase() : null,
    harnessSha: /^[a-f0-9]{40}$/i.test(String(input.harnessSha || batch.manifest.harnessSha || '')) ? String(input.harnessSha || batch.manifest.harnessSha).toLowerCase() : null,
    sourceRef: batch.manifest.sourceRef,
    evidenceSchemaSha256: batch.manifest.evidenceSchemaSha256,
    sourceSpecSha256: batch.manifest.sourceSpecSha256,
    workloadId: workload.id,
    workloadVersion: workloadCatalog.workloadVersion,
    workloadSha256: workload.sha256,
    workloadStepIds: workload.stepIds.slice(),
    faultCatalogVersion: catalog.catalogVersion,
    faultCatalogSha256: catalog.sha256,
    faultFamily: fault.family,
    faultId,
    injectionPoint: fault.injectionPoint,
    expectedOutcome: input.expectedOutcome || fault.expectedOutcome,
    expectedBlockCode: input.expectedBlockCode || null,
    executionMode: fault.executionMode,
    pairId: input.pairId || null,
    episodeId,
    runtime: profile.nodeVersion,
    os: `${profile.osPlatform} ${profile.osRelease}`,
    hostProfileId: input.hostProfileId || profile.hostProfileId,
    logicalCpuCount: profile.logicalCpuCount,
    memoryBucketGb: profile.memoryBucketGb,
    storageVolumeRoles: ['work:D'],
    selectedWorkVolume: 'D:',
    taskScratchVolumes: Array.isArray(input.taskScratchVolumes) ? input.taskScratchVolumes : ['D:'],
    candidateRoot: `candidate/${runId}`,
    recoveryConfigurationSha256: sha256(stableStringify(input.recoveryConfiguration || { attempts: 3, executorCompatibility: 'engineering-v1' })),
    classificationPhase: batch.phase,
    startedAt: new Date().toISOString()
  }
  const manifestCheck = validateRunManifest(manifest)
  if (!manifestCheck.ok) throw Object.assign(new Error('new run manifest does not satisfy evidence schema v1'), { code: manifestCheck.code })
  writeJsonAtomic(path.join(runDir, 'manifest.json'), manifest)
  const startNs = process.hrtime.bigint()
  let eventSeq = 0
  const eventsPath = path.join(runDir, 'events.jsonl')
  fs.writeFileSync(eventsPath, '', 'utf8')
  function appendEvent(event) {
    if (fs.existsSync(path.join(runDir, 'SHA256SUMS.txt'))) return { ok: false, code: 'RUN_SEALED' }
    if (!isRecord(event) || !EVENT_TYPES.has(event.type)) return { ok: false, code: 'EVENT_SCHEMA_INVALID' }
    for (const [key, value] of Object.entries(event)) {
      if (!EVENT_FIELDS.has(key)) return { ok: false, code: 'EVENT_FIELD_UNSUPPORTED', field: key }
      if (key === 'reason' && String(value).length > 256) return { ok: false, code: 'EVENT_VALUE_UNBOUNDED', field: key }
      if (key === 'code' && String(value).length > 100) return { ok: false, code: 'EVENT_VALUE_UNBOUNDED', field: key }
      if (key === 'pathId' && (typeof value !== 'string' || value.length > 100 || path.isAbsolute(value) || path.win32.isAbsolute(value))) {
        return { ok: false, code: 'EVENT_PATH_MUST_BE_ABSTRACT_ID', field: key }
      }
      if (key === 'faultId' && (!Number.isInteger(value) || value < 1 || value > 89)) return { ok: false, code: 'EVENT_FAULT_ID_INVALID' }
    }
    const record = {
      batchId: batch.batchId,
      runId,
      episodeId,
      eventSeq: eventSeq + 1,
      monotonicMs: Number(process.hrtime.bigint() - startNs) / 1e6,
      wallTime: new Date().toISOString()
    }
    for (const [key, value] of Object.entries(event)) record[key] = value
    if (!validateEventRecord(record, manifest)) return { ok: false, code: 'EVENT_SCHEMA_INVALID' }
    eventSeq += 1
    fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, 'utf8')
    return { ok: true, event: record }
  }
  return {
    batchId: batch.batchId,
    batchDir: batch.batchDir,
    runId,
    episodeId,
    runDir,
    eventsPath,
    manifest,
    appendEvent
  }
}

function readEvents(eventsPath, expected = null) {
  const source = fs.readFileSync(eventsPath, 'utf8')
  if (source && !source.endsWith('\n')) throw Object.assign(new Error('events.jsonl ends with an incomplete record'), { code: 'EVENT_STREAM_TRUNCATED' })
  const lines = source.split('\n').filter(Boolean)
  const events = []
  let previousSeq = 0
  let previousMono = -1
  for (const line of lines) {
    const event = JSON.parse(line)
    if (!validateEventRecord(event, expected) || event.eventSeq !== previousSeq + 1 || event.monotonicMs < previousMono) {
      throw Object.assign(new Error('events.jsonl sequence or schema is invalid'), { code: 'EVENT_STREAM_INVALID' })
    }
    previousSeq = event.eventSeq
    previousMono = event.monotonicMs
    events.push(event)
  }
  return events
}

function checkpointCursor(event) {
  if (Number.isInteger(event.cursor)) return event.cursor
  if (isRecord(event.cursor) && Number.isInteger(event.cursor.nextStepIndex)) return event.cursor.nextStepIndex
  return null
}

function oracleResult(applicable, pass, observations = {}, sourceEvents = [], failureReason = null) {
  return { applicable, pass: applicable ? Boolean(pass) : null, observations, sourceEventSeqs: sourceEvents.map((event) => event.eventSeq), failureReason }
}

function deriveOracles(manifest, events) {
  const beforeFault = events.findIndex((event) => event.type === 'fault_injected')
  const faultOffset = beforeFault < 0 ? events.length : beforeFault
  const resumeOffset = events.findIndex((event) => event.type === 'resume_accepted')
  const checkpointEvents = events.filter((event) => event.type === 'checkpoint_observed')
  const preFaultCheckpoints = checkpointEvents.filter((event) => event.eventSeq < (events[faultOffset] && events[faultOffset].eventSeq || Number.MAX_SAFE_INTEGER))
  const postResumeCheckpoints = resumeOffset < 0 ? [] : checkpointEvents.filter((event) => event.eventSeq > events[resumeOffset].eventSeq)
  const priorVerified = new Set(preFaultCheckpoints.length ? preFaultCheckpoints[preFaultCheckpoints.length - 1].verifiedStepIds || [] : [])
  const latestPostResumeCheckpoint = postResumeCheckpoints.length ? postResumeCheckpoints[postResumeCheckpoints.length - 1] : null
  const postVerified = new Set(latestPostResumeCheckpoint ? latestPostResumeCheckpoint.verifiedStepIds || [] : [])
  const lostVerifiedSteps = [...priorVerified].filter((stepId) => !postVerified.has(stepId))

  const priorMutationCheckpoint = preFaultCheckpoints.length ? preFaultCheckpoints[preFaultCheckpoints.length - 1] : null
  const verifiedMutationIds = new Set(priorMutationCheckpoint && Array.isArray(priorMutationCheckpoint.verifiedMutationIds) ? priorMutationCheckpoint.verifiedMutationIds : [])
  const priorMutationEffects = new Map(events.filter((event) => event.type === 'mutation_effect' && event.effect === 'applied' &&
    event.eventSeq < (events[faultOffset] && events[faultOffset].eventSeq || Number.MAX_SAFE_INTEGER) && verifiedMutationIds.has(event.mutationId))
    .map((event) => [event.mutationId, event.effectId]))
  const replayEvents = events.filter((event) => event.type === 'mutation_effect' && event.effect === 'applied' &&
    event.eventSeq > (resumeOffset < 0 ? Number.MAX_SAFE_INTEGER : events[resumeOffset].eventSeq) && verifiedMutationIds.has(event.mutationId))
  const presenceEvents = events.filter((event) => event.type === 'mutation_effect' && event.effect === 'present_after_resume' &&
    event.eventSeq > (resumeOffset < 0 ? Number.MAX_SAFE_INTEGER : events[resumeOffset].eventSeq))
  const postResumePresence = new Map(presenceEvents.map((event) => [event.mutationId, event.effectId]))
  const missingOrChangedMutationEvidence = [...verifiedMutationIds].filter((mutationId) =>
    !postResumePresence.has(mutationId) || postResumePresence.get(mutationId) !== priorMutationEffects.get(mutationId))
  const appliedEffects = events.filter((event) => event.type === 'mutation_effect' && event.effect === 'applied' && typeof event.effectId === 'string')
  const effectCounts = new Map()
  for (const event of appliedEffects) effectCounts.set(event.effectId, (effectCounts.get(event.effectId) || 0) + 1)
  const duplicateEffectCount = [...effectCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)

  let cursorMonotonic = true
  let cursorSemanticsValid = Array.isArray(manifest.workloadStepIds) && manifest.workloadStepIds.length > 0 &&
    new Set(manifest.workloadStepIds).size === manifest.workloadStepIds.length
  let previousSequence = 0
  let previousCursor = 0
  for (const event of checkpointEvents) {
    const cursor = checkpointCursor(event)
    if (!Number.isSafeInteger(event.checkpointSeq) || event.checkpointSeq <= previousSequence || cursor === null || cursor < previousCursor) cursorMonotonic = false
    const cursorRecord = isRecord(event.cursor) ? event.cursor : null
    const verified = Array.isArray(event.verifiedStepIds) ? event.verifiedStepIds : []
    const skipped = cursorRecord && Array.isArray(cursorRecord.skippedStepIds) ? cursorRecord.skippedStepIds : []
    const known = new Set(manifest.workloadStepIds || [])
    const settled = new Set([...verified, ...skipped])
    if (!cursorRecord || !Number.isSafeInteger(cursorRecord.nextStepIndex) || !Array.isArray(cursorRecord.verifiedStepIds) ||
      settled.size !== verified.length + skipped.length || [...settled].some((stepId) => !known.has(stepId)) ||
      JSON.stringify([...cursorRecord.verifiedStepIds].sort()) !== JSON.stringify([...verified].sort())) {
      cursorSemanticsValid = false
    } else {
      let expectedCursor = 0
      while (expectedCursor < manifest.workloadStepIds.length && settled.has(manifest.workloadStepIds[expectedCursor])) expectedCursor += 1
      if (cursorRecord.nextStepIndex !== expectedCursor) cursorSemanticsValid = false
    }
    previousSequence = Number.isSafeInteger(event.checkpointSeq) ? event.checkpointSeq : previousSequence
    previousCursor = cursor === null ? previousCursor : cursor
  }

  const blockedEvents = events.filter((event) => event.type === 'recovery_blocked')
  const expectedBlock = String(manifest.expectedOutcome || '').startsWith('BLOCKED') || String(manifest.expectedOutcome || '').startsWith('CLEANUP_BLOCKED')
  const expectedBlockCode = manifest.expectedBlockCode || null
  const postBlockMutations = blockedEvents.length
    ? events.filter((event) => event.type === 'mutation_effect' && event.effect === 'applied' && event.eventSeq > blockedEvents[0].eventSeq).length
    : 0
  const failClosedCorrect = expectedBlock && blockedEvents.length > 0 &&
    (!expectedBlockCode || blockedEvents[0].code === expectedBlockCode) && postBlockMutations === 0

  const claimEvents = events.filter((event) => event.type === 'recovery_claim_acquired' || event.type === 'owner_snapshot')
  const maxLiveOwners = claimEvents.reduce((maximum, event) => Math.max(maximum, Number(event.liveOwnerCount) || (Array.isArray(event.owners) ? event.owners.length : 0)), 0)
  const singleOwner = claimEvents.length > 0 && maxLiveOwners <= 1

  const registrations = events.filter((event) => event.type === 'cross_volume_temp_registered')
  const registeredPaths = new Set(registrations.map((event) => event.pathId))
  const deletedEvents = events.filter((event) => event.type === 'cleanup_entry_deleted')
  const unsafeDeletes = deletedEvents.filter((event) => !registeredPaths.has(event.pathId))
  const sentinelEvents = events.filter((event) => event.type === 'sentinel_observed')
  const sentinelBefore = new Map(sentinelEvents.filter((event) => event.phase === 'before').map((event) => [event.pathId, event.sha256]))
  const sentinelAfter = new Map(sentinelEvents.filter((event) => event.phase === 'after').map((event) => [event.pathId, event.sha256]))
  const changedSentinels = [...sentinelBefore].filter(([pathId, hash]) => sentinelAfter.get(pathId) !== hash).map(([pathId]) => pathId)
  const crossVolumeApplicable = registrations.length > 0 || manifest.workloadId === 'W2' || (manifest.faultId >= 79 && manifest.faultId <= 89)
  const cleanupVerified = events.find((event) => event.type === 'cleanup_verified') || null
  const terminalEvent = events.find((event) => event.type === 'episode_completed' || event.type === 'recovery_blocked') || null

  const rebootApplicable = manifest.workloadId === 'W4' || (manifest.faultId >= 73 && manifest.faultId <= 78)
  const session = events.find((event) => event.type === 'windows_session_restored') || null
  const rebootProof = Boolean(session && session.sameAccount === true && session.manualCredentialPromptObserved === false &&
    events.some((event) => event.type === 'app_relaunched') && events.some((event) => event.type === 'resume_accepted') &&
    events.some((event) => event.type === 'first_post_resume_checkpoint'))

  const hasResume = resumeOffset >= 0
  const hasCheckpointBefore = preFaultCheckpoints.length > 0
  const hasPostCheckpoint = postResumeCheckpoints.length > 0
  const oracles = {
    O1_progress_preservation: oracleResult(hasResume && hasCheckpointBefore && hasPostCheckpoint, lostVerifiedSteps.length === 0, { lostVerifiedSteps, preservedCount: priorVerified.size - lostVerifiedSteps.length }, [...preFaultCheckpoints.slice(-1), latestPostResumeCheckpoint].filter(Boolean)),
    O2_no_verified_replay: oracleResult(hasResume && priorMutationCheckpoint !== null && verifiedMutationIds.size > 0,
      replayEvents.length === 0 && missingOrChangedMutationEvidence.length === 0,
      { verifiedMutationReplayCount: replayEvents.length, replayedMutationIds: replayEvents.map((event) => event.mutationId), missingOrChangedMutationEvidence },
      [priorMutationCheckpoint, ...replayEvents, ...presenceEvents].filter(Boolean)),
    O3_no_duplicate_effect: oracleResult(appliedEffects.length > 0, duplicateEffectCount === 0, { duplicateEffectCount }, appliedEffects),
    O4_cursor_monotonic: oracleResult(checkpointEvents.length > 0, cursorMonotonic && cursorSemanticsValid,
      { checkpointSequences: checkpointEvents.map((event) => event.checkpointSeq), cursors: checkpointEvents.map(checkpointCursor), cursorSemanticsValid }, checkpointEvents),
    O5_fail_closed_correct: oracleResult(expectedBlock, failClosedCorrect, { expectedBlockCode, actualBlockCode: blockedEvents[0] && blockedEvents[0].code || null, postBlockMutations }, [...blockedEvents, ...events.filter((event) => event.type === 'mutation_effect')]),
    O6_single_execution_owner: oracleResult(claimEvents.length > 0, singleOwner, { maxLiveOwners, claimObservations: claimEvents.length }, claimEvents),
    O7_cleanup_safety: oracleResult(crossVolumeApplicable && (registrations.length > 0 || blockedEvents.length > 0), unsafeDeletes.length === 0 && changedSentinels.length === 0,
      { unsafeDeletePathIds: unsafeDeletes.map((event) => event.pathId), changedSentinelPathIds: changedSentinels, registeredPathIds: [...registeredPaths] }, [...registrations, ...deletedEvents, ...sentinelEvents]),
    O8_cleanup_completeness: oracleResult(crossVolumeApplicable && terminalEvent && terminalEvent.type === 'episode_completed', Boolean(cleanupVerified && cleanupVerified.residualCount === 0),
      { residualCount: cleanupVerified ? cleanupVerified.residualCount : null, registeredPathCount: registrations.length }, [cleanupVerified, terminalEvent].filter(Boolean)),
    O9_reboot_autonomy: oracleResult(rebootApplicable, rebootProof, {
      sameWindowsAccount: session ? session.sameAccount : null,
      manualCredentialPromptObserved: session ? session.manualCredentialPromptObserved : null,
      newerCheckpointObserved: events.some((event) => event.type === 'first_post_resume_checkpoint')
    }, [session, ...events.filter((event) => ['app_relaunched', 'resume_accepted', 'first_post_resume_checkpoint'].includes(event.type))].filter(Boolean))
  }
  return { oracle: oracles, lostVerifiedSteps: lostVerifiedSteps.length, verifiedMutationReplayCount: replayEvents.length, duplicateEffectCount }
}

function makeResult(manifest, events, derived, options = {}) {
  const resume = events.find((event) => event.type === 'resume_accepted') || null
  const blocked = events.find((event) => event.type === 'recovery_blocked') || null
  const candidate = events.find((event) => event.type === 'recovery_candidate_detected') || null
  const firstCheckpoint = events.find((event) => event.type === 'first_post_resume_checkpoint') || null
  const cleanupStart = events.find((event) => event.type === 'cleanup_started') || null
  const cleanupEnd = events.find((event) => event.type === 'cleanup_verified') || null
  const applicable = Object.values(derived.oracle).filter((item) => item.applicable)
  const safetyPass = applicable.every((item) => item.pass === true)
  const expectedBlocked = String(manifest.expectedOutcome || '').startsWith('BLOCKED') || String(manifest.expectedOutcome || '').startsWith('CLEANUP_BLOCKED')
  const resumeSucceeded = Boolean(resume)
  let classification
  if (expectedBlocked && blocked && derived.oracle.O5_fail_closed_correct.pass === true && safetyPass) classification = 'EXPECTED_BLOCK'
  else if (resumeSucceeded && safetyPass && derived.oracle.O1_progress_preservation.pass && derived.oracle.O2_no_verified_replay.pass && derived.oracle.O3_no_duplicate_effect.pass) classification = 'PASS'
  else if (options.invalidReason) classification = 'INVALID'
  else classification = 'FAIL'
  const allCheckpoints = events.filter((event) => event.type === 'checkpoint_observed')
  const first = allCheckpoints[0] || {}
  const last = allCheckpoints[allCheckpoints.length - 1] || {}
  return {
    schemaVersion: SCHEMA_VERSION,
    batchId: manifest.batchId,
    runId: manifest.runId,
    runOrdinal: manifest.runOrdinal,
    faultId: manifest.faultId,
    workloadId: manifest.workloadId,
    seed: manifest.seed,
    classification,
    invalidReason: options.invalidReason || null,
    expectedOutcome: manifest.expectedOutcome,
    actualOutcome: blocked ? blocked.code || 'RECOVERY_BLOCKED' : resume ? 'RESUME_ACCEPTED' : 'NO_PROOF_EVENT',
    eligibleResume: !expectedBlocked,
    resumeSucceeded,
    resumeProofReached: Boolean(resume && firstCheckpoint && last.checkpointSeq >= firstCheckpoint.checkpointSeq),
    blockedReason: blocked ? blocked.code || blocked.reason || null : null,
    checkpointSeqBeforeFault: first.checkpointSeq || null,
    cursorBeforeFault: checkpointCursor(first),
    checkpointSeqAfterRecovery: last.checkpointSeq || null,
    cursorAfterRecovery: checkpointCursor(last),
    lostVerifiedSteps: derived.lostVerifiedSteps,
    verifiedMutationReplayCount: derived.verifiedMutationReplayCount,
    duplicateEffectCount: derived.duplicateEffectCount,
    stepsReexecuted: events.filter((event) => event.type === 'step_observed' && event.phase === 'after_resume').length,
    verifiedStepsPreserved: derived.oracle.O1_progress_preservation.observations.preservedCount || 0,
    faultToCandidateMs: candidate && events.find((event) => event.type === 'fault_injected') ? candidate.monotonicMs - events.find((event) => event.type === 'fault_injected').monotonicMs : null,
    faultToResumeAcceptedMs: resume && events.find((event) => event.type === 'fault_injected') ? resume.monotonicMs - events.find((event) => event.type === 'fault_injected').monotonicMs : null,
    faultToFirstNewCheckpointMs: firstCheckpoint && events.find((event) => event.type === 'fault_injected') ? firstCheckpoint.monotonicMs - events.find((event) => event.type === 'fault_injected').monotonicMs : null,
    cleanupDurationMs: cleanupStart && cleanupEnd ? cleanupEnd.monotonicMs - cleanupStart.monotonicMs : null,
    offWorkVolumeTempCreatedCount: events.filter((event) => event.type === 'cross_volume_temp_registered').length,
    offWorkVolumeTempDeletedCount: events.filter((event) => event.type === 'cleanup_entry_deleted').length,
    offWorkVolumeResidualCount: cleanupEnd ? cleanupEnd.residualCount : null,
    fallbackToOlderCheckpoint: events.some((event) => event.type === 'recovery_candidate_detected' && event.fallbackToOlderCheckpoint === true),
    claimConflictCount: events.filter((event) => event.code === 'CLAIM_ALREADY_OWNED').length,
    sameWindowsAccount: derived.oracle.O9_reboot_autonomy.applicable ? derived.oracle.O9_reboot_autonomy.observations.sameWindowsAccount : null,
    manualCredentialPromptObserved: derived.oracle.O9_reboot_autonomy.applicable ? derived.oracle.O9_reboot_autonomy.observations.manualCredentialPromptObserved : null,
    testStopReason: options.testStopReason || null,
    totalCompletionMs: options.totalCompletionMs === undefined ? null : options.totalCompletionMs,
    oracle: Object.fromEntries(Object.entries(derived.oracle).map(([key, value]) => [key, value.applicable ? value.pass : null]))
  }
}

function eventLines(eventsPath) {
  return readEvents(eventsPath).map((event) => JSON.stringify(event)).join('\n') + (fs.statSync(eventsPath).size ? '\n' : '')
}

function finalizeRun(run, options = {}) {
  const manifestPath = path.join(run.runDir, 'manifest.json')
  const manifest = readJson(manifestPath)
  const manifestCheck = validateRunManifest(manifest)
  if (!manifestCheck.ok) throw Object.assign(new Error('run manifest did not meet evidence schema v1'), { code: manifestCheck.code })
  const events = readEvents(run.eventsPath, manifest)
  const derived = deriveOracles(manifest, events)
  const result = makeResult(manifest, events, derived, options)
  if (!validateResultDocument(result, manifest)) {
    const schemaCheck = validateEvidenceDocument('result', result)
    throw Object.assign(new Error(`derived result did not meet evidence schema v1${schemaCheck.errors.length ? `: ${schemaCheck.errors.join('; ')}` : ''}`), { code: 'RESULT_SCHEMA_INVALID' })
  }
  writeJsonAtomic(path.join(run.runDir, 'result.json'), result)
  const oracleDocument = {
    schemaVersion: SCHEMA_VERSION,
    batchId: run.batchId,
    runId: run.runId,
    oracle: derived.oracle
  }
  if (!validateOracleDocument(oracleDocument, manifest)) throw Object.assign(new Error('independent oracle did not meet evidence schema v1'), { code: 'ORACLE_SCHEMA_INVALID' })
  writeJsonAtomic(path.join(run.runDir, 'oracle.json'), oracleDocument)
  const lines = []
  for (const file of RAW_RUN_FILES) lines.push(`${sha256File(path.join(run.runDir, file))}  ${file}`)
  fs.writeFileSync(path.join(run.runDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')

  const batchManifestPath = path.join(run.batchDir, 'batch-manifest.json')
  const batchManifest = readJson(batchManifestPath)
  if (batchManifest.runs.some((entry) => entry.runId === run.runId)) throw new Error('batch manifest already contains this run id')
  batchManifest.runs.push({
    runId: run.runId,
    runOrdinal: manifest.runOrdinal,
    classification: result.classification,
    faultId: manifest.faultId,
    workloadId: manifest.workloadId,
    sha256sumsSha256: sha256File(path.join(run.runDir, 'SHA256SUMS.txt'))
  })
  writeJsonAtomic(batchManifestPath, batchManifest)
  return result
}

function verifyRunIntegrity(runDir) {
  try {
    const sumsPath = path.join(runDir, 'SHA256SUMS.txt')
    if (!fs.existsSync(sumsPath)) return { ok: false, code: 'RUN_NOT_SEALED', reason: 'run checksum manifest is missing' }
    const rows = fs.readFileSync(sumsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    const expectedFiles = new Set(RAW_RUN_FILES)
    const checks = new Map()
    for (const row of rows) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(row)
      if (!match || !expectedFiles.has(match[2]) || checks.has(match[2])) return { ok: false, code: 'INVALID_EVIDENCE_INTEGRITY', reason: 'checksum manifest has an invalid or duplicate artifact path' }
      checks.set(match[2], match[1])
    }
    if (checks.size !== expectedFiles.size) return { ok: false, code: 'INVALID_EVIDENCE_INTEGRITY', reason: 'checksum manifest does not cover every raw artifact' }
    for (const file of expectedFiles) {
      const target = path.join(runDir, file)
      if (!fs.existsSync(target) || sha256File(target) !== checks.get(file)) return { ok: false, code: 'INVALID_EVIDENCE_INTEGRITY', reason: `raw artifact checksum mismatch: ${file}` }
    }
    const manifest = readJson(path.join(runDir, 'manifest.json'))
    const result = readJson(path.join(runDir, 'result.json'))
    const oracle = readJson(path.join(runDir, 'oracle.json'))
    if (!validateRunManifest(manifest).ok || !validateResultDocument(result, manifest) || !validateOracleDocument(oracle, manifest)) {
      return { ok: false, code: 'INVALID_EVIDENCE_SCHEMA', reason: 'a checksummed raw artifact violates evidence schema v1' }
    }
    readEvents(path.join(runDir, 'events.jsonl'), manifest)
    return { ok: true, files: [...expectedFiles] }
  } catch (error) {
    return { ok: false, code: 'INVALID_EVIDENCE_INTEGRITY', reason: String(error && error.message ? error.message : error) }
  }
}

function batchRawIntegrity(batchDir, manifest) {
  try {
    const freeze = readJson(path.join(batchDir, 'evidence-freeze.json'))
    if (!isRecord(manifest) || !validateEvidenceDocument('batchManifest', manifest).ok || manifest.schemaVersion !== SCHEMA_VERSION || !safeId(manifest.batchId, 'batchId') ||
      !['DIAGNOSTIC', 'PILOT', 'FINAL'].includes(manifest.phase) || !Number.isInteger(manifest.seed) || !Array.isArray(manifest.runs) ||
      !isRecord(freeze) || freeze.batchId !== manifest.batchId || freeze.phase !== manifest.phase || freeze.seed !== manifest.seed ||
      freeze.implementationSha !== manifest.implementationSha || freeze.harnessSha !== manifest.harnessSha ||
      freeze.evidenceSchemaSha256 !== manifest.evidenceSchemaSha256 || freeze.faultCatalogSha256 !== manifest.faultCatalogSha256 ||
      freeze.workloadDefinitionsSha256 !== manifest.workloadDefinitionsSha256 || !validDigest(manifest.evidenceSchemaSha256) ||
      !validDigest(manifest.sourceSpecSha256) || !validDigest(manifest.faultCatalogSha256) || !validDigest(manifest.workloadDefinitionsSha256)) {
      return { ok: false, code: 'BATCH_SCHEMA_INVALID', reason: 'batch manifest or evidence freeze is invalid' }
    }
    const ids = manifest.runs.map((entry) => entry && safeId(entry.runId, 'runId'))
    if (new Set(ids).size !== ids.length || ids.some((id) => !id)) return { ok: false, code: 'BATCH_RUN_INDEX_INVALID', reason: 'batch run IDs are missing or duplicated' }
    return { ok: true, runIds: ids }
  } catch (error) {
    return { ok: false, code: 'BATCH_SCHEMA_INVALID', reason: String(error && error.message ? error.message : error) }
  }
}

function writeBatchChecksums(batchDir, manifest) {
  const files = ['evidence-freeze.json', 'batch-manifest.json']
  for (const item of manifest.runs) files.push(`runs/${safeId(item.runId, 'runId')}/SHA256SUMS.txt`)
  for (const name of fs.readdirSync(path.join(batchDir, 'derived')).sort()) {
    const target = path.join(batchDir, 'derived', name)
    if (fs.statSync(target).isFile()) files.push(`derived/${name}`)
  }
  const lines = files.sort().map((relative) => `${sha256File(path.join(batchDir, relative))}  ${relative}`)
  fs.writeFileSync(path.join(batchDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
}

function verifyBatchIntegrity(batchOrDir) {
  try {
    const batchDir = requireDVolume(typeof batchOrDir === 'string' ? batchOrDir : batchOrDir.batchDir, 'batch directory')
    const manifest = readJson(path.join(batchDir, 'batch-manifest.json'))
    const raw = batchRawIntegrity(batchDir, manifest)
    if (!raw.ok) return raw
    const sumsPath = path.join(batchDir, 'SHA256SUMS.txt')
    if (!fs.existsSync(sumsPath)) return { ok: false, code: 'BATCH_CHECKSUMS_MISSING', reason: 'batch checksum manifest is missing' }
    const expected = new Set(['evidence-freeze.json', 'batch-manifest.json'])
    for (const runId of raw.runIds) expected.add(`runs/${runId}/SHA256SUMS.txt`)
    for (const name of fs.readdirSync(path.join(batchDir, 'derived'))) {
      if (fs.statSync(path.join(batchDir, 'derived', name)).isFile()) expected.add(`derived/${name}`)
    }
    const checks = new Map()
    for (const row of fs.readFileSync(sumsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
      const match = /^([a-f0-9]{64})  ((?:derived|runs)\/[A-Za-z0-9._/-]+|evidence-freeze\.json|batch-manifest\.json)$/.exec(row)
      if (!match || !expected.has(match[2]) || checks.has(match[2])) return { ok: false, code: 'BATCH_CHECKSUM_INVALID', reason: 'batch checksum manifest has an invalid or duplicate path' }
      checks.set(match[2], match[1])
    }
    if (checks.size !== expected.size) return { ok: false, code: 'BATCH_CHECKSUM_INVALID', reason: 'batch checksum manifest does not cover every artifact' }
    for (const relative of expected) {
      const target = path.resolve(batchDir, relative)
      if (!insideBatch(batchDir, target) || !fs.existsSync(target) || !fs.statSync(target).isFile() || sha256File(target) !== checks.get(relative)) {
        return { ok: false, code: 'BATCH_CHECKSUM_MISMATCH', reason: `batch artifact checksum mismatch: ${relative}` }
      }
    }
    const runs = raw.runIds.map((runId) => verifyRunIntegrity(path.join(batchDir, 'runs', runId)))
    if (runs.some((result) => !result.ok)) return { ok: false, code: 'RAW_RUN_INVALID', reason: 'one or more raw run artifacts failed integrity validation' }
    return { ok: true, batchId: manifest.batchId, artifacts: [...expected] }
  } catch (error) {
    return { ok: false, code: 'BATCH_CHECKSUM_INVALID', reason: String(error && error.message ? error.message : error) }
  }
}

function insideBatch(root, target) {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function csvCell(value) {
  const source = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(source) ? `"${source.replace(/"/g, '""')}"` : source
}

function writeCsv(file, headers, records) {
  const lines = [headers.map(csvCell).join(',')]
  for (const record of records) lines.push(headers.map((header) => csvCell(record[header])).join(','))
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function deriveBatch(batchOrDir) {
  const batchDir = requireDVolume(typeof batchOrDir === 'string' ? batchOrDir : batchOrDir.batchDir, 'batch directory')
  const manifest = readJson(path.join(batchDir, 'batch-manifest.json'))
  const batchCheck = batchRawIntegrity(batchDir, manifest)
  if (!batchCheck.ok) return { ...batchCheck, analysis: null, invalidRuns: 1, runs: [] }
  const runs = []
  let invalidRuns = 0
  for (const item of manifest.runs) {
    const runDir = path.join(batchDir, 'runs', safeId(item.runId, 'runId'))
    const integrity = verifyRunIntegrity(runDir)
    if (!integrity.ok) {
      invalidRuns += 1
      runs.push({ runId: item.runId, faultId: item.faultId, workloadId: item.workloadId, classification: 'INVALID', invalidReason: integrity.reason })
      continue
    }
    const result = readJson(path.join(runDir, 'result.json'))
    const oracle = readJson(path.join(runDir, 'oracle.json'))
    if (result.runId !== item.runId || result.classification !== item.classification || result.faultId !== item.faultId || result.workloadId !== item.workloadId) {
      invalidRuns += 1
      runs.push({ runId: item.runId, faultId: item.faultId, workloadId: item.workloadId, classification: 'INVALID', invalidReason: 'batch index does not match its checksummed run result' })
      continue
    }
    runs.push({ ...result, oracle: oracle.oracle })
  }
  const counts = { PASS: 0, EXPECTED_BLOCK: 0, FAIL: 0, INVALID: 0 }
  for (const run of runs) counts[counts[run.classification] === undefined ? 'INVALID' : run.classification] += 1
  const catalog = loadFaultCatalog()
  const runByFault = new Map()
  for (const run of runs) {
    const list = runByFault.get(run.faultId) || []
    list.push(run)
    runByFault.set(run.faultId, list)
  }
  const coverage = catalog.faults.map((fault) => {
    const found = runByFault.get(fault.id) || []
    const status = found.length
      ? (found.some((run) => run.classification === 'PASS' || run.classification === 'EXPECTED_BLOCK') ? 'OBSERVED' : 'ATTEMPTED_NOT_ACCEPTED')
      : (fault.executionMode === 'maintenance-window' ? 'NOT_RUN_MAINTENANCE_WINDOW' : 'NOT_RUN')
    return { faultId: fault.id, family: fault.family, expectedOutcome: fault.expectedOutcome, executionMode: fault.executionMode, observations: found.length, status }
  })
  const derivedDir = path.join(batchDir, 'derived')
  fs.mkdirSync(derivedDir, { recursive: true })
  writeCsv(path.join(derivedDir, 'runs.csv'), ['runId', 'faultId', 'workloadId', 'classification', 'expectedOutcome', 'actualOutcome', 'lostVerifiedSteps', 'verifiedMutationReplayCount', 'duplicateEffectCount', 'faultToResumeAcceptedMs', 'faultToFirstNewCheckpointMs', 'offWorkVolumeResidualCount'], runs)
  writeCsv(path.join(derivedDir, 'fault-coverage.csv'), ['faultId', 'family', 'expectedOutcome', 'executionMode', 'observations', 'status'], coverage)
  writeCsv(path.join(derivedDir, 'rq1-correctness.csv'), ['runId', 'faultId', 'classification', 'lostVerifiedSteps', 'verifiedMutationReplayCount', 'duplicateEffectCount', 'O4_cursor_monotonic', 'O5_fail_closed_correct', 'O6_single_execution_owner'], runs)
  writeCsv(path.join(derivedDir, 'rq2-efficiency.csv'), ['runId', 'faultId', 'faultToCandidateMs', 'faultToResumeAcceptedMs', 'faultToFirstNewCheckpointMs', 'stepsReexecuted', 'verifiedStepsPreserved'], runs)
  writeCsv(path.join(derivedDir, 'rq3-robustness.csv'), ['runId', 'faultId', 'workloadId', 'classification', 'O7_cleanup_safety', 'O8_cleanup_completeness', 'O9_reboot_autonomy'], runs)
  writeCsv(path.join(derivedDir, 'reboot.csv'), ['runId', 'faultId', 'classification', 'sameWindowsAccount', 'manualCredentialPromptObserved', 'O9_reboot_autonomy'], runs.filter((run) => run.faultId >= 73 && run.faultId <= 78))
  writeCsv(path.join(derivedDir, 'cleanup.csv'), ['runId', 'faultId', 'classification', 'offWorkVolumeTempCreatedCount', 'offWorkVolumeTempDeletedCount', 'offWorkVolumeResidualCount', 'O7_cleanup_safety', 'O8_cleanup_completeness'], runs.filter((run) => run.faultId >= 79 && run.faultId <= 89))
  const analysis = {
    schemaVersion: SCHEMA_VERSION,
    batchId: manifest.batchId,
    phase: manifest.phase,
    seed: manifest.seed,
    runCount: runs.length,
    invalidRuns,
    counts,
    faultCatalogSha256: catalog.sha256,
    faultCoverage: { total: coverage.length, observed: coverage.filter((entry) => entry.status === 'OBSERVED').length, notRun: coverage.filter((entry) => entry.status.startsWith('NOT_RUN')).length },
    rawRunIds: runs.map((run) => run.runId),
    acceptanceStatus: manifest.phase === 'FINAL' && invalidRuns === 0 && counts.FAIL === 0 ? 'REQUIRES_A1_A8_REVIEW' : 'NOT_READY'
  }
  writeJsonAtomic(path.join(derivedDir, 'analysis.json'), analysis)
  const report = [
    `# Recovery evidence analysis — ${manifest.batchId}`,
    '',
    `Phase: ${manifest.phase}; seed: ${manifest.seed}; runs: ${runs.length}.`,
    `Classifications: PASS ${counts.PASS}, EXPECTED_BLOCK ${counts.EXPECTED_BLOCK}, FAIL ${counts.FAIL}, INVALID ${counts.INVALID}.`,
    `Fault coverage: ${analysis.faultCoverage.observed}/${coverage.length} observed; ${analysis.faultCoverage.notRun} not run.`,
    `Status: ${analysis.acceptanceStatus}.`,
    '',
    'All tables are derived from checksummed raw runs. Missing observations remain NOT_RUN; maintenance-window cases are not inferred from adapter simulations.'
  ].join('\n')
  fs.writeFileSync(path.join(derivedDir, 'analysis.md'), `${report}\n`, 'utf8')
  writeBatchChecksums(batchDir, manifest)
  const integrity = verifyBatchIntegrity(batchDir)
  return { ok: invalidRuns === 0 && integrity.ok, analysis, invalidRuns, runs, integrity }
}

module.exports = {
  SCHEMA_VERSION,
  validateEvidenceDocument,
  RAW_RUN_FILES,
  createBatch,
  createRun,
  appendEvent(run, event) { return run.appendEvent(event) },
  finalizeRun,
  deriveOracles,
  deriveBatch,
  verifyRunIntegrity,
  verifyBatchIntegrity,
  loadFaultCatalog,
  loadWorkloads,
  seededRandom,
  seededShuffle,
  sha256,
  sha256File,
  stableStringify,
  hostProfile,
  readEvents,
  requireDVolume
}
