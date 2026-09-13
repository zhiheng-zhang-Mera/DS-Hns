'use strict'

/**
 * DS-Hns acceleration: workspace isolation.
 *
 * Phase 10 of the acceleration plan. Parallel writes are the part of single-task
 * parallelism that can destroy work: two workers editing the same file in the same
 * working tree do not merge, they overwrite, and the loser's change is gone with no
 * diff to show it ever existed. The plan's answer is the standard one — an isolated
 * working tree per worker, built on `git worktree` — and this module owns exactly that
 * lifecycle, and nothing else.
 *
 * It is the *mechanism*; the policy that decides when isolation is required lives in
 * the parallel executor (sections 19 and 22 of the plan). What this module guarantees:
 *
 *  * **Isolation is verified, never assumed.** `git worktree add` returning success is
 *    not the same as a usable tree, so the new path is probed before it is handed out.
 *  * **A refusal is a first-class answer.** When `git worktree` is unavailable — an old
 *    git, a shallow checkout, a directory that is not a repository, or a repository
 *    with no commit yet — `create` fails with a reason and `kind: 'shared'`, which is
 *    the signal for the caller to run serially. It never returns a path that pretends
 *    to be isolated, because "parallelism that silently shares a tree" is precisely the
 *    failure the plan forbids.
 *  * **Worktrees do not leak.** Reclaim is confirmed, a failed reclaim stays visible in
 *    `status()` rather than being forgotten, and `sweep()` adopts the trees a previous
 *    crashed process left behind — the restart case, not the happy case.
 */

const fs = require('node:fs')
const path = require('node:path')

/** `shared` is the honest answer when isolation cannot be provided. */
const ISOLATION_KINDS = Object.freeze({
  SHARED: 'shared',
  WORKTREE: 'worktree'
})

const DEFAULT_POLICY = Object.freeze({
  /**
   * Where the worktrees live. Deliberately a sibling of the repository rather than a
   * directory inside it: a worktree inside the working tree shows up in the user's
   * `git status`, and the runtime's bookkeeping must never look like their change.
   */
  dir: null,
  /** Detached by default: the runtime must not create branches in the user's repo. */
  detached: true,
  branchPrefix: 'dshns/iso',
  maxWorktrees: 8,
  timeoutMs: 60_000
})

function toForwardSlashes(value) {
  return String(value).split('\\').join('/')
}

/**
 * @param {object} input
 * @param {string} input.root the repository root
 * @param {Function} input.git `async (args, options) => { ok, stdout, stderr, reason }`
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 * @param {object} [input.policy]
 */
