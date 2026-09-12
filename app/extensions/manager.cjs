'use strict'

/**
 * Extension manager.
 *
 * Architectural rule: the official dsh window must be fully usable before
 * extensions are loaded. Extensions are optional; a failure here must never
 * take down the Alien-derived shell or mutate the official renderer.
 */
let active = []

async function start(context) {
  active = []
  const specs = [
    { id: 'mega', disabled: process.env.DSH_DISABLE_MEGA === '1', load: () => require('./mega/index.cjs') }
  ]

  for (const spec of specs) {
    if (spec.disabled) continue
    try {
      const extension = spec.load()
      await extension.start({ ...context, extensionId: spec.id })
      active.push({ id: spec.id, extension })
      context.log?.(`extension started: ${spec.id}`)
    } catch (error) {
      context.log?.(`extension failed: ${spec.id}: ${error?.stack || error}`)
    }
  }
  return active.map((x) => x.id)
}

function stop() {
  for (const item of [...active].reverse()) {
    try {
      item.extension.stop?.()
    } catch {
      // Extension shutdown is best-effort; the Alien shell owns process exit.
    }
  }
  active = []
}

/**
 * Data the shell's Dual-UI runtime needs but does not own.
 *
 * The scheduler, the settings service and the updater belong to the Mega
 * extension, so the shell asks for them here instead of reaching into the
 * extension's modules. A missing extension yields an empty answer, which the
 * adapter reports as a degraded - never as a crash.
 */
function describeNativeData() {
  for (const item of active) {
    try {
      const data = item.extension?.describeNativeData?.()
      if (data) return data
    } catch {
      // A failing extension must not take the shell's read path down with it.
    }
  }
  return { tasks: [], settings: null, harnessVersion: null, latestVersion: null }
}

/**
 * Forward a dock-layout decision to the extension that owns the dock.
 *
 * The shell owns the views and therefore the mode, but the *dock state* (its
 * width, its persisted preference) belongs to Mega. This is the one call the
 * shell needs to keep the official UI at its proper width in Work Mode without
 * taking ownership of the dock.
 */
function setDockExpanded(expanded, options = {}) {
  for (const item of active) {
    try {
      if (typeof item.extension?.setDockExpanded === 'function') {
        return item.extension.setDockExpanded(Boolean(expanded), options)
      }
    } catch {
      return null
    }
  }
  return null
}

module.exports = { start, stop, describeNativeData, setDockExpanded }
