'use strict'

/**
 * DS-Hns Core: the unified install pipeline.
 *
 * One path from "a user named a repository" to "a plugin in the manager". Before this, the store
 * staged things, compatibility mode adopted some of them, and the adapter framework adapted what
 * was already on disk — three halves of one story with no single place that could answer *what is
 * about to be installed, and what will it be allowed to do*.
 *
 * ```
 *   source ──► materialise ──► inspect ──► plan ──► adapt ──► manager.install
 *                  │              │          │         │            │
 *              fetch it,      detect the   the five   the only    Installed /
 *              do not run it   type, read  things a   way to get  Enabled /
 *                              deps+perms  person     a plugin    Loaded /
 *                                          decides    object      Healthy
 * ```
 *
 * ## The rule this module exists to enforce
 *
 * > Nothing executes because it was downloaded. It executes because an **adapter** turned it into
 * > a plugin, and the adapter is the only thing that can.
 *
 * A plugin object is produced by `framework.adapt()` or it does not exist, so "an unknown format
 * must not be executed directly" is not a check this module remembers to perform — there is no
 * other way to reach `manager.install()`. What the pipeline adds is what to do instead: a verdict
 * of `refuse` with the detector's own evidence, or `manual` when the artifact is recognisably a
 * plugin whose host half this build cannot serve (a Cordis bundle with no entry, say), which is a
 * request for a person rather than a failure.
 *
 * ## Update, pin, rollback, uninstall, quarantine
 *
 * Each is a small state machine over the record store, and each is *checked before it acts*: a pin
 * is a refusal an update must honour, and a quarantine is a refusal the install must honour. A
 * plugin whose install or load fails is quarantined rather than retried — failure isolation means
 * the failing plugin stops being mounted, and the rest of the world keeps building.
 */

const path = require('node:path')

const { createInstallRecords, RECORD_STATES } = require('./records.cjs')
const { buildPlan, summarize, RISK_LEVELS } = require('./plan.cjs')
const { ADAPTER_FAULT_CODES, ADAPTER_PHASES } = require('../plugin-adapters/contract.cjs')
const { createCordisBridge } = require('../plugin-adapters/bridge/host.cjs')

/** The verdicts a plan can carry. */
const VERDICTS = Object.freeze({
  /** An adapter takes it; installing is a normal install. */
  INSTALL: 'install',
  /** Nothing recognises it, or the recogniser refused. Nothing will run. */
  REFUSE: 'refuse',
  /** Recognisably a plugin, but not one this build can run without somebody deciding something. */
  MANUAL: 'manual'
})

/** The pipeline's own fault codes. */
const INSTALL_FAULT_CODES = Object.freeze({
  NO_SUCH_SOURCE: 'INSTALL_NO_SUCH_SOURCE',
  MATERIALISE_FAILED: 'INSTALL_MATERIALISE_FAILED',
  UNDETECTED: 'INSTALL_UNDETECTED',
  NO_ADAPTER: 'INSTALL_NO_ADAPTER',
  ADAPTER_REFUSED: 'INSTALL_ADAPTER_REFUSED',
  MANUAL_REQUIRED: 'INSTALL_MANUAL_REQUIRED',
  NOT_CONFIRMED: 'INSTALL_NOT_CONFIRMED',
  UNKNOWN_FORMAT_BLOCKED: 'INSTALL_UNKNOWN_FORMAT_BLOCKED',
  ALREADY_INSTALLED: 'INSTALL_ALREADY_INSTALLED',
  RECORD_PINNED: 'INSTALL_RECORD_PINNED',
  RECORD_QUARANTINED: 'INSTALL_RECORD_QUARANTINED',
  NO_ROLLBACK: 'INSTALL_NO_ROLLBACK',
  VERSION_NOT_FOUND: 'INSTALL_VERSION_NOT_FOUND'
})

function fault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

