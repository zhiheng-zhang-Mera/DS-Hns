'use strict'

/**
 * DS-Hns Core: what a DeepSeek Harness / Cordis community plugin declares about itself.
 *
 * A community plugin is not an unknown package. It follows a convention, and the convention is
 * written down in three places that can all be read without running anything:
 *
 *   * `package.json` → `dsh.bundle.patch` — the profile patch layer this bundle contributes;
 *   * `package.json` → `dsh.client` — the browser half: which client modules it injects, which
 *     platform it is for, and whether it wants to load immediately;
 *   * `cordis.patch.yml` — the rows the patch inserts;
 *   * `peerDependencies` — the host services it expects the *host* to provide, which is what a
 *     peer dependency means and what the bridge has to honour.
 *
 * This module reads all four and answers one question: *what is this plugin, and what would it
 * need to run here.* It reads only. It never imports the plugin, never runs it, never writes to it
 * and never patches it — the whole point of an adapter is that the community plugin is left
 * exactly as its author published it.
 *
 * Two distinctions the report keeps that a simpler reader would collapse:
 *
 *   1. **A required peer and an optional peer are different facts.** `wallpaper-engine-dsh`
 *      declares every one of its peers optional, which is a statement that it degrades; a plugin
 *      that requires `@deepseek-ai/dsh-host-webserver` without the optional marker is saying it
 *      cannot work at all without it. Reporting both as "missing dependency" would hide that.
 *   2. **The host half and the client half are different halves.** The host half is node code this
 *      bridge can run and mediate. The client half is browser code that ships to the web UI, and a
 *      process-level bridge cannot serve it. Conflating them is how "we support client plugins"
 *      becomes a claim nobody can check.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The markers a community DSH plugin is recognised by, in the order they are reported. */
const STRUCTURE_MARKERS = Object.freeze({
  BUNDLE_PATCH: 'package.json#dsh.bundle.patch',
  CLIENT: 'package.json#dsh.client',
  PATCH_FILE: 'cordis.patch.yml',
  ENGINES_DSH: 'package.json#dsh.engines.dsh',
  PEER_CORDIS: 'peerDependencies#@deepseek-ai/cordis'
})

/** How the plugin half is written, which decides how it can be imported. */
const MODULE_FORMATS = Object.freeze({ ESM: 'esm', CJS: 'cjs', UNKNOWN: 'unknown' })

/** What the analysis concluded the artifact is. */
const PLUGIN_SHAPES = Object.freeze({
  /** A DSH bundle: declares a patch layer, and therefore expects to be a profile row. */
  DSH_BUNDLE: 'dsh-bundle',
  /** Carries `dsh.client` but contributes no host patch: a browser-only extension. */
  DSH_CLIENT_ONLY: 'dsh-client-only',
  /** A Cordis plugin without the DSH markers. */
  CORDIS_PLUGIN: 'cordis-plugin',
  /** A package that declares none of it. */
  PLAIN_PACKAGE: 'plain-package'
})

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** A package-relative path that stays inside the package, as posix, or null. */
function insidePackage(dir, relative) {
  if (!relative) return null
  const resolved = path.resolve(dir, String(relative))
  const relativeToDir = path.relative(dir, resolved)
  if (!relativeToDir || relativeToDir.startsWith('..') || path.isAbsolute(relativeToDir)) return null
  return relativeToDir.split(path.sep).join('/')
}

/** The entry a package declares, from `exports['.']` first and `main` second (npm's own order). */
function entryFrom(pkg, dir, subpath = null) {
  const exports_ = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : null
  const key = subpath || '.'
  const declared = exports_ && exports_[key] !== undefined ? exports_[key] : null
  const fromExports = typeof declared === 'string'
    ? declared
    : declared && typeof declared === 'object'
      ? ['default', 'import', 'require', 'node'].map((condition) => declared[condition]).find((value) => typeof value === 'string') || null
      : null
  const candidate = fromExports || (subpath ? null : (typeof pkg.main === 'string' ? pkg.main : null))
  const relative = insidePackage(dir, candidate)
  return {
    declared: candidate ? String(candidate) : null,
    file: relative,
    exists: relative ? isFile(path.join(dir, relative)) : false
  }
}

/** ESM or CJS, from `type`, the entry's extension, and the entry's own syntax. */
function formatFor(pkg, entry) {
  if (entry && /\.mjs$/i.test(entry.file || '')) return MODULE_FORMATS.ESM
  if (entry && /\.cjs$/i.test(entry.file || '')) return MODULE_FORMATS.CJS
  if (pkg.type === 'module') return MODULE_FORMATS.ESM
  if (pkg.type === 'commonjs') return MODULE_FORMATS.CJS
  return MODULE_FORMATS.UNKNOWN
}

