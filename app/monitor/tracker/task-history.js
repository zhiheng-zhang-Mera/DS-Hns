'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('../utils/paths')

/**
 * Recent Tasks — a small, bounded history file. It is intentionally not a
 * full task-management system.
 */

function historyFile() {
  return path.join(PATHS.TASK_HISTORY, 'recent.json')
}

function loadRecent() {
  try {
    return JSON.parse(fs.readFileSync(historyFile(), 'utf8'))
  } catch {
    return []
  }
}

function appendRecent(entry, maxEntries = 50) {
  fs.mkdirSync(PATHS.TASK_HISTORY, { recursive: true })
  const list = loadRecent().filter((e) => e?.id !== entry?.id)
  list.unshift({ savedAt: Date.now(), ...entry })
  const trimmed = list.slice(0, maxEntries)
  fs.writeFileSync(historyFile(), JSON.stringify(trimmed, null, 2), 'utf8')
  return trimmed
}

module.exports = { loadRecent, appendRecent, historyFile }
