'use strict'
/**
 * Theme engine integration scenarios.
 *
 * Data file for `generate-theme-engine-test.cjs`. Each scenario declares the step
 * bodies and the assertions that must hold, so the generated test file stays a
 * thin, readable shell.
 *
 * `steps[stepId]` is the body of an async function running inside a sandboxed
 * child process (see tests/helpers/theme-sandbox.cjs).
 */

/** Shared scenario preamble: a started engine with no-op logging and rendering. */
const ENGINE = "const engine = engineModule.createThemeEngine({ log: () => {}, applyToRenderer: () => {} })\nengine.start()"

/**
 * Dedent a script body.
 *
 * Used as a tagged template (`code\`...\``), so the result must be a plain string:
 * the generator JSON-encodes whatever it receives.
 *
 * A leading `${ENGINE}` interpolation is written flush-left by the template
 * literal (interpolated lines start at column 0), so it is lifted out before the
 * common indent is computed and re-prepended afterwards. That keeps every
 * scenario's body uniformly indented without hand-aligning every call site.
 */
function code(strings, ...values) {
  const raw = Array.isArray(strings) ? strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '') : String(strings)
  const all = raw.replace(/\t/g, '  ').split('\n')
  while (all.length && !all[0].trim()) all.shift()
  while (all.length && !all[all.length - 1].trim()) all.pop()

  const engineLine = all[0] === ENGINE ? all.shift() : null
  let rest = all
  // A template literal's first line keeps the source indentation of the opening
  // backtick while its siblings carry their body indentation. When the first line
  // is indented and the rest are not, that opening indentation is the common one.
  const first = all[0] || ''
  if (first.trim() && /^\s+/.test(first)) {
    const opening = first.match(/^ */)[0]
    rest = [first.slice(opening.length), ...all.slice(1).map((line) => (line.startsWith(opening) ? line.slice(opening.length) : line))]
  }
  const indents = rest.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length)
  const indent = indents.length ? Math.min(...indents) : 0
  const body = rest.map((line) => line.slice(indent)).join('\n').trim()
  return engineLine ? `${engineLine}\n${body}` : body
}

