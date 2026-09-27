'use strict'
const fs = require('node:fs')
const path = require('node:path')

/**
 * DS-Harness project root resolution for the Mega feature extension.
 * The extension lives at <root>\app\extensions\mega\utils\paths.js.
 * It is deliberately root-agnostic and never owns the Electron shell.
 */
function resolveRoot() {
  if (process.env.DSH_ROOT) return path.resolve(process.env.DSH_ROOT)
  const self = path.resolve(__dirname, '..', '..', '..', '..')
  const hasConfig = (p) => {
    try {
      return fs.existsSync(path.join(p, 'config'))
    } catch {
      return false
    }
  }
  if (hasConfig(self)) return self
  if (process.env.DSH_HOME) {
    const alt = path.dirname(path.resolve(process.env.DSH_HOME))
    if (hasConfig(alt)) return alt
  }
  return self
}

const ROOT = resolveRoot()
const CONFIG_DIR = path.join(ROOT, 'config')

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'))
  } catch {
    return fallback
  }
}

const paths = readJson('paths.json', {})
const app = readJson('app.json', {})
const DSH_HOME = path.resolve(process.env.DSH_HOME || paths.DSH_HOME || path.join(ROOT, 'data'))
const RUNTIME_ROOT = path.resolve(process.env.DSH_RUNTIME_ROOT || ROOT)
const TEMP_ROOT = path.resolve(process.env.DSH_TEMP_ROOT || paths.TEMP || path.join(RUNTIME_ROOT, 'cache', 'temp'))

const PATHS = Object.freeze({
  ROOT,
  APP: paths.APP || path.join(ROOT, 'app'),
  CONFIG: CONFIG_DIR,
  RUNTIME: paths.RUNTIME || path.join(ROOT, 'runtime'),
  DSH_HOME,
  CACHE: process.env.DSH_CACHE_ROOT || paths.CACHE || path.join(RUNTIME_ROOT, 'cache'),
  TEMP: TEMP_ROOT,
  DOWNLOADS: paths.DOWNLOADS || path.join(RUNTIME_ROOT, 'cache', 'downloads'),
  LOGS: paths.LOGS || path.join(RUNTIME_ROOT, 'logs'),
  DATA: DSH_HOME,
  TOOLS: paths.TOOLS || path.join(ROOT, 'tools'),
  WORKSPACE: paths.WORKSPACE || path.join(RUNTIME_ROOT, 'workspace'),
  SESSIONS: paths.SESSIONS || path.join(DSH_HOME, 'sessions'),
  TASK_HISTORY: paths.TASK_HISTORY || path.join(DSH_HOME, 'task-history'),
  PRICING: paths.PRICING || path.join(DSH_HOME, 'pricing'),
  STATE: paths.STATE || path.join(DSH_HOME, 'state'),
  SOUNDS: paths.SOUNDS || path.join(ROOT, 'assets', 'sounds'),
  USER_SOUNDS: paths.USER_SOUNDS || path.join(DSH_HOME, 'sounds'),
  // Generated launcher icon directory. The source asset is always the
  // repository-root icon.jpg; ds-harness.ico inside this directory is a build
  // artifact produced by scripts\ensure-icon.ps1 and never edited by hand.
  ICON: paths.ICON || path.join(ROOT, 'assets', 'icon')
})

module.exports = { ROOT, PATHS, app, readJson }
