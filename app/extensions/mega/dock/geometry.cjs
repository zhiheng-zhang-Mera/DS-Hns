'use strict'

/**
 * Where the dock is allowed to start, on both backend generations.
 *
 * The dock is a strip on the right of the window, and in the integrated build it is a
 * `WebContentsView` drawn *over the official page* — the official UI is the window's own document,
 * laid out against the full window width, so it has no idea a strip of its right edge is covered.
 * That is fine below the conversation header and wrong at the top of it: the official header's
 * controls sit in the top-right corner, which is exactly where the dock (and the collapsed rail)
 * used to begin.
 *
 * So the dock yields that band: both the rail and the panel start below it, as one unit — they are
 * one view, and a per-part offset would break the seam between them. What is left above is the
 * official UI itself, unmodified and unblurred, which is what "merges with the official interface"
 * means in a layout: nothing of ours is drawn there.
 *
 * **Where 76 comes from.** It is not this product's number. The official conversation header
 * (`@deepseek-ai/dsh-client-ui-conversation`) is `min-height:76px` with `padding:10px 28px 0 20px`,
 * so 76 is the floor of the band that carries the header's controls. It is a floor rather than an
 * exact height: a header whose content wraps is taller, and the dock would then cover its last few
 * pixels. Measuring it for real is not available to us — the official page is never scripted, which
 * is a product rule, not a preference — so the number is a named constant with an override for
 * whoever needs a different one, and the clamp below keeps a typo from moving the dock off-screen.
 */

/** The official conversation header's own `min-height`, in CSS pixels. */
const OFFICIAL_HEADER_MIN_HEIGHT = 76

/** How far the dock may be pushed down: a typo must not park it off the bottom of the window. */
const MAX_TOP_INSET = 240

/** The name of the environment override, so the error message and the docs agree. */
const TOP_INSET_ENV = 'DSH_MEGA_DOCK_TOP_INSET'

/**
 * The band the dock leaves to the official UI, in CSS pixels.
 *
 * `0` is a legitimate answer — it is what a build with no official header above the dock wants —
 * and so is a value someone typed because their header is taller. Anything unreadable falls back to
 * the shipped floor rather than to zero: silently covering the controls again is the defect.
 *
 * @param {object} [env] the environment, injectable for tests
 */
function dockTopInset(env = process.env) {
  const raw = env ? env[TOP_INSET_ENV] : undefined
  if (raw === undefined || raw === null || String(raw).trim() === '') return OFFICIAL_HEADER_MIN_HEIGHT
  const value = Number(String(raw).trim())
  if (!Number.isFinite(value)) return OFFICIAL_HEADER_MIN_HEIGHT
  return Math.max(0, Math.min(MAX_TOP_INSET, Math.round(value)))
}

/**
 * The dock's rectangle inside a window of `width` x `height`.
 *
 * One function so the two backends cannot disagree: the integrated view and the legacy window both
 * describe the same strip, and it is the strip — not each caller's arithmetic — that has to be
 * right about the top.
 *
 * @param {object} input `{ x, width, height, inset }`
 */
function dockBounds({ x, width, height, inset = OFFICIAL_HEADER_MIN_HEIGHT }) {
  const top = Math.max(0, Math.min(MAX_TOP_INSET, Math.round(Number(inset) || 0)))
  const total = Math.max(1, Math.round(Number(height) || 0))
  // A window shorter than the band would leave no dock at all, so the inset gives way: the dock
  // shrinking to nothing is worse than covering a header in a window nobody can use anyway.
  const usable = total - top
  const effectiveTop = usable >= 1 ? top : 0
  return { x: Math.round(Number(x) || 0), y: effectiveTop, width: Math.max(1, Math.round(Number(width) || 0)), height: total - effectiveTop }
}

module.exports = { dockTopInset, dockBounds, OFFICIAL_HEADER_MIN_HEIGHT, MAX_TOP_INSET, TOP_INSET_ENV }
