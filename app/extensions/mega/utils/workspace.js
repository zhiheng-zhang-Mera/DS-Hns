'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('./paths')

/**
 * 项目工作区设置(Project Workspace)。
 *
 * 概念:每次 headless 任务都在 <workspaceRoot>\active\<taskId> 目录下执行,
 * dsh 子进程收到 DEEPSEEK_HARNESS_WORKSPACE=<workspaceRoot>。
 * 默认 workspaceRoot = <root>\workspace;可在 设置 → 项目工作区 中改为任意目录
 * (持久化到 data\state\workspace.json,不入库)。
 */

function stateFile() {
  return path.join(PATHS.STATE, 'workspace.json')
}

function getWorkspaceRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    if (cfg && typeof cfg.root === 'string' && cfg.root && fs.existsSync(cfg.root)) return cfg.root
  } catch {
    /* fall back to default */
  }
  return PATHS.WORKSPACE
}

function getActiveDir(id) {
  return path.join(getWorkspaceRoot(), 'active', String(id || 'task'))
}

function setWorkspaceRoot(root) {
  const p = String(root || '').trim()
  if (!p) throw new Error('workspace root 不能为空')
  if (!fs.existsSync(p)) throw new Error(`目录不存在: ${p}`)
  if (!fs.statSync(p).isDirectory()) throw new Error(`不是目录: ${p}`)
  fs.mkdirSync(path.join(p, 'active'), { recursive: true })
  fs.mkdirSync(PATHS.STATE, { recursive: true })
  fs.writeFileSync(stateFile(), JSON.stringify({ root: p, savedAt: Date.now() }, null, 2), 'utf8')
  return p
}

module.exports = { getWorkspaceRoot, getActiveDir, setWorkspaceRoot, stateFile }
