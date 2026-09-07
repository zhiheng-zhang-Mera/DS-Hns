'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Runs one dsh headless job as an external Node child. The queue owns the
 * child lifecycle and always works from a per-task directory on D:.
 */

const { PATHS, ROOT } = require('../utils/paths')

// Single dsh install for the whole desktop app: <root>\app\node_modules\@deepseek-ai\dsh
const DSH_BIN = path.join(PATHS.APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function nodeExecutable() {
  return process.env.DSH_NODE || 'node'
}

function childEnv(overrides = {}) {
  return {
    ...process.env,
    // Same engine home as the dsh Web UI (<root>\data), so every session —
    // foreground or queue — lands in one store the monitor watches for bells.
    DSH_HOME: PATHS.DSH_HOME,
    DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED',
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'workspace-write',
    TEMP: PATHS.TEMP,
    TMP: PATHS.TEMP,
    npm_config_cache: path.join(PATHS.CACHE, 'npm'),
    DEEPSEEK_HARNESS_WORKSPACE: PATHS.WORKSPACE,
    ...overrides
  }
}

function startJob({ id, prompt, taskDir, permissionMode, logFile }) {
  fs.mkdirSync(taskDir, { recursive: true })
  const log = logFile || path.join(ROOT, 'logs', 'harness', `${id}.log`)
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const stream = fs.createWriteStream(log, { flags: 'a' })
  const args = [DSH_BIN, '--profile', 'headless', prompt]
  const child = spawn(nodeExecutable(), args, {
    cwd: taskDir,
    env: childEnv(permissionMode ? { DSH_PERMISSION_MODE: permissionMode } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  child.logStream = stream
  return { child, pid: child.pid, logFile: log }
}

function killTree(pid) {
  if (!pid) return
  try {
    spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch {
    /* process may already be gone */
  }
}

module.exports = { startJob, killTree, childEnv, DSH_BIN, nodeExecutable }
