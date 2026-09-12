'use strict'

/**
 * Theme Orchestrator.
 *
 * The single entry point for the whole theme subsystem, and the only place that
 * implements the mandated pipeline (engineering spec §1.2 / §2):
 *
 *   User Prompt
 *     -> UI Inspection            (structure + visual snapshot)
 *     -> Capability Discovery     (manifest of what may be themed right now)
 *     -> Design Intent            (semantic, model-facing)
 *     -> Preview Mockup           (the live dock wearing the draft)
 *     -> Validation               (readability / contrast / states / occlusion)
 *     -> User Revision / Approval
 *     -> Theme Compilation        (Theme Builder, self-contained package)
 *     -> Validation               (package validator)
 *     -> Registration
 *     -> Installation
 *
 * A prompt can never produce an installed theme: `createTheme` stops at a live
 * preview, and only `approve` promotes a package into the user theme directory.
 *
 * The optional model-assisted interpreter is a *refinement* layer. It is never
 * required: when it is absent, disabled or failing, the deterministic local
 * interpreter produces the same output contract.
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const designer = require('./designer')
const preview = require('./preview')
const validator = require('./validator')
const inspectorModule = require('./inspector')

const DRAFT_STATE_FILE = 'theme-drafts.json'

function createOrchestrator({
  registry,
  recovery,
  runtime,
  lifecycle,
  snapshot,
  builder,
  log = () => {},
  onChanged = () => {},
  modelInterpreter = null,
  capturePreview = null,
  readLoad = () => null
} = {}) {
  /** Latest design intent + draft per theme id, so a revision is incremental. */
  const sessions = new Map()

  function draftStatePath() {
    return path.join(registry.workspaceDir(), DRAFT_STATE_FILE)
  }

  function persistSessions() {
    try {
      const file = draftStatePath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = [...sessions.entries()].map(([draftId, session]) => ({
        draftId,
        themeId: session.themeId,
        name: session.name,
        prompt: session.prompt,
        intent: session.intent,
        revision: session.revision,
        updatedAt: session.updatedAt
      }))
      fs.writeFileSync(file, `${JSON.stringify({ updated_at: new Date().toISOString(), sessions: payload }, null, 2)}\n`, 'utf8')
    } catch (error) {
      log(`draft session persist failed: ${error?.message || error}`)
    }
  }

  function rememberSession(draftId, session) {
    sessions.set(draftId, { ...session, updatedAt: new Date().toISOString() })
    persistSessions()
  }

  /**
   * Step 1 + 2: observe the real UI and discover current capabilities.
   * Both degrade gracefully; a missing visual capture is recorded, never faked.
   *
   * The result carries the visual verdict explicitly (`visual`, `degraded`,
   * `reason`, `observedSlots`) so a caller — the dock, the acceptance run, the
   * design summary — can tell a full observation from a structure-only one.
   */
  async function observe({ pages = null } = {}) {
    const manifest = runtime.manifest({
      dockState: (() => {
        try { return lifecycle.listThemes() && registry.readActiveId() } catch { return null }
      })()
    })
    let snapshotPackage = null
    let dir = null
    if (snapshot) {
      try {
        const result = await snapshot.observe({ pages })
        snapshotPackage = result.package
        dir = result.dir
      } catch (error) {
        log(`UI observation failed, continuing structure-only: ${error?.message || error}`)
      }
    }
    const observedSlots = snapshotPackage
      ? inspectorModule.observedSlots({
          slots: Object.fromEntries(Object.entries(snapshotPackage.slot_map || {}).map(([id, slot]) => [id, {
            id,
            present: slot.present,
            boundingBox: slot.boundingBox
          }]))
        })
      : { count: 0, ids: [], boundingBoxes: {} }
    return {
      manifest,
      snapshot: snapshotPackage,
      snapshotDir: dir,
      visual: Boolean(snapshotPackage && snapshotPackage.visual),
      degraded: !snapshotPackage || Boolean(snapshotPackage.degraded),
      reason: snapshotPackage
        ? snapshotPackage.visual_reason || null
        : 'the UI snapshot service was unavailable',
      observedSlots
    }
  }

  /**
   * Step 3: prompt -> Design Intent. The model interpreter may refine the local
   * result, but only into the same known shape.
   */
  async function interpretIntent(prompt, { previousIntent = null } = {}) {
    const local = designer.interpret(prompt, { previousIntent })
    if (!modelInterpreter || typeof modelInterpreter !== 'function') {
      return { intent: local, engine: 'local' }
    }
    try {
      const refined = await modelInterpreter({ prompt, localIntent: local, previousIntent })
      if (!refined || typeof refined !== 'object') return { intent: local, engine: 'local' }
      const merged = mergeIntent(local, refined)
      return { intent: merged, engine: 'local+model' }
    } catch (error) {
      // Model unavailability is not a theme failure.
      log(`model intent refinement unavailable: ${error?.message || error}`)
      return { intent: local, engine: 'local', modelError: String(error?.message || error) }
    }
  }

  function mergeIntent(local, refined) {
    const merged = { ...local }
    const scalarKeys = ['design_language', 'style_tag', 'palette_label', 'base_hint', 'density', 'motion', 'decoration', 'readability_priority']
    for (const key of scalarKeys) {
      if (typeof refined[key] === 'string' && refined[key].trim()) merged[key] = refined[key].trim()
    }
    if (Array.isArray(refined.palette) && refined.palette.length && typeof refined.palette[0] === 'string') {
      merged.palette = [refined.palette[0]]
    }
    if (refined.persona && typeof refined.persona === 'object') {
      merged.persona = {
        enabled: Boolean(refined.persona.enabled),
        // HNS clamps persona prominence no matter what the model says.
        prominence: Math.max(0, Math.min(0.4, Number(refined.persona.prominence) || 0)),
        character: typeof refined.persona.character === 'string' ? refined.persona.character : merged.persona.character
      }
    }
    merged.model_refined = true
    return merged
  }

  /**
   * Steps 4-6: create a theme from a prompt. Stops at a validated live preview.
   */
  async function createTheme({ prompt, name = null, pages = null, draftId = null } = {}) {
    if (!prompt || !String(prompt).trim()) return { ok: false, reason: 'prompt_required' }

    const observation = await observe({ pages })
    const { intent, engine, modelError } = await interpretIntent(String(prompt))
    const draft = designer.design({
      intent,
      darkTokens: registry.darkTokens(),
      withAssets: false
    })

    const themeId = registry.uniqueUserId(name || intent.palette_label || 'theme')
    const previewed = lifecycle.previewDraft({
      draft,
      id: themeId,
      name: name || `${intent.palette_label} ${intent.density}`,
      prompt: String(prompt),
      intent,
      draftId
    })

    if (!previewed.ok) {
      return { ok: false, reason: previewed.reason, stage: 'preview', issues: previewed.issues || [] }
    }

    const report = validate({ draftId: previewed.draftId, snapshot: observation.snapshot })
    rememberSession(previewed.draftId, {
      draftId: previewed.draftId,
      themeId,
      name: previewed.name,
      prompt: String(prompt),
      intent,
      revision: 0,
      engine,
      modelError: modelError || null,
      validation: report.validation,
      capabilityManifest: observation.manifest,
      snapshotCaptured: Boolean(observation.snapshot && observation.snapshot.visual),
      observation: describeObservation(observation),
      contrastAdjustments: previewed.contrastAdjustments || []
    })

    return {
      ok: true,
      draftId: previewed.draftId,
      themeId,
      name: previewed.name,
      stage: 'preview',
      intent,
      engine,
      designSummary: designer.describe(draft),
      validation: report.validation,
      previewPackage: report.preview,
      contrastAdjustments: previewed.contrastAdjustments || [],
      capability: {
        themeApiVersion: observation.manifest.theme_api_version,
        slots: Object.keys(observation.manifest.slots).length,
        writableSlots: Object.values(observation.manifest.slots).filter((slot) => slot.permission !== contract.PERMISSION.STRUCTURAL).length,
        states: observation.manifest.states,
        canThemeOfficialUi: observation.manifest.capabilities.can_theme_official_ui
      },
      // A structure-only design is allowed; being quiet about it is not. The
      // renderer shows `degraded`, the acceptance run asserts on it, and the log
      // records why.
      observation: describeObservation(observation),
      snapshot: {
        captured: Boolean(observation.snapshot),
        visual: Boolean(observation.snapshot && observation.snapshot.visual),
        degraded: Boolean(observation.degraded),
        reason: observation.reason || null,
        dir: observation.snapshotDir,
        pages: observation.snapshot ? observation.snapshot.page_names : [],
        observedSlots: observation.observedSlots || { count: 0, ids: [], boundingBoxes: {} }
      }
    }
  }

  /** Compact, renderer-safe view of what the observation actually produced. */
  function describeObservation(observation) {
    return {
      visual: Boolean(observation.visual),
      degraded: Boolean(observation.degraded),
      reason: observation.reason || null,
      snapshotDir: observation.snapshotDir || null,
      observedSlots: observation.observedSlots || { count: 0, ids: [], boundingBoxes: {} },
      captureProblems: (observation.snapshot && observation.snapshot.capture_problems) || []
    }
  }

  /**
   * Step 7 (revision): apply a natural-language modification incrementally.
   * Unmentioned design decisions are preserved (spec §8).
   */
  async function reviseTheme({ draftId, prompt } = {}) {
    if (!draftId) return { ok: false, reason: 'draft_required' }
    if (!prompt || !String(prompt).trim()) return { ok: false, reason: 'prompt_required' }
    const session = sessions.get(draftId)
    if (!session) return { ok: false, reason: 'draft_not_found', draftId }

    const { intent, engine } = await interpretIntent(String(prompt), { previousIntent: session.intent })
    const change = designer.revise(session.intent, String(prompt))
    const draft = designer.design({
      intent,
      darkTokens: registry.darkTokens(),
      withAssets: false
    })

    const revised = lifecycle.reviseDraft({
      draftId,
      draft,
      prompt: String(prompt),
      intent,
      name: session.name
    })
    if (!revised.ok) return { ok: false, reason: revised.reason, stage: 'preview', issues: revised.issues || [] }

    const report = validate({ draftId })
    const history = (session.history || []).concat([{ at: new Date().toISOString(), prompt: String(prompt), changed: change.changed }])
    rememberSession(draftId, {
      ...session,
      intent,
      revision: (session.revision || 0) + 1,
      engine,
      history,
      validation: report.validation,
      lastRevisionPrompt: String(prompt),
      contrastAdjustments: revised.contrastAdjustments || []
    })

    return {
      ok: true,
      draftId,
      themeId: session.themeId,
      name: session.name,
      stage: 'preview',
      intent,
      changed: change.changed,
      engine,
      revision: (session.revision || 0) + 1,
      designSummary: designer.describe(draft),
      validation: report.validation,
      previewPackage: report.preview,
      contrastAdjustments: revised.contrastAdjustments || []
    }
  }

  /** Step 5: validate the candidate against the preview checklist. */
  function validate({ draftId, snapshot: snapshotOverride = null } = {}) {
    const session = draftId ? sessions.get(draftId) : null
    const draftRecord = draftId ? lifecycle.drafts().get(draftId) : null
    const theme = draftRecord
      ? {
          id: draftRecord.themeId,
          manifest: draftRecord.manifest,
          tokens: validator.resolveTokens(draftRecord.tokens, registry.darkTokens()),
          components: {
            slots: draftRecord.components?.slots || {},
            animation: validator.normalizeAnimation(draftRecord.components?.animation)
          },
          persona: draftRecord.persona,
          validation: draftRecord.validation
        }
      : runtime.currentTheme()
    if (!theme) return { validation: { ok: false, checks: [], failures: [{ id: 'no_theme', label: 'no candidate theme', ok: false, detail: null }], passed: 0, total: 0 } }

    const snapshotPackage = snapshotOverride || (snapshot ? snapshot.latest() : null)
    const structural = preview.assertNoStructuralWrites(theme)

    const report = preview.validatePreview({
      theme,
      regions: (snapshotPackage && snapshotPackage.slot_map) || {},
      viewport: (snapshotPackage && snapshotPackage.window) || null,
      snapshot: snapshotPackage,
      load: readLoad()
    })

    if (structural.length) {
      const structuralChecks = structural.map((violation) => ({
        id: 'structural_write',
        label: 'structural slot untouched',
        ok: false,
        detail: `${violation.slot}: ${violation.reason}`,
        severity: 'error'
      }))
      report.checks = report.checks.concat(structuralChecks)
      report.failures = report.failures.concat(structuralChecks)
      report.warnings = report.warnings || []
      report.ok = false
      report.total = report.checks.length
      report.passed = report.checks.filter((check) => check.ok).length
    }

    if (session) {
      rememberSession(draftId, { ...session, validation: report })
    }

    const capture = snapshotPackage && snapshotPackage.visual
      ? { captured: true, pages: Object.keys(snapshotPackage.screenshots || {}), dir: snapshot ? snapshot.workspaceDir() : null }
      : { captured: false, pages: [], reason: 'no visual snapshot available; the live dock remains the preview surface' }

    return {
      draftId,
      validation: report,
      preview: {
        themeId: theme.id,
        name: theme.manifest?.name || theme.id,
        live: true,
        liveDetail: 'the candidate theme is applied to the live HNS dock renderer',
        capture
      }
    }
  }

  /** Steps 8-11: compile, validate, register, install, apply. */
  function approve({ draftId } = {}) {
    const session = draftId ? sessions.get(draftId) : null
    if (!session) return { ok: false, reason: 'draft_not_found', draftId }
    const current = validate({ draftId })
    if (!current.validation.ok) {
      return {
        ok: false,
        reason: 'preview_validation_failed',
        draftId,
        issues: current.validation.failures,
        message: 'the preview did not pass validation, so nothing was installed'
      }
    }
    const installed = lifecycle.approveDraft(draftId)
    if (!installed.ok) return { ...installed, stage: 'install' }
    sessions.delete(draftId)
    persistSessions()
    onChanged()
    return {
      ok: true,
      stage: 'installed',
      id: installed.id,
      name: installed.name,
      dir: installed.dir,
      registered: installed.registered,
      status: installed.status,
      validation: { ok: installed.validation.ok, warnings: installed.validation.warnings.length }
    }
  }

  /** Discard a draft: nothing was ever registered or installed. */
  function discard({ draftId } = {}) {
    const session = sessions.get(draftId)
    const result = lifecycle.discardDraft(draftId)
    if (session) {
      sessions.delete(draftId)
      persistSessions()
    }
    onChanged()
    return { ok: true, ...result }
  }

  function listThemes() {
    return lifecycle.listThemes()
  }

  function applyTheme(id) {
    return lifecycle.applyTheme(id)
  }

  function deleteTheme(id) {
    return lifecycle.deleteTheme(id)
  }

  function duplicateTheme(id, options) {
    return lifecycle.duplicateTheme(id, options)
  }

  function restoreBuiltin(id) {
    return lifecycle.restoreBuiltin(id)
  }

  function importTheme(dir, options) {
    return lifecycle.importTheme(dir, options)
  }

  /** Renderer-facing appearance snapshot. */
  function describe() {
    const list = listThemes()
    const themeRuntime = runtime.describe()
    return {
      themeApiVersion: contract.THEME_API_VERSION,
      active: list.active,
      activeName: themeRuntime.activeName,
      previewing: themeRuntime.previewing,
      previewDraftId: themeRuntime.previewDraftId,
      effect: themeRuntime.effect,
      effectLevel: themeRuntime.effectLevel,
      degraded: themeRuntime.degraded,
      load: themeRuntime.load,
      animation: themeRuntime.animation,
      recovery: themeRuntime.recovery,
      themes: list.themes,
      revisionHistory: [...sessions.values()].map((session) => ({
        draftId: session.draftId,
        themeId: session.themeId,
        name: session.name,
        prompt: session.prompt,
        revision: session.revision,
        updatedAt: session.updatedAt,
        history: session.history || []
      })),
      quickPrompts: [
        '银发角色，黑灰蓝色调，未来科研工作站，人物别太抢屏',
        '赛博全息 HUD，高密度信息，扫描线，微光',
        '极简浅色中性，低装饰，文字清晰优先',
        '紫蓝二次元角色，轻量挂件，装饰中等',
        '深色工业监控台，冷灰钢蓝，克制动效'
      ],
      protectedNote: 'Dark and Light are protected system themes; Dark is also the automatic recovery target.'
    }
  }

  /** Capability manifest, exposed so the UI can explain what is themable. */
  function capabilities() {
    return runtime.manifest()
  }

  function setModelInterpreter(interpreter) {
    modelInterpreter = typeof interpreter === 'function' ? interpreter : null
  }

  function setCapture(fn) {
    capturePreview = typeof fn === 'function' ? fn : null
  }

  return {
    observe,
    interpretIntent,
    createTheme,
    reviseTheme,
    validate,
    approve,
    discard,
    listThemes,
    applyTheme,
    deleteTheme,
    duplicateTheme,
    restoreBuiltin,
    importTheme,
    describe,
    capabilities,
    setModelInterpreter,
    setCapture,
    sessions: () => new Map(sessions),
    stateFile: draftStatePath
  }
}

module.exports = { createOrchestrator, DRAFT_STATE_FILE }
