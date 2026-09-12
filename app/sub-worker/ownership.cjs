'use strict'

/**
 * File conflict control and the File Ownership Registry (plan §17, §19).
 *
 * Two mechanisms, both about the same risk ("让多个 agent 同时修改同一个 working
 * tree" is forbidden):
 *
 *   expected_file_scope — before a node runs, its write scope is compared with
 *                         every other active scope. A high-probability overlap
 *                         means the two must not run at the same time.
 *   File Ownership Registry — for files that must be shared, the first worker to
 *                         claim a path becomes its writer; every other worker
 *                         may read it but not write it, and waits for the owner
 *                         to release.
 *
 * The registry is enforced at dispatch time by narrowing the task the worker is
 * given (write scope minus other owners' claims, plus explicit read-only
 * paths), so the executor's own path guard does the actual blocking.
 */

const path = require('node:path')

const { matchesAnyGlob, normalizeRelativePath } = require('./permissions.cjs')

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePattern(value) {
  return String(value == null ? '' : value).trim().replaceAll('\\', '/').replace(/^\.\//, '')
}

/** Does a concrete path match a glob pattern (shared with the path guard)? */
function matchesPattern(candidate, pattern) {
  const target = normalizePattern(candidate)
  const glob = normalizePattern(pattern)
  if (!target || !glob) return false
  const matched = matchesAnyGlob(target, [glob])
  if (matched) return true
  // A directory pattern also covers its children.
  if (!/[*?]/.test(glob) && (target === glob || target.startsWith(`${glob.replace(/\/$/, '')}/`))) return true
  return false
}

/** Does a glob pattern overlap another glob pattern in any plausible way? */
function patternsOverlap(left, right) {
  const a = normalizePattern(left)
  const b = normalizePattern(right)
  if (!a || !b) return false
  if (a === b) return true
  // A wildcard always overlaps anything below the same root; a concrete path is
  // tested against the other pattern directly.
  if (!/[*?]/.test(a) && matchesPattern(a, b)) return true
  if (!/[*?]/.test(b) && matchesPattern(b, a)) return true
  if (/[*?]/.test(a) && /[*?]/.test(b)) {
    const rootA = a.split(/[*?]/)[0].replace(/\/$/, '')
    const rootB = b.split(/[*?]/)[0].replace(/\/$/, '')
    if (!rootA || !rootB) return true
    return rootA.startsWith(rootB) || rootB.startsWith(rootA)
  }
  return false
}

/**
 * Compare two write scopes.
 * @returns {{overlap: boolean, pairs: Array<{a: string, b: string}>}}
 */
function scopesOverlap(leftScope, rightScope) {
  const left = (Array.isArray(leftScope) ? leftScope : []).map(normalizePattern).filter(Boolean)
  const right = (Array.isArray(rightScope) ? rightScope : []).map(normalizePattern).filter(Boolean)
  if (!left.length || !right.length) return { overlap: false, pairs: [] }
  const pairs = []
  for (const a of left) {
    for (const b of right) {
      if (patternsOverlap(a, b)) pairs.push({ a, b })
    }
  }
  return { overlap: pairs.length > 0, pairs }
}

/**
 * Scope of a node: an explicit `write_scope`/`file_scope`, else the task's
 * allowed paths, else nothing (unscoped work is treated as conflicting with
 * everything, which keeps the default safe).
 */
function scopeOf(node) {
  const explicit = node?.write_scope || node?.file_scope
  if (Array.isArray(explicit) && explicit.length) return explicit.map(normalizePattern).filter(Boolean)
  const allowed = node?.task?.allowed_paths
  if (Array.isArray(allowed) && allowed.length) return allowed.map(normalizePattern).filter(Boolean)
  return []
}

class FileOwnershipRegistry {
  constructor({ file = null, log = () => {} } = {}) {
    this.file = file
    this.log = log
    this.owners = new Map() // pattern -> { owner, nodeId, claimedAt }
    this.waiters = new Map() // owner -> Set(waiterId)
  }

  /** Load a previously persisted registry. */
  load(serialized) {
    const source = isPlainObject(serialized) ? serialized : {}
    this.owners.clear()
    for (const [pattern, entry] of Object.entries(isPlainObject(source.owners) ? source.owners : {})) {
      if (!isPlainObject(entry) || !entry.owner) continue
      this.owners.set(normalizePattern(pattern), {
        owner: String(entry.owner),
        nodeId: entry.nodeId ? String(entry.nodeId) : null,
        claimedAt: entry.claimedAt || null
      })
    }
    return this.owners.size
  }

  serialize() {
    const owners = {}
    for (const [pattern, entry] of this.owners) owners[pattern] = entry
    return { version: 1, savedAt: new Date().toISOString(), owners }
  }

  ownerOf(candidatePath) {
    const target = normalizePattern(candidatePath)
    if (!target) return null
    for (const [pattern, entry] of this.owners) {
      // An exact file claim wins over a directory claim.
      if (pattern === target) return { pattern, ...entry }
    }
    for (const [pattern, entry] of this.owners) {
      if (matchesPattern(target, pattern)) return { pattern, ...entry }
    }
    return null
  }

  /** Claim a scope for one worker. Returns the patterns it now owns. */
  claim(workerId, nodeId, scope) {
    const claimed = []
    for (const raw of Array.isArray(scope) ? scope : []) {
      const pattern = normalizePattern(raw)
      if (!pattern) continue
      const existing = this.owners.get(pattern)
      if (existing && existing.owner !== workerId) continue
      this.owners.set(pattern, { owner: String(workerId), nodeId: nodeId ? String(nodeId) : null, claimedAt: new Date().toISOString() })
      claimed.push(pattern)
    }
    return claimed
  }

  /** Release everything a worker held. Returns the released patterns. */
  release(workerId) {
    const released = []
    for (const [pattern, entry] of [...this.owners]) {
      if (entry.owner !== String(workerId)) continue
      this.owners.delete(pattern)
      released.push(pattern)
    }
    this.waiters.delete(String(workerId))
    return released
  }

  releaseNode(nodeId) {
    const released = []
    for (const [pattern, entry] of [...this.owners]) {
      if (entry.nodeId !== String(nodeId)) continue
      this.owners.delete(pattern)
      released.push(pattern)
    }
    return released
  }

  /** Paths a worker may not write because someone else owns them. */
  blockedFor(workerId, scope) {
    const blocked = []
    for (const raw of Array.isArray(scope) ? scope : []) {
      const pattern = normalizePattern(raw)
      if (!pattern) continue
      for (const [owned, entry] of this.owners) {
        if (entry.owner === String(workerId)) continue
        if (patternsOverlap(pattern, owned)) blocked.push({ pattern, owned, owner: entry.owner })
      }
    }
    return blocked
  }

  list() {
    return [...this.owners].map(([pattern, entry]) => ({ path: pattern, ...entry }))
  }

  /** Owners that currently hold any part of the given scope. */
  ownersWithin(scope) {
    const owners = new Set()
    for (const [pattern, entry] of this.owners) {
      for (const raw of Array.isArray(scope) ? scope : []) {
        if (patternsOverlap(normalizePattern(raw), pattern)) owners.add(entry.owner)
      }
    }
    return [...owners]
  }
}

/**
 * Conflict filter (plan §17, §42 `filter_conflicts`).
 *
 * @returns {{ok: boolean, reason: string|null, conflicts: Array}}
 */
function filterConflicts(candidate, active, { registry = null } = {}) {
  const candidateScope = scopeOf(candidate)
  const conflicts = []

  if (!candidateScope.length) {
    // Unscoped work is treated as a potential conflict with any other active
    // work: silently assuming "no overlap" is what corrupts a shared tree.
    if (active.length) {
      return {
        ok: false,
        reason: `node ${candidate.node_id} declares no write scope while ${active.length} other node(s) are running`,
        conflicts: active.map((entry) => ({ node_id: entry.node_id, reason: 'unscoped' }))
      }
    }
    return { ok: true, reason: null, conflicts: [] }
  }

  for (const entry of active) {
    const otherScope = scopeOf(entry)
    const { overlap, pairs } = scopesOverlap(candidateScope, otherScope)
    if (overlap) conflicts.push({ node_id: entry.node_id, worker_id: entry.worker_id || null, pairs })
  }
  if (conflicts.length) {
    return {
      ok: false,
      reason: `node ${candidate.node_id} overlaps ${conflicts.map((entry) => entry.node_id).join(', ')}`,
      conflicts
    }
  }

  if (registry) {
    const blocked = registry.blockedFor(candidate.worker_id || 'unassigned', candidateScope)
    if (blocked.length) {
      return {
        ok: false,
        reason: `node ${candidate.node_id} would write ${blocked.map((entry) => entry.pattern).join(', ')} owned by ${[...new Set(blocked.map((entry) => entry.owner))].join(', ')}`,
        conflicts: blocked.map((entry) => ({ node_id: entry.owner, reason: 'file ownership', path: entry.pattern }))
      }
    }
  }

  return { ok: true, reason: null, conflicts: [] }
}

/**
 * Three-way merge of a node's file changes onto a base tree (plan §18, §42
 * "Validation / Merge"). Returns a structured outcome; a conflict is reported
 * for the Controller instead of being resolved by guesswork.
 *
 * Rule: two contributions touching the same path is a conflict — whether they
 * both created it, both edited it, or one did each. §17 forbids two workers
 * writing one file at the same time, and the merge stage must not silently pick
 * a winner afterwards.
 */
function mergeFileChanges(base, incoming, { label = 'node' } = {}) {
  const baseFiles = isPlainObject(base) ? base : {}
  const incomingFiles = isPlainObject(incoming) ? incoming : {}
  const merged = { ...baseFiles }
  const applied = []
  const conflicts = []

  for (const [file, change] of Object.entries(incomingFiles)) {
    const existing = merged[file]
    const before = existing?.content ?? null
    const after = change?.content ?? null

    if (existing && existing.from && existing.from !== label) {
      if (before === after) continue
      conflicts.push({
        path: file,
        reason: `both ${existing.from} and ${label} changed this file`,
        base: change?.base ?? null,
        incoming: after,
        other: before
      })
      continue
    }

    if (!existing) {
      merged[file] = { content: after, from: label }
      applied.push(file)
      continue
    }
    if (before === after) continue
    if (change?.base !== undefined && change.base !== null && change.base !== before) {
      conflicts.push({ path: file, reason: 'the base changed since the node started', base: before, incoming: change.base })
      continue
    }
    merged[file] = { content: after, from: label }
    applied.push(file)
  }

  return {
    ok: conflicts.length === 0,
    merged,
    applied,
    conflicts,
    summary: conflicts.length
      ? `${conflicts.length} conflict(s) require the Controller`
      : `${applied.length} file(s) merged from ${label}`
  }
}

/** The scope a plan claims in total, used to describe a worktree (§18). */
function planScope(plan) {
  const patterns = new Set()
  for (const node of plan?.nodes || []) {
    for (const pattern of scopeOf(node)) patterns.add(pattern)
  }
  return [...patterns]
}

function worktreePathFor(targetRepo, planId, nodeId) {
  const resolved = path.resolve(String(targetRepo))
  const parent = path.dirname(resolved)
  const name = path.basename(resolved)
  return path.join(parent, `${name}-worktrees`, `hns-${String(planId)}-${String(nodeId)}`)
}

module.exports = {
  normalizePattern,
  matchesPattern,
  patternsOverlap,
  scopesOverlap,
  scopeOf,
  FileOwnershipRegistry,
  filterConflicts,
  mergeFileChanges,
  planScope,
  worktreePathFor
}