/**
 * The services a plugin declares it needs, read from its host entry.
 *
 * Cordis declares dependencies as `export const inject = ['webServer']`, or as
 * `{ required: [...], optional: [...] }` when some of them may be absent. A *built* plugin rarely
 * writes the first form: a bundler emits `const inject = ["webServer"]` near the bottom of the
 * file and re-exports it from a list, so both spellings are read, and the bare binding only counts
 * when the name is actually exported — a local variable that happens to be called `inject` is not
 * a declaration of anything.
 *
 * The whole entry is read rather than its head, because a bundle puts its export list at the end.
 * An entry is capped so a pathological file cannot turn analysis into a memory event.
 */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024

function injectFrom(entryFile) {
  if (!entryFile || !isFile(entryFile)) return { declared: false, required: [], optional: [], source: null }
  let text = ''
  try {
    text = fs.readFileSync(entryFile, 'utf8').slice(0, MAX_ENTRY_BYTES)
  } catch {
    return { declared: false, required: [], optional: [], source: null }
  }

  /** The names a bundled entry re-exports, which is how a built plugin publishes its contract. */
  const exported = new Set()
  for (const block of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) exported.add(name)
    }
  }

  const LITERAL = '(\\[[^\\]]*\\]|\\{[\\s\\S]{0,800}?\\})'
  const direct = new RegExp(`export\\s+(?:const|let|var)\\s+inject\\s*=\\s*${LITERAL}`).exec(text)
  const literal = direct
    ? direct[1]
    : (() => {
        const binding = new RegExp(`(?:const|let|var)\\s+inject\\s*=\\s*${LITERAL}`).exec(text)
        return binding && exported.has('inject') ? binding[1] : null
      })()
  if (!literal) return { declared: false, required: [], optional: [], source: null }

  const names = (chunk) => {
    const out = []
    for (const found of String(chunk).matchAll(/['"]([^'"]+)['"]/g)) out.push(found[1])
    return out
  }
  if (literal.trimStart().startsWith('[')) {
    return { declared: true, required: names(literal), optional: [], source: literal.slice(0, 400) }
  }
  const required = /required\s*:\s*(\[[^\]]*\])/.exec(literal)
  const optional = /optional\s*:\s*(\[[^\]]*\])/.exec(literal)
  return {
    declared: true,
    required: required ? names(required[1]) : [],
    optional: optional ? names(optional[1]) : [],
    source: literal.slice(0, 400)
  }
}

/**
 * The rows a `cordis.patch.yml` inserts.
 *
 * The rows are what tell the host *which names the bundle expects to be mounted as*, which is the
 * fact a profile needs and a `package.json` does not carry.
 *
 * This is a focused reader rather than a general YAML parser, on purpose. The repository's own
 * `parseYaml` is a *resource-config* reader: it rejects the nested `- insert:` / `- id:` sequence
 * this file is made of (`sequence entry without a list key`), and pulling in a full YAML engine to
 * read two fields would be a large dependency for a small question. The patch format is a fixed
 * shape — a top-level list of entries, each optionally inserting a list of rows — so the reader
 * handles that shape and reports what it could not read rather than guessing.
 */
function patchRowsFor(dir, relative) {
  const file = insidePackage(dir, relative)
  if (!file || !isFile(path.join(dir, file))) {
    return { file, exists: false, rows: [], error: null }
  }
  let text = ''
  try {
    text = fs.readFileSync(path.join(dir, file), 'utf8')
  } catch (error) {
    return { file, exists: true, rows: [], error: String(error && error.message ? error.message : error) }
  }

  const rows = []
  let insideInsert = false
  let insertIndent = -1
  let current = null

  const unquote = (value) => {
    const trimmed = String(value).trim()
    const quoted = /^(['"])(.*)\1$/.exec(trimmed)
    return quoted ? quoted[2] : trimmed
  }
  /** A comment is a `#` that starts a line or follows whitespace, and is not inside quotes. */
  const stripComment = (line) => {
    let quote = null
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quote) {
        if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
    }
    return line
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw)
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length

    if (/^\s*-\s*insert\s*:\s*$/.test(line)) {
      insideInsert = true
      insertIndent = indent
      current = null
      continue
    }
    if (insideInsert && indent <= insertIndent && /^\s*-\s*/.test(line)) {
      // A new top-level entry began: the insert block is over.
      insideInsert = false
      current = null
    }
    if (!insideInsert) continue

    const idMatch = /^\s*-\s*id\s*:\s*(.+?)\s*$/.exec(line)
    if (idMatch) {
      current = { id: unquote(idMatch[1]), name: null, hasConfig: false }
      rows.push(current)
      continue
    }
    if (!current) continue
    const nameMatch = /^\s*name\s*:\s*(.+?)\s*$/.exec(line)
    if (nameMatch) {
      current.name = unquote(nameMatch[1])
      continue
    }
    if (/^\s*config\s*:/.test(line)) current.hasConfig = true
  }

  return { file, exists: true, rows, error: null }
}

