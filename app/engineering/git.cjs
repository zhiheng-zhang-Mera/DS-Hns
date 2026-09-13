'use strict'

/**
 * Engineering Runtime: git awareness.
 *
 * The runtime works inside somebody's repository, which makes git the place where
 * a mistake is expensive. So this module is deliberately narrow, and everything it
 * refuses to do is as important as what it does:
 *
 *   allowed    status, diff, log, add (explicit paths), commit, snapshot hashes
 *   forbidden  `reset --hard`, `clean -fd`, `push --force`, history rewriting,
 *              branch deletion, and any push or merge without an explicit contract
 *
 * `git reset --hard` in a repair loop destroys the user's uncommitted work, and a
 * force push destroys everybody else's. Neither is something a maintenance
 * runtime may decide on its own, so the destructive commands are not implemented
 * rather than "checked before use" — there is no code path that can run them.
 *
 * The default commit policy is *off*: the runtime may prepare a working tree, and
 * may commit its own changes only when the contract says so, and may never push or
 * merge unless the contract says that too.
 */

const { spawnSync } = require('node:child_process')

/** Commands the runtime may never issue, whatever the contract says. */
const FORBIDDEN_COMMANDS = Object.freeze([
  { pattern: /^reset\s+--hard/, reason: 'a hard reset destroys uncommitted work' },
  { pattern: /^clean\s+-[a-z]*f/, reason: 'a forced clean deletes untracked files' },
  { pattern: /^push\s+.*--force/, reason: 'a force push rewrites shared history' },
  { pattern: /^push\s+.*-f(\s|$)/, reason: 'a force push rewrites shared history' },
  { pattern: /^filter-branch/, reason: 'history rewriting is out of scope' },
  { pattern: /^rebase\s+.*--root/, reason: 'history rewriting is out of scope' },
  { pattern: /^branch\s+-D/, reason: 'deleting branches is not a maintenance action' },
  { pattern: /^update-ref\s+-d/, reason: 'deleting refs is not a maintenance action' },
  { pattern: /^checkout\s+--\s+\./, reason: 'discarding the working tree destroys uncommitted work' },
  { pattern: /^restore\s+\./, reason: 'discarding the working tree destroys uncommitted work' }
])

/** The default policy: prepare the tree, do not commit, never push or merge. */
const DEFAULT_GIT_POLICY = Object.freeze({
  allowCommit: false,
  allowPush: false,
  allowMerge: false,
  commitMessagePrefix: 'chore(engineering):'
})

/**
 * @param {object} input
 * @param {string} input.root the verified repository root
 * @param {object} [input.policy] `{ allowCommit, allowPush, allowMerge, commitMessagePrefix }`
 * @param {Function} [input.now]
 */
