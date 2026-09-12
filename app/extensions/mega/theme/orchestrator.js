'use strict'

/**
 * Theme Orchestrator.
 *
 * The single entry point for the whole theme subsystem, and the only place that
 * implements the mandated pipeline (engineering spec 搂1.2 / 搂2):
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
const planner = require('./assets/planner')
const overlayLayout = require('./official/overlay-layout')
const overlaySafety = require('./official/overlay-safety')

const DRAFT_STATE_FILE = 'theme-drafts.json'

/** Sensible fallback when the official view bounds were not observed. */
const FALLBACK_OFFICIAL_VIEW = Object.freeze({ x: 0, y: 0, width: 1280, height: 800 })

function clamp(value, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return min
  return Math.max(min, Math.min(max, numeric))
}

function round(value) {
  return Math.round(Number(value) || 0)
}

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
  readLoad = () => null,
  officialBounds = null,
  imageGenerator = null,
  onPlanned = () => {}
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
   * `reason`, `observedSlots`) so a caller 鈥?the dock, the acceptance run, the
   * design summary 鈥?can tell a full observation from a structure-only one.
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
   * Steps 4-6: create a theme from a prompt.
   *
   * The order is mandated (浠诲姟 8): Prompt -> Observe -> Plan -> Generate ->
   * Compose -> Preview. A prompt never reaches the designer before the UI has
   * been observed, and the plans are produced from that observation.
   *
   * Stops at a validated live preview; nothing is registered or installed.
   */
  async function createTheme({ prompt, name = null, pages = null, draftId = null } = {}) {
    if (!prompt || !String(prompt).trim()) return { ok: false, reason: 'prompt_required' }

    const observation = await observe({ pages })
    const ui = buildUiObservation(observation)
    const { intent, engine, modelError } = await interpretIntent(String(prompt))
    const baseDraft = designer.design({ intent, darkTokens: registry.darkTokens(), withAssets: false })
    const planned = plan({ intent, design: baseDraft, uiObservation: ui })
    const draft = applyPlan(baseDraft, planned)

    const themeId = registry.uniqueUserId(name || intent.palette_label || 'theme')
    const previewed = await lifecycle.previewDraft({
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
      observation: describeObservation({ ...observation, ui }),
      contrastAdjustments: previewed.contrastAdjustments || [],
      plans: describePlans(planned),
      assetPlan: planned.assetPlan,
      overlayPlan: planned.overlayPlan,
      surfacePlan: planned.surfacePlan,
      placement: planned.placement
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
        canThemeOfficialUi: observation.manifest.capabilities.can_theme_official_ui,
        surfaces: observation.manifest.themeable_surfaces.map((surface) => ({ id: surface.id, permission: surface.permission, themable: surface.themable }))
      },
      // 浠诲姟 7 + 浠诲姟 12: the plans and the layout the preview is showing.
      plans: describePlans(planned),
      preview: describePreview({ planned, previewed, observation }),
      // A structure-only design is allowed; being quiet about it is not. The
      // renderer shows `degraded`, the acceptance run asserts on it, and the log
      // records why.
      observation: describeObservation({ ...observation, ui }),
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

  /**
   * Per-surface preview report (浠诲姟 13).
   *
   * Four previews, and each one names the artifact that proves it: the HNS preview
   * is the live dock, the official previews are the compiled documents inside the
   * package, and the composite preview combines them. `installed: false` is always
   * true here 鈥?nothing has been approved yet.
   */
  function describePreview({ planned, previewed, observation }) {
    const dir = previewed.dir
    const files = {
      hns: 'preview.html',
      composite: 'preview/composite-preview.html',
      officialOverlay: 'preview/official-overlay-preview.html',
      officialShell: 'preview/official-shell-preview.html'
    }
    return {
      draftId: previewed.draftId,
      themeId: previewed.themeId,
      live: true,
      liveDetail: 'the candidate theme is applied to the live HNS dock renderer',
      installed: false,
      surfaces: {
        hns_native: { preview: 'live', detail: 'the running dock renderer is repainted with the draft tokens and slots' },
        official_shell: { preview: 'compiled', file: files.officialShell, dir },
        official_overlay: { preview: 'compiled', file: files.officialOverlay, dir },
        composite: { preview: 'compiled', file: files.composite, dir }
      },
      capture: observation.snapshot && observation.snapshot.visual
        ? { captured: true, pages: Object.keys(observation.snapshot.screenshots || {}), dir: observation.snapshotDir }
        : { captured: false, pages: [], reason: 'no visual snapshot available; the live dock remains the preview surface' },
      layout: planned.placement
        ? {
            mode: planned.placement.mode,
            anchor: planned.placement.anchor,
            character: planned.placement.placements?.character_primary || null,
            safeRegion: planned.placement.safe_region || null,
            degraded: planned.placement.degraded === true
          }
        : null
    }
  }

  /**
   * Step 7 (revision): apply a natural-language modification incrementally.
   * Unmentioned design decisions are preserved, and 鈥?the point of 浠诲姟 14 鈥?only
   * the parts the revision names are re-planned and re-generated. A revision that
   * only moves the character keeps the wallpaper, the skin and the texture bytes
   * from the previous draft.
   */
  async function reviseTheme({ draftId, prompt } = {}) {
    if (!draftId) return { ok: false, reason: 'draft_required' }
    if (!prompt || !String(prompt).trim()) return { ok: false, reason: 'prompt_required' }
    const session = sessions.get(draftId)
    if (!session) return { ok: false, reason: 'draft_not_found', draftId }

    const { intent, engine } = await interpretIntent(String(prompt), { previousIntent: session.intent })
    const change = designer.revise(session.intent, String(prompt))
    const scope = revisionScope(String(prompt), change.changed)
    // The observation is re-read, because a revision may move the character and
    // the safe region is a property of the live UI.
    const observation = await observe({})
    const ui = buildUiObservation(observation)
    const baseDraft = designer.design({ intent, darkTokens: registry.darkTokens(), withAssets: false })
    const planned = plan({ intent, design: baseDraft, uiObservation: ui })

    // Incremental generation: only the assets inside the revision's scope are
    // re-planned. Everything else keeps the previous plan entry verbatim, so the
    // compiled package reuses the exact same asset bytes.
    const previousPlan = session.assetPlan || null
    const assetPlan = scope.assets === 'all'
      ? planned.assetPlan
      : reuseAssets(previousPlan, planned.assetPlan, scope.assets)
    const draft = applyPlan(baseDraft, { ...planned, assetPlan })

    const revised = await lifecycle.reviseDraft({
      draftId,
      draft,
      prompt: String(prompt),
      intent,
      name: session.name
    })
    if (!revised.ok) return { ok: false, reason: revised.reason, stage: 'preview', issues: revised.issues || [] }

    const report = validate({ draftId })
    const history = (session.history || []).concat([{
      at: new Date().toISOString(),
      prompt: String(prompt),
      changed: change.changed,
      scope: { intent: scope.intent, assets: scope.assets, overlay: scope.overlay },
      preserved: scope.preserved
    }])
    rememberSession(draftId, {
      ...session,
      intent,
      revision: (session.revision || 0) + 1,
      engine,
      history,
      validation: report.validation,
      lastRevisionPrompt: String(prompt),
      contrastAdjustments: revised.contrastAdjustments || [],
      plans: describePlans({ ...planned, assetPlan }),
      assetPlan,
      overlayPlan: planned.overlayPlan,
      surfacePlan: planned.surfacePlan,
      placement: planned.placement
    })

    return {
      ok: true,
      draftId,
      themeId: session.themeId,
      name: session.name,
      stage: 'preview',
      intent,
      changed: change.changed,
      scope: { intent: scope.intent, assets: scope.assets, overlay: scope.overlay },
      preserved: scope.preserved,
      engine,
      revision: (session.revision || 0) + 1,
      designSummary: designer.describe(draft),
      validation: report.validation,
      previewPackage: report.preview,
      contrastAdjustments: revised.contrastAdjustments || [],
      plans: describePlans({ ...planned, assetPlan }),
      preview: describePreview({ planned: { ...planned, assetPlan }, previewed: revised, observation })
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
      captureProblems: (observation.snapshot && observation.snapshot.capture_problems) || [],
      ui: observation.ui || null
    }
  }

  /**
   * The UI Observation the planner designs against (浠诲姟 8).
   *
   * The mandate is explicit: never `Prompt -> theme`. The theme must observe the
   * HNS bounds, the dock bounds, the official bounds, the window size, the slot
   * geometry, the available character regions and the critical interaction regions
   * first, and *then* plan. Everything here is either measured or marked missing:
   * `degraded` is true the moment one of the inputs had to be assumed, and the
   * planner records the same verdict in the plans it writes.
   *
   * The official renderer itself is never read: its bounds come from the shell
   * (a rectangle), which is the only thing about it DS-Hns is allowed to know.
   */
  function buildUiObservation(observation) {
    const snapshotPackage = observation?.snapshot || null
    const windowSize = snapshotPackage?.window || null
    const dock = snapshotPackage?.dock || null
    let official = FALLBACK_OFFICIAL_VIEW
    let officialObserved = false
    if (typeof officialBounds === 'function') {
      try {
        const measured = officialBounds()
        if (measured && Number(measured.width) > 0 && Number(measured.height) > 0) {
          official = {
            x: round(measured.x),
            y: round(measured.y),
            width: round(measured.width),
            height: round(measured.height)
          }
          officialObserved = true
        }
      } catch (error) {
        log(`official view bounds unavailable: ${error?.message || error}`)
      }
    }

    const slotBoxes = observation?.observedSlots?.boundingBoxes || {}
    const critical = []
    for (const region of snapshotPackage?.protected_regions || []) {
      const box = region.boundingBox || slotBoxes[region.id]
      if (!box || !Number(box.width) || !Number(box.height)) continue
      if (region.critical === false) continue
      critical.push({ id: region.id, label: region.label, x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) })
    }
    // The official view is its own critical region: it is the surface the overlay
    // must not ruin, and it is the viewport the overlay is measured against.
    const viewport = officialObserved ? official : (windowSize
      ? { x: 0, y: 0, width: round(windowSize.width), height: round(windowSize.height) }
      : { ...FALLBACK_OFFICIAL_VIEW })
    const regionModel = overlayLayout.computeRegions({ viewport, critical, observed: critical.length > 0 })
    const safe = overlayLayout.computeSafeRegion({ viewport, critical: regionModel.critical, margin: 8 })

    return {
      viewport,
      window: windowSize ? { width: round(windowSize.width), height: round(windowSize.height) } : null,
      hns_bounds: dock ? { width: round(dock.width), height: round(dock.height) } : null,
      dock_bounds: dock ? { width: round(dock.width), height: round(dock.height), expanded: dock.expanded === true } : null,
      official_bounds: { ...official },
      official_bounds_observed: officialObserved,
      slot_geometry: slotBoxes,
      slot_count: Object.keys(slotBoxes).length,
      character_regions: safe.regions,
      safe_region: { x: round(safe.primary.x), y: round(safe.primary.y), width: round(safe.primary.width), height: round(safe.primary.height) },
      critical_regions: regionModel.critical.map((region) => ({
        id: region.id || null,
        label: region.label || null,
        x: round(region.x),
        y: round(region.y),
        width: round(region.width),
        height: round(region.height),
        source: region.source || 'assumed'
      })),
      critical_observed: regionModel.observed,
      // Degraded as soon as anything the plan depends on was assumed.
      degraded: !officialObserved || !regionModel.observed || Boolean(observation?.degraded),
      reason: (!officialObserved
        ? 'the official view bounds were not observed; the overlay viewport is an assumption'
        : (!regionModel.observed ? regionModel.reason : (observation?.reason || null)))
    }
  }

  /**
   * Plan, enforce the safety ceilings and lay the overlay out (浠诲姟 7/9/10/11).
   *
   * Returns the three plan documents plus the layout the renderer will use. The
   * enforcement step can only lower strengths, so a prompt cannot produce an
   * overlay that violates an engineering ceiling; if even the lowest strength
   * cannot clear a critical region the overlay is disabled as a whole (and only
   * the overlay 鈥?the theme still installs).
   */
  function plan({ intent, design, uiObservation }) {
    const observation = uiObservation || null
    const planInput = { intent, design, observation, limits: null }
    const surfacePlan = planner.planSurfaces({ intent, observation })
    const overlayPlan = planner.planOverlay(planInput)
    const assetPlan = planner.planAssets(planInput)

    const enforcement = overlaySafety.enforce({
      plan: overlayPlan,
      viewport: observation?.official_bounds || observation?.viewport || FALLBACK_OFFICIAL_VIEW,
      critical: (observation?.critical_regions || []).map((region) => ({ ...region })),
      observed: Boolean(observation?.critical_observed),
      assets: {},
      background: design?.palette_values?.base || '#0f1115'
    })

    const report = enforcement.report
    const blocked = report.failures.filter((entry) => entry.id !== 'critical_regions_observed')
    const enabled = overlayPlan.enabled !== false && enforcement.ok && blocked.length === 0
    for (const adjustment of enforcement.adjustments) log(`overlay safety: ${adjustment.reason}`)
    if (!enforcement.ok) {
      log(`overlay disabled for this design: ${report.failures.map((entry) => entry.id).join(', ')}`)
    }

    const effectiveOverlayPlan = { ...enforcement.plan, enabled, safety: {
      ok: report.ok,
      passed: report.passed,
      total: report.total,
      failures: report.failures.map((entry) => ({ id: entry.id, actual: entry.actual, limit: entry.limit, detail: entry.detail })),
      checks: report.checks.map((entry) => ({ id: entry.id, ok: entry.ok, actual: entry.actual, limit: entry.limit })),
      effect: report.effect,
      adjustments: enforcement.adjustments,
      degradation: enforcement.degradation
    } }

    const placement = enforcement.ok
      ? enforcement.placement
      : overlayLayout.layout({
          viewport: observation?.official_bounds || observation?.viewport || FALLBACK_OFFICIAL_VIEW,
          plan: effectiveOverlayPlan,
          critical: (observation?.critical_regions || []).map((region) => ({ ...region })),
          observed: Boolean(observation?.critical_observed)
        })

    const result = { surfacePlan, overlayPlan: effectiveOverlayPlan, assetPlan, placement, enforcement }
    try {
      // The engine publishes the layout so the prepaint wrapper can place the
      // official overlay's character box without re-planning.
      onPlanned(result)
    } catch (error) {
      log(`plan notification failed: ${error?.message || error}`)
    }
    return result
  }

  /** Re-derive a draft's plan-dependent tokens/slots from an enforced plan. */
  function applyPlan(draft, { surfacePlan, overlayPlan, assetPlan }) {
    const next = designer.applyOverlayPlan(
      { ...draft, surface_plan: surfacePlan || draft.surface_plan },
      { assetPlan: assetPlan || draft.asset_plan, overlayPlan: overlayPlan || draft.overlay_plan }
    )
    return {
      ...next,
      surface_plan: surfacePlan || draft.surface_plan,
      asset_plan: assetPlan || draft.asset_plan,
      overlay_plan: overlayPlan || draft.overlay_plan,
      // The image-generation capability is carried on the draft so the builder's
      // asset pipeline can use it without the builder having to know where it came
      // from. Absent or null means "procedural only", which is always valid.
      image_generator: typeof imageGenerator === 'function' ? imageGenerator : null
    }
  }

  /** A renderer/UI-safe summary of the three plans and the layout. */
  function describePlans({ surfacePlan, overlayPlan, assetPlan, placement }) {
    return {
      surfaces: (surfacePlan?.surfaces || []).map((entry) => ({
        surface: entry.surface,
        permission: entry.permission,
        writes: entry.writes === true,
        protected: entry.protected === true,
        reason: entry.reason
      })),
      protectedSurface: 'official_renderer',
      overlay: {
        enabled: overlayPlan?.enabled !== false,
        visualOnly: true,
        mode: placement?.mode || overlayPlan?.layout?.mode || null,
        anchor: placement?.anchor || overlayPlan?.layout?.anchor || null,
        characterCoverage: placement?.placements?.character_primary?.coverage ?? 0,
        criticalOverlap: placement?.placements?.character_primary?.critical_overlap ?? 0,
        safety: overlayPlan?.safety || null,
        degraded: Boolean(overlayPlan?.degraded),
        reason: overlayPlan?.reason || null
      },
      layout: placement
        ? {
            mode: placement.mode,
            anchor: placement.anchor,
            observed: placement.observed === true,
            degraded: placement.degraded === true,
            reason: placement.reason || null,
            safeRegion: placement.safe_region?.primary || null,
            criticalRegions: (placement.critical_regions || []).length,
            adjustments: placement.adjustments || [],
            placements: Object.fromEntries(Object.entries(placement.placements || {}).map(([key, value]) => [key, {
              box: value.box || null,
              opacity: value.opacity ?? null,
              coverage: value.coverage ?? null,
              enabled: value.enabled !== false
            }]))
          }
        : null,
      assets: {
        count: assetPlan?.count || 0,
        perSurface: assetPlan?.per_surface || {},
        character: assetPlan?.character || { enabled: false },
        degraded: Boolean(assetPlan?.degraded),
        reason: assetPlan?.reason || null,
        entries: (assetPlan?.asset_plan || []).map((entry) => ({
          kind: entry.kind,
          surface: entry.surface,
          dimensions: [entry.width, entry.height],
          transparent: entry.transparent === true,
          anchor: entry.anchor,
          layout: entry.layout,
          opacity: entry.opacity,
          prominence: entry.prominence,
          generation_prompt: entry.generation_prompt,
          path: entry.path || null
        }))
      }
    }
  }

  /**
   * Which parts of a design a revision prompt actually touches (任务 14).
   *
   * The modifications the spec names explicitly — 人物小一点 / 人物移到左边 /
   * 官方蒙版淡一点 / 官方区域不要角色 / 只换人物 / 只换皮肤 / 只改官方区域 /
   * 只改 HNS 区域 / 颜色更冷 / 人物透明一点 — are all *scoped*: they must change one
   * part, not re-roll the theme. This classifies the prompt into the smallest scope
   * that covers it, so the generator can reuse every asset outside that scope
   * byte-for-byte.
   *
   * @returns {{intent: boolean, overlay: boolean, assets: string, preserved: string[]}}
   */
  function revisionScope(prompt, changed = []) {
    const text = String(prompt || '').toLowerCase()
    const preserved = []
    const characterOnly = /只换人物|人物换|换个(人物|角色)|only (the )?character|swap the character|replace the character/.test(text)
    const skinOnly = /只换皮肤|只换官方皮肤|only (the )?skin|swap the skin/.test(text)
    const shellOnly = /只改官方(外壳|边框)|only the (frame|shell|border)/.test(text)
    const hnsOnly = /只改\s*hns|只改自己|only\s*hns|only the dock/.test(text)
    const decorationOnly = /只换装饰|装饰换|only (the )?decoration/.test(text)
    const characterTouch = /人物|角色|character|persona|silhouette/.test(text)
    const overlayTouch = /蒙版|遮罩|overlay|tint|纹理|texture|扫描|scanline|vignette|官方/.test(text)
    const colourTouch = /颜色|色|color|colour|冷|暖|cool|warm|palette/.test(text)
    const shellTouch = /外壳|边框|frame|shell|border|radius|圆角/.test(text)

    let assets = 'all'
    if (characterOnly) assets = 'character'
    else if (skinOnly) assets = 'skin'
    else if (shellOnly) assets = 'shell'
    else if (hnsOnly) assets = 'hns'
    else if (decorationOnly) assets = 'decoration'
    else if (characterTouch && !colourTouch && !overlayTouch && !shellTouch) assets = 'character'
    else if (overlayTouch && !colourTouch && !shellTouch) assets = 'skin'

    // What the revision did not ask about stays as it was.
    if (!characterTouch && !characterOnly) preserved.push('character')
    if (!overlayTouch && !skinOnly) preserved.push('official_overlay')
    if (!shellTouch && !shellOnly) preserved.push('official_shell')
    if (!colourTouch && !changed.includes('palette')) preserved.push('palette')
    if (!changed.includes('motion')) preserved.push('motion')
    if (!changed.includes('density')) preserved.push('density')
    if (!changed.includes('decoration') && !decorationOnly) preserved.push('decoration')
    if (!hnsOnly) preserved.push('hns_native')

    return {
      intent: true,
      overlay: overlayTouch || characterTouch || changed.length > 0,
      assets,
      preserved
    }
  }

  /**
   * Reuse the previous plan's asset entries outside the revision's scope.
   *
   * This is what makes 任务 14 real rather than nominal: "人物小一点" keeps the
   * wallpaper, the official skin, the texture and the frame from the previous
   * draft, so the compiled package reuses their exact bytes and the unchanged
   * assets are provably identical (the acceptance run compares hashes).
   */
  function reuseAssets(previousPlan, nextPlan, scope) {
    if (!previousPlan || scope === 'all') return nextPlan
    const scopeKinds = {
      character: new Set(['hns_character', 'official_character', 'persona_avatar']),
      skin: new Set(['official_skin', 'official_overlay_texture', 'official_character']),
      shell: new Set(['frame_decoration', 'official_skin']),
      decoration: new Set(['hud_decoration', 'frame_decoration']),
      hns: new Set(['wallpaper', 'panel_texture', 'icon_set', 'hns_character', 'persona_avatar', 'hud_decoration']),
      none: new Set()
    }[scope] || null
    if (!scopeKinds) return nextPlan
    const previousByKind = new Map((previousPlan.asset_plan || []).map((entry) => [entry.kind, entry]))
    const entries = (nextPlan.asset_plan || []).map((entry) => {
      if (scopeKinds.has(entry.kind)) return entry
      const previous = previousByKind.get(entry.kind)
      if (!previous) return entry
      // The placement comes from the new plan (the layout may have moved); the
      // *content identity* comes from the previous one, so the builder reuses the
      // same bytes.
      return { ...previous, position: entry.position, anchor: entry.anchor, opacity: entry.opacity, safe_region: entry.safe_region }
    })
    return { ...nextPlan, asset_plan: entries, count: entries.length }
  }

  /** Step 8: validate the candidate against the preview checklist. */
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
  async function approve({ draftId } = {}) {
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
    const installed = await lifecycle.approveDraft(draftId)
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
      validation: { ok: installed.validation.ok, warnings: installed.validation.warnings.length },
      // 任务 12: what was approved, and what of it degraded.
      plans: session.plans || null,
      degradation: installed.status?.degradation || null
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
        '深色工业监控台，冷灰钢蓝，克制动效',
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

  /**
   * Install the image-generation capability (任务 5).
   *
   * This is how a real image model reaches the asset pipeline. It is optional by
   * design: with nothing installed the procedural renderer produces the assets, and
   * with a failing one the same fallback runs per asset. The generator receives
   * `{ prompt, spec, kind, surface }` and must return PNG bytes; anything else is
   * rejected by the asset validator rather than trusted.
   */
  function setImageGenerator(fn) {
    imageGenerator = typeof fn === 'function' ? fn : null
    return { imageGenerator: Boolean(imageGenerator) }
  }

  /** Install the live official view bounds reader (任务 8 / 任务 9). */
  function setOfficialBounds(fn) {
    officialBounds = typeof fn === 'function' ? fn : null
    return { officialBounds: Boolean(officialBounds) }
  }

  return {
    observe,
    buildUiObservation,
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
    describePlans,
    plan,
    setModelInterpreter,
    setCapture,
    setImageGenerator,
    setOfficialBounds,
    sessions: () => new Map(sessions),
    stateFile: draftStatePath
  }
}

module.exports = { createOrchestrator, DRAFT_STATE_FILE }
