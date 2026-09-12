'use strict'

/**
 * Permission and risk guard for the Sub-worker (plan §4.2, §9, §19, §23, §34).
 *
 * This module is deliberately a pure policy library: it takes a task and a
 * requested operation and answers allow/deny with a machine-readable code. The
 * executor must never bypass it, and the worker has no API to widen the policy
 * it was given (a worker may not enlarge its own allowed range).
 */

const path = require('node:path')
const {
  RISK_LEVELS,
  ALLOWED_RISK_LEVELS,
  RISK_BY_TIER,
  RESULT_CODES,
  CAPABILITIES,
  isPlainObject
} = require('./protocol.cjs')

/** Paths the executor may never write, regardless of the task's allow list. */
const ALWAYS_PROTECTED_WRITE_PATTERNS = Object.freeze([
  '.git/**',
  '.git',
  '**/.git/**'
])

/** Critical modules a worker may not delete on its own authority (§4.2). */
const CRITICAL_DELETE_PATTERNS = Object.freeze([
  'package.json',
  '**/package.json',
  'package-lock.json',
  '**/package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  '**/tsconfig.json',
  '.gitignore',
  'src/ipc/**',
  '**/ipc/**',
  '**/electron/main*',
  '**/desktop-main*'
])

/**
 * High-risk / irreversible commands. Denied outright: these are exactly the
 * "自行执行高风险系统操作" and "自行 merge 到受保护分支" items of §4.2.
 */