function createWorkspaceIsolation(input = {}) {
  const root = path.resolve(String(input.root || process.cwd()))
  const git = typeof input.git === 'function' ? input.git : async () => ({ ok: false, reason: 'no git runner is attached' })
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}
  const policy = { ...DEFAULT_POLICY, ...(input.policy || {}) }
  const dir = path.resolve(policy.dir || path.join(path.dirname(root), '.dshns-worktrees', path.basename(root)))

  const records = new Map()
  let nextId = 1
  let created = 0
  let reclaimed = 0
  let failed = 0
  let refused = 0
  let availability = null

  /** Probe once, cache, and allow an explicit re-probe. */
  async function available(options = {}) {
    if (availability && options.force !== true) return availability
    const inside = await git(['rev-parse', '--show-toplevel'])
    if (!inside || inside.ok !== true) {
      availability = { ok: false, kind: ISOLATION_KINDS.SHARED, reason: `${root} is not a git work tree` }
      return availability
    }
    const head = await git(['rev-parse', '--verify', 'HEAD'])
    if (!head || head.ok !== true) {
      availability = { ok: false, kind: ISOLATION_KINDS.SHARED, reason: 'the repository has no commit, so a worktree cannot be created from HEAD' }
      return availability
    }
    const list = await git(['worktree', 'list', '--porcelain'])
    if (!list || list.ok !== true) {
      availability = { ok: false, kind: ISOLATION_KINDS.SHARED, reason: `git worktree is unavailable: ${(list && list.reason) || 'unknown failure'}` }
      return availability
    }
    availability = { ok: true, kind: ISOLATION_KINDS.WORKTREE, reason: null }
    return availability
  }

  async function create(options = {}) {
    const verdict = await available()
    if (!verdict.ok) {
      refused += 1
      return { ok: false, kind: ISOLATION_KINDS.SHARED, reason: verdict.reason }
    }
    if (records.size >= policy.maxWorktrees) {
      refused += 1
      return {
        ok: false,
        kind: ISOLATION_KINDS.SHARED,
        reason: `no isolation capacity: ${records.size} of ${policy.maxWorktrees} worktrees are live`
      }
    }
    const id = `iso-${nextId}`
    nextId += 1
    const worktreePath = path.join(dir, id)
    const ref = options.ref || 'HEAD'
    const wantsBranch = options.branch === true || policy.detached === false
    const branch = wantsBranch ? `${policy.branchPrefix}-${id}` : null
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      failed += 1
      return { ok: false, kind: ISOLATION_KINDS.SHARED, reason: `cannot create ${dir}: ${error && error.message ? error.message : error}` }
    }
    const args = branch
      ? ['worktree', 'add', '-b', branch, worktreePath, ref]
      : ['worktree', 'add', '--detach', worktreePath, ref]
    const added = await git(args, { timeoutMs: policy.timeoutMs })
    if (!added || added.ok !== true) {
      failed += 1
      return {
        ok: false,
        kind: ISOLATION_KINDS.SHARED,
        reason: `git worktree add failed: ${(added && added.reason) || 'unknown failure'}`
      }
    }
    // Success from git is a claim, not a fact: probe the tree before handing it out.
    const probe = await git(['rev-parse', '--show-toplevel'], { cwd: worktreePath })
    if (!probe || probe.ok !== true) {
      failed += 1
      await git(['worktree', 'remove', '--force', worktreePath], { timeoutMs: policy.timeoutMs })
      await git(['worktree', 'prune'])
      return {
        ok: false,
        kind: ISOLATION_KINDS.SHARED,
        reason: `the worktree at ${worktreePath} was created but is not usable`
      }
    }
    const record = {
      id,
      kind: ISOLATION_KINDS.WORKTREE,
      path: worktreePath,
      relative: toForwardSlashes(path.relative(root, worktreePath)),
      label: options.label || null,
      ref,
      branch,
      detached: branch === null,
      createdAt: now()
    }
    records.set(id, record)
    created += 1
    log(`workspace isolation: created ${id} at ${worktreePath} (${branch ? `branch ${branch}` : 'detached'})`)
    return { ok: true, ...record }
  }

  async function reclaim(id, options = {}) {
    const record = records.get(id)
    if (!record) return { ok: false, reason: `unknown worktree "${id}"` }
    return reclaimPath(record, options)
  }

  async function reclaimPath(record, options = {}) {
    const force = options.force !== false
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(record.path)
    const removed = await git(args, { timeoutMs: policy.timeoutMs })
    if (!removed || removed.ok !== true) {
      // The leak stays visible on purpose: a worktree the runtime believes it removed
      // and did not is how the next run fails with "already exists".
      failed += 1
      record.lastError = (removed && removed.reason) || 'unknown failure'
      record.lastAttemptAt = now()
      return { ok: false, id: record.id, path: record.path, reason: `git worktree remove failed: ${record.lastError}` }
    }
    await git(['worktree', 'prune'])
    records.delete(record.id)
    reclaimed += 1
    log(`workspace isolation: reclaimed ${record.id} at ${record.path}`)
    return { ok: true, id: record.id, path: record.path }
  }

  /**
   * Reclaim the worktrees a previous process left behind.
   *
   * A crashed episode cannot clean up after itself, and the trees it created are
   * indistinguishable from the ones this process would create. Anything under our own
   * directory that we do not have a live record for is ours to remove.
   */
  async function sweep() {
    const listed = await git(['worktree', 'list', '--porcelain'])
    if (!listed || listed.ok !== true) {
      return { ok: false, removed: [], kept: [], reason: `git worktree list failed: ${(listed && listed.reason) || 'unknown failure'}` }
    }
    const known = new Set([...records.values()].map((record) => path.resolve(record.path)))
    const removed = []
    const kept = []
    for (const raw of String(listed.stdout || '').split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (!line.startsWith('worktree ')) continue
      const candidate = path.resolve(line.slice('worktree '.length).trim())
      if (known.has(candidate)) continue
      const relative = path.relative(dir, candidate)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const outcome = await git(['worktree', 'remove', '--force', candidate], { timeoutMs: policy.timeoutMs })
      if (outcome && outcome.ok === true) removed.push(candidate)
      else kept.push({ path: candidate, reason: (outcome && outcome.reason) || 'unknown failure' })
    }
    if (removed.length) await git(['worktree', 'prune'])
    return { ok: kept.length === 0, removed, kept }
  }

  async function dispose() {
    const outcomes = []
    for (const record of [...records.values()]) outcomes.push(await reclaimPath(record))
    return {
      ok: outcomes.every((outcome) => outcome.ok),
      reclaimed: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.id),
      failed: outcomes.filter((outcome) => !outcome.ok)
    }
  }

  return {
    ISOLATION_KINDS,
    policy,
    root,
    dir,
    available,
    create,
    reclaim,
    sweep,
    dispose,
    list: () => [...records.values()].map((record) => ({
      id: record.id,
      path: record.path,
      label: record.label,
      branch: record.branch,
      detached: record.detached,
      ageMs: now() - record.createdAt,
      lastError: record.lastError || null
    })),
    get size() {
      return records.size
    },
    status: () => ({
      root,
      dir,
      available: availability ? availability.ok : null,
      reason: availability ? availability.reason : 'not probed yet',
      live: records.size,
      created,
      reclaimed,
      failed,
      refused,
      leaked: [...records.values()].filter((record) => record.lastError).map((record) => ({ id: record.id, path: record.path, reason: record.lastError })),
      policy: { ...policy, dir }
    })
  }
}

module.exports = { createWorkspaceIsolation, ISOLATION_KINDS, DEFAULT_POLICY }
