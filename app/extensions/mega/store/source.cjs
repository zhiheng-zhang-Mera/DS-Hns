'use strict'

/**
 * Where a plugin comes from: `owner/name`, `owner/name#path`, or a GitHub URL of either.
 *
 * Both halves of the store need this and neither may disagree about it — the search turns what the
 * user typed into a repository to look up, and the installer turns the same string into a URL to
 * clone and a directory to stage — so it lives in one place. The `#path` form is what makes a
 * monorepo installable: 22 plugins in one repository means "the repository is not a plugin" is the
 * wrong answer for a user who named a *package*.
 */

/** `owner/name`, and nothing else. */
function normalizeRepo(value) {
  const text = String(value || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(text)) return null
  return text
}

/**
 * Parse a store source.
 *
 * A path is refused rather than sanitised when it could mean something other than "a directory
 * inside the repository": a source string arrives from a text box, so absolute paths, Windows
 * drive letters, backslashes, NUL bytes, `.` and `..` segments all produce `null` and the caller
 * reports that the source is not a repository. A *leading* slash is only stripped, because git
 * paths are always relative to the repository root and `#/packages/x` is the same package.
 *
 * @returns {{repo:string, path:string|null, source:string}|null}
 */
function parseSource(value) {
  const text = String(value || '').trim()
  const hash = text.indexOf('#')
  const repo = normalizeRepo(hash === -1 ? text : text.slice(0, hash))
  if (!repo) return null
  const rawPath = hash === -1 ? '' : text.slice(hash + 1).trim().replace(/^\/+|\/+$/g, '')
  if (!rawPath) return { repo, path: null, source: repo }
  if (/[\\#]/.test(rawPath) || /^[a-zA-Z]:/.test(rawPath) || /\0/.test(rawPath)) return null
  const segments = rawPath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return { repo, path: segments.join('/'), source: `${repo}#${segments.join('/')}` }
}

/** A path inside a repository, as a URL fragment, with no leading or trailing slash. */
function cleanPath(value) {
  const text = String(value || '').trim().replace(/^\/+|\/+$/g, '')
  if (!text) return null
  if (/[\\#]/.test(text) || /^[a-zA-Z]:/.test(text) || /\0/.test(text)) return null
  const segments = text.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

module.exports = { normalizeRepo, parseSource, cleanPath }