const DENIED_COMMAND_PATTERNS = Object.freeze([
  { pattern: /\brm\s+-rf\s+[/\\]\s*($|[;&|])/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'refusing recursive delete of a filesystem root' },
  { pattern: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\(\s|$)/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'refusing recursive delete of a drive root' },
  { pattern: /\b(?:format|diskpart|mkfs|fdisk)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'disk formatting is a high-risk system operation' },
  { pattern: /\b(?:shutdown|reboot|halt)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'power-state changes are outside the executor contract' },
  { pattern: /\breg(?:\.exe)?\s+(?:add|delete|import)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'registry mutation is a high-risk system operation' },
  { pattern: /\b(?:sc|sc\.exe)\s+(?:delete|stop|config)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'service control is a high-risk system operation' },
  { pattern: /\btaskkill\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'process termination is controller-only' },
  { pattern: /\bgit\s+push\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'pushing is controller-only' },
  { pattern: /\bgit\s+(?:merge|rebase|cherry-pick)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'history rewriting / merging is controller-only' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'hard reset destroys unrelated work' },
  { pattern: /\bgit\s+(?:checkout|switch)\s+(?:main|master|release\/\S+)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'switching to a protected branch is controller-only' },
  { pattern: /\bgit\s+branch\s+-D\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'branch deletion is controller-only' },
  { pattern: /\bgit\s+worktree\s+(?:remove|prune)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'the worker never releases its own workspace' },
  { pattern: /\b(?:npm|pnpm|yarn)\s+publish\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'publishing is a release action owned by the Controller' },
  { pattern: /\bdocker\s+(?:rm|rmi|system\s+prune)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'destructive container operations are controller-only' },
  { pattern: /(?:^|[|&]\s*)(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'piping a remote script into a shell is never allowed' },
  { pattern: /\|\s*(?:iex|Invoke-Expression)\b/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'piping anything into Invoke-Expression is never allowed' },
  { pattern: /\b(?:Remove-Item|rm)\s+[^\n]*-Recurse[^\n]*-Force\s+[a-z]:\\?(?:\s|$)/i, code: RESULT_CODES.COMMAND_DENIED, reason: 'refusing recursive delete of a drive root' }
])

/** Commands that need `permissions.network` (task) to be true. */
const NETWORK_COMMAND_PATTERNS = Object.freeze([
  /\b(?:npm|pnpm|yarn)\s+(?:install|i|add|update|upgrade|ci|audit|publish)\b/i,
  /\bpip(?:3)?\s+(?:install|download)\b/i,
  /\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i,
  /\bgit\s+(?:clone|fetch|pull|submodule\s+update|ls-remote)\b/i,
  /\b(?:apt-get|apt|brew|choco|winget|scoop)\s+(?:install|update|upgrade)\b/i,
  /\bnpx\b/i,
  /\bnpm\s+run\s+[^\n]*\b(?:deploy|release|publish)\b/i,
  /\b(?:ssh|scp|rsync)\b/i
])

const GIT_COMMIT_PATTERNS = Object.freeze([
  /\bgit\s+commit\b/i,
  /\bgit\s+tag\b/i
])

/** Protected branches the worker may never commit to (§4.2). */
const PROTECTED_BRANCHES = Object.freeze(['main', 'master', 'trunk', 'release', 'develop'])

function isProtectedBranch(branch) {
  const name = String(branch || '').trim().toLowerCase()
  if (!name) return false
  if (PROTECTED_BRANCHES.includes(name)) return true
  return /^(?:release|hotfix)\//.test(name) || /^v\d/.test(name)
}

/** Convert a package-style glob into a regular expression. */
function globToRegExp(glob) {
  const raw = String(glob || '').replaceAll('\\', '/').trim()
  if (!raw) return null
  // A bare `**` means "everything", including nested paths.
  if (raw === '**') return /^.*$/i
  // `dir/**` holds the directory itself as well, which is what a task author
  // means by "src/knowledge/**".
  const trailingRecursive = /\/\*\*$/.test(raw)
  const core = trailingRecursive ? raw.slice(0, -3) : raw

  let out = ''
  for (let i = 0; i < core.length; i += 1) {
    const char = core[i]
    if (char === '*') {
      if (core[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (core[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  if (trailingRecursive) out += '(?:/.*)?'
  return new RegExp(`^${out}$`, 'i')
}

const globCache = new Map()

function matchesAnyGlob(relativePath, patterns) {
  const target = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '')
  for (const pattern of patterns || []) {
    const key = String(pattern)
    if (!globCache.has(key)) globCache.set(key, globToRegExp(key))
    const regex = globCache.get(key)
    if (!regex) continue
    if (regex.test(target)) return String(pattern)
    // A directory pattern also covers everything below it.
    if (!/[*?]/.test(key) && (target === key || target.startsWith(`${key.replace(/\/$/, '')}/`))) return String(pattern)
  }
  return null
}

function normalizeRelativePath(candidate) {
  const text = String(candidate == null ? '' : candidate).trim().replaceAll('\\', '/')
  if (!text) return { ok: false, error: 'path is required' }
  if (/^[a-zA-Z]:\//.test(text) || text.startsWith('//') || text.startsWith('/')) {
    return { ok: false, error: 'absolute paths are not accepted; paths are workspace-relative' }
  }
  const normalized = path.posix.normalize(text).replace(/^\.\//, '')
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, error: 'path escapes the workspace' }
  }
  // `.` names the workspace root itself (useful for `list_dir`).
  if (normalized === '.') return { ok: true, value: '.' }
  if (!normalized) return { ok: false, error: 'path must name a file or directory' }
  return { ok: true, value: normalized }
}

function denial(code, reason, extra = {}) {
  return { allowed: false, code, reason, ...extra }
}

function allowance(reason = '', extra = {}) {
  return { allowed: true, code: RESULT_CODES.OK, reason, ...extra }
}

/**
 * Decide whether a workspace-relative path may be touched.
 *
 * `allowed_paths` is the task's modification range (plan §4.2: the worker may
 * never enlarge the range it was given), so it bounds `write`/`delete`.
 * `forbidden_paths` is an explicit veto and applies to every action including
 * reads. Reads are additionally bounded by the workspace itself.
 *
 * @param {'read'|'write'|'delete'} action
 */
function checkPath(task, candidatePath, action = 'read') {
  const relative = normalizeRelativePath(candidatePath)
  if (!relative.ok) return denial(RESULT_CODES.PATH_FORBIDDEN, relative.error)

  const target = relative.value
  const forbidden = matchesAnyGlob(target, task?.forbidden_paths)
  if (forbidden) {
    return denial(RESULT_CODES.PATH_FORBIDDEN, `path ${target} is forbidden by the task (${forbidden})`, { path: target })
  }

  if (action !== 'read') {
    const allowed = Array.isArray(task?.allowed_paths) ? task.allowed_paths : []
    if (allowed.length) {
      const match = matchesAnyGlob(target, allowed)
      if (!match) {
        return denial(RESULT_CODES.PATH_FORBIDDEN, `path ${target} is outside the task's allowed_paths`, { path: target })
      }
    }

    const protectedMatch = matchesAnyGlob(target, ALWAYS_PROTECTED_WRITE_PATTERNS)
    if (protectedMatch) {
      return denial(RESULT_CODES.PATH_FORBIDDEN, `path ${target} is repository metadata and is never written by the worker`, { path: target })
    }
  }

  if (action === 'delete') {
    const critical = matchesAnyGlob(target, CRITICAL_DELETE_PATTERNS)
    if (critical) {
      return denial(
        RESULT_CODES.REQUIRES_CONTROLLER,
        `deleting ${target} is a critical-module deletion and requires the Controller`,
        { path: target }
      )
    }
  }

  return allowance('', { path: target })
}

/**
 * Decide whether a shell command may run.
 * @param {object} task validated task object
 * @param {string} command raw command line
 * @param {{ allowGitCommit?: boolean, branch?: string|null }} options
 */
function checkCommand(task, command, options = {}) {
  const text = String(command == null ? '' : command).trim()
  if (!text) return denial(RESULT_CODES.COMMAND_DENIED, 'empty command')
  if (!task?.permissions?.shell) {
    return denial(RESULT_CODES.PERMISSION_DENIED, 'the task did not grant shell permission')
  }

  for (const rule of DENIED_COMMAND_PATTERNS) {
    if (rule.pattern.test(text)) return denial(rule.code, rule.reason)
  }

  const isCommit = GIT_COMMIT_PATTERNS.some((pattern) => pattern.test(text))
  if (isCommit) {
    if (!task?.permissions?.git_commit) {
      return denial(RESULT_CODES.PERMISSION_DENIED, 'the task did not grant git_commit permission')
    }
    if (options.allowGitCommit !== true) {
      return denial(RESULT_CODES.REQUIRES_CONTROLLER, 'committing is disabled by configuration (subWorker.allowGitCommit)')
    }
    if (isProtectedBranch(options.branch)) {
      return denial(RESULT_CODES.REQUIRES_CONTROLLER, `committing to protected branch ${options.branch} requires the Controller`)
    }
  }

  if (!task?.permissions?.network) {
    const networkPattern = NETWORK_COMMAND_PATTERNS.find((pattern) => pattern.test(text))
    if (networkPattern) {
      return denial(RESULT_CODES.PERMISSION_DENIED, 'the task did not grant network permission')
    }
  }

  return allowance('', { command: text })
}

/**
 * Task-level admission control (plan §9, §23).
 * Returns `{ ok: true }` or `{ ok: false, code, reason, requires_controller }`.
 */
function guardTask(task, { capabilities = CAPABILITIES } = {}) {
  if (!isPlainObject(task)) {
    return { ok: false, code: RESULT_CODES.TASK_REJECTED, reason: 'task is not an object', requires_controller: true }
  }

  const risk = String(task.risk_level || '').toUpperCase()
  if (!RISK_LEVELS.includes(risk)) {
    return { ok: false, code: RESULT_CODES.TASK_REJECTED, reason: `unknown risk_level ${task.risk_level}`, requires_controller: true }
  }
  if (!ALLOWED_RISK_LEVELS.includes(risk)) {
    return {
      ok: false,
      code: RESULT_CODES.REQUIRES_CONTROLLER,
      reason: `risk level ${risk} (${RISK_BY_TIER[risk]}) is outside the executor contract; the Controller must own it`,
      requires_controller: true
    }
  }

  if (task.requires_vision && capabilities.vision !== true) {
    return {
      ok: false,
      code: RESULT_CODES.UNSUPPORTED_CAPABILITY,
      reason: 'task requires vision but the worker runtime cannot see images',
      requires_controller: true
    }
  }

  if (!task.permissions?.read) {
    return { ok: false, code: RESULT_CODES.PERMISSION_DENIED, reason: 'the task did not grant read permission', requires_controller: true }
  }

  if (task.workspace_mode === 'isolated_worktree' && !task.target_repo) {
    return { ok: false, code: RESULT_CODES.TASK_REJECTED, reason: 'isolated_worktree mode requires target_repo', requires_controller: true }
  }

  return { ok: true, code: RESULT_CODES.OK, reason: '', requires_controller: false }
}

/**
 * Auto-delegate policy (plan §19). Phase 1 keeps this off by default; when it is
 * on, only categorically safe work may be delegated without an explicit click.
 *
 * Order matters: the most specific matching category wins, so "add unit tests"
 * is classified as tests rather than implementation.
 */
const AUTO_DELEGATE_CATEGORIES = Object.freeze({
  tests: /\b(?:test|tests|spec|specs|coverage)\b|测试|用例/i,
  lint: /\b(?:lint|lint\w*|format|formatting|prettier|eslint|style)\b|格式化|静态检查/i,
  docs: /\b(?:doc|docs|documentation|readme|comment|comments)\b|文档|注释/i,
  'small refactor': /\b(?:refactor|rename|extract|cleanup|tidy)\b|重构|重命名|清理/i,
  implementation: /\b(?:implement|add|create|write|build)\b|实现|新增|增加/i
})

const AUTO_DELEGATE_FORBIDDEN = Object.freeze([
  { category: 'architecture redesign', pattern: /\b(?:architecture|redesign|re-architect|restructure the project)\b|架构|总体设计/i },
  { category: 'security-sensitive', pattern: /\b(?:auth|authentication|authorization|credential|secret|token|crypto|encryption|permission model)\b|鉴权|认证|密钥|加密/i },
  { category: 'deployment', pattern: /\b(?:deploy|deployment|release|publish|production|rollout)\b|部署|发布|上线/i },
  { category: 'large deletion', pattern: /\b(?:delete|remove|drop|purge)\b[^\n]{0,40}\b(?:all|every|entire|whole|module|directory|folder)\b|删除全部|清空/i },
  { category: 'research direction', pattern: /\b(?:research|explore|investigate options|evaluate approaches|roadmap|strategy)\b|调研|研究|选型|路线/i },
  { category: 'high-risk migration', pattern: /\b(?:migrat|rewrite history|schema change|breaking change)\b|迁移|破坏性变更/i }
])

function classifyDelegation(objective) {
  const text = String(objective == null ? '' : objective)
  for (const rule of AUTO_DELEGATE_FORBIDDEN) {
    if (rule.pattern.test(text)) {
      return { eligible: false, category: rule.category, reason: `${rule.category} is never auto-delegated` }
    }
  }
  for (const [category, pattern] of Object.entries(AUTO_DELEGATE_CATEGORIES)) {
    if (pattern.test(text)) return { eligible: true, category, reason: '' }
  }
  return { eligible: false, category: null, reason: 'objective does not clearly match an auto-delegatable category' }
}

/**
 * Combined gate for automatic dispatch: category policy *and* configuration.
 */
function canAutoDelegate(task, config = {}) {
  if (config.autoDelegate !== true) return { eligible: false, category: null, reason: 'auto delegate is OFF' }
  const classified = classifyDelegation(task?.objective)
  if (!classified.eligible) return classified
  const guarded = guardTask(task)
  if (!guarded.ok) return { eligible: false, category: classified.category, reason: guarded.reason }
  return classified
}

/**
 * Operation-level guard used by the executor for every single operation.
 */
function checkOperation(task, operation, options = {}) {
  if (!isPlainObject(operation)) return denial(RESULT_CODES.NO_EXECUTABLE_OPERATION, 'operation must be an object')
  const op = String(operation.op || '').trim()
  switch (op) {
    case 'list_dir':
    case 'read_file':
      // Reads are not bounded by `allowed_paths` (that is the modification
      // range), but an explicitly forbidden path is still a veto.
      return checkPath(task, operation.path, 'read')
    case 'git_status':
    case 'git_diff':
      // These run `git` as a child process, so they need shell permission just
      // like any other command; otherwise `permissions.shell: false` would be a
      // lie that a task could rely on.
      if (!task?.permissions?.shell) {
        return denial(RESULT_CODES.PERMISSION_DENIED, 'the task did not grant shell permission (git inspection runs git)')
      }
      return allowance()
    case 'write_file':
    case 'replace_in_file':
      if (!task?.permissions?.write) return denial(RESULT_CODES.PERMISSION_DENIED, 'the task did not grant write permission')
      return checkPath(task, operation.path, 'write')
    case 'delete_file':
      if (!task?.permissions?.write) return denial(RESULT_CODES.PERMISSION_DENIED, 'the task did not grant write permission')
      return checkPath(task, operation.path, 'delete')
    case 'run_command':
    case 'run_tests':
      return checkCommand(task, operation.command, options)
    default:
      return denial(RESULT_CODES.NO_EXECUTABLE_OPERATION, `unknown operation: ${op || '(missing)'}`)
  }
}

module.exports = {
  ALWAYS_PROTECTED_WRITE_PATTERNS,
  CRITICAL_DELETE_PATTERNS,
  DENIED_COMMAND_PATTERNS,
  NETWORK_COMMAND_PATTERNS,
  PROTECTED_BRANCHES,
  AUTO_DELEGATE_CATEGORIES,
  AUTO_DELEGATE_FORBIDDEN,
  globToRegExp,
  matchesAnyGlob,
  normalizeRelativePath,
  isProtectedBranch,
  checkPath,
  checkCommand,
  checkOperation,
  guardTask,
  classifyDelegation,
  canAutoDelegate
}