/**
 * The peer dependencies, split into what the host must supply and what it may.
 *
 * `resolved` is recorded per root so a report can say *where* a peer came from: a plugin whose
 * peer resolves out of the harness's own install and one that resolves out of a private provider
 * directory are different deployment facts.
 *
 * @param {string} dir the plugin directory
 * @param {object} pkg its package.json
 * @param {string[]} roots directories that provide host dependencies, most specific first
 * @param {string[]} [platformWords] specifiers the *client module host* supplies as platform words
 *   rather than as installed packages. A community plugin's `dsh.client.inject` list is exactly that
 *   list: those names are answered by the browser module loader's own table at load time, so a
 *   `node_modules` search for them is the wrong question. Anything unresolved that is named here is
 *   reported as `providedAtRuntime` and not as missing — a distinction that keeps "the host does not
 *   provide this" apart from "this host has nothing to do with it".
 */
function auditPeers(dir, pkg, roots = [], platformWords = []) {
  const peers = pkg.peerDependencies && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : {}
  const meta = pkg.peerDependenciesMeta && typeof pkg.peerDependenciesMeta === 'object' ? pkg.peerDependenciesMeta : {}
  const words = new Set((Array.isArray(platformWords) ? platformWords : []).map(String))
  const resolved = {}
  const missing = []
  const providedAtRuntime = []
  const required = []
  const optional = []

  for (const [name, range] of Object.entries(peers)) {
    const isOptional = Boolean(meta[name] && meta[name].optional)
    const entry = { name, range: String(range), optional: isOptional }
    if (isOptional) optional.push(entry)
    else required.push(entry)

    let found = null
    // The plugin's own dependencies win: a plugin that vendors its own copy is entitled to it.
    const localCandidate = path.join(dir, 'node_modules', name, 'package.json')
    if (isFile(localCandidate)) {
      found = { root: path.join(dir, 'node_modules'), source: 'plugin' }
    } else {
      for (const root of roots) {
        const candidate = path.join(root, name, 'package.json')
        if (isFile(candidate)) {
          found = { root, source: 'host' }
          break
        }
      }
    }
    if (found) {
      const manifest = readJson(path.join(found.root, name, 'package.json'))
      resolved[name] = { ...found, version: manifest && manifest.version ? String(manifest.version) : null }
    } else if (words.has(name)) {
      // A platform word: the client module host answers this specifier out of its own table, so
      // there is nothing to resolve from disk and nothing missing.
      providedAtRuntime.push({ ...entry, providedBy: 'client-module-platform' })
    } else if (!isOptional) {
      // Only a *required* peer that is missing is a blocker. An optional peer that is absent is
      // the plugin's own stated degradation, and reporting it as a failure would be this platform
      // overruling the plugin's author about their own plugin.
      missing.push(entry)
    }
  }
  return { required, optional, resolved, missing, providedAtRuntime }
}

/**
 * Analyse one community plugin directory.
 *
 * @param {string} dir an absolute path that already exists
 * @param {object} [options]
 * @param {string[]} [options.roots] directories providing host dependencies
 * @returns {{ok:boolean, code?:string, reason?:string, structure?:object}}
 */
