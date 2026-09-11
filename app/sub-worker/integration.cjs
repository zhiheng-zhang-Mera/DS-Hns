'use strict'

/**
 * Integration Manager (plan §18, §22, §42 "Validation / Merge").
 *
 * Each node works in its own git worktree, so the supervisor has to bring the
 * results back together. The policy is deliberately conservative:
 *
 *   1. every node's changes are collected as file contents (not as a raw diff
 *      to be applied blindly);
 *   2. files changed by exactly one node are merged automatically;
 *   3. a file changed by two nodes is a CONFLICT and is reported to the
 *      Controller instead of being resolved by guesswork;
 *   4. the merged result is written into a dedicated integration worktree and
 *      validated there - the Controller's own working tree is never touched.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { mergeFileChanges } = require('./ownership.cjs')
const { redactSecrets } = require('./event-bus.cjs')

const MAX_MERGED_FILES = 400
const MAX_FILE_BYTES = 1024 * 1024

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function git(args, cwd, { timeoutMs = 60_000 } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: redactSecrets(String(result.stderr || '').trim())
  }
}

/** The commit a worktree was created from, used as the merge base. */
function headCommit(worktree) {
  const result = git(['rev-parse', 'HEAD'], worktree)
  return result.ok ? result.stdout.split(/\r?\n/).pop() : null
}

/**
 * Read a node's contribution: the files it changed relative to the base commit.
 */
function collectChanges(worktree, baseCommit, { maxFiles = MAX_MERGED_FILES } = {}) {
  const base = baseCommit || headCommit(worktree)
  if (!base) return { ok: false, reason: 'no base commit was available', files: {} }
  const status = git(['diff', '--name-status', base], worktree)
  const untracked = git(['ls-files', '--others', '--exclude-standard'], worktree)
  if (!status.ok) return { ok: false, reason: `git diff failed: ${status.stderr}`, files: {} }

  const files = {}
  const entries = []
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [kind, ...rest] = line.split(/\s+/)
    const file = rest.join(' ').trim()
    if (!file) continue
    entries.push({ kind, file })
  }
  for (const line of untracked.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    entries.push({ kind: 'A', file: line.trim() })
  }

  for (const entry of entries.slice(0, maxFiles)) {
    const absolute = path.join(worktree, entry.file)
    if (entry.kind === 'D') {
      files[entry.file] = { content: null, base: null, deleted: true }
      continue
    }
    try {
      const stat = fs.statSync(absolute)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      files[entry.file] = {
        content: fs.readFileSync(absolute, 'utf8'),
        base: entry.kind === 'M' ? readBaseFile(worktree, base, entry.file) : null
      }
    } catch {
      // A file that vanished between the diff and the read is simply skipped.
    }
  }
  return { ok: true, reason: null, base, files, truncated: entries.length > maxFiles }
}

function readBaseFile(worktree, commit, file) {
  const result = spawnSync('git', ['show', `${commit}:${file}`], { cwd: worktree, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (result.status !== 0) return null
  return String(result.stdout || '')
}

/**
 * Merge every node's contribution.
 *
 * @returns {{ok:boolean, merged:object, conflicts:Array, contributions:Array,
 *            summary:string, reasons:string[]}}
 */
function mergeContributions(contributions) {
  const reasons = []
  let merged = {}
  const conflicts = []
  const applied = []

  for (const contribution of contributions) {
    const label = contribution.label || contribution.node_id || 'node'
    const result = mergeFileChanges(merged, contribution.files || {}, { label })
    merged = result.merged
    applied.push(...result.applied.map((file) => ({ file, from: label })))
    for (const conflict of result.conflicts) {
      conflicts.push({ ...conflict, node_id: contribution.node_id || null, worker_id: contribution.worker_id || null })
    }
    if (!result.ok) reasons.push(`${label}: ${result.summary}`)
  }

  return {
    ok: conflicts.length === 0,
    merged,
    conflicts,
    applied,
    summary: conflicts.length
      ? `${conflicts.length} merge conflict(s) across ${contributions.length} contribution(s)`
      : `${applied.length} file(s) merged from ${contributions.length} contribution(s)`,
    reasons
  }
}

/** Path of the integration worktree for a plan. */
function integrationWorktreePath(targetRepo, planId) {
  const resolved = path.resolve(String(targetRepo))
  const parent = path.dirname(resolved)
  const name = path.basename(resolved)
  return path.join(parent, `${name}-worktrees`, `hns-${String(planId)}-integration`)
}

/**
 * Create (or reuse) the integration worktree and apply the merged files there.
 * The Controller's working tree is never written to.
 */
function materializeIntegration({ targetRepo, planId, merged, log = () => {} }) {
  const target = path.resolve(String(targetRepo))
  const worktree = integrationWorktreePath(target, planId)
  if (!fs.existsSync(path.join(worktree, '.git')) && !fs.existsSync(path.join(worktree, '.git.txt'))) {
    fs.mkdirSync(path.dirname(worktree), { recursive: true })
    const created = git(['worktree', 'add', '--detach', worktree], target, { timeoutMs: 120_000 })
    if (!created.ok && !fs.existsSync(worktree)) {
      return { ok: false, reason: `could not create the integration worktree: ${created.stderr || `exit ${created.status}`}`, worktree }
    }
  }

  let written = 0
  const failed = []
  for (const [file, entry] of Object.entries(merged || {})) {
    const absolute = path.join(worktree, file)
    try {
      if (entry.content === null) {
        fs.rmSync(absolute, { force: true })
      } else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, entry.content, 'utf8')
      }
      written += 1
    } catch (error) {
      failed.push({ file, reason: String(error?.message || error) })
    }
  }
  if (failed.length) log(`[integration] ${failed.length} merged file(s) could not be written`)
  return { ok: failed.length === 0, worktree, written, failed }
}

/**
 * High-level: turn finished nodes into one validated integration worktree.
 */
function integrate({
  targetRepo,
  planId,
  nodeChanges = [],
  log = () => {}
} = {}) {
  if (!targetRepo) return { ok: false, reason: 'the plan has no target repository', conflicts: [] }
  const contributions = nodeChanges.filter((entry) => isPlainObject(entry.files) && Object.keys(entry.files).length > 0)
  if (!contributions.length) {
    return { ok: true, merged: {}, conflicts: [], applied: [], summary: 'no node changed any file', worktree: null }
  }
  const merged = mergeContributions(contributions)
  const materialized = materializeIntegration({ targetRepo, planId, merged: merged.merged, log })
  return {
    ...merged,
    worktree: materialized.worktree || null,
    written: materialized.written || 0,
    materialized: materialized.ok,
    materialize_reason: materialized.reason || null
  }
}

module.exports = {
  MAX_MERGED_FILES,
  MAX_FILE_BYTES,
  headCommit,
  collectChanges,
  readBaseFile,
  mergeContributions,
  integrationWorktreePath,
  materializeIntegration,
  integrate
}