/** Normalise the three shapes a source can arrive in. */
function normalizeSource(source) {
  if (!source) return null
  if (typeof source === 'string') {
    const text = source.trim()
    if (!text) return null
    // `owner/repo`, `owner/repo#path`, or a URL — anything else is a local path.
    const github = /^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#(.+))?$/.exec(text)
    if (github && !path.isAbsolute(text) && text.includes('/')) {
      return { kind: 'github', repo: github[1], path: github[2] ? github[2].replace(/^\/+/, '') : null, spec: text }
    }
    return { kind: 'local', dir: path.resolve(text), spec: text }
  }
  if (typeof source === 'object') {
    if (source.kind === 'local' || source.dir) return { kind: 'local', dir: path.resolve(String(source.dir || source.path)), spec: String(source.dir || source.path) }
    if (source.repo) return { kind: 'github', repo: String(source.repo), path: source.path ? String(source.path) : null, branch: source.branch ? String(source.branch) : null, spec: source.spec || String(source.repo) }
  }
  return null
}

/**
 * @param {object} input
 * @param {object} input.framework the adapter framework
 * @param {object} input.manager the plugin manager
 * @param {string} input.recordsFile where install records live
 * @param {Function} [input.materialise] `(source, targetDir) => { ok, dir }` — how a remote source is fetched
 * @param {string} [input.storeDir] where fetched plugins land
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 */
function createInstallPipeline(input = {}) {
  const framework = input.framework
  const manager = input.manager
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}
  const storeDir = input.storeDir ? path.resolve(String(input.storeDir)) : null
  const records = input.records || createInstallRecords({ file: input.recordsFile || path.join(storeDir || '.', 'records.json'), now, log })

  /** id → the source it came from, so update has somewhere to look. */
  const sources = new Map()

  /**
   * Fetch a remote source, or accept a local directory.
   *
   * The materialiser is injectable because fetching is the one step that talks to the network, and
   * a pipeline whose only testable path requires GitHub is a pipeline that is only tested against
   * GitHub. It never runs what it fetched: materialising produces a directory.
   */
  async function materialise(source) {
    if (source.kind === 'local') {
      const fs = require('node:fs')
      try {
        if (!fs.statSync(source.dir).isDirectory()) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `${source.dir} is not a directory`)
      } catch {
        return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `${source.dir} does not exist`)
      }
      return { ok: true, dir: source.dir, fetched: false }
    }
    if (typeof input.materialise !== 'function') {
      return fault(INSTALL_FAULT_CODES.MATERIALISE_FAILED, 'this pipeline has no way to fetch a remote source')
    }
    try {
      const outcome = await input.materialise(source, storeDir)
      if (!outcome || outcome.ok !== true) {
        return fault(INSTALL_FAULT_CODES.MATERIALISE_FAILED, (outcome && outcome.reason) || `fetching ${source.spec} failed`)
      }
      return { ok: true, dir: path.resolve(String(outcome.dir)), fetched: true }
    } catch (error) {
      return fault(INSTALL_FAULT_CODES.MATERIALISE_FAILED, `fetching ${source.spec} threw: ${error && error.message ? error.message : error}`)
    }
  }

  /** Whatever structure report the adapter produced, for the plan's display. */
  function structureOf(adapted) {
    const info = adapted.plugin && typeof adapted.plugin.runtimeInfo === 'function' ? adapted.plugin.runtimeInfo() : null
    const detail = info && info.detail ? info.detail : null
    return detail && detail.structure ? detail.structure : null
  }

  /** The facts the plan's risk and degradation are computed from. */
  function statsOf(adapted, structure) {
    return {
      hasClientHalf: Boolean(structure && structure.client && structure.client.declared),
      missingPeers: structure && structure.peers ? structure.peers.missing.length : 0
    }
  }

  /**
   * Inspect a source and produce the plan — **without installing anything and without running any
   * of it**.
   *
   * This is the function a confirmation dialog calls. It materialises the source (a download is
   * not execution), runs detection and adaptation to learn what the plugin *would* be, and stops
   * there. The adapted plugin object is held in the plan so `install()` cannot re-derive a
   * different answer.
   */
  async function plan(source) {
    const normalized = normalizeSource(source)
    if (!normalized) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, 'a GitHub repository or a directory is required')

    const fetched = await materialise(normalized)
    if (fetched.ok !== true) return fetched

    const adapted = await framework.adapt({ dir: fetched.dir, source: normalized.spec, repo: normalized.repo || null, branch: normalized.branch || null })

    if (adapted.ok !== true) {
      // Two different refusals, and the difference matters to a person: "nothing recognises this"
      // is a bug report about the format, while "the recogniser declined it" carries a reason that
      // is usually actionable.
      const undetected = adapted.code === ADAPTER_FAULT_CODES.UNDETECTED || adapted.code === ADAPTER_FAULT_CODES.BAD_ARTIFACT
      const manual = adapted.code === ADAPTER_FAULT_CODES.REFUSED && Array.isArray(adapted.attempts) && adapted.attempts.length > 0
      const planDocument = buildPlan({
        manifest: { id: null, name: path.basename(fetched.dir), version: '0.0.0', provides: [], permissions: { declared: [], granted: [], refused: [], unknown: [] }, runtime: null },
        source: normalized.spec,
        provenance: { kind: normalized.kind, repo: normalized.repo || null, path: normalized.path || null, branch: normalized.branch || null, dir: fetched.dir },
        adapter: adapted.adapter || null,
        detectedType: adapted.detection ? adapted.detection.type : null,
        confidence: adapted.detection ? adapted.detection.confidence : null,
        evidence: adapted.detection ? adapted.detection.evidence : [],
        verdict: manual ? VERDICTS.MANUAL : VERDICTS.REFUSE,
        verdictReason: adapted.reason,
        limitations: undetected
          ? ['no detector recognised this directory as any plugin format this build knows']
          : ['an adapter recognised the format and declined this artifact; see the attempt list']
      })
      planDocument.attempts = adapted.attempts || []
      planDocument.code = manual ? INSTALL_FAULT_CODES.MANUAL_REQUIRED : (undetected ? INSTALL_FAULT_CODES.UNDETECTED : INSTALL_FAULT_CODES.ADAPTER_REFUSED)
      log({ kind: 'install-plan-refused', source: normalized.spec, verdict: planDocument.verdict, reason: adapted.reason })
      // The code is returned at the top level as well as on the plan, because a caller that is
      // branching — "should I offer the manual flow?" — should not have to know where it lives.
      return { ok: true, plan: planDocument, code: planDocument.code, adapterOutput: null, dir: fetched.dir, fetched: fetched.fetched, refused: true }
    }

    const structure = structureOf(adapted)
    const planDocument = buildPlan({
      manifest: adapted.plugin.manifest,
      source: normalized.spec,
      provenance: { kind: normalized.kind, repo: normalized.repo || null, path: normalized.path || null, branch: normalized.branch || null, dir: fetched.dir },
      adapter: adapted.adapter,
      detectedType: adapted.detection.type,
      confidence: adapted.detection.confidence,
      evidence: adapted.detection.evidence,
      stats: statsOf(adapted, structure),
      structure,
      verdict: VERDICTS.INSTALL
    })
    log({ kind: 'install-planned', plan: summarize(planDocument) })
    return { ok: true, plan: planDocument, adapterOutput: adapted, dir: fetched.dir, fetched: fetched.fetched, refused: false }
  }

  /**
   * Install what was planned.
   *
   * The plan is passed back in rather than recomputed, so the thing that was shown is the thing
   * that happens. A plugin whose plan carries no adapter cannot reach the manager: the guard is
   * first, and it is not a check on the plan's text but on the presence of an adapted plugin
   * object — which only `plan()` can produce, and only when adaptation succeeded.
   */
  async function install(source, options = {}) {
    const planned = options.plan ? { ok: true, plan: options.plan, adapterOutput: options.adapterOutput, dir: options.dir } : await plan(source)
    if (planned.ok !== true) return planned
    if (planned.plan.verdict !== VERDICTS.INSTALL) {
      return fault(
        planned.plan.code || INSTALL_FAULT_CODES.UNKNOWN_FORMAT_BLOCKED,
        planned.plan.verdictReason || `${planned.plan.id || 'this artifact'} was not adapted, so nothing may run`,
        { plan: planned.plan }
      )
    }
    if (!planned.adapterOutput || !planned.adapterOutput.plugin) {
      return fault(INSTALL_FAULT_CODES.UNKNOWN_FORMAT_BLOCKED, 'no adapter produced a plugin object, so there is nothing to install')
    }
    // The confirmation is a parameter rather than a convention: a caller that skipped the dialog
    // cannot install by forgetting to ask.
    if (options.confirm !== true) {
      return fault(INSTALL_FAULT_CODES.NOT_CONFIRMED, 'the plan has not been confirmed', { plan: planned.plan })
    }

    const plugin = planned.adapterOutput.plugin
    const id = plugin.manifest.id

    const existing = records.get(id)
    if (existing && existing.state === RECORD_STATES.QUARANTINED) {
      return fault(INSTALL_FAULT_CODES.RECORD_QUARANTINED, `${id} is quarantined (${existing.quarantine ? existing.quarantine.reason : 'no reason recorded'}); release it before installing`, { plan: planned.plan })
    }
    const allowed = records.allowsUpdate(id, plugin.manifest.version)
    if (allowed.ok !== true && options.replace !== true) {
      return fault(INSTALL_FAULT_CODES.RECORD_PINNED, allowed.reason, { plan: planned.plan })
    }

    const installed = manager.install(plugin, { replace: Boolean(existing) })
    if (installed.ok !== true) {
      // A plugin that cannot even be installed is quarantined: it is not retried, and the rest of
      // the world keeps building. That is what failure isolation means here.
      records.upsert({
        id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        adapter: { id: planned.adapterOutput.adapter.id, version: planned.adapterOutput.adapter.version },
        runtime: plugin.manifest.runtime,
        permissions: plugin.manifest.permissions,
        risk: planned.plan.risk,
        source: planned.plan.source,
        provenance: planned.plan.provenance,
        directory: planned.dir,
        quarantine: { at: now(), reason: installed.reason || 'the manager refused the install' },
        state: RECORD_STATES.QUARANTINED
      })
      return fault(INSTALL_FAULT_CODES.ADAPTER_REFUSED, installed.reason || 'the manager refused the install', { plan: planned.plan, code: installed.code })
    }

    const record = records.upsert({
      id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      adapter: { id: planned.adapterOutput.adapter.id, version: planned.adapterOutput.adapter.version },
      runtime: plugin.manifest.runtime,
      permissions: plugin.manifest.permissions,
      risk: planned.plan.risk,
      source: planned.plan.source,
      provenance: planned.plan.provenance,
      directory: planned.dir,
      state: RECORD_STATES.INSTALLED
    })
    sources.set(id, planned.plan.source)
    log({ kind: 'install-completed', id, version: record.version, adapter: record.adapter ? record.adapter.id : null })
    return { ok: true, plugin, plan: planned.plan, record }
  }

  /**
   * Install the newest version available from the plugin's own source.
   *
   * The order is the contract: a pin refuses before anything is fetched, and a quarantine refuses
   * before anything is replaced. Both are *refusals with a reason*, not warnings.
   */
  async function update(id, options = {}) {
    const record = records.get(id)
    if (!record) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `no record for ${id}`)
    if (record.pinned) {
      return fault(INSTALL_FAULT_CODES.RECORD_PINNED, `${id} is pinned to ${record.pinnedVersion || record.version}; unpin it before updating`)
    }
    if (record.state === RECORD_STATES.QUARANTINED) {
      return fault(INSTALL_FAULT_CODES.RECORD_QUARANTINED, `${id} is quarantined; release it before updating`)
    }
    const source = options.source || record.source || sources.get(id)
    if (!source) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `${id} has no recorded source, so there is nothing to update from`)

    const planned = await plan(source)
    if (planned.ok !== true) return planned
    if (planned.plan.version === record.version && options.force !== true) {
      return { ok: true, unchanged: true, id, version: record.version, plan: planned.plan }
    }
    return install(source, { ...options, plan: planned.plan, adapterOutput: planned.adapterOutput, dir: planned.dir, confirm: true, replace: true })
  }

  /**
   * Re-install the previous version from the recorded provenance.
   *
   * A rollback re-fetches: the previous version's *files* are not kept, so "go back" is an install
   * of a version rather than an undo. Saying that plainly matters — a rollback that silently
   * restored files from a cache would be a different feature with a different failure mode.
   */
  async function rollback(id, options = {}) {
    const record = records.get(id)
    if (!record) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `no record for ${id}`)
    const target = records.rollbackTarget(id)
    if (target.ok !== true) return fault(INSTALL_FAULT_CODES.NO_ROLLBACK, target.reason)
    const source = options.source || record.source || sources.get(id)
    if (!source) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `${id} has no recorded source, so there is nothing to roll back to`)

    // The target version is checked against what the source offers before anything is replaced: a
    // rollback to a version that no longer exists must fail *before* it uninstalls the working one.
    const planned = await plan(source)
    if (planned.ok !== true) return planned
    if (planned.plan.version !== target.to && options.allowDifferentVersion !== true) {
      return fault(
        INSTALL_FAULT_CODES.VERSION_NOT_FOUND,
        `${source} now offers ${planned.plan.version}, not the recorded ${target.to}; the rollback was not attempted`
      )
    }
    const outcome = await install(source, { ...options, plan: planned.plan, adapterOutput: planned.adapterOutput, dir: planned.dir, confirm: true, replace: true })
    if (outcome.ok === true) records.remember(id, { action: 'rolled-back', from: target.from, to: target.to })
    return outcome
  }

  /**
   * Uninstall: unload, forget, and (when a store directory is known) leave the files on disk.
   *
   * The files are kept on purpose. An uninstall that deleted a directory would make a reinstall a
   * download, and would make "why did it fail" unanswerable after the fact.
   */
  async function uninstall(id) {
    const record = records.get(id)
    const removed = await manager.remove(id)
    if (record) records.forget(id)
    sources.delete(String(id))
    log({ kind: 'install-uninstalled', id, removed: removed.ok === true })
    return { ok: true, id, removed: removed.ok === true, filesKept: record ? record.directory : null }
  }

  /**
   * Quarantine a plugin: it stops being mounted, and it keeps everything else.
   *
   * Failing isolation, stated as an operation: the plugin is unloaded and its record is flagged, so
   * nothing mounts it again until somebody releases it. It is not deleted — a fault worth
   * quarantining is a fault worth being able to look at.
   */
  async function quarantine(id, reason) {
    const record = records.get(id)
    if (!record) return fault(INSTALL_FAULT_CODES.NO_SUCH_SOURCE, `no record for ${id}`)
    await manager.unload(id)
    const outcome = records.quarantine(id, reason || 'quarantined by the pipeline')
    log({ kind: 'install-quarantined', id, reason: String(reason || '') })
    return { ok: outcome.ok === true, id, quarantine: records.get(id) ? records.get(id).quarantine : null }
  }

  async function release(id) {
    const outcome = records.release(id)
    if (outcome.ok !== true) return outcome
    log({ kind: 'install-released', id })
    return { ok: true, id, released: outcome.released || null }
  }

  /** The records, joined with the manager's live four states, which is the whole point of both. */
  function list() {
    return records.list().map((record) => {
      const entry = manager.entry(record.id)
      return {
        id: record.id,
        name: record.name,
        version: record.version,
        adapter: record.adapter,
        runtime: record.runtime,
        risk: record.risk,
        source: record.source,
        /** Where it came from: the repository, the path inside it, the branch, the directory. */
        provenance: record.provenance,
        directory: record.directory,
        pinned: record.pinned,
        pinnedVersion: record.pinnedVersion,
        state: record.state,
        quarantine: record.quarantine,
        versions: record.versions,
        history: (record.history || []).slice(-5),
        // The four states are the manager's, and they are reported beside the record rather than
        // copied into it: a record that cached "loaded" would be wrong the moment anything moved.
        live: entry
          ? { installed: entry.installed, enabled: entry.enabled, loaded: entry.loaded, healthy: entry.healthy, fault: entry.fault ? entry.fault.reason : null }
          : { installed: false, enabled: false, loaded: false, healthy: null, fault: null }
      }
    })
  }

  /** Everything a diagnostic surface needs about the pipeline itself. */
  function describe() {
    return {
      recordsFile: records.file,
      storeDir,
      records: records.count(),
      adapters: framework.describe().adapters.map((adapter) => ({ id: adapter.id, priority: adapter.priority, runtime_kind: adapter.runtime_kind, supports: adapter.supports })),
      verdicts: Object.values(VERDICTS),
      /** Whether this pipeline can fetch a remote source at all. */
      canFetch: typeof input.materialise === 'function',
      hasBridge: typeof createCordisBridge === 'function'
    }
  }

  return {
    VERDICTS,
    INSTALL_FAULT_CODES,
    RISK_LEVELS,
    records,
    normalizeSource,
    plan,
    install,
    update,
    rollback,
    pin: (id, version) => records.pin(id, version),
    unpin: (id) => records.unpin(id),
    uninstall,
    quarantine,
    release,
    list,
    describe
  }
}

module.exports = { createInstallPipeline, VERDICTS, INSTALL_FAULT_CODES, normalizeSource }
