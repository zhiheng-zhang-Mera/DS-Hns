'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('../utils/paths')
const { readJson } = require('../utils/paths')

/**
 * Sound notifications for COMPLETED / FAILED / INTERRUPTED. The service only
 * resolves URLs and validates assets; playback happens in the browser and a
 * sound failure can never affect dsh execution.
 */

function loadSoundConfig() {
  return readJson('sound.json', { enabled: false, events: {} })
}

function resolveFile(eventName) {
  const cfg = loadSoundConfig()
  const file = cfg.events?.[eventName]
  if (!cfg.enabled || !file) return null
  const p = path.join(PATHS.SOUNDS, file)
  return fs.existsSync(p) ? p : null
}

function describeSounds() {
  const cfg = loadSoundConfig()
  return Object.fromEntries(
    Object.entries(cfg.events || {}).map(([name, file]) => {
      const p = path.join(PATHS.SOUNDS, file)
      return [name, { enabled: cfg.enabled !== false && fs.existsSync(p), url: `/sounds/${file}` }]
    })
  )
}

module.exports = { resolveFile, describeSounds }
