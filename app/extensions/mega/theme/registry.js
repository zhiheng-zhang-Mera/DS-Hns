'use strict'

/**
 * Theme Registry.
 *
 * Owns the durable theme list and the active theme selection (engineering spec
 * §15). It is deliberately dumb about *how* a theme is produced: built-in,
 * generated, imported and duplicated themes all end up as the same kind of
 * record pointing at a self-contained package directory.
 *
 * Registry integrity rules:
 *   - built-in system records can never be removed from the registry;
 *   - a record whose package fails validation is marked `broken` rather than
 *     being silently dropped, so the UI can explain what happened;
 *   - the active theme is always resolvable to Dark, whatever the records say.
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const validator = require('./validator')
const { PATHS } = require('../utils/paths')

/** System theme ids. Dark is also the global recovery target. */
const SYSTEM_DARK_ID = 'hns.system.dark'
const SYSTEM_LIGHT_ID = 'hns.system.light'
const RECOVERY_THEME_ID = SYSTEM_DARK_ID

const BUILTIN_DIR = path.join(__dirname, 'builtin')
const USER_THEMES_DIR = () => path.join(PATHS.DATA, 'themes', 'user')
const REGISTRY_FILE = () => path.join(PATHS.STATE, 'theme-registry.json')
const ACTIVE_FILE = () => path.join(PATHS.STATE, 'theme-active.json')
const DELETED_BUILTINS_FILE = () => path.join(PATHS.STATE, 'theme-deleted-builtins.json')
const WORKSPACE_DIR = () => path.join(PATHS.DATA, 'theme-workspace')

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** Built-in theme descriptors, read from disk so the packages stay authoritative. */
function builtinSpecs() {
  return [
    {
      id: SYSTEM_DARK_ID,
      name: 'Dark',
      source: 'system',
      protected: true,
      deletable: false,
      editable: false,
      dir: path.join(BUILTIN_DIR, 'system', 'dark'),
      officialPalette: 'dark'
    },
    {
      id: SYSTEM_LIGHT_ID,
      name: 'Light',
      source: 'system',
      protected: true,
      deletable: false,
      editable: false,
      dir: path.join(BUILTIN_DIR, 'system', 'light'),
      officialPalette: 'light'
    },
    {
      id: 'hns.demo.minimal',
      name: 'Minimal Neutral',
      source: 'builtin-demo',
      protected: false,
      deletable: true,
      editable: true,
      dir: path.join(BUILTIN_DIR, 'demo', 'minimal-neutral'),
      officialPalette: 'light'
    },
    {
      id: 'hns.demo.anime-persona',
      name: 'Anime Persona Demo',
      source: 'builtin-demo',
      protected: false,
      deletable: true,
      editable: true,
      dir: path.join(BUILTIN_DIR, 'demo', 'anime-persona'),
      officialPalette: 'dark'
    },
    {
      id: 'hns.demo.cyber-hud',
      name: 'Cyber HUD Demo',
      source: 'builtin-demo',
      protected: false,
      deletable: true,
      editable: true,
      dir: path.join(BUILTIN_DIR, 'demo', 'cyber-hud'),
      officialPalette: 'dark'
    }
  ]
}