const SCENARIO_LIST = [
  // -------------------------------------------------------------------------
  // pipeline
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'the full prompt -> preview -> approval -> install pipeline works on a clean install',
    steps: {
      boot: {
        boot: code`
          const paints = []
          const engine = engineModule.createThemeEngine({
            log: () => {},
            applyToRenderer: (payload) => paints.push({ id: payload.id, preview: payload.preview, effect: payload.effectLabel })
          })
          engine.start()
          const before = engine.describe()
          return { paints, active: before.active, themeCount: before.themes.length }`
      },
      create: {
        create: code`
        ${ENGINE}
          const result = await engine.orchestrator.createTheme({
            prompt: '银发角色，黑灰蓝色调，看起来像未来科研工作站，人物别太抢屏'
          })
          return {
            ok: result.ok,
            stage: result.stage,
            validationOk: result.validation.ok,
            failures: result.validation.failures.map((f) => f.id),
            warnings: result.validation.warnings.length,
            intent: result.intent,
            capability: result.capability,
            snapshot: result.snapshot
          }`
      },
      notInstalledBeforeApproval: {
        notInstalled: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '赛博全息 HUD，黑灰蓝' })
          const list = engine.describe()
          const userThemes = list.themes.filter((theme) => theme.source !== 'system' && theme.source !== 'builtin-demo')
          return {
            created: created.ok,
            stage: created.stage,
            previewing: list.previewing,
            installed: userThemes.map((theme) => theme.id)
          }`
      },
      approve: {
        approve: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '赛博全息 HUD，黑灰蓝，扫描线' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          const after = engine.describe()
          const record = after.themes.find((theme) => theme.id === approved.id)
          return {
            approveOk: approved.ok,
            stage: approved.stage,
            id: approved.id,
            activeAfterApprove: after.active,
            registered: approved.registered,
            recordExists: Boolean(record),
            recordSource: record ? record.source : null,
            recordActive: record ? record.active : null,
            recordValidationOk: record ? record.validation.ok : null,
            previewingAfter: after.previewing
          }`
      },
      revisionIsIncremental: {
        revision: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '银发角色，紫蓝色调，未来科研工作站' })
          const revised = await engine.orchestrator.reviseTheme({ draftId: created.draftId, prompt: '人物再小一点，按钮不要这么亮' })
          const session = engine.orchestrator.sessions().get(created.draftId)
          return {
            ok: revised.ok,
            changed: revised.changed,
            revision: revised.revision,
            prominenceBefore: created.intent.persona.prominence,
            prominenceAfter: revised.intent.persona.prominence,
            designLanguagePreserved: revised.intent.design_language === created.intent.design_language,
            palettePreserved: JSON.stringify(revised.intent.palette) === JSON.stringify(created.intent.palette),
            historyLength: session ? (session.history || []).length : 0
          }`
      },
      discardLeavesNothing: {
        discard: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '极简浅色中性' })
          const discarded = engine.orchestrator.discard({ draftId: created.draftId })
          const after = engine.describe()
          return {
            discarded: discarded.ok,
            userThemes: after.themes.filter((theme) => theme.source === 'generated').length,
            previewing: after.previewing
          }`
      }
    },
    asserts: [
      "assert.equal(value.boot.active, 'hns.system.dark', 'a clean install starts on the Dark recovery theme')",
      "assert.equal(value.boot.themeCount, 5, 'installed: Dark, Light and three demo themes')",
      'assert.ok(value.boot.paints.length >= 1)',
      'assert.equal(value.boot.paints[0].preview, false)',
      '',
      'assert.equal(value.create.ok, true)',
      "assert.equal(value.create.stage, 'preview', 'a prompt stops at a preview')",
      'assert.equal(value.create.validationOk, true, `preview validation failed: ${JSON.stringify(value.create.failures)}`)',
      'assert.equal(value.create.failures.length, 0)',
      "assert.equal(value.create.intent.persona.character, 'silver_hair_assistant')",
      'assert.ok(value.create.intent.persona.prominence <= 0.2)',
      'assert.ok(value.create.capability.writableSlots > 25)',
      'assert.equal(value.create.capability.canThemeOfficialUi, false)',
      'assert.ok(Array.isArray(value.create.capability.states) && value.create.capability.states.length === 10)',
      '',
      'assert.equal(value.notInstalled.created, true)',
      "assert.equal(value.notInstalled.stage, 'preview')",
      "assert.equal(value.notInstalled.previewing, true, 'the dock is showing a live preview')",
      "assert.deepEqual(value.notInstalled.installed, [], 'nothing is installed before approval')",
      '',
      'assert.equal(value.approve.approveOk, true)',
      "assert.equal(value.approve.stage, 'installed')",
      "assert.ok(value.approve.id.startsWith('hns.user.'))",
      'assert.equal(value.approve.recordExists, true)',
      "assert.equal(value.approve.recordSource, 'generated')",
      "assert.equal(value.approve.recordActive, true, 'an approved theme becomes active')",
      'assert.equal(value.approve.recordValidationOk, true)',
      'assert.equal(value.approve.previewingAfter, false)',
      '',
      'assert.equal(value.revision.ok, true)',
      "assert.deepEqual(value.revision.changed, ['motion', 'persona'])",
      'assert.equal(value.revision.revision, 1)',
      'assert.ok(value.revision.prominenceAfter < value.revision.prominenceBefore)',
      "assert.equal(value.revision.designLanguagePreserved, true, 'an unmentioned decision survives a revision')",
      'assert.equal(value.revision.palettePreserved, true)',
      'assert.equal(value.revision.historyLength, 1)',
      '',
      'assert.equal(value.discard.discarded, true)',
      "assert.equal(value.discard.userThemes, 0, 'discarding a draft installs nothing')",
      'assert.equal(value.discard.previewing, false)'
    ]
  },

  // -------------------------------------------------------------------------
  // protection / deletion
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'protected system themes can never be deleted, and deleting the active theme returns to Dark',
    steps: {
      protection: {
        protection: code`
        ${ENGINE}
          const dark = engine.orchestrator.deleteTheme('hns.system.dark')
          const light = engine.orchestrator.deleteTheme('hns.system.light')
          const unknown = engine.orchestrator.deleteTheme('nope')
          const listed = engine.describe().themes.map((theme) => theme.id)
          return {
            dark, light, unknown,
            darkStillListed: listed.includes('hns.system.dark'),
            lightStillListed: listed.includes('hns.system.light')
          }`
      },
      deleteActive: {
        deleteActive: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '赛博全息 HUD' })
          await engine.orchestrator.approve({ draftId: created.draftId })
          const activeId = engine.describe().active
          const removed = engine.orchestrator.deleteTheme(activeId)
          const after = engine.describe()
          return {
            activeId,
            removed,
            activeAfter: after.active,
            stillListed: after.themes.some((theme) => theme.id === activeId),
            remaining: after.themes.length
          }`
      },
      deleteDemo: {
        deleteDemo: code`
        ${ENGINE}
          const removed = engine.orchestrator.deleteTheme('hns.demo.cyber-hud')
          const restored = engine.orchestrator.restoreBuiltin('hns.demo.cyber-hud')
          const restoreProtected = engine.orchestrator.restoreBuiltin('hns.system.dark')
          return { removed, restored, restoreProtected, listed: engine.describe().themes.map((t) => t.id) }`
      }
    },
    asserts: [
      'assert.equal(value.protection.dark.ok, false)',
      "assert.equal(value.protection.dark.reason, 'protected')",
      "assert.equal(value.protection.light.reason, 'protected')",
      "assert.equal(value.protection.unknown.reason, 'not_found')",
      'assert.equal(value.protection.darkStillListed, true)',
      'assert.equal(value.protection.lightStillListed, true)',
      '',
      'assert.equal(value.deleteActive.removed.ok, true)',
      "assert.equal(value.deleteActive.removed.switchedTo, 'hns.system.dark', 'deleting the active theme switches to Dark first')",
      "assert.equal(value.deleteActive.activeAfter, 'hns.system.dark')",
      'assert.equal(value.deleteActive.stillListed, false)',
      'assert.ok(value.deleteActive.remaining >= 5)',
      '',
      'assert.equal(value.deleteDemo.removed.ok, true)',
      "assert.equal(value.deleteDemo.restored.ok, true, `a built-in demo theme can be restored after deletion: ${value.deleteDemo.restored.reason || ''}`)",
      "assert.equal(value.deleteDemo.restoreProtected.reason, 'protected', 'a system theme cannot be factory-restored either')",
      "assert.deepEqual(value.deleteDemo.hidden || [], [], 'restoring clears the hidden marker')",
      "assert.ok(value.deleteDemo.listed.includes('hns.demo.cyber-hud'), `the restored demo is listed again: restored=${JSON.stringify(value.deleteDemo.restored)} hidden=${JSON.stringify(value.deleteDemo.hidden)} listed=${JSON.stringify(value.deleteDemo.listed)}`)"
    ]
  },

  // -------------------------------------------------------------------------
  // self-containment
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'duplication produces a self-contained copy with no runtime link to its source',
    steps: {
      duplicate: {
        duplicate: code`
          const fs = require('node:fs')
          const path = require('node:path')
          ${ENGINE}
          const copied = await engine.orchestrator.duplicateTheme('hns.demo.cyber-hud', { name: 'cyber copy' })
          if (!copied.ok) {
            return { ok: false, error: copied.reason, issues: (copied.issues || []).map((issue) => issue.message) }
          }
          const copyManifest = JSON.parse(fs.readFileSync(path.join(copied.dir, 'manifest.json'), 'utf8'))
          const copyTokens = JSON.parse(fs.readFileSync(path.join(copied.dir, 'tokens.json'), 'utf8'))
          const hasWallpaper = fs.existsSync(path.join(copied.dir, 'assets', 'wallpapers', 'main.png'))
          // Deleting the source template must not disturb the copy.
          engine.orchestrator.deleteTheme('hns.demo.cyber-hud')
          const afterDelete = engine.lifecycle.inspectTheme(copied.id)
          return {
            ok: true,
            id: copied.id,
            from: copied.from,
            derivedFrom: copyManifest.derived_from,
            copyHasOwnAssets: hasWallpaper,
            copyHasOwnTokens: Object.keys(copyTokens).length > 20,
            copySurvivesSourceDeletion: afterDelete.ok,
            copyValidationOk: afterDelete.ok ? afterDelete.record.validation.ok : false,
            noParentField: !Object.prototype.hasOwnProperty.call(copyManifest, 'parent_theme') && !Object.prototype.hasOwnProperty.call(copyManifest, 'required_theme')
          }`
      }
    },
    asserts: [
      "assert.equal(value.duplicate.ok, true, `duplication failed: ${value.duplicate.error || ''} ${JSON.stringify(value.duplicate.issues || [])}`)",
      'assert.notEqual(value.duplicate.id, value.duplicate.from)',
      "assert.equal(value.duplicate.derivedFrom, 'hns.demo.cyber-hud')",
      'assert.equal(value.duplicate.copyHasOwnAssets, true)',
      'assert.equal(value.duplicate.copyHasOwnTokens, true)',
      "assert.equal(value.duplicate.noParentField, true, 'no runtime dependency field is written')",
      "assert.equal(value.duplicate.copySurvivesSourceDeletion, true, 'deleting the source theme cannot affect the copy')",
      'assert.equal(value.duplicate.copyValidationOk, true)'
    ]
  },

  // -------------------------------------------------------------------------
  // recovery
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'a broken package recovers to Dark instead of taking the dock down',
    steps: {
      recovery: {
        recovery: code`
          const fs = require('node:fs')
          const path = require('node:path')
          ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '二次元角色，紫蓝色调' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          // Corrupt the installed theme the way a disk failure would.
          fs.writeFileSync(path.join(approved.dir, 'manifest.json'), '{ broken', 'utf8')
          const record = engine.registry.list().find((theme) => theme.id === approved.id)
          const applied = engine.orchestrator.applyTheme(approved.id)
          const paint = engine.paintPayload()
          return {
            markedBroken: record ? record.broken : null,
            brokenCodes: record ? record.validation.issues.filter((i) => i.severity === 'error').map((i) => i.code) : [],
            applyOk: applied.ok,
            applyReason: applied.reason,
            recovered: applied.recovered,
            activeAfter: engine.describe().active,
            paintId: paint.id,
            paintTokens: Object.keys(paint.tokens || {}).length
          }`
      },
      missingAssetRecovery: {
        missingAsset: code`
          const fs = require('node:fs')
          const path = require('node:path')
          ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '赛博全息 HUD' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          // Remove the compiled asset files: the package is now incomplete.
          fs.rmSync(path.join(approved.dir, 'assets'), { recursive: true, force: true })
          const record = engine.registry.list().find((theme) => theme.id === approved.id)
          const applied = engine.orchestrator.applyTheme(approved.id)
          return {
            broken: record ? record.broken : null,
            codes: record ? record.validation.issues.filter((i) => i.severity === 'error').map((i) => i.code) : [],
            recovered: applied.recovered,
            active: engine.describe().active
          }`
      },
      fallbackConstants: {
        fallback: code`
          const recovery = requireApp('extensions/mega/theme/recovery')
          const contract = requireApp('extensions/mega/theme/contract')
          const theme = recovery.fallbackTheme('hns.system.dark')
          return {
            tokenCount: Object.keys(theme.tokens).length,
            expected: contract.TOKEN_NAMES.length,
            slotCount: Object.keys(theme.components.slots).length,
            assetsNeutralised: theme.tokens['asset.wallpaper'] === 'none',
            personaOff: theme.persona.enabled === false
          }`
      }
    },
    asserts: [
      "assert.equal(value.recovery.markedBroken, true, 'an unparsable manifest marks the record broken')",
      "assert.ok(value.recovery.brokenCodes.includes('manifest_unparsable'))",
      "assert.equal(value.recovery.applyOk, false, 'applying a broken theme is refused')",
      'assert.equal(value.recovery.recovered, true)',
      "assert.equal(value.recovery.activeAfter, 'hns.system.dark', 'the engine falls back to Dark')",
      "assert.equal(value.recovery.paintId, 'hns.system.dark')",
      "assert.ok(value.recovery.paintTokens > 20, 'the dock still receives a complete paint payload')",
      '',
      'assert.equal(value.missingAsset.broken, true)',
      "assert.ok(value.missingAsset.codes.includes('asset_missing'))",
      'assert.equal(value.missingAsset.recovered, true)',
      "assert.equal(value.missingAsset.active, 'hns.system.dark')",
      '',
      'assert.equal(value.fallback.tokenCount, value.fallback.expected)',
      'assert.ok(value.fallback.slotCount > 20)',
      'assert.equal(value.fallback.assetsNeutralised, true)',
      'assert.equal(value.fallback.personaOff, true)'
    ]
  },

  // -------------------------------------------------------------------------
  // import
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'import copies a package into the user theme directory as a self-contained theme',
    steps: {
      import: {
        import: code`
          const path = require('node:path')
          ${ENGINE}
          // Build a standalone package the way another installation would export it.
          const draft = engine.designer.design({ intent: engine.designer.interpret('极简浅色中性，低装饰') })
          const outDir = path.join(process.env.DSH_ROOT, 'incoming-theme')
          const built = await engine.builder.buildPackage({
            draft, id: 'vendored.theme', name: 'Vendored Theme', outDir, source: 'generated'
          })
          const imported = engine.orchestrator.importTheme(outDir, { name: 'Vendored' })
          const record = imported.ok ? engine.registry.list().find((theme) => theme.id === imported.id) : null
          return {
            built: built.ok,
            imported,
            recordSource: record ? record.source : null,
            recordName: record ? record.name : null,
            manifestIdMatches: record ? record.id === imported.id : false
          }`
      }
    },
    asserts: [
      'assert.equal(value.import.built, true)',
      'assert.equal(value.import.imported.ok, true)',
      "assert.equal(value.import.recordSource, 'imported')",
      "assert.equal(value.import.recordName, 'Vendored')",
      'assert.equal(value.import.manifestIdMatches, true)'
    ]
  },

  // -------------------------------------------------------------------------
  // load degradation
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'the runtime degrades heavy effects under load without touching the theme package',
    steps: {
      degradation: {
        degradation: code`
          let load = { cpuPercent: 10, freeGb: 8, running: 0, slots: 4, capacity: 4 }
          const engine = engineModule.createThemeEngine({
            log: () => {},
            scheduler: {
              describe: () => ({
                system: { cpu: { usagePercent: load.cpuPercent }, memory: { freeGb: load.freeGb } },
                activeQueue: { running: load.running, workerSlotsInUse: load.slots },
                concurrency: { current: load.capacity }
              })
            },
            applyToRenderer: () => {}
          })
          engine.start()
          const created = await engine.orchestrator.createTheme({ prompt: '赛博全息 HUD，强烈动感，装饰丰富' })
          await engine.orchestrator.approve({ draftId: created.draftId })
          const idle = engine.paintPayload()

          // Load spikes: the runtime must down-grade, not fail.
          load = { cpuPercent: 97, freeGb: 0.4, running: 4, slots: 4, capacity: 4 }
          engine.runtime.sampleLoad()
          const loadedPaint = engine.paintPayload()

          // Recovery: effects come back.
          load = { cpuPercent: 5, freeGb: 9, running: 0, slots: 4, capacity: 4 }
          engine.runtime.sampleLoad()
          const restored = engine.runtime.describe()

          const record = engine.registry.list().find((theme) => theme.id === created.themeId)
          return {
            idleLevel: idle.effectLevel,
            loadedLevel: loadedPaint.effectLevel,
            loadedLabel: loadedPaint.effectLabel,
            loadedAnimation: loadedPaint.animation,
            idleAnimation: idle.animation,
            loadedWallpaperNeutralised: loadedPaint.tokens['asset.wallpaper'] === 'none',
            restoredLevel: restored.effectLevel,
            packageUntouched: record ? record.validation.ok : false
          }`
      }
    },
    asserts: [
      'assert.equal(value.degradation.idleLevel, 0)',
      "assert.equal(value.degradation.loadedLevel, 2, 'a saturated machine drops to the minimal effect budget')",
      "assert.equal(value.degradation.loadedAnimation.type, 'none')",
      "assert.equal(value.degradation.loadedWallpaperNeutralised, true, 'heavy assets are dropped under load')",
      "assert.equal(value.degradation.restoredLevel, 0, 'effects return when the load clears')",
      "assert.equal(value.degradation.packageUntouched, true, 'degradation never edits the installed theme package')"
    ]
  },

  // -------------------------------------------------------------------------
  // capability manifest
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'the capability manifest describes what may be themed and what may not',
    steps: {
      manifest: {
        manifest: code`
        ${ENGINE}
          const manifest = engine.capabilities()
          const permissions = Object.values(manifest.slots).map((slot) => slot.permission)
          return {
            app: manifest.app,
            apiVersion: manifest.theme_api_version,
            surfaces: manifest.themeable_surfaces.map((s) => ({ id: s.id, themable: s.themable, hint: Boolean(s.paletteHintOnly), permission: s.permission, writable: s.writable })),
            states: manifest.states,
            animations: manifest.capabilities.animations,
            canThemeOfficial: manifest.capabilities.can_theme_official_ui,
            personaMax: manifest.capabilities.persona_max_prominence,
            layoutOverride: manifest.capabilities.layout_override,
            structuralCount: permissions.filter((p) => p === 'STRUCTURAL').length,
            writableCount: permissions.filter((p) => p !== 'STRUCTURAL').length,
            protectedRegions: manifest.protected_regions.map((region) => region.id),
            pages: manifest.pages.map((page) => page.id)
          }`
      }
    },
    asserts: [
      "assert.equal(value.manifest.app, 'hns')",
      "assert.equal(value.manifest.apiVersion, '1.0')",
      "assert.equal(value.manifest.canThemeOfficial, false, 'the official renderer is never claimed as themable')",
      "assert.equal(value.manifest.layoutOverride, false, 'structural layout is never offered to the generator')",
      'assert.equal(value.manifest.personaMax, 0.4)',
      'assert.ok(value.manifest.structuralCount >= 3)',
      'assert.ok(value.manifest.writableCount >= 30)',
      'assert.equal(value.manifest.states.length, 10)',
      "assert.ok(value.manifest.animations.includes('soft_blur'))",
      'const surfaceIds = value.manifest.surfaces.map((s) => s.id).sort()',
      "assert.deepEqual(surfaceIds, ['hns_native', 'official_overlay', 'official_renderer', 'official_shell'], 'the manifest exposes exactly the four Theme Surfaces')",
      "const protectedSurface = value.manifest.surfaces.find((s) => s.id === 'official_renderer')",
      "assert.equal(protectedSurface.permission, 'protected', 'the official renderer is protected')",
      "assert.equal(protectedSurface.writable, false, 'the official renderer is never writable')",
      "assert.equal(protectedSurface.hint, true, 'the official UI is still exposed as a palette hint only')",
      "assert.equal(value.manifest.surfaces.find((s) => s.id === 'official_overlay').permission, 'visual-only', 'the official overlay is visual-only')",
      "assert.equal(value.manifest.surfaces.find((s) => s.id === 'official_shell').writable, true, 'the official shell is writable')",
      "assert.ok(value.manifest.protectedRegions.includes('queue-create'))",
      "assert.ok(value.manifest.pages.includes('dashboard'))"
    ]
  },

  // -------------------------------------------------------------------------
  // declarative payload
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'every theme paint payload is declarative data, never executable content',
    steps: {
      payload: {
        systemPayload: code`
        ${ENGINE}
          const paint = engine.paintPayload()
          const forbidden = /<script|javascript:|onerror=|onload=|eval\\(|new Function/i
          return {
            keys: Object.keys(paint).sort(),
            cssIsVarDeclarationsOnly: paint.css.split('\\n').every((line) => line.trim() === '' || /^--hns-[a-z0-9-]+: .+;$/.test(line.trim())),
            tokensInCss: paint.css.includes('--hns-color-bg-base:'),
            noExecutable: !forbidden.test(JSON.stringify(paint)),
            assetsAreDataUris: Object.entries(paint.tokens)
              .filter(([name]) => name.startsWith('asset.'))
              .every(([, value]) => value === 'none' || String(value).startsWith('data:image/')),
            personaConfined: paint.slots['hns.operator.widget'].position === 'corner-bottom-right'
          }`
      },
      userThemePayload: {
        userPayload: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '二次元银发角色，紫蓝色调，装饰丰富' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          const paint = engine.paintPayload()
          const forbidden = /<script|javascript:|onerror=|onload=|eval\\(|new Function/i
          return {
            approved: approved.ok,
            noExecutable: !forbidden.test(JSON.stringify(paint)),
            hasWallpaperDataUri: String(paint.tokens['asset.wallpaper']).startsWith('data:image/png;base64,'),
            hasAvatarDataUri: String(paint.tokens['asset.persona_avatar']).startsWith('data:image/png;base64,'),
            personaEnabled: paint.persona.enabled
          }`
      }
    },
    asserts: [
      "assert.deepEqual(value.systemPayload.keys, ['animation', 'css', 'draftId', 'effectLabel', 'effectLevel', 'id', 'name', 'officialPalette', 'persona', 'preview', 'slots', 'tokens'].sort())",
      "assert.equal(value.systemPayload.cssIsVarDeclarationsOnly, true, 'the paint payload only carries CSS custom properties')",
      'assert.equal(value.systemPayload.tokensInCss, true)',
      'assert.equal(value.systemPayload.noExecutable, true)',
      'assert.equal(value.systemPayload.assetsAreDataUris, true)',
      'assert.equal(value.systemPayload.personaConfined, true)',
      '',
      'assert.equal(value.userPayload.approved, true)',
      'assert.equal(value.userPayload.noExecutable, true)',
      'assert.equal(value.userPayload.hasWallpaperDataUri, true)',
      'assert.equal(value.userPayload.hasAvatarDataUri, true)',
      'assert.equal(value.userPayload.personaEnabled, true)'
    ]
  },

  // -------------------------------------------------------------------------
  // package layout
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'the installed theme directory layout matches the documented package structure',
    steps: {
      layout: {
        layout: code`
          const fs = require('node:fs')
          const path = require('node:path')
          ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '二次元银发角色，装饰丰富' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          const manifest = JSON.parse(fs.readFileSync(path.join(approved.dir, 'manifest.json'), 'utf8'))
          return {
            entries: fs.readdirSync(approved.dir).sort(),
            assets: fs.readdirSync(path.join(approved.dir, 'assets')).sort(),
            manifestFields: Object.keys(manifest).sort(),
            revisionHistory: manifest.revision_history.length,
            hasPrompt: typeof manifest.generated_prompt === 'string' && manifest.generated_prompt.length > 0,
            installedAt: Boolean(manifest.installed_at),
            previewPng: fs.existsSync(path.join(approved.dir, 'preview.png')),
            previewHtml: fs.existsSync(path.join(approved.dir, 'preview.html')),
            insideUserThemes: approved.dir.startsWith(engine.registry.userThemesDir())
          }`
      }
    },
    asserts: [
      "for (const required of ['manifest.json', 'tokens.json', 'components.json', 'persona.json', 'preview.png', 'preview.html', 'assets']) {",
      "  assert.ok(value.layout.entries.includes(required), `installed package contains ${required}`)",
      '}',
      "for (const required of ['decorations', 'icons', 'panels', 'persona', 'wallpapers']) {",
      "  assert.ok(value.layout.assets.includes(required), `assets/ contains ${required}`)",
      '}',
      "for (const field of ['id', 'name', 'version', 'source', 'protected', 'theme_api_version', 'supported_apps', 'created_at', 'generated_prompt', 'revision_history', 'derived_from']) {",
      "  assert.ok(value.layout.manifestFields.includes(field), `manifest declares ${field}`)",
      '}',
      'assert.equal(value.layout.insideUserThemes, true)',
      'assert.equal(value.layout.previewPng, true)',
      'assert.equal(value.layout.previewHtml, true)',
      'assert.equal(value.layout.revisionHistory, 1)',
      'assert.equal(value.layout.hasPrompt, true)',
      'assert.equal(value.layout.installedAt, true)'
    ]
  },

  // -------------------------------------------------------------------------
  // persistence
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'the theme registry survives a reload and stays consistent with disk',
    steps: {
      persistence: {
        persistence: code`
          const fs = require('node:fs')
          const path = require('node:path')
          ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '深色工业监控台，冷灰钢蓝' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          engine.stop()
          const active = JSON.parse(fs.readFileSync(path.join(process.env.DSH_ROOT, 'data', 'state', 'theme-active.json'), 'utf8'))
          const registry = JSON.parse(fs.readFileSync(path.join(process.env.DSH_ROOT, 'data', 'state', 'theme-registry.json'), 'utf8'))

          // A fresh engine instance must see exactly the same world.
          const reloaded = engineModule.createThemeEngine({ log: () => {}, applyToRenderer: () => {} })
          reloaded.start()
          const after = reloaded.describe()
          const record = after.themes.find((theme) => theme.id === approved.id)
          return {
            activeId: active.id,
            registryEntries: registry.themes.map((entry) => ({ id: entry.id, source: entry.source, protected: entry.protected, hasPrompt: Boolean(entry.generated_prompt), hasApi: entry.theme_api_version === '1.0' })),
            reloadActive: after.active,
            reloadSeesTheme: Boolean(record),
            reloadRecordValidationOk: record ? record.validation.ok : false
          }`
      }
    },
    asserts: [
      "assert.ok(value.persistence.activeId.startsWith('hns.user.'))",
      "assert.equal(value.persistence.reloadActive, value.persistence.activeId, 'the active theme survives a restart')",
      'assert.equal(value.persistence.reloadSeesTheme, true)',
      'assert.equal(value.persistence.reloadRecordValidationOk, true)',
      'const entry = value.persistence.registryEntries.find((item) => item.id === value.persistence.activeId)',
      "assert.ok(entry, 'the user theme is recorded in the registry file')",
      'assert.equal(entry.protected, false)',
      'assert.equal(entry.hasPrompt, true)',
      'assert.equal(entry.hasApi, true)',
      "assert.ok(!value.persistence.registryEntries.some((item) => item.source === 'system'), 'system themes are never written to the user registry')"
    ]
  },

  // -------------------------------------------------------------------------
  // isolation
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'theme files never land outside their own directory',
    steps: {
      isolation: {
        isolation: code`
          const fs = require('node:fs')
          const path = require('node:path')
          ${ENGINE}
          const dataDir = path.join(process.env.DSH_ROOT, 'data')
          const before = fs.readdirSync(dataDir).sort()
          const created = await engine.orchestrator.createTheme({ prompt: '深色工业监控台，冷灰钢蓝' })
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          const after = fs.readdirSync(dataDir).sort()
          const files = []
          const walk = (dir) => {
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, item.name)
              if (item.isDirectory()) walk(full)
              else files.push(path.relative(approved.dir, full))
            }
          }
          walk(approved.dir)
          return {
            dataEntriesAdded: after.filter((item) => !before.includes(item)),
            escapes: files.filter((file) => file.startsWith('..')),
            fileCount: files.length
          }`
      }
    },
    asserts: [
      'assert.deepEqual(value.isolation.escapes, [])',
      'assert.ok(value.isolation.fileCount > 8)',
      "for (const entry of value.isolation.dataEntriesAdded) {",
      "  assert.ok(['themes', 'theme-workspace', 'state'].includes(entry), `unexpected data entry ${entry}`)",
      '}'
    ]
  },

  // -------------------------------------------------------------------------
  // shipped demos
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'the demo themes shipped in the repository are valid, self-contained packages',
    steps: {
      demos: {
        demos: code`
          const fs = require('node:fs')
          const path = require('node:path')
          const validator = requireApp('extensions/mega/theme/validator')
          const builtin = path.join(app, 'extensions', 'mega', 'theme', 'builtin')
          const results = []
          for (const relative of ['system/dark', 'system/light', 'demo/minimal-neutral', 'demo/anime-persona', 'demo/cyber-hud']) {
            const dir = path.join(builtin, relative)
            const report = validator.validatePackage({ dir })
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
            results.push({
              relative,
              ok: report.ok,
              errors: report.errors.map((e) => e.code),
              protected: Boolean(manifest.protected),
              deletable: manifest.deletable,
              source: manifest.source,
              hasPreview: fs.existsSync(path.join(dir, 'preview.png')) || manifest.source === 'system'
            })
          }
          return { results }`
      }
    },
    asserts: [
      'for (const demo of value.demos.results) {',
      '  assert.ok(demo.ok, `${demo.relative} must validate: ${demo.errors.join(\', \')}`)',
      '  assert.equal(demo.hasPreview, true, `${demo.relative} ships a preview`)',
      '}',
      "const byRelative = Object.fromEntries(value.demos.results.map((item) => [item.relative, item]))",
      "assert.equal(byRelative['system/dark'].protected, true)",
      "assert.equal(byRelative['system/dark'].deletable, false)",
      "assert.equal(byRelative['system/light'].protected, true)",
      "assert.equal(byRelative['demo/cyber-hud'].protected, false)",
      "assert.equal(byRelative['demo/cyber-hud'].deletable, true)"
    ]
  },

  // -------------------------------------------------------------------------
  // the four-surface visual pipeline (Update-Plan/General-Theme.md 任务 1-16)
  // -------------------------------------------------------------------------
  {
    kind: 'each',
    test: 'a prompt observes the UI, plans four surfaces, generates real assets and previews before install',
    steps: {
      pipeline: {
        surfaces: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '银发机械助手，半身，右下角，不挡主要内容' })
          const surfaces = engine.orchestrator.capabilities().themeable_surfaces
          return {
            ok: created.ok,
            reason: created.reason || null,
            stage: created.stage,
            surfaces: surfaces.map((s) => ({ id: s.id, permission: s.permission, writable: s.writable, protected: Boolean(s.protected) })),
            planSurfaces: (created.plans && created.plans.surfaces) || [],
            protectedSurface: created.plans && created.plans.protectedSurface
          }`,
        observation: code`
        ${ENGINE}
          const observed = await engine.orchestrator.observe({})
          const ui = engine.orchestrator.buildUiObservation(observed)
          return {
            observed: Boolean(observed),
            hasViewport: Boolean(ui.viewport && ui.viewport.width > 0),
            officialObserved: ui.official_bounds_observed,
            hasSafeRegion: Boolean(ui.safe_region && ui.safe_region.width > 0),
            criticalCount: (ui.critical_regions || []).length,
            criticalObserved: ui.critical_observed,
            slotCount: ui.slot_count,
            degraded: ui.degraded,
            reason: ui.reason || null
          }`,
        assets: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '银发机械助手，半身，右下角，不挡主要内容' })
          if (!created.ok) return { ok: false, reason: created.reason }
          const dir = engine.lifecycle.drafts().get(created.draftId).dir
          const planFile = path.join(dir, 'asset-plan.json')
          const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
          const character = plan.assets.find((entry) => entry.kind === 'official_character')
          const hnsCharacter = plan.assets.find((entry) => entry.kind === 'hns_character')
          const bytes = character && !character.disabled ? fs.readFileSync(path.join(dir, character.path)) : null
          const decoded = bytes ? pngModule.decodePng(bytes) : null
          let transparent = 0
          if (decoded) {
            for (let index = 3; index < decoded.data.length; index += 4) if (decoded.data[index] < 8) transparent += 1
          }
          return {
            ok: true,
            count: plan.count,
            surfaces: [...new Set(plan.assets.map((entry) => entry.surface))].sort(),
            characterDisabled: character ? character.disabled : null,
            characterTransparent: character ? character.transparency !== false && character.transparent === true : null,
            characterValidation: character ? character.validation : null,
            hnsCharacterPresent: Boolean(hnsCharacter),
            bytes: bytes ? bytes.length : 0,
            transparentRatio: decoded ? Number((transparent / (decoded.width * decoded.height)).toFixed(3)) : 0,
            width: decoded ? decoded.width : 0,
            height: decoded ? decoded.height : 0,
            prompts: plan.assets.map((entry) => entry.generation_prompt).filter(Boolean).length
          }`,
        preview: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '赛博全息 HUD，扫描线' })
          if (!created.ok) return { ok: false, reason: created.reason }
          const preview = created.preview || {}
          const dir = engine.lifecycle.drafts().get(created.draftId).dir
          const files = ['hns-preview.html', 'official-shell-preview.html', 'official-overlay-preview.html', 'composite-preview.html']
          return {
            ok: true,
            installedBeforeApproval: engine.lifecycle.listThemes().themes.some((theme) => theme.id === created.themeId),
            stages: Object.keys(preview.surfaces || {}).sort(),
            composite: Boolean(preview.surfaces && preview.surfaces.composite),
            onDisk: files.map((file) => ({ file, present: fs.existsSync(path.join(dir, 'preview', file)) })),
            installed: preview.installed === true
          }`,
        revision: code`
        ${ENGINE}
          const created = await engine.orchestrator.createTheme({ prompt: '银发机械助手，紫蓝色调，右下角' })
          if (!created.ok) return { ok: false, reason: created.reason }
          const draftDir = engine.lifecycle.drafts().get(created.draftId).dir
          const before = JSON.parse(fs.readFileSync(path.join(draftDir, 'asset-plan.json'), 'utf8'))
          const hashOf = (plan, kind) => {
            const entry = plan.assets.find((item) => item.kind === kind)
            if (!entry || entry.disabled) return null
            return crypto.createHash('sha256').update(fs.readFileSync(path.join(draftDir, entry.path))).digest('hex')
          }
          const wallpaperBefore = hashOf(before, 'wallpaper')
          const skinBefore = hashOf(before, 'official_skin')
          const characterBefore = hashOf(before, 'official_character')
          const revised = await engine.orchestrator.reviseTheme({ draftId: created.draftId, prompt: '人物小一点' })
          if (!revised.ok) return { ok: false, reason: revised.reason }
          const dirAfter = engine.lifecycle.drafts().get(created.draftId).dir
          const after = JSON.parse(fs.readFileSync(path.join(dirAfter, 'asset-plan.json'), 'utf8'))
          const hashAfter = (kind) => {
            const entry = after.assets.find((item) => item.kind === kind)
            if (!entry || entry.disabled) return null
            return crypto.createHash('sha256').update(fs.readFileSync(path.join(dirAfter, entry.path))).digest('hex')
          }
          const sizeOf = (plan, kind) => {
            const entry = plan.assets.find((item) => item.kind === kind)
            return entry ? [entry.width, entry.height] : null
          }
          return {
            ok: true,
            changed: revised.changed,
            scope: revised.scope,
            preserved: revised.preserved,
            wallpaperSame: wallpaperBefore !== null && wallpaperBefore === hashAfter('wallpaper'),
            skinSame: skinBefore !== null && skinBefore === hashAfter('official_skin'),
            characterSame: characterBefore !== null && characterBefore === hashAfter('official_character'),
            characterBefore: sizeOf(before, 'official_character'),
            characterAfter: sizeOf(after, 'official_character'),
            revision: revised.revision
          }`,
        fallback: code`
        ${ENGINE}
          // A theme generation whose image capability always fails must still produce
          // a complete, installable package.
          engine.orchestrator.setImageGenerator(async () => { throw new Error('image capability unavailable') })
          const created = await engine.orchestrator.createTheme({ prompt: '银发机械助手，右下角' })
          if (!created.ok) return { ok: false, reason: created.reason }
          const approved = await engine.orchestrator.approve({ draftId: created.draftId })
          const dir = path.join(process.env.DSH_ROOT, 'data', 'themes', 'user', created.themeId)
          const plan = JSON.parse(fs.readFileSync(path.join(dir, 'asset-plan.json'), 'utf8'))
          const character = plan.assets.find((entry) => entry.kind === 'official_character')
          return {
            ok: true,
            approved: approved.ok,
            disabledCount: plan.assets.filter((entry) => entry.disabled).length,
            degradedCount: plan.assets.filter((entry) => entry.degraded).length,
            characterProvenance: character ? character.provenance : null,
            characterDisabled: character ? character.disabled : null,
            onDisk: fs.existsSync(path.join(dir, 'manifest.json'))
          }`
      }
    },
    asserts: [
      'assert.equal(value.surfaces.ok, true, `theme creation failed: ${value.surfaces.reason}`)',
      "assert.equal(value.surfaces.stage, 'preview', 'a prompt still stops at the preview')",
      "assert.deepEqual(value.surfaces.surfaces.map((s) => s.id), ['hns_native', 'official_shell', 'official_overlay', 'official_renderer'])",
      "const byId = Object.fromEntries(value.surfaces.surfaces.map((s) => [s.id, s]))",
      "assert.equal(byId.hns_native.permission, 'full')",
      "assert.equal(byId.official_shell.permission, 'full')",
      "assert.equal(byId.official_overlay.permission, 'visual-only')",
      "assert.equal(byId.official_renderer.permission, 'protected')",
      "assert.equal(byId.official_renderer.writable, false, 'the official renderer is never writable')",
      "assert.equal(value.surfaces.protectedSurface, 'official_renderer')",
      "const renderer = value.surfaces.planSurfaces.find((s) => s.surface === 'official_renderer')",
      "assert.equal(renderer.writes, false, 'the design plans no write into the official renderer')",
      "assert.equal(renderer.protected, true)",
      "for (const planned of value.surfaces.planSurfaces.filter((s) => s.surface !== 'official_renderer')) {",
      "  assert.equal(planned.writes, true, `${planned.surface} is themed by this design`)",
      "}",
      '',
      'assert.equal(value.observation.observed, true, \'the pipeline observed the UI\')',
      'assert.equal(value.observation.hasViewport, true, \'the observation carries a viewport\')',
      'assert.equal(value.observation.hasSafeRegion, true, \'the observation derives a safe region\')',
      'assert.equal(typeof value.observation.degraded, \'boolean\')',
      'assert.equal(value.observation.criticalCount > 0, true, \'the observation derives critical regions even without live geometry\')',
      '',
      'assert.equal(value.assets.ok, true, `asset planning failed: ${value.assets.reason}`)',
      "assert.ok(value.assets.count >= 8, `the plan carries ${value.assets.count} assets`)",
      "assert.deepEqual(value.assets.surfaces, ['hns_native', 'official_overlay', 'official_shell'], 'assets land on the three writable surfaces')",
      "assert.equal(value.assets.characterTransparent, true, 'the official character is declared transparent')",
      "assert.equal(value.assets.hnsCharacterPresent, true, 'the HNS surface gets a real character too')",
      "assert.equal(value.assets.characterDisabled, false, 'the character was generated, not disabled')",
      "assert.equal(value.assets.characterValidation.transparent, true, 'the generated character really is transparent')",
      "assert.ok(value.assets.characterValidation.distinct_colors >= 2, 'the generated character is a real image')",
      "assert.ok(value.assets.characterValidation.ink_ratio > 0.05, `the character carries visible content (ink ${value.assets.characterValidation.ink_ratio})`)",
      "assert.ok(value.assets.transparentRatio > 0.1, `the character PNG on disk is transparent (${value.assets.transparentRatio})`)",
      "assert.ok(value.assets.width > 64 && value.assets.height > 64, 'the character has a usable size')",
      "assert.ok(value.assets.bytes > 1024, 'the character asset is a real file')",
      "assert.equal(value.assets.prompts, value.assets.count, 'every planned asset carries the prompt it was generated from')",
      '',
      'assert.equal(value.preview.ok, true)',
      "assert.equal(value.preview.installedBeforeApproval, false, 'nothing is installed before approval')",
      "assert.equal(value.preview.installed, false)",
      "assert.deepEqual(value.preview.stages, ['composite', 'hns_native', 'official_overlay', 'official_shell'])",
      "assert.equal(value.preview.composite, true, 'the composite preview exists')",
      "for (const file of value.preview.onDisk) {",
      "  assert.equal(file.present, true, `${file.file} is compiled into the package`)",
      "}",
      '',
      'assert.equal(value.revision.ok, true, `revision failed: ${value.revision.reason}`)',
      "assert.equal(value.revision.revision, 1)",
      "assert.equal(value.revision.wallpaperSame, true, 'a character-only revision keeps the wallpaper bytes')",
      "assert.equal(value.revision.skinSame, true, 'a character-only revision keeps the official skin bytes')",
      "assert.equal(value.revision.characterSame, false, 'the character itself was regenerated')",
      "assert.ok(value.revision.characterAfter[0] < value.revision.characterBefore[0], '人物小一点 really made the figure smaller')",
      "assert.ok(value.revision.preserved.includes('official_shell'), 'the revision reports what it preserved')",
      '',
      'assert.equal(value.fallback.ok, true, `fallback run failed: ${value.fallback.reason}`)',
      "assert.equal(value.fallback.approved, true, 'a theme whose image capability fails is still installable')",
      "assert.equal(value.fallback.characterDisabled, false, 'the procedural fallback produced the character')",
      "assert.equal(value.fallback.characterProvenance, 'procedural-fallback')",
      "assert.ok(value.fallback.degradedCount >= 1, 'the degradation is recorded rather than hidden')",
      "assert.equal(value.fallback.onDisk, true, 'the package exists on disk')"
    ]
  }
]

module.exports.code = code

module.exports = { scenarios: SCENARIO_LIST, code }
