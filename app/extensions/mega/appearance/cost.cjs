'use strict'

/**
 * What the appearance costs (`updateplan/startup2.md` §55-§57).
 *
 * The plan's performance rules are about two things this product controls: how much of the screen is blurred
 * (a full-window `backdrop-filter` is the expensive shape it names) and how much the wallpaper layer has to
 * carry (a picture inlined as a `data:` URL is a string the size of the file, held in a renderer).
 *
 * So this is a ledger rather than a limiter. It reads the numbers the two layers are actually using, says what
 * they cost, and warns — in the log and in the Control Center — when a number is outside the plan's guidance.
 * It does **not** take the user's control away: the glass slider is theirs, and a product that silently clamps
 * a number the user set would be lying about what is on screen. What it can do is make the cost visible, which
 * is the difference between a heavy appearance and an unexplained one.
 */

/**
 * The plan's guidance, as numbers: §55's blur ranges, and a ceiling for the picture's payload (a 4 MB
 * photograph is a reasonable upper bound for a full-screen image; beyond that the layer is carrying more than
 * the screen can show).
 */
const APPEARANCE_BUDGETS = Object.freeze({
  glassBlurComfort: 14,
  glassBlurCeiling: 40,
  wallpaperBytesComfort: 4 * 1024 * 1024
})

const BYTES_PER_KILOBYTE = 1024

function kilobytes(bytes) {
  return Math.round((Number(bytes) || 0) / BYTES_PER_KILOBYTE)
}

/**
 * @param {object} input
 * @param {object} [input.glass]     `{ blur, opacity }` in force
 * @param {number} [input.windowBytes] the main screen's picture payload
 * @param {number} [input.dockBytes]   the dock's picture payload
 * @param {number} [input.layers]      how many picture layers are drawing (0-2)
 * @param {number} [input.blurPixels]  how many pixels the blurred area covers, when a caller can measure it
 */
function estimateAppearanceCost({ glass = {}, windowBytes = 0, dockBytes = 0, layers = 0, blurPixels = null } = {}) {
  const blur = Number(glass.blur) || 0
  const opacity = Number(glass.opacity)
  const bytes = (Number(windowBytes) || 0) + (Number(dockBytes) || 0)
  const warnings = []
  if (blur > APPEARANCE_BUDGETS.glassBlurCeiling) {
    warnings.push({ id: 'blur-over-ceiling', reason: `the glass blurs ${blur}px, past the ${APPEARANCE_BUDGETS.glassBlurCeiling}px the plan allows even at its heaviest` })
  } else if (blur > APPEARANCE_BUDGETS.glassBlurComfort) {
    warnings.push({ id: 'blur-over-comfort', reason: `the glass blurs ${blur}px; §55's comfortable range is 6-14px`, comfort: true })
  }
  if (bytes > APPEARANCE_BUDGETS.wallpaperBytesComfort) {
    warnings.push({ id: 'wallpaper-heavy', reason: `the pictures carry ${kilobytes(bytes)} KB, over the ${kilobytes(APPEARANCE_BUDGETS.wallpaperBytesComfort)} KB a full-screen layer should need` })
  }
  return {
    ok: true,
    glass: { blur, opacity: Number.isFinite(opacity) ? opacity : null },
    blurPixels: Number.isFinite(Number(blurPixels)) ? Number(blurPixels) : null,
    wallpaper: { windowBytes: Number(windowBytes) || 0, dockBytes: Number(dockBytes) || 0, bytes, kilobytes: kilobytes(bytes) },
    layers,
    warnings,
    /** §55/§57 in one line for the log: what the appearance costs, in the numbers it is made of. */
    line: `[PERF] appearance glass=${blur}px/${Number.isFinite(opacity) ? `${opacity}%` : '—'} pictures=${kilobytes(bytes)}KB layers=${layers}${warnings.length ? ` warnings=${warnings.map((warning) => warning.id).join(',')}` : ''}`
  }
}

module.exports = { estimateAppearanceCost, APPEARANCE_BUDGETS, kilobytes }
