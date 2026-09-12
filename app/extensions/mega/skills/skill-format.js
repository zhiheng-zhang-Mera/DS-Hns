'use strict'

/**
 * Skill source format.
 *
 * HNS does not invent a skill format: the harness owns it. This module mirrors
 * exactly what `@deepseek-ai/dsh-skill-filesystem` accepts, so anything the dock
 * reports as installed is something the running harness will actually load, and
 * anything the dock rejects is something the harness would silently skip.
 *
 * Accepted layouts inside a scanned root (`<dshHome>/skills`):
 *
 *   <name>/SKILL.md     directory bundle (nested **\/SKILL.md is NOT discovered)
 *   <name>.md           flat file
 *
 * Required YAML frontmatter: `name` (kebab-case) and `description`.
 * Optional: `whenToUse`, `metadata`, `disable-model-invocation`, `user-invocable`.
 */
const fs = require('node:fs')
const path = require('node:path')

/** The harness's public skill-name grammar. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Directories that are never treated as skills. */
const RESERVED_DIRS = Object.freeze(['.system', '.git', 'node_modules'])

/** Maximum accepted `SKILL.md` size; a skill is instructions, not a payload. */
const MAX_SKILL_BYTES = 512 * 1024

function isSkillName(value) {
  return typeof value === 'string' && SKILL_NAME.test(value)
}

/**
 * Split `---` frontmatter from the body.
 *
 * Deliberately strict, like the harness: a file without a leading `---` block is
 * not a skill, and an unterminated block is a parse failure rather than a guess.
 *
 * @returns {{data: Record<string,string>, body: string}|null}
 */
function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) return null
  return { data: parseSimpleYaml(match[1]), body: text.slice(match[0].length) }
}

/**
 * Parse the small YAML subset a skill frontmatter uses: `key: value` pairs with
 * optional quoting, plus one level of nested maps (`metadata:`).
 *
 * A full YAML parser is deliberately not pulled in: the theme/skill subsystem must
 * not depend on a heavyweight parser to read a five-line header, and an
 * unsupported construct degrades to a reported parse error instead of a silent
 * misreading.
 */
function parseSimpleYaml(text) {
  const data = {}
  let currentKey = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const indent = rawLine.match(/^ */)[0].length
    const line = rawLine.trim()
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value === '') {
      // A bare `key:` opens a nested map (or is empty).
      currentKey = indent === 0 ? key : currentKey
      if (indent === 0 && !(key in data)) data[key] = {}
      continue
    }
    value = unquote(value)
    // A quoted value containing '#' must keep it; an unquoted one is trimmed at '#'.
    if (!/^['"]/.test(line.slice(separator + 1).trim()) && value.includes(' #')) {
      value = value.slice(0, value.indexOf(' #')).trim()
    }
    if (indent > 0 && currentKey && typeof data[currentKey] === 'object' && data[currentKey] !== null) {
      data[currentKey][key] = value
      continue
    }
    data[key] = value
  }
  return data
}

function unquote(value) {
  const text = String(value)
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = text.slice(1, -1)
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'")
    }
  }
  return text
}

/** YAML boolean forms the harness accepts (case-insensitive). */
const TRUE_FORMS = new Set(['true', 'yes', 'on', '1'])
const FALSE_FORMS = new Set(['false', 'no', 'off', '0'])

/**
 * Read an optional boolean frontmatter key.
 *
 * @returns {{ok: true, value: boolean|undefined} | {ok: false, reason: string}}
 */
function parseBooleanField(data, key) {
  if (!(key in data)) return { ok: true, value: undefined }
  const raw = data[key]
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  const text = String(raw).trim().toLowerCase()
  if (TRUE_FORMS.has(text)) return { ok: true, value: true }
  if (FALSE_FORMS.has(text)) return { ok: true, value: false }
  return { ok: false, reason: `"${key}" must be a boolean, got ${JSON.stringify(raw)}` }
}

/**
 * Validate parsed frontmatter against the harness's rules.
 *
 * @returns {{ok: true, skill: object} | {ok: false, reason: string}}
 */
function validateFrontmatter(data) {
  if (!data || typeof data !== 'object') return { ok: false, reason: 'missing YAML frontmatter' }
  const name = typeof data.name === 'string' ? data.name.trim() : undefined
  const description = typeof data.description === 'string' ? data.description.trim() : undefined
  if (!name) return { ok: false, reason: 'frontmatter requires "name"' }
  if (!description) return { ok: false, reason: 'frontmatter requires "description"' }
  if (!isSkillName(name)) {
    return { ok: false, reason: `invalid skill name "${name}": use lowercase kebab-case (a-z, 0-9, single dashes)` }
  }
  const modelInvocation = parseBooleanField(data, 'disable-model-invocation')
  if (!modelInvocation.ok) return { ok: false, reason: modelInvocation.reason }
  const userInvocation = parseBooleanField(data, 'user-invocable')
  if (!userInvocation.ok) return { ok: false, reason: userInvocation.reason }

  return {
    ok: true,
    skill: {
      name,
      description,
      whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse.trim() : null,
      metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
      // The harness defaults both surfaces to permitted when the key is absent.
      modelInvocable: modelInvocation.value === undefined ? true : !modelInvocation.value,
      userInvocable: userInvocation.value === undefined ? true : userInvocation.value
    }
  }
}

