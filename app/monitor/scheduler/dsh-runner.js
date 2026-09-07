'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Runs one dsh headless job as an external Node child. The queue owns the
 * child lifecycle and always works from a per-task directory on D:.
 */

const { ROOT } = require('../utils/paths')
const DSH_BIN = path.join(ROOT, 'app', 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

function nodeExecutable() {
  return process.env.DSH_NODE || 'node'
}

function childEnv(overrides = {}) {
  return {
    ...process.env,
    DSH_HOME: path.join(ROOT, 'runtime', 'dsh'),
    DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED',
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'workspace-write',
    TEMP: path.join(ROOT, 'cache', 'temp'),
    TMP: path.join(ROOT, 'cache', 'temp'),
    npm_config_cache: path.join(ROOT, 'cache', 'npm'),
    DEEPSEEK_HARNESS_WORKSPACE: path.join(ROOT, 'workspace'),
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
