'use strict'
const fs = require('node:fs')
const path = require('node:path')

/**
 * DS-Harness project root resolution — root-agnostic, never hardcoded:
 *   1. DSH_ROOT env var (explicit override; set by scripts\env.ps1 and the Electron shell)
 *   2. DSH_HOME env var -> its parent (<root>\data)
 *   3. self-derived from this module's location (<root>\app\monitor\utils\paths.js)
 */
function resolveRoot() {
  if (process.env.DSH_ROOT) return path.resolve(process.env.DSH_ROOT)
  if (process.env.DSH_HOME) return path.dirname(path.resolve(process.env.DSH_HOME))
  return path.resolve(__dirname, '..', '..', '..')
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

// Optional machine-local overrides (config\paths.json, gitignored). When absent
// every default below points inside the project root, so nothing lives on C:.
const paths = readJson('paths.json', {})
const app = readJson('app.json', {})

const PATHS = Object.freeze({
  ROOT,
  APP: paths.APP || path.join(ROOT, 'app'),
  CONFIG: CONFIG_DIR,
  RUNTIME: paths.RUNTIME || path.join(ROOT, 'runtime'),
  // Single engine home for BOTH the dsh Web UI and headless queue jobs:
  // dsh stores sessions/storages under <DSH_HOME>\sessions etc.
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
  // User-uploaded ringtones: gitignored, per-machine, listed alongside presets.
  USER_SOUNDS: paths.USER_SOUNDS || path.join(ROOT, 'data', 'sounds')
})

module.exports = { ROOT, PATHS, app, readJson }
