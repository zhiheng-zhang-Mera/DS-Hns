'use strict'

/**
 * Asset Generator (Update-Plan/General-Theme.md 任务 4).
 *
 * Owns the *generation* half of the asset pipeline and nothing else: it turns one
 * asset-plan entry into one validated, processed, encoded PNG. It is the only
 * module that talks to an image-generation capability, and the capability is
 * injected — this module never reaches for a network client, a model SDK or the
 * official Harness.
 *
 * The mandated fallback chain lives here (任务 17):
 *
 *   1. real image generation        (when an `imageGenerator` is configured)
 *      -> validated; a bad answer is not accepted just because it came back
 *   2. retry                        (`retries`, default 1; each attempt is recorded)
 *   3. procedural fallback          (`assets/fallback.js` -> asset-factory)
 *      -> also validated, so the fallback cannot be a false green either
 *   4. disable that single asset    (the theme still builds; the item is reported)
 *
 * A failure at any stage returns a *result*, because the caller must be able to
 * degrade one asset instead of failing the whole theme.
 */
const path = require('node:path')

const assets = require('../asset-factory')
const png = require('../png')
const processor = require('./processor')
const validator = require('./validator')
const fallback = require('./fallback')
const surfaceModule = require('../surface')

/** A "real image" has to clear this before it is trusted as model output. */
const MODEL_IMAGE_MIN_EDGE = 192
const MODEL_IMAGE_MIN_BYTES = 2048
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * @param {object} options
 * @param {Function} [options.imageGenerator] async ({ prompt, spec, kind, surface }) => Buffer|Uint8Array|{buffer}|{data}
 * @param {number}   [options.retries]        model attempts after the first (default 1)
 * @param {number}   [options.timeoutMs]      per-attempt timeout
 * @param {Function} [options.log]
 */
