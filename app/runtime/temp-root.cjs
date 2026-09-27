'use strict'

const { resolveStorageRoots } = require('./storage-roots.cjs')

/**
 * Resolve a command temp root that is on the repository volume but disjoint from the repository.
 * Windows ACL sandboxing refuses an overlapping temp root, while an ambient C: temp would violate
 * the portable D: installation boundary. Invalid ambient candidates therefore fail closed to the
 * checkout parent's dedicated `temp` directory.
 */
function resolveCommandTemp(root, env = process.env) {
  return resolveStorageRoots(root, {
    ...env,
    DSH_TEMP_ROOT: env.DSH_TEMP_ROOT || env.TMP || env.TEMP
  }).temp
}

module.exports = { resolveCommandTemp }
