'use strict'

/**
 * The appearance controller (`updateplan/startup2.md` §26-§28).
 *
 * The product already has the two layers a desktop appearance is made of — the wallpaper (a picture per
 * backdrop, with its own opacity, blur and scrim) and the frosted glass the dock is made of — and what it
 * did not have is a *decision* about them. That is what this is: three readability presets, expressed as
 * numbers both layers already accept.
 *
 *   * **Work** (the default) — the plan's §5 numbers: enough picture to see it, enough darkening and
 *     glass to read text on for hours.
 *   * **Immersive** — more picture, less scrim, a lighter glass: for showing the wallpaper and short
 *     browsing, explicitly *not* the default (§5.2).
 *   * **Reading** — the opposite: the picture pulled back, the darkening and the glass up, for long text
 *     and code review (§5.3).
 *
 * Two rules, both of which the plan states as requirements rather than preferences:
 *
 *   1. **Readability first** (§4.2, "先保证文字长期可读，再谈通透感"). Every preset works with *no*
 *      wallpaper at all — the glass numbers alone are a complete appearance — and Reading is the
 *      strictest of the three.
 *   2. **A failure belongs to one layer, not to the appearance.** Applying a preset writes the glass and
 *      the wallpaper independently and reports each answer: a wallpaper that cannot be changed (no file
 *      chosen, the layer switched off) still leaves the glass at the preset's numbers, and the answer
 *      says so rather than pretending the whole thing failed.
 */

const { validate, toLayerPatch } = require('./tokens.cjs')

/**
 * The presets, in the units both layers already clamp to: glass opacity is a percentage (5-100), blur is
 * pixels (0-40), and a backdrop's opacity and scrim are percentages (0-100).
 */
const APPEARANCE_PRESETS = Object.freeze({
  work: Object.freeze({
    id: 'work',
    label: '工作 · Work',
    default: true,
    note: 'the shipped balance: the picture is visible and the text is not paying for it',
    glass: { blur: 12, opacity: 82 },
    wallpaper: {
      main: { opacity: 60, blur: 12, scrim: 18 },
      dock: { opacity: 82, blur: 12, scrim: 18 }
    },
    /** §5's numbers, under §27's names: brightness 60%, contrast 90%, saturation 80%, darkening 18%. */
    tokens: {
      '--dsh-surface-opacity': 82,
      '--dsh-surface-blur': 12,
      '--dsh-wallpaper-brightness': 0.6,
      '--dsh-wallpaper-contrast': 0.9,
      '--dsh-wallpaper-saturation': 0.8,
      '--dsh-wallpaper-darken': 18
    }
  }),
  immersive: Object.freeze({
    id: 'immersive',
    label: '沉浸 · Immersive',
    default: false,
    note: 'more picture and less darkening: for showing the wallpaper, not for long text',
    glass: { blur: 10, opacity: 60 },
    wallpaper: {
      main: { opacity: 78, blur: 8, scrim: 12 },
      dock: { opacity: 65, blur: 8, scrim: 12 }
    },
    tokens: {
      '--dsh-surface-opacity': 60,
      '--dsh-surface-blur': 10,
      '--dsh-wallpaper-brightness': 0.8,
      '--dsh-wallpaper-contrast': 1,
      '--dsh-wallpaper-saturation': 1,
      '--dsh-wallpaper-darken': 12
    }
  }),
  reading: Object.freeze({
    id: 'reading',
    label: '阅读 · Reading',
    default: false,
    note: 'the picture pulled back and the darkening raised: for long text and code review',
    glass: { blur: 14, opacity: 90 },
    wallpaper: {
      main: { opacity: 45, blur: 14, scrim: 22 },
      dock: { opacity: 90, blur: 14, scrim: 22 }
    },
    tokens: {
      '--dsh-surface-opacity': 90,
      '--dsh-surface-blur': 14,
      '--dsh-wallpaper-brightness': 0.55,
      '--dsh-wallpaper-contrast': 0.95,
      '--dsh-wallpaper-saturation': 0.8,
      '--dsh-wallpaper-darken': 22
    }
  })
})

const APPEARANCE_PRESET_IDS = Object.freeze(Object.keys(APPEARANCE_PRESETS))

function presetById(id) {
  return APPEARANCE_PRESETS[String(id || '').toLowerCase()] || null
}

/** The default preset, for a caller with no preference yet. */
function defaultPreset() {
  return APPEARANCE_PRESET_IDS.map((id) => APPEARANCE_PRESETS[id]).find((preset) => preset.default) || APPEARANCE_PRESETS.work
}

/**
 * Which preset the numbers in force look like, or `null` when they are a mixture.
 *
 * The panel uses this so it does not keep its own idea of the state: the numbers *are* the state, and a
 * hand-tuned mixture is reported as a mixture rather than snapped to the nearest preset.
 */