function createRegistry({ log = () => {}, resolveDarkTokens } = {}) {
  const darkTokensCache = { value: null }

  function darkTokens() {
    if (darkTokensCache.value) return darkTokensCache.value
    const darkDir = path.join(BUILTIN_DIR, 'system', 'dark')
    const tokens = readJsonFile(path.join(darkDir, 'tokens.json'), null)
    darkTokensCache.value = tokens && typeof tokens === 'object' ? tokens : {}
    return darkTokensCache.value
  }

  /** Resolve a theme directory for a record id. */
  function dirFor(id) {
    const spec = builtinSpecs().find((entry) => entry.id === id)
    if (spec) return spec.dir
    return path.join(USER_THEMES_DIR(), id)
  }

  /**
   * Read one theme off disk. Never throws: a broken package becomes a record
   * with `broken: true` plus the validator issues.
   */
  function inspect(id, { expectedDir, spec } = {}) {
    const dir = expectedDir || dirFor(id)
    const report = validator.validatePackage({ dir, darkTokens: darkTokens(), expectedId: id })
    const manifest = readJsonFile(path.join(dir, 'manifest.json'), null)
    const tokens = readJsonFile(path.join(dir, 'tokens.json'), {}) || {}
    const components = readJsonFile(path.join(dir, 'components.json'), {}) || {}
    const persona = readJsonFile(path.join(dir, 'persona.json'), {}) || { enabled: false }
    const resolvedTokens = validator.resolveTokens(tokens, darkTokens())
    const base = spec || {}
    return {
      id,
      name: (manifest && manifest.name) || base.name || id,
      author: (manifest && manifest.author) || 'HNS Theme Engine',
      version: (manifest && manifest.version) || '0.0.0',
      source: (manifest && manifest.source) || base.source || 'user',
      protected: Boolean((manifest && manifest.protected) || base.protected),
      deletable: base.protected ? false : !(manifest && manifest.deletable === false),
      editable: base.protected ? false : !(manifest && manifest.editable === false),
      system_theme: (manifest && manifest.system_theme) || base.source === 'system',
      official_palette: (manifest && manifest.official_palette) || base.officialPalette || 'dark',
      theme_api_version: (manifest && manifest.theme_api_version) || null,
      supported_apps: (manifest && manifest.supported_apps) || ['hns'],
      created_at: (manifest && manifest.created_at) || null,
      generated_prompt: (manifest && manifest.generated_prompt) || null,
      revision_history: (manifest && Array.isArray(manifest.revision_history)) ? manifest.revision_history : [],
      derived_from: (manifest && manifest.derived_from) || null,
      animation: validator.normalizeAnimation(components && components.animation),
      installed_at: (manifest && manifest.installed_at) || null,
      dir,
      broken: !report.ok,
      validation: { ok: report.ok, errors: report.errors.length, warnings: report.warnings.length, issues: report.issues },
      hasTokens: Object.keys(resolvedTokens).length > 0,
      tokenCount: Object.keys(tokens).length,
      slotCount: components && components.slots ? Object.keys(components.slots).length : 0,
      persona: {
        enabled: Boolean(persona && persona.enabled),
        prominence: Number(persona && persona.prominence) || 0,
        character: (persona && persona.character) || null
      }
    }
  }

  /** Full registry snapshot: built-ins first, then user themes, then the active id. */
  function list() {
    const specs = builtinSpecs()
    const hidden = hiddenBuiltins()
    const records = []
    const seen = new Set()
    for (const spec of specs) {
      seen.add(spec.id)
      // A deleted built-in demo theme is *hidden*, never destroyed: the shipped
      // package under `theme/builtin/` is application data that every other
      // installation shares, and `restoreBuiltin` must be able to bring it back.
      if (hidden.has(spec.id)) continue
      records.push(inspect(spec.id, { expectedDir: spec.dir, spec }))
    }
    const userDir = USER_THEMES_DIR()
    let entries = []
    try {
      entries = fs.readdirSync(userDir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue
      seen.add(entry.name)
      records.push(inspect(entry.name, { expectedDir: path.join(userDir, entry.name) }))
    }
    const stored = readJsonFile(REGISTRY_FILE(), { themes: [] })
    const storedById = new Map((stored.themes || []).map((item) => [item.id, item]))
    for (const record of records) {
      const extra = storedById.get(record.id)
      if (extra) {
        record.duplicated_from = extra.duplicated_from || null
        record.registered_at = extra.registered_at || null
      }
    }
    return records
  }

  function readActiveId() {
    const stored = readJsonFile(ACTIVE_FILE(), null)
    const id = stored && typeof stored.id === 'string' ? stored.id : null
    if (!id) return RECOVERY_THEME_ID
    const exists = list().some((record) => record.id === id)
    return exists ? id : RECOVERY_THEME_ID
  }

  function writeActiveId(id, extra = {}) {
    writeJsonFile(ACTIVE_FILE(), { id, updated_at: new Date().toISOString(), ...extra })
  }

  /** Built-in theme ids the user has removed from their list. */
  function hiddenBuiltins() {
    const stored = readJsonFile(DELETED_BUILTINS_FILE(), { ids: [] })
    return new Set(Array.isArray(stored.ids) ? stored.ids : [])
  }

  function hideBuiltin(id) {
    const set = hiddenBuiltins()
    set.add(id)
    writeJsonFile(DELETED_BUILTINS_FILE(), { updated_at: new Date().toISOString(), ids: [...set].sort() })
  }

  function unhideBuiltin(id) {
    const set = hiddenBuiltins()
    const had = set.delete(id)
    writeJsonFile(DELETED_BUILTINS_FILE(), { updated_at: new Date().toISOString(), ids: [...set].sort() })
    return had
  }

  function persistRecords(records) {
    const themes = records
      .filter((record) => record.source !== 'system')
      .map((record) => ({
        id: record.id,
        name: record.name,
        author: record.author,
        source: record.source,
        created_at: record.created_at,
        version: record.version,
        supported_apps: record.supported_apps,
        protected: record.protected,
        generated_prompt: record.generated_prompt,
        revision_history: record.revision_history,
        theme_api_version: record.theme_api_version,
        derived_from: record.derived_from,
        duplicated_from: record.duplicated_from || null,
        registered_at: record.registered_at || new Date().toISOString()
      }))
    writeJsonFile(REGISTRY_FILE(), { updated_at: new Date().toISOString(), themes })
  }

  /** Register (or refresh) one theme id in the durable registry. */
  function register(id) {
    const records = list()
    const record = records.find((entry) => entry.id === id)
    if (!record) return { ok: false, reason: 'not_found', id }
    if (record.broken) {
      return { ok: false, reason: 'validation_failed', id, issues: record.validation.issues }
    }
    record.registered_at = new Date().toISOString()
    persistRecords(records)
    log(`registered theme ${id}`)
    return { ok: true, id, record }
  }

  /** Remove a theme's record. Refuses protected themes. */
  function unregister(id) {
    const records = list()
    const record = records.find((entry) => entry.id === id)
    if (!record) return { ok: true, id, alreadyAbsent: true }
    if (record.protected || record.source === 'system') {
      return { ok: false, reason: 'protected', id }
    }
    persistRecords(records.filter((entry) => entry.id !== id))
    log(`unregistered theme ${id}`)
    return { ok: true, id }
  }

  function uniqueUserId(baseName) {
    const existing = new Set(list().map((record) => record.id))
    const base = `hns.user.${slugify(baseName) || 'theme'}`
    if (!existing.has(base)) return base
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`
      if (!existing.has(candidate)) return candidate
    }
    return `${base}-${Date.now()}`
  }

  return {
    SYSTEM_DARK_ID,
    SYSTEM_LIGHT_ID,
    RECOVERY_THEME_ID,
    BUILTIN_DIR,
    builtinSpecs,
    userThemesDir: USER_THEMES_DIR,
    workspaceDir: WORKSPACE_DIR,
    darkTokens,
    dirFor,
    inspect,
    list,
    readActiveId,
    writeActiveId,
    register,
    unregister,
    persistRecords,
    uniqueUserId,
    slugify,
    readJsonFile,
    writeJsonFile,
    hiddenBuiltins,
    hideBuiltin,
    unhideBuiltin,
    resolveDarkTokens: resolveDarkTokens || darkTokens
  }
}

module.exports = {
  SYSTEM_DARK_ID,
  SYSTEM_LIGHT_ID,
  RECOVERY_THEME_ID,
  BUILTIN_DIR,
  USER_THEMES_DIR,
  REGISTRY_FILE,
  ACTIVE_FILE,
  DELETED_BUILTINS_FILE,
  WORKSPACE_DIR,
  builtinSpecs,
  createRegistry,
  slugify,
  readJsonFile,
  writeJsonFile,
  THEME_API_VERSION: contract.THEME_API_VERSION
}