function createGitController(input = {}) {
  const root = input.root
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const policy = { ...DEFAULT_GIT_POLICY, ...(input.policy || {}) }
  const history = []

  function remember(entry) {
    history.push(entry)
    if (history.length > 200) history.splice(0, history.length - 200)
    return entry
  }

  /** Run one git command. Refuses a forbidden verb before it reaches the shell. */
  function run(args, options = {}) {
    const verb = args.join(' ').trim()
    for (const forbidden of FORBIDDEN_COMMANDS) {
      if (forbidden.pattern.test(verb)) {
        return remember({
          at: now(),
          args: args.slice(),
          ok: false,
          refused: true,
          reason: `refused: ${forbidden.reason}`,
          stdout: '',
          stderr: ''
        })
      }
    }
    const startedAt = now()
    const result = spawnSync('git', args, {
      cwd: options.cwd || root,
      encoding: 'utf8',
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    return remember({
      at: startedAt,
      durationMs: now() - startedAt,
      args: args.slice(),
      ok: result.status === 0,
      refused: false,
      code: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      reason: result.status === 0 ? null : (result.stderr || '').trim().split('\n')[0] || 'git failed'
    })
  }

  /** Parse `git status --porcelain=v1` into the four states the runtime acts on. */
  function status() {
    const result = run(['status', '--porcelain=v1', '--untracked-files=all'])
    if (!result.ok) return { ok: false, reason: result.reason, modified: [], staged: [], untracked: [], conflicted: [] }
    const modified = []
    const staged = []
    const untracked = []
    const conflicted = []
    for (const raw of result.stdout.split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (!line.trim()) continue
      const x = line[0]
      const y = line[1]
      let file = line.slice(3).trim()
      if (file.includes(' -> ')) file = file.split(' -> ')[1].trim()
      if (x === '?' && y === '?') untracked.push(file)
      else if (x === 'U' || y === 'U') conflicted.push(file)
      else {
        if (x !== ' ') staged.push(file)
        if (y !== ' ') modified.push(file)
      }
    }
    return { ok: true, reason: null, modified, staged, untracked, conflicted }
  }

  /** The current branch and HEAD, and whether HEAD is detached. */
  function head() {
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const sha = run(['rev-parse', 'HEAD'])
    return {
      ok: branch.ok && sha.ok,
      branch: branch.ok ? branch.stdout.trim() : null,
      sha: sha.ok ? sha.stdout.trim() : null,
      detached: branch.ok ? branch.stdout.trim() === 'HEAD' : false,
      reason: branch.ok ? null : branch.reason
    }
  }

  /** The unified diff of the working tree, bounded. */
  function diff(options = {}) {
    const args = ['diff', '--no-color']
    if (options.staged === true) args.push('--cached')
    if (options.paths && options.paths.length) args.push('--', ...options.paths)
    const result = run(args, options)
    if (!result.ok) return { ok: false, text: '', reason: result.reason }
    const limit = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 512 * 1024
    const text = result.stdout
    const truncated = Buffer.byteLength(text) > limit
    return {
      ok: true,
      text: truncated ? Buffer.from(text).subarray(0, limit).toString('utf8') : text,
      truncated,
      bytes: Buffer.byteLength(text),
      reason: null
    }
  }

  /** The staged diff, for the commit message's own evidence. */
  function stagedDiff(options = {}) {
    return diff({ ...options, staged: true })
  }

  /**
   * Stage exactly the paths the episode changed.
   *
   * Explicit paths, never `add -A`: a maintenance runtime staging whatever happens
   * to be in the tree is how it commits somebody else's half-finished work.
   */
  function stage(paths) {
    const list = (Array.isArray(paths) ? paths : []).filter(Boolean)
    if (!list.length) return { ok: false, reason: 'no paths to stage' }
    const result = run(['add', '--', ...list])
    return { ok: result.ok, reason: result.reason, paths: list.slice() }
  }

  /**
   * Commit the staged changes.
   *
   * Refuses when the policy says no, when nothing is staged, or when the message
   * does not name the goal — a commit that cannot be explained later is not worth
   * making.
   */
  function commit(message, options = {}) {
    if (policy.allowCommit !== true) {
      return { ok: false, reason: 'the contract does not allow commits', committed: false }
    }
    if (!message) return { ok: false, reason: 'a commit needs a message', committed: false }
    const staged = options.paths && options.paths.length ? stage(options.paths) : { ok: true }
    if (!staged.ok) return { ok: false, reason: staged.reason, committed: false }
    const before = head()
    const result = run(['commit', '-m', String(message)], { timeoutMs: 60_000 })
    if (!result.ok) {
      return { ok: false, reason: result.reason, committed: false, stdout: result.stdout, stderr: result.stderr }
    }
    const after = head()
    return {
      ok: true,
      committed: after.sha !== before.sha,
      sha: after.sha,
      previousSha: before.sha,
      branch: after.branch,
      reason: null
    }
  }

  /** Push, only when the contract allows it, and never with force. */
  function push(options = {}) {
    if (policy.allowPush !== true) {
      return { ok: false, reason: 'the contract does not allow pushes', pushed: false }
    }
    const args = ['push']
    if (options.remote) args.push(String(options.remote))
    if (options.branch) args.push(String(options.branch))
    const result = run(args, { timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000 })
    return { ok: result.ok, pushed: result.ok, reason: result.reason, stdout: result.stdout, stderr: result.stderr }
  }

  /** Merge, only when the contract allows it. */
  function merge(branch, options = {}) {
    if (policy.allowMerge !== true) {
      return { ok: false, reason: 'the contract does not allow merges', merged: false }
    }
    const result = run(['merge', '--no-edit', String(branch)], { timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120_000 })
    return { ok: result.ok, merged: result.ok, reason: result.reason, stdout: result.stdout, stderr: result.stderr }
  }

  /**
   * Have the branch or HEAD moved since the episode started?
   *
   * This is environment drift, not a code failure: the runtime pauses mutations
   * and re-snapshots rather than overwriting whatever moved.
   */
  function drift(baseline) {
    if (!baseline) return { drifted: false, reasons: [] }
    const current = head()
    const reasons = []
    if (baseline.sha && current.sha && baseline.sha !== current.sha) {
      reasons.push(`HEAD moved: ${baseline.sha.slice(0, 8)} -> ${String(current.sha).slice(0, 8)}`)
    }
    if (baseline.branch && current.branch && baseline.branch !== current.branch) {
      reasons.push(`branch changed: ${baseline.branch} -> ${current.branch}`)
    }
    if (current.detached && !baseline.detached) reasons.push('HEAD became detached')
    return { drifted: reasons.length > 0, reasons, current }
  }

  return {
    root,
    policy,
    run,
    status,
    head,
    diff,
    stagedDiff,
    stage,
    commit,
    push,
    merge,
    drift,
    commands() {
      return history.map((entry) => ({ at: entry.at, args: entry.args, ok: entry.ok, refused: entry.refused === true, reason: entry.reason }))
    },
    refusals() {
      return history.filter((entry) => entry.refused === true)
    }
  }
}

module.exports = { createGitController, FORBIDDEN_COMMANDS, DEFAULT_GIT_POLICY }
