'use strict'

/**
 * Theme Lifecycle Manager.
 *
 * The only place that may mutate the installed theme set. Every mutating
 * operation follows the engineering spec exactly:
 *
 *   install   Approved Design -> Builder -> Validator -> Register -> Install -> Apply
 *   delete    protected check -> active check (switch to Dark first)
 *             -> unregister -> delete the theme's own files -> delete its cache
 *             -> refresh the list                                   (spec §17)
 *   restore   factory restore of a built-in demo theme
 *
 * Because no user theme may runtime-depend on another theme (spec §11), deletion
 * needs no dependency tree: removing one theme's directory can never break
 * another. That property is asserted, not assumed  — `deleteTheme` refuses to
 * touch anything outside the theme's own directory.
 */
const fs = require('node:fs')
const path = require('node:path')

const validator = require('./validator')

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true })
}

/** Is `child` inside `parent`? Guards every destructive operation. */
function isInside(parent, child) {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(resolvedParent + path.sep)
}

function createLifecycle({
  registry,
  builder,
  runtime,
  recovery,
  loadPackage = null,
  log = () => {},
  onChanged = () => {}
} = {}) {
  const drafts = new Map()

  /**
   * Read a package for duplication/read-back. Prefers the injected module-level
   * loader and falls back to the guard instance when one is supplied.
   */
  function readPackage(dir, id) {
    if (typeof loadPackage === 'function') return loadPackage(dir, id)
    return { ok: false, reason: 'package_loader_unavailable', issues: [] }
  }

  function listThemes() {
    let records = []
    try {
      records = registry.list()
    } catch (error) {
      log(`theme list failed: ${error?.message || error}`)
      records = []
    }
    const active = runtime ? runtime.activeId : registry.readActiveId()
    return {
      active,
      themes: records.map((record) => ({
        ...record,
        active: record.id === active
      }))
    }
  }

  /** Apply an installed theme. A broken theme recovers to Dark. */
  function applyTheme(id) {
    if (!id) return { ok: false, reason: 'id_required' }
    const record = registry.list().find((entry) => entry.id === id)
    if (!record) return { ok: false, reason: 'not_found', id }
    if (record.broken) {
      log(`refusing to apply broken theme ${id}; falling back to Dark`)
      const status = runtime.activate(registry.RECOVERY_THEME_ID, { persist: true, reason: 'broken-package' })
      onChanged()
      return {
        ok: false,
        reason: 'validation_failed',
        id,
        recovered: true,
        status,
        issues: record.validation.issues.slice(0, 8)
      }
    }
    const status = runtime.activate(id, { persist: true, reason: 'user' })
    onChanged()
    return { ok: true, status }
  }

  /**
   * Start (or update) a live preview. The draft lives in the workspace only —
   * it is never registered and never appears in the theme list before approval
   * (THEME_INTERFACE_SPEC §5).
   */
  function previewDraft({ draft, id, name, prompt, intent, draftId = null } = {}) {
    if (!draft) return { ok: false, reason: 'draft_required' }
    const workspaceId = draftId || `draft-${Date.now().toString(36)}`
    const dir = path.join(registry.workspaceDir(), 'temp', workspaceId)
    const record = {
      id: workspaceId,
      themeId: id,
      name: name || id || workspaceId,
      prompt: prompt || null,
      intent: intent || draft.intent || null,
      draft,
      dir,
      revision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      validation: null
    }

    // The draft is materialized in the temp workspace so the same package
    // validator that guards installation also guards the preview.
    const built = builder.buildPackage({
      draft,
      id: id || `draft.${workspaceId}`,
      name: record.name,
      outDir: dir,
      source: 'generated',
      generatedPrompt: record.prompt,
      darkTokens: registry.darkTokens()
    })

    if (!built.ok) {
      return { ok: false, reason: built.reason, issues: built.issues, dir }
    }

    record.manifest = built.manifest
    record.tokens = built.tokens
    record.components = built.components
    record.persona = built.persona
    record.validation = built.validation

    const previewTheme = {
      id: built.manifest.id,
      manifest: built.manifest,
      tokens: validator.resolveTokens(built.tokens, registry.darkTokens()),
      declaredTokens: built.tokens,
      components: {
        slots: built.components.slots || {},
        animation: validator.normalizeAnimation(built.components.animation)
      },
      persona: built.persona,
      dir,
      validation: built.validation
    }

    drafts.set(workspaceId, record)
    if (runtime) runtime.startPreview(previewTheme, workspaceId)
    onChanged()
    return {
      ok: true,
      draftId: workspaceId,
      themeId: built.manifest.id,
      name: record.name,
      dir,
      preview: previewTheme,
      validation: built.validation,
      contrastAdjustments: draft.contrast_adjustments || []
    }
  }

  /** Re-preview with a revised design (incremental, same draft id). */
  function reviseDraft({ draftId, draft, prompt, intent, name } = {}) {
    const record = drafts.get(draftId)
    const next = previewDraft({
      draft,
      id: record?.themeId,
      name: name || record?.name,
      prompt,
      intent,
      draftId
    })
    if (next.ok) {
      const updated = drafts.get(draftId)
      if (updated) updated.revision = (record?.revision || 0) + 1
    }
    return next
  }

  /** Discard a preview and delete its temp workspace. */
  function discardDraft(draftId) {
    const record = drafts.get(draftId)
    if (runtime) runtime.cancelPreview()
    if (record) {
      try {
        if (isInside(registry.workspaceDir(), record.dir)) rmrf(record.dir)
      } catch (error) {
        log(`draft cleanup failed: ${error?.message || error}`)
      }
      drafts.delete(draftId)
    }
    onChanged()
    return { ok: true, draftId }
  }

  /**
   * Approve a previewed draft: register + install into the production theme
   * directory and make it active.
   */
  function approveDraft(draftId) {
    const record = drafts.get(draftId)
    if (!record) return { ok: false, reason: 'draft_not_found', draftId }
    if (!record.validation || !record.validation.ok) {
      return { ok: false, reason: 'validation_failed', draftId, issues: record.validation?.issues || [] }
    }

    const themesDir = registry.userThemesDir()
    const target = path.join(themesDir, record.themeId)
    if (!isInside(themesDir, target)) {
      return { ok: false, reason: 'target_outside_themes_dir', draftId }
    }

    // Promote: copy the validated temp package into the production directory.
    try {
      fs.mkdirSync(themesDir, { recursive: true })
      rmrf(target)
      copyTree(record.dir, target)
    } catch (error) {
      return { ok: false, reason: 'install_failed', draftId, issues: [{ severity: 'error', code: 'install_failed', message: String(error?.message || error) }] }
    }

    // Stamp installed_at and validate the promoted copy (not the temp one).
    try {
      const manifestPath = path.join(target, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.installed_at = new Date().toISOString()
      manifest.source = 'generated'
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    } catch (error) {
      log(`manifest stamp failed for ${record.themeId}: ${error?.message || error}`)
    }

    const promoted = validator.validatePackage({
      dir: target,
      darkTokens: registry.darkTokens(),
      expectedId: record.themeId
    })
    if (!promoted.ok) {
      try { rmrf(target) } catch {}
      return { ok: false, reason: 'installed_package_invalid', draftId, issues: promoted.issues }
    }

    const registered = registry.register(record.themeId)
    // Promoting a draft ends the preview: the previewed design *becomes* the
    // installed theme, so the dock must stop painting a draft.
    if (runtime) runtime.cancelPreview()
    const status = runtime ? runtime.activate(record.themeId, { persist: true, reason: 'installed' }) : null
    try {
      if (isInside(registry.workspaceDir(), record.dir)) rmrf(record.dir)
    } catch {}
    drafts.delete(draftId)
    onChanged()

    return {
      ok: true,
      id: record.themeId,
      name: record.name,
      dir: target,
      registered: registered.ok,
      status,
      validation: promoted
    }
  }

  /**
   * Delete a theme (spec §17).
   *
   * @returns {{ok: boolean, reason?: string, switchedTo?: string}}
   */
  function deleteTheme(id) {
    if (!id) return { ok: false, reason: 'id_required' }
    const records = registry.list()
    const record = records.find((entry) => entry.id === id)
    if (!record) return { ok: false, reason: 'not_found', id }

    // 1 + 2. protected / system themes can never be deleted.
    if (record.protected || record.system_theme || record.source === 'system') {
      log(`delete refused for protected theme ${id}`)
      return { ok: false, reason: 'protected', id, message: 'Dark and Light are protected system themes and cannot be deleted.' }
    }

    // 3. if it is the active theme, switch to Dark first.
    let switchedTo = null
    if (runtime && runtime.activeId === id) {
      const status = runtime.activate(registry.RECOVERY_THEME_ID, { persist: true, reason: 'deleted-active-theme' })
      switchedTo = status.id
    }

    // 4. unregister.
    const unregistered = registry.unregister(id)
    if (!unregistered.ok) return { ok: false, reason: unregistered.reason, id }

    // 5 + 6. delete the theme's own files and cache.
    //
    // Only *user* themes own files that may be removed. A built-in demo theme is
    // shipped application data: deleting it from the list hides it (and is
    // reversible through restoreBuiltin) rather than destroying the package that
    // every installation shares.
    const removed = []
    if (record.source === 'builtin-demo') {
      registry.hideBuiltin(id)
    } else {
      const dirs = [path.join(registry.userThemesDir(), id)]
      for (const dir of dirs) {
        if (!isInside(registry.userThemesDir(), dir)) continue
        if (!fs.existsSync(dir)) continue
        try {
          rmrf(dir)
          removed.push(dir)
        } catch (error) {
          log(`theme file removal failed for ${dir}: ${error?.message || error}`)
        }
      }
    }
    try {
      const stateDir = path.join(registry.workspaceDir(), 'cache')
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(path.join(stateDir, `${id}.removed`), new Date().toISOString(), 'utf8')
    } catch {}

    // 7. refresh.
    onChanged()
    const remaining = listThemes()
    return { ok: true, id, switchedTo, removedDirs: removed, remaining: remaining.themes.length }
  }

  /** Restore a built-in demo theme to its factory state (spec §12.3). */
  function restoreBuiltin(id) {
    const spec = registry.builtinSpecs().find((entry) => entry.id === id)
    if (!spec) return { ok: false, reason: 'not_a_builtin_theme', id }
    if (spec.source === 'system') return { ok: false, reason: 'protected', id }
    const exists = fs.existsSync(path.join(spec.dir, 'manifest.json'))
    if (!exists) {
      return {
        ok: false,
        reason: 'factory_package_missing',
        id,
        message: 'the built-in demo package is not present in this installation; regenerate it with extensions/mega/theme/builtin/generate-demos.cjs'
      }
    }
    const report = validator.validatePackage({ dir: spec.dir, darkTokens: registry.darkTokens(), expectedId: id })
    if (!report.ok) return { ok: false, reason: 'factory_package_invalid', id, issues: report.issues }
    // Un-hide first, then register: `restore` must work for a theme that was
    // deleted from the list as well as for one that is merely unregistered.
    const unhidden = registry.unhideBuiltin(id)
    const registered = registry.register(id)
    log(`restore builtin ${id}: unhidden=${unhidden} registered=${registered.ok}${registered.ok ? '' : ` (${registered.reason})`}`)
    onChanged()
    return { ok: true, id, registered: registered.ok, unhidden, validation: report }
  }

  /**
   * Duplicate a theme. The copy is fully self-contained: the source's compiled
   * tokens/slots/assets are written into the new package and are *not* linked to
   * the original in any way (spec §11.1/§11.2)  — only `derived_from` metadata
   * records the history.
   */
  function duplicateTheme(id, { name } = {}) {
    const record = registry.list().find((entry) => entry.id === id)
    if (!record) return { ok: false, reason: 'not_found', id }
    const newId = registry.uniqueUserId(name || `${record.name} copy`)
    let source = null
    try {
      source = readPackage(record.dir, id)
    } catch (error) {
      return { ok: false, reason: 'source_unreadable', id, issues: [{ severity: 'error', code: 'source_unreadable', message: String(error?.message || error) }] }
    }
    if (!source.ok) return { ok: false, reason: source.reason, id, issues: source.issues }

    const themesDir = registry.userThemesDir()
    const target = path.join(themesDir, newId)
    const sourceEvents = (source.theme.manifest.revision_history || [])
    const draft = {
      design_language: source.theme.manifest.design_language || record.id,
      palette: source.theme.manifest.palette || record.name,
      palette_label: record.name,
      mode: source.theme.manifest.mode || 'dark',
      style_tag: source.theme.manifest.design_language || 'research',
      tokens: source.theme.declaredTokens,
      palette_values: {
        base: source.theme.tokens['color.bg.base'],
        layer1: source.theme.tokens['color.bg.layer1'],
        layer2: source.theme.tokens['color.bg.layer2'],
        accent: source.theme.tokens['color.accent.primary'],
        accentSecondary: source.theme.tokens['color.accent.secondary'],
        label: source.theme.tokens['color.label.primary']
      },
      components: {
        slots: copySlots(source.theme),
        animation: source.theme.components.animation
      },
      persona: source.theme.persona,
      intent: { density: 'normal', motion: 'none', decoration: 'medium_low' }
    }

    const built = builder.buildPackage({
      draft,
      id: newId,
      name: name || `${record.name} copy`,
      outDir: target,
      source: 'duplicated',
      generatedPrompt: record.generated_prompt,
      derivedFrom: id,
      revisionHistory: sourceEvents,
      darkTokens: registry.darkTokens()
    })
    if (!built.ok) return { ok: false, reason: built.reason, id, issues: built.issues }

    const registered = registry.register(newId)
    onChanged()
    return { ok: true, id: newId, from: id, dir: target, registered: registered.ok, validation: built.validation }
  }

  /** Read a theme package for the UI (tokens/slots/preview). */
  function inspectTheme(id) {
    const record = registry.list().find((entry) => entry.id === id)
    if (!record) return { ok: false, reason: 'not_found', id }
    const loaded = readPackage(record.dir, id)
    if (!loaded.ok) return { ok: false, reason: loaded.reason, id, issues: loaded.issues }
    return { ok: true, record, theme: loaded.theme }
  }

  /** Import a theme package from an arbitrary directory (self-contained copy). */
  function importTheme(sourceDir, { name } = {}) {
    const probe = validator.validatePackage({ dir: sourceDir, darkTokens: registry.darkTokens() })
    if (!probe.metadata) return { ok: false, reason: 'manifest_missing', issues: probe.issues }
    const id = registry.uniqueUserId(name || probe.metadata.name || 'imported')
    const target = path.join(registry.userThemesDir(), id)
    try {
      fs.mkdirSync(registry.userThemesDir(), { recursive: true })
      rmrf(target)
      copyTree(sourceDir, target)
      const manifestPath = path.join(target, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      manifest.id = id
      manifest.name = name || probe.metadata.name || id
      manifest.source = 'imported'
      manifest.protected = false
      manifest.deletable = true
      manifest.installed_at = new Date().toISOString()
      manifest.derived_from = probe.metadata.id || null
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, reason: 'import_failed', issues: [{ severity: 'error', code: 'import_failed', message: String(error?.message || error) }] }
    }
    const report = validator.validatePackage({ dir: target, darkTokens: registry.darkTokens(), expectedId: id })
    if (!report.ok) {
      try { rmrf(target) } catch {}
      return { ok: false, reason: 'imported_package_invalid', issues: report.issues }
    }
    const registered = registry.register(id)
    onChanged()
    return { ok: true, id, dir: target, registered: registered.ok, validation: report }
  }

  return {
    listThemes,
    applyTheme,
    previewDraft,
    reviseDraft,
    discardDraft,
    approveDraft,
    deleteTheme,
    restoreBuiltin,
    duplicateTheme,
    inspectTheme,
    importTheme,
    drafts: () => new Map(drafts)
  }
}

/** Copy a built-in demo id to its directory slug. */
function demoSlug(id) {
  return String(id).replace(/^hns\.demo\./, '')
}

function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false })
}

/** Slots are copied verbatim: the duplicate owns its own copy. */
function copySlots(theme) {
  const slots = {}
  for (const [slotId, payload] of Object.entries(theme.components?.slots || {})) {
    slots[slotId] = { ...payload }
  }
  return slots
}

module.exports = {
  isInside,
  demoSlug,
  copyTree,
  createLifecycle
}