function createAssetGenerator({ imageGenerator = null, retries = 1, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  const attempts = []

  function record(entry) {
    attempts.push({ at: new Date().toISOString(), ...entry })
    if (attempts.length > 256) attempts.splice(0, attempts.length - 256)
  }

  function modelAvailable() {
    return typeof imageGenerator === 'function'
  }

  /** Run the injected generator with a timeout; never throws. */
  async function callModel({ prompt, spec, kind, surface }) {
    let timer = null
    try {
      const raced = await Promise.race([
        Promise.resolve().then(() => imageGenerator({ prompt, spec, kind, surface })),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`image generation timed out after ${timeoutMs}ms`)), timeoutMs)
          timer.unref?.()
        })
      ])
      return { ok: true, value: raced }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Accept only a genuinely usable image from the model path. */
  function inspectModelImage(value, spec) {
    const buffer = Buffer.isBuffer(value)
      ? value
      : (value && Buffer.isBuffer(value.buffer) ? value.buffer : null)
    if (!buffer || !buffer.length) return { ok: false, reason: 'the image generator returned no bytes' }
    if (buffer.length < MODEL_IMAGE_MIN_BYTES) {
      return { ok: false, reason: `the image generator returned only ${buffer.length} bytes` }
    }
    const header = png.readPngHeader(buffer)
    if (!header) return { ok: false, reason: 'the image generator returned bytes that are not a PNG' }
    if (header.width < MODEL_IMAGE_MIN_EDGE || header.height < MODEL_IMAGE_MIN_EDGE) {
      return { ok: false, reason: `the image generator returned ${header.width}x${header.height}, below the ${MODEL_IMAGE_MIN_EDGE}px floor` }
    }
    const wanted = Number(spec.width) && Number(spec.height)
      ? spec.width / spec.height
      : null
    if (wanted) {
      const actual = header.width / header.height
      // Framing matters: a 16:9 plate stretched into a 2:3 half body is not the
      // asset the plan asked for, and no amount of cropping fixes a wrong subject.
      if (Math.max(actual / wanted, wanted / actual) > 2.2) {
        return { ok: false, reason: `the image generator returned ${header.width}x${header.height} (aspect ${actual.toFixed(2)}), far from the planned ${wanted.toFixed(2)}` }
      }
    }
    return { ok: true, buffer, header }
  }

  /**
   * Normalise any produced canvas/buffer into the planned box, with the planned
   * transparency. This is the only place an asset's pixels are reshaped.
   */
  function conform({ canvas, spec, base, kind }) {
    let working = canvas
    const notes = []
    const wantsTransparency = spec.transparent === true || base.transparent === true

    // A flat plate behind a character is the one defect worth fixing rather than
    // rejecting: the rest of the asset is fine and the transparency is derivable.
    if (wantsTransparency) {
      const knockout = processor.knockout(working, { tolerance: 26 })
      if (knockout.removed) {
        working = knockout.canvas
        notes.push(knockout.reason)
      }
    }
    if (base.framing === 'tile') {
      working = processor.fit(working, spec.width, spec.height, { mode: 'stretch' })
    } else if (base.framing === 'background') {
      working = processor.fit(working, spec.width, spec.height, { mode: 'cover' })
    } else {
      // Characters, plates, frames and sheets keep their aspect ratio: the layout
      // engine positions them, so distortion here would be unrecoverable.
      working = processor.fit(working, spec.width, spec.height, { mode: 'contain' })
    }
    if (wantsTransparency) {
      // `contain` letterboxes; trimming restores the real content box so the
      // layout engine measures the figure and not the letterbox.
      working = processor.trim(working, { margin: Math.round(Math.min(spec.width, spec.height) * 0.02) })
    }
    return { canvas: working, notes }
  }

  /**
   * Generate one asset.
   *
   * @param {object} options
   * @param {object} options.entry            asset plan entry (see assets/planner.js)
   * @param {object} options.palette          resolved theme palette
   * @param {string} [options.style]
   * @param {string} [options.seed]
   * @param {string} [options.character]
   * @param {string} [options.packagePath]    package-relative path the asset will be written to
   * @returns {Promise<object>} an asset result; never throws
   */
  async function generate({ entry, palette = {}, style = 'research', seed = 'asset', character = null, packagePath = null } = {}) {
    const plan = entry || {}
    const kind = String(plan.kind || '')
    const base = assets.REAL_ASSET_CATALOG[kind] || {}
    const targetSurface = plan.surface || base.surface || null

    const warnings = []
    const steps = []
    const result = {
      kind,
      surface: targetSurface,
      path: packagePath || null,
      plan: { ...plan },
      buffer: null,
      canvas: null,
      width: 0,
      height: 0,
      provenance: null,
      degraded: false,
      disabled: false,
      attempts: 0,
      warnings,
      steps,
      validation: null,
      reason: null
    }

    // A surface gate first: an asset destined for the protected renderer is never
    // even generated, so no bytes for it can exist anywhere in the pipeline.
    const gate = surfaceModule.assertWritable(targetSurface, { kind: 'asset', assetKind: kind, target: packagePath || kind })
    if (!gate.ok) {
      result.disabled = true
      result.reason = gate.code
      warnings.push(`${kind}: ${gate.reason}`)
      steps.push({ step: 'surface_gate', ok: false, detail: gate.code })
      record({ kind, surface: targetSurface, outcome: 'refused', reason: gate.code })
      return result
    }
    steps.push({ step: 'surface_gate', ok: true, detail: targetSurface })

    const spec = {
      width: Number(plan.width) || base.width || 256,
      height: Number(plan.height) || base.height || 256,
      framing: plan.framing || base.framing || 'half_body',
      transparent: plan.transparent === true || base.transparent === true
    }

    let canvas = null
    let source = null

    if (modelAvailable()) {
      const maxAttempts = 1 + Math.max(0, Number(retries) || 0)
      for (let attempt = 1; attempt <= maxAttempts && !canvas; attempt += 1) {
        result.attempts = attempt
        const call = await callModel({
          prompt: plan.generation_prompt || base.prompt || kind,
          spec,
          kind,
          surface: targetSurface
        })
        if (!call.ok) {
          warnings.push(`${kind}: model attempt ${attempt} failed (${call.reason})`)
          steps.push({ step: 'model_generate', ok: false, attempt, detail: call.reason })
          record({ kind, surface: targetSurface, outcome: 'model_failed', reason: call.reason, attempt })
          continue
        }
        const inspected = inspectModelImage(call.value, spec)
        if (!inspected.ok) {
          warnings.push(`${kind}: model attempt ${attempt} rejected (${inspected.reason})`)
          steps.push({ step: 'model_inspect', ok: false, attempt, detail: inspected.reason })
          record({ kind, surface: targetSurface, outcome: 'model_rejected', reason: inspected.reason, attempt })
          continue
        }
        try {
          canvas = png.decodePng(inspected.buffer)
          source = 'image-model'
          steps.push({ step: 'model_generate', ok: true, attempt, detail: `${inspected.header.width}x${inspected.header.height}` })
          record({ kind, surface: targetSurface, outcome: 'model_ok', attempt })
        } catch (error) {
          warnings.push(`${kind}: model attempt ${attempt} produced an undecodable PNG (${error?.message || error})`)
          steps.push({ step: 'model_decode', ok: false, attempt, detail: String(error?.message || error) })
          record({ kind, surface: targetSurface, outcome: 'model_undecodable', attempt })
        }
      }
    } else {
      steps.push({ step: 'model_generate', ok: false, detail: 'no image generator is configured for this build' })
    }

    if (!canvas) {
      const proc = fallback.render({ kind, surface: targetSurface, palette, spec, style, seed, framing: spec.framing, character })
      if (proc.canvas) {
        canvas = proc.canvas
        source = 'procedural-fallback'
        result.degraded = modelAvailable()
        steps.push({ step: 'procedural_fallback', ok: true, detail: proc.renderer })
        if (result.degraded) warnings.push(`${kind}: generated by the procedural fallback after the image generator did not deliver`)
        record({ kind, surface: targetSurface, outcome: 'procedural', reason: proc.reason })
      } else {
        result.disabled = true
        result.degraded = true
        result.reason = 'asset_generation_failed'
        warnings.push(`${kind}: disabled — ${proc.reason}`)
        steps.push({ step: 'procedural_fallback', ok: false, detail: proc.reason })
        record({ kind, surface: targetSurface, outcome: 'disabled', reason: proc.reason })
        return result
      }
    }

    const conformed = conform({ canvas, spec, base, kind })
    result.canvas = conformed.canvas
    for (const note of conformed.notes) warnings.push(`${kind}: ${note}`)
    steps.push({ step: 'process', ok: true, detail: `${conformed.canvas.width}x${conformed.canvas.height}` })

    const encoded = processor.toPng(conformed.canvas, { maxEdge: plan.max_edge || 0 })
    result.buffer = encoded.buffer
    result.canvas = encoded.canvas
    result.width = encoded.width
    result.height = encoded.height
    result.provenance = source
    result.bytes = encoded.buffer.length

    const verdict = validator.validate({
      kind,
      buffer: encoded.buffer,
      spec: { ...plan, width: encoded.width, height: encoded.height, transparent: spec.transparent },
      catalog: base
    })
    result.validation = verdict
    for (const soft of verdict.soft) warnings.push(`${kind}: ${soft.message}`)

    if (!verdict.ok) {
      // A produced-but-invalid asset is worse than a disabled one: it would be
      // placed on a real surface while failing every guarantee the layout and the
      // overlay safety validator rely on.
      result.disabled = true
      result.degraded = true
      result.buffer = null
      result.reason = verdict.reason
      steps.push({ step: 'validate', ok: false, detail: verdict.reason })
      record({ kind, surface: targetSurface, outcome: 'invalid', reason: verdict.reason })
      return result
    }
    steps.push({ step: 'validate', ok: true, detail: `${encoded.width}x${encoded.height}, ${encoded.buffer.length} bytes` })
    record({ kind, surface: targetSurface, outcome: 'ok', source, bytes: encoded.buffer.length })
    return result
  }

  return {
    generate,
    modelAvailable,
    history: () => attempts.slice(),
    clearHistory: () => { attempts.length = 0 },
    describe: () => ({
      imageGenerator: modelAvailable(),
      retries: Math.max(0, Number(retries) || 0),
      timeoutMs,
      attempts: attempts.length
    })
  }
}