/** Parse a skill file's text into a validated record. */
function parseSkillText(raw) {
  let parsed = null
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${error?.message || error}` }
  }
  if (!parsed) return { ok: false, reason: 'missing YAML frontmatter' }
  const validated = validateFrontmatter(parsed.data)
  if (!validated.ok) return validated
  return { ok: true, skill: { ...validated.skill, body: String(parsed.body || '').trim() } }
}

/** Read and parse one skill file from disk. */
function readSkillFile(file) {
  let raw = ''
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { ok: false, reason: 'not a file' }
    if (stat.size > MAX_SKILL_BYTES) return { ok: false, reason: `file exceeds ${Math.round(MAX_SKILL_BYTES / 1024)} KB` }
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: `unreadable: ${error?.message || error}` }
  }
  return parseSkillText(raw)
}

/** Serialize a record back into a `SKILL.md` document. */
function renderSkillDocument({ name, description, whenToUse = null, metadata = {}, modelInvocable = true, userInvocable = true, body = '' }) {
  const lines = ['---', `name: ${name}`, `description: ${quoteYaml(description)}`]
  if (whenToUse) lines.push(`whenToUse: ${quoteYaml(whenToUse)}`)
  const keys = Object.keys(metadata || {})
  if (keys.length) {
    lines.push('metadata:')
    for (const key of keys) lines.push(`  ${key}: ${quoteYaml(String(metadata[key]))}`)
  }
  if (modelInvocable === false) lines.push('disable-model-invocation: true')
  if (userInvocable === false) lines.push('user-invocable: false')
  lines.push('---', '', String(body || '').trim(), '')
  return lines.join('\n')
}

function quoteYaml(value) {
  const text = String(value ?? '')
  // Quote whenever the value could be misread as YAML structure or a comment.
  if (/^[\w][\w .,:;/()+-]*$/.test(text) && !text.includes(' #') && !text.endsWith(':')) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/**
 * Enumerate the skills installed in one root, in the same shape the harness
 * discovers: top-level `<name>/SKILL.md` bundles and top-level `<name>.md` files.
 *
 * @returns {Array<{name, description, kind, dir, file, valid, reason}>}
 */
function scanSkillRoot(root) {
  const found = []
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (RESERVED_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      const file = path.join(root, entry.name, 'SKILL.md')
      if (!fs.existsSync(file)) continue
      const parsed = readSkillFile(file)
      found.push({
        name: entry.name,
        kind: 'bundle',
        dir: path.join(root, entry.name),
        file,
        valid: parsed.ok,
        reason: parsed.ok ? null : parsed.reason,
        skill: parsed.ok ? parsed.skill : null
      })
      continue
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
      const file = path.join(root, entry.name)
      const parsed = readSkillFile(file)
      found.push({
        name: entry.name.replace(/\.md$/i, ''),
        kind: 'flat',
        dir: null,
        file,
        valid: parsed.ok,
        reason: parsed.ok ? null : parsed.reason,
        skill: parsed.ok ? parsed.skill : null
      })
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Resolve a user-supplied skill name to an installed entry inside `root`. */
function resolveInstalled(root, name) {
  if (!isSkillName(name)) return null
  const bundle = path.join(root, name, 'SKILL.md')
  if (fs.existsSync(bundle)) return { name, kind: 'bundle', dir: path.join(root, name), file: bundle }
  const flat = path.join(root, `${name}.md`)
  if (fs.existsSync(flat)) return { name, kind: 'flat', dir: null, file: flat }
  return null
}

/**
 * Pick a skill name for an incoming source. Prefers the source's own frontmatter
 * name so an installed skill is addressable exactly the way the harness will
 * resolve it, and falls back to a slug of the directory name.
 */
function chooseName({ frontmatterName = null, dirName = null, explicit = null } = {}) {
  for (const candidate of [explicit, frontmatterName, dirName]) {
    if (candidate && isSkillName(candidate)) return candidate
  }
  const slug = slugify(explicit || frontmatterName || dirName || '')
  return isSkillName(slug) ? slug : null
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

module.exports = {
  SKILL_NAME,
  RESERVED_DIRS,
  MAX_SKILL_BYTES,
  isSkillName,
  slugify,
  parseFrontmatter,
  parseSimpleYaml,
  parseBooleanField,
  validateFrontmatter,
  parseSkillText,
  readSkillFile,
  renderSkillDocument,
  quoteYaml,
  scanSkillRoot,
  resolveInstalled,
  chooseName
}
