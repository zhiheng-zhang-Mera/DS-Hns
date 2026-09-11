'use strict'

/**
 * Context Snapshot and Worker Task Package (plan §20, §21).
 *
 * Every worker doing its own repository scan is wasted work and wasted RAM, so
 * the supervisor builds the snapshot once per plan and hands each node only the
 * slice it needs. The package also bounds the node: without an explicit
 * `write_scope`, `timeout` and acceptance list a worker could widen its own
 * task, which plan §21 explicitly forbids.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const MAX_FILES = 400
const MAX_FILE_BYTES = 64 * 1024
const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target',
  'vendor', '.hns', '.cache', 'tmp', 'temp'
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeReadJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function relative(root, file) {
  return path.relative(root, file).replaceAll('\\', '/')
}

/**
 * Walk the project once, bounded: depth, file count and ignored directories are
 * all capped so a huge repository cannot turn the snapshot into the bottleneck.
 */
function walk(root, { maxFiles = MAX_FILES, maxDepth = 6 } = {}) {
  const files = []
  const directories = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length && files.length < maxFiles) {
    const { dir, depth } = queue.shift()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        directories.push(relative(root, path.join(dir, entry.name)))
        if (depth + 1 <= maxDepth) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      let size = 0
      try {
        size = fs.statSync(path.join(dir, entry.name)).size
      } catch {
        size = 0
      }
      files.push({ path: relative(root, path.join(dir, entry.name)), size })
    }
  }
  return { files, directories, truncated: files.length >= maxFiles }
}

/** The git state the snapshot records (plan §20 "current git state"). */
function gitState(root, { timeoutMs = 15_000 } = {}) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
    if (result.status !== 0) return null
    return String(result.stdout || '').trim()
  }
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { available: false, reason: 'not a git work tree' }
  }
  const porcelain = run(['status', '--porcelain=v1'])
  if (porcelain === null) return { available: false, reason: 'git status failed' }
  return {
    available: true,
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: run(['rev-parse', 'HEAD']),
    dirty: porcelain.length > 0,
    changed_files: porcelain
      ? porcelain.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean).slice(0, 100)
      : []
  }
}

/** Dependency map from the manifests a project actually uses (plan §20). */
function dependencyMap(root) {
  const map = {}
  const packageJson = safeReadJson(path.join(root, 'package.json'))
  if (packageJson) {
    map.npm = {
      name: packageJson.name || null,
      scripts: packageJson.scripts ? Object.keys(packageJson.scripts) : [],
      dependencies: packageJson.dependencies ? Object.keys(packageJson.dependencies) : [],
      devDependencies: packageJson.devDependencies ? Object.keys(packageJson.devDependencies) : []
    }
  }
  const pyproject = fs.existsSync(path.join(root, 'pyproject.toml'))
  if (pyproject) map.python = { manifest: 'pyproject.toml' }
  if (fs.existsSync(path.join(root, 'requirements.txt'))) map.python = { ...(map.python || {}), manifest: 'requirements.txt' }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) map.rust = { manifest: 'Cargo.toml' }
  if (fs.existsSync(path.join(root, 'go.mod'))) map.go = { manifest: 'go.mod' }
  return map
}

/**
 * Files that look like the interfaces of the project: entry points, index
 * modules and the manifests. This is what a node usually needs to "know" before
 * it touches anything.
 */
function importantInterfaces(root, files) {
  const patterns = [
    /^package\.json$/,
    /^README(\.[a-z]+)?$/i,
    /^tsconfig\.json$/,
    /^pyproject\.toml$/,
    /(^|\/)index\.(ts|js|tsx|jsx|mjs|cjs)$/,
    /(^|\/)(main|app|server|cli|desktop-main)\.(ts|js|tsx|jsx|mjs|cjs)$/,
    /(^|\/)types?\.(ts|d\.ts)$/,
    /(^|\/)api\.(ts|js|py)$/
  ]
  return files
    .filter((file) => patterns.some((pattern) => pattern.test(file.path)))
    .map((file) => file.path)
    .slice(0, 40)
}

/**
 * Build the Repository Snapshot (plan §20).
 */
function buildSnapshot(root, { planId = null, log = () => {}, maxFiles = MAX_FILES } = {}) {
  const resolved = path.resolve(String(root))
  const { files, directories, truncated } = walk(resolved, { maxFiles })
  const snapshot = {
    version: 1,
    plan_id: planId,
    created_at: new Date().toISOString(),
    root: resolved,
    project_structure: {
      file_count: files.length,
      directory_count: directories.length,
      truncated,
      top_level: [...new Set(files.map((file) => file.path.split('/')[0]))].slice(0, 40),
      files: files.slice(0, 200).map((file) => file.path),
      directories: directories.slice(0, 80)
    },
    dependency_map: dependencyMap(resolved),
    important_interfaces: importantInterfaces(resolved, files),
    configuration: readProjectConfiguration(resolved),
    git: gitState(resolved),
    total_size_bytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
  }
  log(`[snapshot] ${snapshot.project_structure.file_count} files / ${snapshot.project_structure.directory_count} dirs at ${resolved}${truncated ? ' (truncated)' : ''}`)
  return snapshot
}

/** Configuration keys that are safe to hand to a worker (never secrets). */
function readProjectConfiguration(root) {
  const configuration = {}
  const appJson = safeReadJson(path.join(root, 'config', 'app.json'))
  if (appJson) {
    configuration.project = appJson.project || null
    configuration.version = appJson.version || null
    configuration.extensions = appJson.extensions ? Object.keys(appJson.extensions) : []
  }
  const resourceFile = path.join(root, 'config', 'hns-resource.yaml')
  if (fs.existsSync(resourceFile)) configuration.resource_config = 'config/hns-resource.yaml'
  return configuration
}

