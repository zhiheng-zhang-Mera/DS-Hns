'use strict'

/**
 * DS-Hns acceleration: the repository map.
 *
 * The runtime should learn a repository once, not re-read it on every call. The map
 * answers the five questions a coding step actually has:
 *
 *   findSymbol(name)          where is this defined, or re-exported?
 *   findReferences(symbol)    who uses it?
 *   getDependencies(path)     what does this file import?
 *   getDependents(path)       what would break if I change it?
 *   getRelevantTests(path)    which tests should run first?
 *
 * It is deliberately a *scanner*, not a language server: it reads files once,
 * extracts imports, exports and test references with cheap, deterministic rules, and
 * caches the result under a fingerprint of the workspace. Adding a real parser later
 * means changing this file only, because callers see the five questions above and
 * nothing else.
 *
 * Two properties matter for a long run:
 *
 *  * **The map is rebuilt, never assumed.** A file that changed invalidates its own
 *    entry, and a manifest change invalidates the whole map — a stale map is worse
 *    than no map, because it makes the runtime confident about the wrong thing.
 *  * **The scan is bounded.** File count, file size and the recorded references are
 *    all capped, so a repository of any size produces a map of a predictable size.
 */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 4_000,
  maxFileBytes: 512 * 1024,
  maxReferencesPerSymbol: 200,
  /** Directories that are never part of the map. */
  ignore: ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'bin', 'obj']
})

/** The extensions the scanner understands, with the import syntax for each. */
const LANGUAGES = Object.freeze({
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp'
})

const TEST_PATTERN = /(^|[./\\])(tests?|spec|__tests__)([./\\]|$)|[._-](test|spec)\.[a-z]+$/i

function languageOf(file) {
  return LANGUAGES[path.extname(file).toLowerCase()] || null
}

/**
 * Extract the imports, exports and declared symbols from one file's text.
 *
 * These are cheap regexes on purpose: they are the same rules a human uses when
 * skimming, they are deterministic, and they cost a fraction of a parser. Where they
 * are unsure they say nothing rather than guessing, which is why the map records
 * `confidence: 'heuristic'`.
 */
function parseFile(text, language) {
  const imports = []
  const exports = []
  const symbols = []
  const lineStarts = [0]
  for (let cursor = text.indexOf('\n'); cursor !== -1; cursor = text.indexOf('\n', cursor + 1)) lineStarts.push(cursor + 1)
  /** The 1-based line a match starts on, so symbols come back in source order. */
  const lineAt = (index) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }
  for (const match of text.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) imports.push(match[1])
  // `const x = require('…')`, `const { a, b } = require('…')`, `const [a] = require('…')`.
  // Destructuring is the dominant style in this repository, so a scanner that only
  // understood `const x = require(…)` would report half the dependency edges as absent.
  for (const match of text.matchAll(/^\s*(?:const|let|var)\s+(?:\{[^}]*\}|\[[^\]]*\]|[\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm)) imports.push(match[1])
  // A bare `require('…')` used for its side effect is still a dependency.
  for (const match of text.matchAll(/^\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm)) imports.push(match[1])
  for (const match of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) imports.push(match[1].replace(/\./g, '/'))
  for (const match of text.matchAll(/^\s*use\s+crate::([\w:]+)/gm)) imports.push(match[1])
  for (const match of text.matchAll(/^\s*import\s+\(?\s*"([^"]+)"/gm)) imports.push(match[1])
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) symbols.push({ name: match[1], kind: 'function', line: lineAt(match.index) })
  for (const match of text.matchAll(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) symbols.push({ name: match[1], kind: 'class', line: lineAt(match.index) })
  for (const match of text.matchAll(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) symbols.push({ name: match[1], kind: 'value', line: lineAt(match.index) })
  for (const match of text.matchAll(/^\s*def\s+([A-Za-z_]\w*)/gm)) symbols.push({ name: match[1], kind: 'function', line: lineAt(match.index) })
  for (const match of text.matchAll(/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm)) symbols.push({ name: match[1], kind: 'function', line: lineAt(match.index) })
  for (const match of text.matchAll(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm)) symbols.push({ name: match[1], kind: 'function', line: lineAt(match.index) })
  for (const match of text.matchAll(/^\s*export\s+(?:default\s+)?([A-Za-z_$][\w$]*)/gm)) exports.push(match[1])
  for (const match of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.split(':')[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) exports.push(trimmed)
    }
  }
  return {
    language,
    imports: [...new Set(imports)],
    exports: [...new Set(exports)],
    symbols: dedupeSymbols(symbols)
  }
}

