'use strict'

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : fallback
}

/**
 * Compute disjoint integrated official and dock rectangles.
 *
 * When both minimum widths cannot fit, the official view keeps the entire
 * content width and the expanded dock is refused instead of covering it.
 */
function computeIntegratedLayout({
  contentWidth,
  contentHeight,
  dockShown = false,
  expanded = false,
  requestedDockWidth,
  officialMinWidth = 1032,
  dockMinWidth = 440,
  dockMaxWidth = 720,
  collapsedDockWidth = 48
} = {}) {
  const width = positiveInteger(contentWidth, 1)
  const height = positiveInteger(contentHeight, 1)
  const officialMinimum = positiveInteger(officialMinWidth, 1032)
  const dockMinimum = positiveInteger(dockMinWidth, 440)
  const dockMaximum = Math.max(dockMinimum, positiveInteger(dockMaxWidth, 720))
  const collapsedWidth = positiveInteger(collapsedDockWidth, 48)
  const requested = Number(requestedDockWidth)
  const preferredDockWidth = Number.isFinite(requested)
    ? Math.max(dockMinimum, Math.min(dockMaximum, Math.floor(requested)))
    : dockMinimum

  let dockWidth = 0
  let dockVisible = false
  let expansionBlocked = false

  if (dockShown && expanded) {
    const availableDockWidth = width - officialMinimum
    if (availableDockWidth < dockMinimum) {
      expansionBlocked = true
    } else {
      dockWidth = Math.min(preferredDockWidth, availableDockWidth)
      dockVisible = true
    }
  } else if (dockShown && width - officialMinimum >= collapsedWidth) {
    dockWidth = collapsedWidth
    dockVisible = true
  }

  const officialWidth = width - dockWidth
  return {
    officialBounds: { x: 0, y: 0, width: officialWidth, height },
    dockBounds: { x: officialWidth, y: 0, width: dockWidth, height },
    dockVisible,
    expansionBlocked
  }
}

module.exports = { computeIntegratedLayout }
