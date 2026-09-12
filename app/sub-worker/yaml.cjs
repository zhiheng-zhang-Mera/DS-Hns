'use strict'

/**
 * Minimal, dependency-free YAML reader for the documented `hns-resource.yaml`
 * (plan §27, §45).
 *
 * The project ships no runtime dependencies, so this implements exactly the
 * subset the resource configuration needs — nested block mappings, scalars,
 * quoted strings, booleans, numbers, `auto`, `null`, inline flow arrays and
 * `#` comments — and nothing else. Anything it cannot parse is reported instead
 * of silently ignored, and a JSON document is accepted as well, so a user can
 * write the file either way.
 *
 * Unsupported constructs are rejected loudly rather than guessed:
 * multi-document streams, anchors/aliases, tags, and block scalars.
 */

const UNSUPPORTED = [
  { pattern: /^\s*---\s*$/, reason: 'multi-document streams are not supported' },
  { pattern: /^\s*\.\.\.\s*$/, reason: 'document end markers are not supported' },
  { pattern: /^\s*[^#\s][^:]*:\s*[&*][A-Za-z_]/, reason: 'anchors and aliases are not supported' },
  { pattern: /^\s*[^#\s][^:]*:\s*[|>][-+]?\s*$/, reason: 'block scalars are not supported' },
  { pattern: /^\s*[^#\s][^:]*:\s*![A-Za-z!]/, reason: 'explicit tags are not supported' }
]

function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === "'" && !inDouble) inSingle = !inSingle
    else if (char === '"' && !inSingle) inDouble = !inDouble
    else if (char === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

function parseScalar(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (text === '') return null
  if (text === '~' || /^(?:null|Null|NULL)$/.test(text)) return null
  if (/^(?:true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(text)) return true
  if (/^(?:false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(text)) return false
  if (/^'(?:[^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'")
  if (/^"(?:[^"\\]|\\.)*"$/.test(text)) {
    try {
      return JSON.parse(text.replace(/\\'/g, "'"))
    } catch {
      return text.slice(1, -1)
    }
  }
  if (/^\[.*\]$/.test(text)) {
    const inner = text.slice(1, -1).trim()
    if (!inner) return []
    return splitFlow(inner).map((entry) => parseScalar(entry))
  }
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number.parseFloat(text)
  // `auto` and any other bare word stay strings; the caller decides what it means.
  return text
}

/** Split an inline flow sequence on top-level commas. */
function splitFlow(text) {
  const parts = []
  let depth = 0
  let current = ''
  let quote = null
  for (const char of text) {
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') depth += 1
    if (char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.trim()) parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * Parse a YAML document into a plain object.
 * @returns {{ok: boolean, value: object|null, errors: string[]}}
 */
function parseYaml(source) {
  const text = String(source == null ? '' : source)
  if (!text.trim()) return { ok: true, value: {}, errors: [] }

  const errors = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const stack = [{ indent: -1, value: {} }]
  const current = () => stack[stack.length - 1]

  /** The next non-empty, non-comment line with its indent and body. */
  const nextMeaningful = (from) => {
    for (let index = from; index < lines.length; index += 1) {
      const candidate = stripComment(lines[index])
      if (!candidate.trim()) continue
      return {
        indent: candidate.length - candidate.trimStart().length,
        body: candidate.trim()
      }
    }
    return null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index]
    const withoutComment = stripComment(original)
    if (!withoutComment.trim()) continue
    if (original.includes('\t')) {
      errors.push(`line ${index + 1}: tab indentation is not supported`)
      continue
    }
    for (const rule of UNSUPPORTED) {
      if (rule.pattern.test(original)) errors.push(`line ${index + 1}: ${rule.reason}`)
    }

    const indent = withoutComment.length - withoutComment.trimStart().length
    const body = withoutComment.trim()

    // Sequence entries belong to the list key that introduced them.
    if (body === '-' || body.startsWith('- ')) {
      const entry = body === '-' ? '' : body.slice(2).trim()
      while (stack.length > 1 && indent < current().indent) stack.pop()
      const frame = current()
      if (!Array.isArray(frame.value)) {
        errors.push(`line ${index + 1}: sequence entry without a list key`)
        continue
      }
      frame.value.push(entry === '' ? null : parseScalar(entry))
      continue
    }

    const separator = body.indexOf(':')
    if (separator <= 0) {
      errors.push(`line ${index + 1}: expected "key: value"`)
      continue
    }
    const key = body.slice(0, separator).trim().replace(/^['"]|['"]$/g, '')
    const rawValue = body.slice(separator + 1).trim()

    while (stack.length > 1 && indent <= current().indent) stack.pop()
    const parent = current()
    if (Array.isArray(parent.value)) {
      errors.push(`line ${index + 1}: nested mapping inside a list is not supported`)
      continue
    }

    if (rawValue === '') {
      // A nested mapping or a list; the next indented line decides which.
      const probe = nextMeaningful(index + 1)
      const isList = Boolean(probe && probe.indent > indent && (probe.body === '-' || probe.body.startsWith('- ')))
      const container = isList ? [] : {}
      parent.value[key] = container
      stack.push({ indent, value: container })
      continue
    }

    parent.value[key] = parseScalar(rawValue)
  }

  return { ok: errors.length === 0, value: stack[0].value, errors }
}

/**
 * Read a resource configuration file: JSON first (if it looks like JSON), then
 * the YAML subset above.
 */
function readResourceFile(fs, file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, missing: true, value: null, errors: [String(error?.message || error)] }
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed)
      return { ok: value && typeof value === 'object', value: value || null, errors: [], format: 'json' }
    } catch (error) {
      return { ok: false, value: null, errors: [`invalid JSON: ${error?.message || error}`], format: 'json' }
    }
  }
  const parsed = parseYaml(text)
  return { ...parsed, format: 'yaml' }
}

module.exports = {
  parseYaml,
  parseScalar,
  readResourceFile,
  stripComment,
  splitFlow
}
