'use strict'
const fs = require('node:fs')
const path = require('node:path')

/**
 * Project root resolution:
 *   1. DSH_HOME env var (set by scripts\env.ps1) -> <root>\runtime\dsh
 *   2. DEEPSEEK_HARNESS_ROOT explicit override
 *   3. reference-deployment fallback (D:\DeepSeek-Harness)
 */
function resolveRoot() {
  if (process.env.DSH_HOME) return path.dirname(path.dirname(process.env.DSH_HOME))
  if (process.env.DEEPSEEK_HARNESS_ROOT) return process.env.DEEPSEEK_HARNESS_ROOT
  return 'D:\\DeepSeek-Harness'
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
  DSH_HOME: paths.DSH_HOME || path.join(ROOT, 'runtime', 'dsh'),
  CACHE: paths.CACHE || path.join(ROOT, 'cache'),
  TEMP: paths.TEMP || path.join(ROOT, 'cache', 'temp'),
  DOWNLOADS: paths.DOWNLOADS || path.join(ROOT, 'cache', 'downloads'),
  LOGS: paths.LOGS || path.join(ROOT, 'logs'),
  DATA: paths.DATA || path.join(ROOT, 'data'),
  TOOLS: paths.TOOLS || path.join(ROOT, 'tools'),
  WORKSPACE: paths.WORKSPACE || path.join(ROOT, 'workspace'),
  SESSIONS: paths.SESSIONS || path.join(ROOT, 'data', 'dsh', 'sessions'),
  TASK_HISTORY: paths.TASK_HISTORY || path.join(ROOT, 'data', 'task-history'),
  PRICING: paths.PRICING || path.join(ROOT, 'data', 'pricing'),
  SOUNDS: paths.SOUNDS || path.join(ROOT, 'assets', 'sounds')
})

module.exports = { ROOT, PATHS, app, readJson }
