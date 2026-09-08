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

module.exports = { start, stop }