/** Package-relative directory per asset kind, used by the builder. */
const ASSET_DIRECTORY = Object.freeze({
  wallpaper: 'assets/wallpapers',
  panel_texture: 'assets/panels',
  icon_set: 'assets/icons',
  persona_avatar: 'assets/persona',
  hns_character: 'assets/characters',
  official_character: 'assets/official',
  official_skin: 'assets/official',
  official_overlay_texture: 'assets/official',
  hud_decoration: 'assets/decorations',
  frame_decoration: 'assets/decorations',
  decoration: 'assets/decorations'
})

/** Package-relative file name per asset kind. */
const ASSET_FILENAME = Object.freeze({
  wallpaper: 'wallpaper.png',
  panel_texture: 'panel.png',
  icon_set: 'icon-set.png',
  persona_avatar: 'persona-avatar.png',
  hns_character: 'hns-character.png',
  official_character: 'official-character.png',
  official_skin: 'official-skin.png',
  official_overlay_texture: 'official-overlay-texture.png',
  hud_decoration: 'decoration-hud.png',
  frame_decoration: 'decoration-frame.png',
  decoration: 'decoration.png'
})

/** Every package-relative directory the asset pipeline can write into. */
const ASSET_DIRECTORIES = Object.freeze([...new Set(Object.values(ASSET_DIRECTORY))])

/** The package path an asset kind is written to. */
function packagePathFor(kind, entry = {}) {
  if (entry.path) return String(entry.path)
  const directory = ASSET_DIRECTORY[kind] || 'assets/decorations'
  const filename = ASSET_FILENAME[kind] || `${String(kind || 'asset').replace(/[^\w.-]+/g, '-')}.png`
  return path.posix.join(directory, filename)
}

/**
 * Fill in a plan entry's package path.
 *
 * The planner runs before the builder, so the path has to be decided by the
 * planner: the plan document the user approves must name the exact file the
 * installed package will carry, and the builder must not be free to move it.
 */
function withPackagePath(entry) {
  return { ...entry, path: packagePathFor(entry?.kind, entry) }
}

module.exports = {
  createAssetGenerator,
  ASSET_DIRECTORY,
  ASSET_DIRECTORIES,
  ASSET_FILENAME,
  packagePathFor,
  withPackagePath,
  MODEL_IMAGE_MIN_EDGE,
  MODEL_IMAGE_MIN_BYTES
}
