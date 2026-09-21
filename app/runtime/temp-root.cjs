'use strict'

const path = require('node:path')

function contains(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Resolve a command temp root that is on the repository volume but disjoint from the repository.
 * Windows ACL sandboxing refuses an overlapping temp root, while an ambient C: temp would violate
 * the portable D: installation boundary. Invalid ambient candidates therefore fail closed to the
 * checkout parent's dedicated `temp` directory.
 */
function resolveCommandTemp(root, env = process.env) {
  const workspace = path.resolve(root)
  const volume = path.parse(workspace).root.toLowerCase()
  const candidates = [env.DSH_TEMP_ROOT, env.TMP, env.TEMP]
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim()) continue
    const candidate = path.resolve(value)
    if (path.parse(candidate).root.toLowerCase() !== volume) continue
    if (contains(workspace, candidate) || contains(candidate, workspace)) continue
    return candidate
  }
  const fallback = path.resolve(path.dirname(workspace), 'temp')
  if (contains(workspace, fallback) || contains(fallback, workspace)) {
    throw new Error(`no disjoint command temp root can be derived for ${workspace}`)
  }
  return fallback
}

module.exports = { resolveCommandTemp }