function analyzeCordisPlugin(dir, options = {}) {
  const root = path.resolve(String(dir || ''))
  let stat = null
  try {
    stat = fs.statSync(root)
  } catch {
    return { ok: false, code: 'CORDIS_NO_DIRECTORY', reason: 'the plugin directory does not exist' }
  }
  if (!stat.isDirectory()) return { ok: false, code: 'CORDIS_NO_DIRECTORY', reason: 'the plugin path is not a directory' }

  const pkg = readJson(path.join(root, 'package.json'))
  if (!pkg) return { ok: false, code: 'CORDIS_NO_PACKAGE_JSON', reason: 'the directory has no readable package.json' }

  const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  const bundle = dsh.bundle && typeof dsh.bundle === 'object' ? dsh.bundle : {}
  const client = dsh.client && typeof dsh.client === 'object' ? dsh.client : null

  const hostEntry = entryFrom(pkg, root, null)
  const clientEntry = entryFrom(pkg, root, './client')
  const patchPath = bundle.patch ? String(bundle.patch) : (isFile(path.join(root, 'cordis.patch.yml')) ? 'cordis.patch.yml' : null)
  const patch = patchRowsFor(root, patchPath)

  const markers = []
  if (bundle.patch) markers.push(STRUCTURE_MARKERS.BUNDLE_PATCH)
  if (client) markers.push(STRUCTURE_MARKERS.CLIENT)
  if (patch.exists) markers.push(STRUCTURE_MARKERS.PATCH_FILE)
  if (dsh.engines && dsh.engines.dsh) markers.push(STRUCTURE_MARKERS.ENGINES_DSH)
  if (pkg.peerDependencies && pkg.peerDependencies['@deepseek-ai/cordis']) markers.push(STRUCTURE_MARKERS.PEER_CORDIS)

  const inject = injectFrom(hostEntry.file ? path.join(root, hostEntry.file) : null)
  // The client half's `inject` list is the set of specifiers the browser module loader answers as
  // platform words, so the peer audit is told about them: an unresolved `@deepseek-ai/dsh-client-runtime`
  // is answered by that table at load time, and calling it missing would be a wrong report about a
  // plugin's correctness rather than a fact about the host.
  const clientInject = client && Array.isArray(client.inject) ? client.inject.map(String) : []
  const peers = auditPeers(root, pkg, Array.isArray(options.roots) ? options.roots : [], clientInject)

  const shape = bundle.patch || patch.exists
    ? PLUGIN_SHAPES.DSH_BUNDLE
    : client
      ? PLUGIN_SHAPES.DSH_CLIENT_ONLY
      : markers.includes(STRUCTURE_MARKERS.PEER_CORDIS) ? PLUGIN_SHAPES.CORDIS_PLUGIN : PLUGIN_SHAPES.PLAIN_PACKAGE

  /** The client half is a real, declared half — and a fact this bridge cannot serve. */
  const clientHalf = client
    ? {
        declared: true,
        inject: Array.isArray(client.inject) ? client.inject.map(String) : [],
        platform: client.platform ? String(client.platform) : 'web',
        immediately: client.immediately === true,
        entry: clientEntry.file,
        entryExists: clientEntry.exists,
        /** Stated rather than implied: the browser half ships to the UI, not to this process. */
        servable: false,
        reason: 'a client half is browser code for the web UI; a host-process bridge cannot serve it'
      }
    : { declared: false, inject: [], platform: null, immediately: false, entry: null, entryExists: false, servable: false, reason: null }

  const hostHalf = {
    declared: true,
    entry: hostEntry.file,
    entryExists: hostEntry.exists,
    declaredEntry: hostEntry.declared,
    injectRequired: inject.required,
    injectOptional: inject.optional,
    injectDeclared: inject.declared,
    /** The services the bridge must mediate for this plugin to activate. */
    needsBridge: inject.required.length > 0 || inject.optional.length > 0
  }

  return {
    ok: true,
    structure: {
      dir: root,
      name: String(pkg.name || path.basename(root)),
      version: pkg.version ? String(pkg.version) : null,
      description: pkg.description ? String(pkg.description) : null,
      license: pkg.license ? String(pkg.license) : null,
      shape,
      format: formatFor(pkg, hostEntry),
      markers,
      bundle: { patch: patchPath, exists: patch.exists, rows: patch.rows, error: patch.error },
      client: clientHalf,
      host: hostHalf,
      engines: {
        dsh: dsh.engines && dsh.engines.dsh ? String(dsh.engines.dsh) : null,
        node: pkg.engines && pkg.engines.node ? String(pkg.engines.node) : null
      },
      peers,
      /** True when the plugin cannot even be imported here, whatever the bridge does. */
      importable: hostEntry.exists,
      package: pkg
    }
  }
}

module.exports = {
  STRUCTURE_MARKERS,
  MODULE_FORMATS,
  PLUGIN_SHAPES,
  analyzeCordisPlugin,
  auditPeers,
  patchRowsFor,
  injectFrom,
  entryFrom,
  insidePackage
}