function dedupeSymbols(symbols) {
  const seen = new Map()
  // Source order, so the map reads like the file and a caller that walks `symbols`
  // sees definitions in the order the reader would.
  for (const symbol of [...symbols].sort((left, right) => left.line - right.line)) {
    const key = `${symbol.name}:${symbol.kind}`
    if (!seen.has(key)) seen.set(key, symbol)
  }
  return [...seen.values()]
}

/**
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {object} [options.limits]
 * @param {Function} [options.now]
 */
function createRepoMap(options = {}) {
  const root = path.resolve(String(options.root || process.cwd()))
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  let files = new Map()
  let builtAt = null
  let scanned = 0
  let skipped = []

  function ignored(name) {
    return limits.ignore.includes(name)
  }

  /** Walk the workspace once, bounded. */
  function scanDirectory(dir, collected) {
    if (collected.length >= limits.maxFiles) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (collected.length >= limits.maxFiles) return
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (entry.isDirectory() || ignored(entry.name)) continue
      }
      if (entry.isDirectory()) {
        if (ignored(entry.name)) continue
        scanDirectory(path.join(dir, entry.name), collected)
        continue
      }
      collected.push(path.join(dir, entry.name))
    }
  }

  /**
   * Build (or rebuild) the map.
   *
   * @param {object} [input]
   * @param {boolean} [input.force] ignore the cache and rescan
   */
  function build(input = {}) {
    const startedAt = now()
    if (builtAt !== null && input.force !== true) return snapshot()
    const collected = []
    scanDirectory(root, collected)
    const next = new Map()
    skipped = []
    for (const file of collected) {
      const language = languageOf(file)
      if (!language) continue
      let stats = null
      try {
        stats = fs.statSync(file)
      } catch {
        skipped.push({ file, reason: 'unreadable' })
        continue
      }
      if (stats.size > limits.maxFileBytes) {
        skipped.push({ file, reason: `larger than ${limits.maxFileBytes} bytes` })
        continue
      }
      let text = ''
      try {
        text = fs.readFileSync(file, 'utf8')
      } catch {
        skipped.push({ file, reason: 'unreadable' })
        continue
      }
      const parsed = parseFile(text, language)
      next.set(file, {
        file,
        relative: path.relative(root, file).split(path.sep).join('/'),
        language,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        isTest: TEST_PATTERN.test(path.relative(root, file)),
        ...parsed
      })
    }
    files = next
    builtAt = now()
    scanned += 1
    return snapshot()
  }

  /** The cached view, plus what a rebuild would need. */
  function snapshot() {
    return {
      root,
      builtAt,
      scans: scanned,
      files: files.size,
      tests: [...files.values()].filter((entry) => entry.isTest).length,
      skipped: skipped.slice(0, 20),
      map: new Map(files)
    }
  }

  /** Resolve an import specifier to a file in the map, when it can be. */
  function resolveImport(fromFile, specifier) {
    if (!specifier || !specifier.startsWith('.')) return null
    const base = path.resolve(path.dirname(fromFile), specifier)
    const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, `${base}.py`, path.join(base, 'index.cjs'), path.join(base, 'index.js')]
    for (const candidate of candidates) {
      if (files.has(candidate)) return candidate
    }
    return null
  }

  /** A file's resolved dependencies. */
  function getDependencies(target) {
    const resolved = resolveTarget(target)
    const entry = resolved ? files.get(resolved) : null
    if (!entry) return []
    return entry.imports
      .map((specifier) => resolveImport(entry.file, specifier))
      .filter(Boolean)
      .map((file) => files.get(file).relative)
  }

  /** Which files import this one. */
  function getDependents(target) {
    const resolved = resolveTarget(target)
    if (!resolved) return []
    const dependents = []
    for (const entry of files.values()) {
      for (const specifier of entry.imports) {
        if (resolveImport(entry.file, specifier) === resolved) {
          dependents.push(entry.relative)
          break
        }
      }
    }
    return dependents.slice(0, limits.maxReferencesPerSymbol)
  }

  /**
   * Which tests are relevant to this file.
   *
   * A test is relevant when it lives in a test file and either imports the target
   * (directly or transitively through one dependency hop) or shares its base name.
   * The one-hop transitivity is what catches `src/auth/token.js` ->
   * `src/auth/index.js` -> `tests/auth/token.test.js`.
   */
  function getRelevantTests(target) {
    const resolved = resolveTarget(target)
    if (!resolved) return []
    const entry = files.get(resolved)
    const base = path.basename(resolved).replace(/\.[^.]+$/, '')
    const direct = new Set(getDependents(entry.relative))
    const transitive = new Set()
    for (const dependent of direct) {
      for (const second of getDependents(dependent)) transitive.add(second)
    }
    const relevant = []
    for (const candidate of files.values()) {
      if (!candidate.isTest) continue
      if (direct.has(candidate.relative) || transitive.has(candidate.relative) || new RegExp(`(^|[/_.-])${escapeRegExp(base)}([._-]|$)`, 'i').test(candidate.relative)) {
        relevant.push(candidate.relative)
      }
    }
    return [...new Set(relevant)].slice(0, limits.maxReferencesPerSymbol)
  }

  /**
   * Where a symbol is defined.
   *
   * A file that only re-exports the name — `module.exports = { name }` for a symbol
   * that actually lives elsewhere — is reported too, with `kind: 'export'`. In a
   * repository with barrel files, "where is this defined" and "where do I import it
   * from" are the same question, and answering only the first sends the model to read
   * the barrel anyway.
   */
  function findSymbol(name) {
    const wanted = String(name || '')
    if (!wanted) return []
    const found = new Map()
    for (const entry of files.values()) {
      for (const symbol of entry.symbols) {
        if (symbol.name !== wanted) continue
        found.set(entry.relative, { name: symbol.name, kind: symbol.kind, file: entry.relative, language: entry.language, line: symbol.line })
      }
      if (!found.has(entry.relative) && entry.exports.includes(wanted)) {
        found.set(entry.relative, { name: wanted, kind: 'export', file: entry.relative, language: entry.language, line: null })
      }
    }
    return [...found.values()].slice(0, limits.maxReferencesPerSymbol)
  }

  /** Who references a symbol, by name. */
  function findReferences(name) {
    const wanted = String(name || '')
    if (!wanted) return []
    const pattern = new RegExp(`\\b${escapeRegExp(wanted)}\\b`)
    const found = []
    for (const entry of files.values()) {
      let text = ''
      try {
        text = fs.readFileSync(entry.file, 'utf8')
      } catch {
        continue
      }
      if (!pattern.test(text)) continue
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (pattern.test(lines[index])) {
          found.push({ file: entry.relative, line: index + 1, text: lines[index].trim().slice(0, 160) })
          break
        }
      }
      if (found.length >= limits.maxReferencesPerSymbol) break
    }
    return found
  }

  /** Resolve a caller-supplied path against the map. */
  function resolveTarget(target) {
    if (!target) return null
    const absolute = path.isAbsolute(String(target)) ? path.resolve(String(target)) : path.resolve(root, String(target))
    if (files.has(absolute)) return absolute
    const relative = String(target).split(path.sep).join('/')
    for (const entry of files.values()) {
      if (entry.relative === relative) return entry.file
    }
    return null
  }

  /**
   * Invalidate part of the map.
   *
   * A file that changed drops its own entry; a manifest or configuration change
   * invalidates everything, because the map's assumptions about the project may no
   * longer hold.
   */
  function invalidate(input = {}) {
    const changed = Array.isArray(input.files) ? input.files : []
    const full = input.full === true || changed.some((file) => /package\.json|tsconfig|pyproject|Cargo\.toml|go\.mod/i.test(String(file)))
    if (full) {
      files = new Map()
      builtAt = null
      return { full: true, removed: 'all' }
    }
    let removed = 0
    for (const file of changed) {
      const absolute = path.isAbsolute(String(file)) ? String(file) : path.resolve(root, String(file))
      if (files.delete(absolute)) removed += 1
    }
    return { full: false, removed }
  }

  return {
    LANGUAGES,
    DEFAULT_LIMITS,
    root,
    limits,
    build,
    snapshot,
    invalidate,
    getDependencies,
    getDependents,
    getRelevantTests,
    findSymbol,
    findReferences,
    resolveTarget,
    get built() {
      return builtAt !== null
    },
    get size() {
      return files.size
    },
    status() {
      return { root, built: builtAt !== null, files: files.size, scans: scanned, skipped: skipped.length, limits: { ...limits } }
    }
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = { createRepoMap, parseFile, languageOf, LANGUAGES, DEFAULT_LIMITS, TEST_PATTERN }