function presetFor({ glass = null, wallpaper = null } = {}) {
  for (const id of APPEARANCE_PRESET_IDS) {
    const preset = APPEARANCE_PRESETS[id]
    const glassMatches = !glass || (Number(glass.blur) === preset.glass.blur && Number(glass.opacity) === preset.glass.opacity)
    const main = wallpaper?.main || null
    const mainMatches = !main || (Number(main.opacity) === preset.wallpaper.main.opacity && Number(main.blur) === preset.wallpaper.main.blur && Number(main.scrim) === preset.wallpaper.main.scrim)
    const dock = wallpaper?.dock || null
    const dockMatches = !dock || (Number(dock.opacity) === preset.wallpaper.dock.opacity && Number(dock.blur) === preset.wallpaper.dock.blur && Number(dock.scrim) === preset.wallpaper.dock.scrim)
    if (glassMatches && mainMatches && dockMatches) return preset.id
  }
  return null
}

/**
 * @param {object}   options
 * @param {Function} [options.glass]     (patch) => the glass layer's answer
 * @param {Function} [options.wallpaper] (patch) => the wallpaper module's answer
 * @param {Function} [options.log]
 */
function createAppearanceController({ glass = null, wallpaper = null, log = () => {} } = {}) {
  let applied = null

  /**
   * Apply one preset.
   *
   * The glass goes first and its failure does not stop the picture: the glass is what the text sits on,
   * so a wallpaper that could not be changed — or was never chosen — must not cost the user readability.
   */
  async function apply(id) {
    const preset = presetById(id)
    if (!preset) return { ok: false, reason: `"${id}" is not an appearance preset; expected ${APPEARANCE_PRESET_IDS.join(', ')}` }
    /**
     * The preset's own numbers go through the §27 whitelist before they reach a layer.
     *
     * The product is not exempt from the boundary it publishes: a preset whose token is misspelled or out of
     * range is refused with a reason, and whatever is left still applies. That is also what keeps the two
     * shapes — the layer numbers and the tokens — from drifting apart.
     */
    const tokens = validate(preset.tokens || {})
    const derived = toLayerPatch(tokens.accepted)
    const glassPatch = { ...preset.glass, ...derived.glass }
    const wallpaperPatch = {
      main: { ...preset.wallpaper.main, ...derived.wallpaper.main },
      dock: { ...preset.wallpaper.dock, ...derived.wallpaper.dock }
    }
    const results = { preset: preset.id, glass: null, wallpaper: null, tokens: { accepted: tokens.tokens, refused: tokens.refused } }
    if (typeof glass === 'function') {
      try {
        results.glass = await glass(glassPatch)
      } catch (error) {
        results.glass = { ok: false, reason: String(error?.message || error) }
        log(`appearance: the glass layer refused the ${preset.id} preset (${results.glass.reason})`)
      }
    }
    if (typeof wallpaper === 'function') {
      try {
        results.wallpaper = await wallpaper(wallpaperPatch)
      } catch (error) {
        results.wallpaper = { ok: false, reason: String(error?.message || error) }
        log(`appearance: the wallpaper refused the ${preset.id} preset (${results.wallpaper.reason})`)
      }
    }
    applied = preset.id
    const ok = results.glass?.ok !== false && results.wallpaper?.ok !== false
    return { ok, ...results }
  }

  /** What the panel shows: the presets, which one the numbers look like, and what was last applied. */
  function describe(current = {}) {
    return {
      ok: true,
      presets: APPEARANCE_PRESET_IDS.map((id) => ({
        id,
        label: APPEARANCE_PRESETS[id].label,
        default: APPEARANCE_PRESETS[id].default,
        note: APPEARANCE_PRESETS[id].note,
        glass: { ...APPEARANCE_PRESETS[id].glass },
        tokens: { ...APPEARANCE_PRESETS[id].tokens },
        wallpaper: {
          main: { ...APPEARANCE_PRESETS[id].wallpaper.main },
          dock: { ...APPEARANCE_PRESETS[id].wallpaper.dock }
        }
      })),
      /** Read from the numbers in force, not remembered: a hand-tuned mixture says `null`. */
      active: presetFor(current),
      lastApplied: applied,
      note: 'readability first: every preset works with no wallpaper, and one layer failing does not take the other with it'
    }
  }

  return {
    APPEARANCE_PRESETS,
    APPEARANCE_PRESET_IDS,
    apply,
    describe,
    presetFor,
    presetById
  }
}

module.exports = {
  createAppearanceController,
  APPEARANCE_PRESETS,
  APPEARANCE_PRESET_IDS,
  defaultPreset,
  presetFor
}
