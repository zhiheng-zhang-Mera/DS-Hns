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

const PATHS = Object.freeze({
  ROOT,
  APP: paths.APP || path.join(ROOT, 'app'),
  CONFIG: CONFIG_DIR,
  RUNTIME: paths.RUNTIME || path.join(ROOT, 'runtime'),
  DSH_HOME: paths.DSH_HOME || path.join(ROOT, 'data'),
  CACHE: paths.CACHE || path.join(ROOT, 'cache'),
  TEMP: paths.TEMP || path.join(ROOT, 'cache', 'temp'),
  DOWNLOADS: paths.DOWNLOADS || path.join(ROOT, 'cache', 'downloads'),
  LOGS: paths.LOGS || path.join(ROOT, 'logs'),
  DATA: paths.DATA || path.join(ROOT, 'data'),
  TOOLS: paths.TOOLS || path.join(ROOT, 'tools'),
  WORKSPACE: paths.WORKSPACE || path.join(ROOT, 'workspace'),
  SESSIONS: paths.SESSIONS || path.join(ROOT, 'data', 'sessions'),
  TASK_HISTORY: paths.TASK_HISTORY || path.join(ROOT, 'data', 'task-history'),
  PRICING: paths.PRICING || path.join(ROOT, 'data', 'pricing'),
  STATE: paths.STATE || path.join(ROOT, 'data', 'state'),
  SOUNDS: paths.SOUNDS || path.join(ROOT, 'assets', 'sounds'),
  USER_SOUNDS: paths.USER_SOUNDS || path.join(ROOT, 'data', 'sounds')
})

module.exports = { ROOT, PATHS, app, readJson }
