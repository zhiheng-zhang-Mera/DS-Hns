'use strict'

const path = require('node:path')

function contains(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveExternalRoot(root, value, fallbackName) {
  const workspace = path.resolve(root)
  const volume = path.parse(workspace).root.toLowerCase()
  if (typeof value === 'string' && value.trim()) {
    const candidate = path.resolve(value)
    if (
      path.parse(candidate).root.toLowerCase() === volume &&
      !contains(workspace, candidate) &&
      !contains(candidate, workspace)
    ) return candidate
  }
  const fallback = path.resolve(path.dirname(workspace), fallbackName)
  if (contains(workspace, fallback) || contains(fallback, workspace)) {
    throw new Error(`no disjoint ${fallbackName} root can be derived for ${workspace}`)
  }
  return fallback
}

function resolveStorageRoots(root, env = process.env) {
  return {
    temp: resolveExternalRoot(root, env.DSH_TEMP_ROOT, 'temp'),
    runtime: resolveExternalRoot(root, env.DSH_RUNTIME_ROOT, 'runtime-data'),
    test: resolveExternalRoot(root, env.DSH_TEST_ROOT, 'test-artifacts')
  }
}

function resolveRuntimeRoot(root, env = process.env) {
  return resolveStorageRoots(root, env).runtime
}

function resolveTestRoot(root, env = process.env) {
  return resolveStorageRoots(root, env).test
}

module.exports = { resolveStorageRoots, resolveRuntimeRoot, resolveTestRoot }
