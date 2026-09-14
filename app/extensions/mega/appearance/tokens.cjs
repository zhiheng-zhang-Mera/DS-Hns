'use strict'

/**
 * The appearance token boundary (`updateplan/startup2.md` §27).
 *
 * What an appearance provider — today the product's own layers, tomorrow a community plugin — is allowed to
 * change about the interface, written down as a closed list:
 *
 *   --dsh-surface-opacity        how much of the dock's pane stays opaque
 *   --dsh-surface-blur           how strongly that pane blurs what is behind it
 *   --dsh-surface-tint           the pane's own colour (this product keeps it transparent, by design)
 *   --dsh-wallpaper-brightness   the picture's brightness
 *   --dsh-wallpaper-contrast     the picture's contrast
 *   --dsh-wallpaper-saturation   the picture's saturation
 *   --dsh-wallpaper-darken       how much the picture is darkened towards the interface
 *
 * And what it may *not* change, which is the half that matters: the DOM, component structure, button templates,
 * the layout grid, window controls or any JavaScript hook. Those are not unusual names to filter — they are the
 * product's behaviour, and the way to keep a wallpaper plugin from becoming a frontend fork is to have no
 * vocabulary for them at all.
 *
 * So this is a validator over a closed list: anything else is refused by name, values are clamped into the range
 * each token has, and an accepted set is translated into the numbers the two layers already use. A provider that
 * asks for something else gets a refusal it can read, not a silent no-op.
 */

/** The closed list. `layer` says where an accepted token ends up; `min`/`max` are what a value is clamped to. */
const APPEARANCE_TOKENS = Object.freeze({
  '--dsh-surface-opacity': Object.freeze({ id: 'surface-opacity', layer: 'glass', key: 'opacity', min: 5, max: 100, unit: '%' }),
  '--dsh-surface-blur': Object.freeze({ id: 'surface-blur', layer: 'glass', key: 'blur', min: 0, max: 40, unit: 'px' }),
  '--dsh-surface-tint': Object.freeze({ id: 'surface-tint', layer: 'glass', key: 'tint', min: null, max: null, unit: null, colour: true }),
  '--dsh-wallpaper-brightness': Object.freeze({ id: 'wallpaper-brightness', layer: 'wallpaper', key: 'brightness', min: 0.4, max: 1.2, unit: '' }),
  '--dsh-wallpaper-contrast': Object.freeze({ id: 'wallpaper-contrast', layer: 'wallpaper', key: 'contrast', min: 0.4, max: 1.2, unit: '' }),
  '--dsh-wallpaper-saturation': Object.freeze({ id: 'wallpaper-saturation', layer: 'wallpaper', key: 'saturation', min: 0, max: 1.5, unit: '' }),
  '--dsh-wallpaper-darken': Object.freeze({
    id: 'wallpaper-darken',
    layer: 'wallpaper',
    key: 'darken',
    // The token's public name is `darken`; the layer's own name for the same number is `scrim`, and one number
    // with two names is how two plausible answers to "how dark is it" start to exist.
    patchKey: 'scrim',
    min: 0,
    max: 60,
    unit: '%'
  })
})

const APPEARANCE_TOKEN_NAMES = Object.freeze(Object.keys(APPEARANCE_TOKENS))

/** The surfaces a token may describe, named so a refusal can say what a name tried to be. */
const FORBIDDEN_SURFACES = Object.freeze([
  'document', 'dom', 'html', 'body', 'structure', 'layout', 'grid', 'template', 'button', 'window', 'script', 'hook'
])

function looksLikeAColour(value) {
  const text = String(value).trim()
  return /^#[0-9a-f]{3,8}$/i.test(text) || /^rgba?\(/i.test(text) || /^hsla?\(/i.test(text) || text === 'transparent'
}

/**
 * Accept or refuse one patch of tokens.
 *
 * @returns {{ok:boolean, accepted:object, refused:{token:string,reason:string}[], tokens:string[]}}
 */
function validate(patch = {}) {
  const accepted = {}
  const refused = []
  for (const [token, value] of Object.entries(patch || {})) {
    const name = String(token)
    const spec = APPEARANCE_TOKENS[name]
    if (!spec) {
      const surface = FORBIDDEN_SURFACES.find((word) => name.toLowerCase().includes(word))
      refused.push({
        token: name,
        reason: surface
          ? `an appearance provider may paint, not take over: "${surface}" is not part of the appearance vocabulary`
          : `"${name}" is not an appearance token; expected ${APPEARANCE_TOKEN_NAMES.join(', ')}`
      })
      continue
    }
    if (spec.colour) {
      if (!looksLikeAColour(value)) {
        refused.push({ token: name, reason: `"${value}" is not a colour` })
        continue
      }
      accepted[name] = String(value)
      continue
    }
    const number = Number(value)
    if (Number.isFinite(number)) {
      accepted[name] = Math.min(spec.max, Math.max(spec.min, number))
    } else {
      refused.push({ token: name, reason: `"${value}" is not a number` })
    }
  }
  return { ok: refused.length === 0, accepted, refused, tokens: Object.keys(accepted) }
}

/**
 * Translate an accepted token patch into the two layers' own numbers.
 *
 * This is where "a provider may paint" stops being a slogan: the only things a token reaches are the glass's
 * opacity and blur, its (by design inert) tint, and the picture's filter and darkening.
 */
function toLayerPatch(patch = {}) {
  const { accepted } = validate(patch)
  const glass = {}
  const wallpaper = { main: {}, dock: {} }
  for (const [token, value] of Object.entries(accepted)) {
    const spec = APPEARANCE_TOKENS[token]
    if (spec.layer === 'glass') glass[spec.key] = value
    else {
      // Both backdrops carry the same picture settings: a provider describes the appearance, not one strip.
      const key = spec.patchKey || spec.key
      wallpaper.main[key] = value
      wallpaper.dock[key] = value
    }
  }
  return { glass, wallpaper }
}

/** The stylesheet fragment, for a document that would rather read the tokens directly. */
function toCss(patch = {}) {
  const { accepted } = validate(patch)
  const lines = Object.entries(accepted).map(([token, value]) => {
    const spec = APPEARANCE_TOKENS[token]
    return `  ${token}: ${spec.unit ? `${value}${spec.unit}` : value};`
  })
  return lines.length ? [':root:root {', ...lines, '}'].join('\n') : ''
}

module.exports = {
  APPEARANCE_TOKENS,
  APPEARANCE_TOKEN_NAMES,
  FORBIDDEN_SURFACES,
  validate,
  toLayerPatch,
  toCss
}