function snapshotPath(root, planId) {
  return path.join(path.resolve(String(root)), 'data', 'sub-worker', 'snapshots', `${String(planId || 'plan').replace(/[^A-Za-z0-9._-]+/g, '-')}.json`)
}

function writeSnapshot(root, snapshot) {
  const file = snapshotPath(root, snapshot.plan_id)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    return file
  } catch (error) {
    return null
  }
}

function readSnapshot(root, planId) {
  return safeReadJson(snapshotPath(root, planId))
}

/** Files a node cares about, derived from its scopes (plan §20 "task-related files"). */
function relevantFilesFor(node, snapshot) {
  const explicit = Array.isArray(node?.relevant_files) ? node.relevant_files : []
  if (explicit.length) return explicit.slice(0, 100)
  const scopes = [...(node?.write_scope || []), ...(node?.file_scope || [])]
  if (!scopes.length) return []
  const files = snapshot?.project_structure?.files || []
  const matched = files.filter((file) => scopes.some((scope) => {
    const prefix = String(scope).replace(/\*\*?.*$/, '').replace(/\/$/, '')
    return prefix && file.startsWith(prefix)
  }))
  return matched.slice(0, 100)
}

/** Read the relevant files for context, bounded by size and count. */
function readRelevantFiles(root, paths, { maxFiles = 20, maxBytes = MAX_FILE_BYTES } = {}) {
  const contents = {}
  for (const relativePath of (Array.isArray(paths) ? paths : []).slice(0, maxFiles)) {
    const file = path.join(path.resolve(String(root)), relativePath)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.size > maxBytes) continue
      contents[relativePath] = fs.readFileSync(file, 'utf8')
    } catch {}
  }
  return contents
}

/**
 * The Worker Task Package (plan §21).
 *
 * @returns {{ok: boolean, errors: string[], package: object|null}}
 */
function buildTaskPackage({
  node,
  plan,
  snapshot = null,
  workspace = null,
  workerId = null,
  writeScope = null,
  readOnlyFiles = [],
  acceptanceTests = [],
  constraints = [],
  timeoutSeconds = null,
  context = null
} = {}) {
  const errors = []
  if (!isPlainObject(node)) errors.push('a node is required')
  const nodeId = String(node?.node_id || '')
  if (!nodeId) errors.push('the node needs a node_id')
  if (errors.length) return { ok: false, errors, package: null }

  const goal = String(node.objective || plan?.objective || nodeId)
  const scope = (Array.isArray(writeScope) && writeScope.length ? writeScope : (node.write_scope || node.file_scope || []))
    .map((value) => String(value).trim().replaceAll('\\', '/'))
    .filter(Boolean)
  const relevant = relevantFilesFor(node, snapshot)
  const readOnly = [...new Set([...(node.read_only_files || []), ...(readOnlyFiles || [])])].map((value) => String(value).replaceAll('\\', '/'))

  const taskPackage = {
    version: 1,
    task_id: `${plan?.plan_id || 'plan'}-${nodeId}`,
    node_id: nodeId,
    plan_id: plan?.plan_id || null,
    worker_id: workerId,
    role: node.role || 'generic',
    goal,
    relevant_files: relevant,
    read_only_files: readOnly,
    write_scope: scope,
    constraints: [...(node.constraints || []), ...(constraints || [])],
    dependencies: (node.depends_on || []).map((value) => String(value)),
    acceptance_tests: [...(node.acceptance_tests || []), ...(acceptanceTests || [])],
    timeout: Number(timeoutSeconds || node.timeout) > 0 ? Math.floor(Number(timeoutSeconds || node.timeout)) : null,
    workspace,
    requires_network: node.requires_network === true,
    requires_gpu: node.requires_gpu === true,
    speculative: node.speculative === true,
    capability: node.capability || null,
    resource_profile: node.resource_profile || null,
    context: context || null,
    created_at: new Date().toISOString()
  }
  return { ok: true, errors: [], package: taskPackage }
}

/**
 * Turn a package into the Task Object the existing executor already accepts:
 * the write scope becomes `allowed_paths` and the read-only files become
 * `forbidden_paths`, so the executor's own guard enforces the package.
 */
function taskFromPackage(taskPackage, { baseTask = {} } = {}) {
  const scope = Array.isArray(taskPackage?.write_scope) ? taskPackage.write_scope : []
  const readOnly = Array.isArray(taskPackage?.read_only_files) ? taskPackage.read_only_files : []
  return {
    ...baseTask,
    version: baseTask.version || 1,
    task_id: baseTask.task_id || taskPackage?.task_id,
    objective: baseTask.objective || taskPackage?.goal,
    workspace_mode: baseTask.workspace_mode,
    allowed_paths: scope.length ? scope : (baseTask.allowed_paths || ['**']),
    forbidden_paths: [...new Set([...(baseTask.forbidden_paths || []), ...readOnly])],
    acceptance: [...new Set([...(baseTask.acceptance || []), ...(taskPackage?.acceptance_tests || [])])],
    // The package's timeout becomes the per-command ceiling of this node.
    operations: (baseTask.operations || []).map((operation) => (
      operation.timeoutMs || !taskPackage?.timeout
        ? { ...operation }
        : { ...operation, timeoutMs: taskPackage.timeout * 1000 }
    ))
  }
}

module.exports = {
  MAX_FILES,
  MAX_FILE_BYTES,
  IGNORED_DIRS,
  walk,
  gitState,
  dependencyMap,
  importantInterfaces,
  buildSnapshot,
  snapshotPath,
  writeSnapshot,
  readSnapshot,
  relevantFilesFor,
  readRelevantFiles,
  buildTaskPackage,
  taskFromPackage
}
