'use strict'

/**
 * Theme package validator.
 *
 * Everything a theme package must satisfy before it may be registered or
 * installed lives here (THEME_INTERFACE_SPEC §4, engineering spec §10.2/§16/§19):
 *
 *   1. manifest parses and carries the required fields;
 *   2. every declared asset exists inside the package itself;
 *   3. no cross-theme path / no parent-theme dependency field;
 *   4. the declared Theme API version is compatible;
 *   5. no executable payload is present anywhere in the package;
 *   6. every written slot exists, is generator-writable, and uses allowed props;
 *   7. tokens match the token schema;
 *   8. readability, contrast and HNS state separability hold.
 *
 * A validator result is always a plain data object — it never throws — because
 * a broken candidate theme must degrade to "rejected", never to "engine down".
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const color = require('./color')
const surfaceModule = require('./surface')

/** Fields no theme package may ever declare (runtime theme dependencies). */
const FORBIDDEN_MANIFEST_FIELDS = Object.freeze([
  'parent_theme',
  'required_theme',
  'extends',
  'inherits',
  'base_theme',
  'depends_on'
])

/** File patterns that would make a theme executable rather than declarative. */
const FORBIDDEN_FILE_PATTERNS = Object.freeze([
  /\.(?:js|cjs|mjs|ts|tsx|jsx|py|rb|sh|ps1|psm1|bat|cmd|exe|dll|node|jar|vbs|wsf)$/i
])

/**
 * Asset sub-directories a self-contained package may carry.
 *
 * `characters` and `official` were added with the real-visual-asset pipeline
 * (Update-Plan 任务 5 / 任务 6): the HNS character, the official character, the
 * official skin and the overlay texture need their own homes inside the package.
 */
const ASSET_DIRS = Object.freeze(['wallpapers', 'icons', 'panels', 'persona', 'decorations', 'characters', 'official'])

const REQUIRED_MANIFEST_FIELDS = Object.freeze(['id', 'name', 'version', 'source', 'theme_api_version', 'supported_apps'])

function issue(severity, code, message, detail) {
  return { severity, code, message, detail: detail === undefined ? null : detail }
}

function error(code, message, detail) {
  return issue('error', code, message, detail)
}

function warn(code, message, detail) {
  return issue('warning', code, message, detail)
}

function summarize(issues) {
  const errors = issues.filter((entry) => entry.severity === 'error')
  return {
    ok: errors.length === 0,
    errors,
    warnings: issues.filter((entry) => entry.severity === 'warning'),
    issues
  }
}

/** Compare two dotted numeric versions. Returns -1 / 0 / 1, or null when invalid. */
function compareVersions(a, b) {
  const parse = (value) => {
    const match = String(value || '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
    if (!match) return null
    return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)]
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  }
  return 0
}

/**
 * Compatibility check. A theme declaring an older API than the engine is
 * accepted (the engine maps missing tokens to their fallback); a theme asking
 * for a newer API is refused, which is what makes "incompatible -> back to Dark"
 * possible (spec §22).
 */
function checkApiVersion(declared) {
  if (!declared || typeof declared !== 'string') {
    return error('api_version_missing', 'manifest.theme_api_version is required', { declared: declared ?? null })
  }
  const forward = compareVersions(declared, contract.THEME_API_VERSION)
  if (forward === null) {
    return error('api_version_invalid', `theme_api_version "${declared}" is not a dotted numeric version`)
  }
  if (forward > 0) {
    return error(
      'api_version_unsupported',
      `theme requires Theme API ${declared} but this engine exposes ${contract.THEME_API_VERSION}`,
      { required: declared, supported: contract.THEME_API_VERSION }
    )
  }
  return null
}

/** Validate one slot payload against the slot table and permission model. */
function validateSlots(slots, { allowStructural = false } = {}) {
  const issues = []
  if (slots === undefined || slots === null) return issues
  if (typeof slots !== 'object' || Array.isArray(slots)) {
    issues.push(error('slots_invalid', 'components.slots must be an object keyed by slot id'))
    return issues
  }
  const writable = allowStructural
    ? [contract.PERMISSION.SAFE, contract.PERMISSION.STYLE, contract.PERMISSION.STRUCTURAL]
    : contract.GENERATOR_PERMISSIONS

  for (const [slotId, payload] of Object.entries(slots)) {
    const definition = contract.SLOTS[slotId]
    if (!definition) {
      issues.push(error('slot_unknown', `slot "${slotId}" is not exposed by the HNS Theme API`, { slot: slotId }))
      continue
    }
    if (!writable.includes(definition.permission)) {
      issues.push(error(
        'slot_permission_denied',
        `slot "${slotId}" is ${definition.permission} and may not be themed automatically`,
        { slot: slotId, permission: definition.permission }
      ))
      continue
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      issues.push(error('slot_payload_invalid', `slot "${slotId}" payload must be an object`, { slot: slotId }))
      continue
    }
    for (const property of Object.keys(payload)) {
      if (property === 'derived_from') continue
      if (!definition.properties.includes(property)) {
        issues.push(error(
          'slot_property_denied',
          `slot "${slotId}" does not allow property "${property}"`,
          { slot: slotId, property, allowed: definition.properties }
        ))
      }
    }
  }
  return issues
}

function isAssetReference(value) {
  return typeof value === 'string' && value.startsWith('assets/')
}

/**
 * Detect a theme that reaches outside itself. Cross-theme resolution is illegal
 * (engineering spec §11), so any path escaping the package or pointing at
 * `themes/<other-id>` is rejected.
 */
function crossThemeReferences(value, trail = []) {
  const found = []
  const visit = (node, trailPath) => {
    if (typeof node === 'string') {
      if (/^themes[\\/]/i.test(node) || /\.\.[\\/]/.test(node) || /^[a-z]:[\\/]/i.test(node)) {
        found.push({ path: trailPath.join('.'), value: node })
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, trailPath.concat(String(index))))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) visit(entry, trailPath.concat(key))
    }
  }
  visit(value, trail)
  return found
}

/** Validate the token document against the token schema. */
function validateTokens(tokens) {
  const issues = []
  if (tokens === undefined || tokens === null) return issues
  if (typeof tokens !== 'object' || Array.isArray(tokens)) {
    issues.push(error('tokens_invalid', 'tokens.json must be an object keyed by token name'))
    return issues
  }
  for (const [name, value] of Object.entries(tokens)) {
    const definition = contract.TOKENS[name]
    if (!definition) {
      issues.push(error('token_unknown', `token "${name}" is not part of the Theme API schema`, { token: name }))
      continue
    }
    if (value === null || value === undefined) {
      issues.push(error('token_empty', `token "${name}" has no value`, { token: name }))
      continue
    }
    if (definition.kind === contract.PROPERTY_KIND.COLOR) {
      if (!color.parseColor(value)) {
        issues.push(error('token_color_invalid', `token "${name}" is not a valid CSS colour: ${JSON.stringify(value)}`, { token: name }))
      }
      continue
    }
    if (definition.kind === contract.PROPERTY_KIND.LENGTH) {
      if (!/^-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|pt|ch)?$/.test(String(value).trim())) {
        issues.push(error('token_length_invalid', `token "${name}" is not a valid CSS length: ${JSON.stringify(value)}`, { token: name }))
      }
      continue
    }
    if (definition.kind === contract.PROPERTY_KIND.NUMBER) {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) {
        issues.push(error('token_number_invalid', `token "${name}" is not numeric: ${JSON.stringify(value)}`, { token: name }))
      }
      continue
    }
    if (definition.kind === contract.PROPERTY_KIND.ASSET) {
      const text = String(value)
      if (text !== 'none' && !text.startsWith('data:image/') && !isAssetReference(text)) {
        issues.push(error('token_asset_invalid', `token "${name}" must be "none", an assets/ reference or an inline data:image`, { token: name }))
      }
      continue
    }
    if (definition.kind === contract.PROPERTY_KIND.SHADOW) {
      if (typeof value !== 'string' || !value.trim()) {
        issues.push(error('token_shadow_invalid', `token "${name}" must be a CSS shadow string`, { token: name }))
      }
    }
  }
  // Unknown-but-harmless: an empty token document is legal (self-contained
  // themes may rely on engine fallbacks), but it must be reported so the UI can
  // explain why the theme looks close to Dark.
  if (!Object.keys(tokens).length) {
    issues.push(warn('tokens_empty', 'theme declares no tokens; every token falls back to the Dark system value'))
  }
  return issues
}

/**
 * Resolve a token map over the Dark fallbacks so validation and preview always
 * operate on a complete token set.
 */
function resolveTokens(tokens, darkTokens) {
  const resolved = {}
  for (const name of contract.TOKEN_NAMES) {
    const value = tokens && Object.prototype.hasOwnProperty.call(tokens, name) ? tokens[name] : undefined
    if (value !== undefined && value !== null && value !== '') resolved[name] = value
    else if (darkTokens && darkTokens[name] !== undefined) resolved[name] = darkTokens[name]
    else resolved[name] = contract.TOKENS[name].fallback
  }
  return resolved
}

/** Readability / contrast / status-colour checks over a resolved token set. */
function validateReadability(resolvedTokens, { stateMinDistance = contract.STATE_MIN_DISTANCE } = {}) {
  const issues = []
  for (const requirement of contract.CONTRAST_REQUIREMENTS) {
    const foreground = resolvedTokens[requirement.foreground]
    const background = resolvedTokens[requirement.background]
    const ratio = color.contrastRatio(foreground, background)
    if (ratio === null) {
      issues.push(error('contrast_unmeasurable', `cannot measure contrast for ${requirement.label}`, {
        foreground, background
      }))
      continue
    }
    if (ratio + 1e-6 < requirement.min) {
      issues.push(error(
        'contrast_too_low',
        `${requirement.label} contrast ${ratio.toFixed(2)}:1 is below the required ${requirement.min}:1`,
        { foreground: requirement.foreground, background: requirement.background, ratio: Number(ratio.toFixed(3)), min: requirement.min }
      ))
    }
  }

  // HNS state visuals must stay mutually distinguishable (HNS spec §3): a theme
  // may restyle a state, but it may never make two states look the same.
  const stateBackground = resolvedTokens['color.bg.layer1']
  for (const state of contract.HNS_STATES) {
    const ratio = color.contrastRatio(resolvedTokens[`state.${state}`], stateBackground)
    if (ratio !== null && ratio + 1e-6 < contract.STATE_VISIBILITY_MIN) {
      issues.push(error(
        'state_invisible',
        `state "${state}" is indistinguishable from the content layer (contrast ${ratio.toFixed(2)}:1 < ${contract.STATE_VISIBILITY_MIN}:1)`,
        { state, ratio: Number(ratio.toFixed(3)), min: contract.STATE_VISIBILITY_MIN }
      ))
    }
  }
  for (let i = 0; i < contract.HNS_STATES.length; i += 1) {
    for (let j = i + 1; j < contract.HNS_STATES.length; j += 1) {
      const a = contract.HNS_STATES[i]
      const b = contract.HNS_STATES[j]
      const distance = color.distance(resolvedTokens[`state.${a}`], resolvedTokens[`state.${b}`])
      if (distance === null) {
        issues.push(error('state_unmeasurable', `cannot measure distance between states "${a}" and "${b}"`))
        continue
      }
      if (distance < stateMinDistance) {
        issues.push(error(
          'state_indistinguishable',
          `HNS states "${a}" and "${b}" are too similar (distance ${distance.toFixed(1)} < ${stateMinDistance})`,
          { states: [a, b], distance: Number(distance.toFixed(2)), min: stateMinDistance }
        ))
      }
    }
  }
  return issues
}

/** Clamp a declared animation block into the engine's allowed envelope. */
function normalizeAnimation(animation) {
  if (!animation || typeof animation !== 'object') return { type: 'none', intensity: 0 }
  const supported = contract.ANIMATION_PRESETS.includes(animation.type)
  const type = supported ? animation.type : 'none'
  const max = contract.ANIMATION_MAX_INTENSITY[type] ?? 0
  const requested = Number(animation.intensity)
  const intensity = Number.isFinite(requested) ? Math.max(0, Math.min(max, requested)) : 0
  // `clamped` describes an intensity that had to be reduced. An unrecognised
  // preset is dropped outright, which is a different (and already visible)
  // outcome: the type becomes `none`.
  return {
    type,
    intensity: Number(intensity.toFixed(3)),
    clamped: supported && Number.isFinite(requested) && requested > max
  }
}

/** List every file in a directory tree, relative to the root, POSIX-style. */
function listFiles(root, { maxFiles = 4096 } = {}) {
  const out = []
  const walk = (dir) => {
    if (out.length > maxFiles) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  walk(root)
  return out
}

/**
 * Validate a fully materialized theme package on disk.
 *
 * @param {object} options
 * @param {string} options.dir          theme package directory
 * @param {object} [options.darkTokens] resolved Dark token set used as fallback
 * @param {string} [options.expectedId] the id the directory is registered under
 */
function validatePackage({ dir, darkTokens, expectedId, surfacePlan = null, overlayPlan = null } = {}) {
  const issues = []
  if (!dir || typeof dir !== 'string') {
    return summarize([error('package_missing', 'no theme directory was supplied')])
  }
  let stat = null
  try {
    stat = fs.statSync(dir)
  } catch {
    return summarize([error('package_missing', `theme directory does not exist: ${dir}`, { dir })])
  }
  if (!stat.isDirectory()) return summarize([error('package_not_directory', `theme path is not a directory: ${dir}`, { dir })])

  // ---- manifest ----
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest = null
  if (!fs.existsSync(manifestPath)) {
    issues.push(error('manifest_missing', 'theme package has no manifest.json'))
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (parseError) {
      issues.push(error('manifest_unparsable', `manifest.json is not valid JSON: ${parseError.message}`))
    }
  }

  if (manifest) {
    if (typeof manifest !== 'object' || Array.isArray(manifest)) {
      issues.push(error('manifest_invalid', 'manifest.json must contain a JSON object'))
      manifest = null
    }
  }

  if (manifest) {
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
        issues.push(error('manifest_field_missing', `manifest.${field} is required`, { field }))
      }
    }
    if (manifest.id !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(String(manifest.id))) {
      issues.push(error('manifest_id_invalid', `manifest.id "${manifest.id}" must be a slug`, { id: manifest.id }))
    }
    if (expectedId && manifest.id && manifest.id !== expectedId) {
      issues.push(error('manifest_id_mismatch', `manifest.id "${manifest.id}" does not match registry id "${expectedId}"`, {
        manifestId: manifest.id, expectedId
      }))
    }
    for (const field of FORBIDDEN_MANIFEST_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(manifest, field)) {
        issues.push(error('manifest_forbidden_dependency', `manifest declares forbidden runtime dependency field "${field}"`, {
          field, value: manifest[field]
        }))
      }
    }
    if (Array.isArray(manifest.supported_apps) && !manifest.supported_apps.includes('hns')) {
      issues.push(error('manifest_app_unsupported', `theme does not support the "hns" app: ${JSON.stringify(manifest.supported_apps)}`))
    }
    const apiIssue = checkApiVersion(manifest.theme_api_version)
    if (apiIssue) issues.push(apiIssue)
    if (manifest.protected === true && manifest.source !== 'system') {
      issues.push(warn('protected_non_system', 'a non-system theme declares protected=true; the registry will honour the flag but it is unusual'))
    }
  }

  // ---- tokens ----
  let tokens = null
  const tokensPath = path.join(dir, 'tokens.json')
  if (fs.existsSync(tokensPath)) {
    try {
      tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'))
    } catch (parseError) {
      issues.push(error('tokens_unparsable', `tokens.json is not valid JSON: ${parseError.message}`))
    }
    if (tokens) issues.push(...validateTokens(tokens))
  } else {
    issues.push(warn('tokens_missing', 'theme has no tokens.json; every token falls back to the Dark system value'))
  }

  // ---- components ----
  let components = null
  const componentsPath = path.join(dir, 'components.json')
  if (fs.existsSync(componentsPath)) {
    try {
      components = JSON.parse(fs.readFileSync(componentsPath, 'utf8'))
    } catch (parseError) {
      issues.push(error('components_unparsable', `components.json is not valid JSON: ${parseError.message}`))
    }
    if (components) {
      if (typeof components !== 'object' || Array.isArray(components)) {
        issues.push(error('components_invalid', 'components.json must contain a JSON object'))
      } else {
        const slots = components.slots || components
        issues.push(...validateSlots(slots))
        if (components.animation) {
          const normalized = normalizeAnimation(components.animation)
          if (normalized.clamped) {
            issues.push(warn('animation_clamped', `animation intensity was clamped to ${normalized.intensity} for preset "${normalized.type}"`))
          }
        }
      }
    }
  }

  // ---- persona ----
  const personaPath = path.join(dir, 'persona.json')
  if (fs.existsSync(personaPath)) {
    try {
      const persona = JSON.parse(fs.readFileSync(personaPath, 'utf8'))
      if (persona && typeof persona === 'object' && persona.enabled === true) {
        const prominence = Number(persona.prominence)
        if (Number.isFinite(prominence) && prominence > 0.4) {
          issues.push(error(
            'persona_prominence_excessive',
            `HNS only allows a lightweight persona; prominence ${prominence} exceeds the 0.4 ceiling`,
            { prominence }
          ))
        }
        if (Number.isFinite(prominence) && prominence < 0) {
          issues.push(error('persona_prominence_invalid', 'persona.prominence must be >= 0', { prominence }))
        }
        if (persona.overlay_main === true) {
          issues.push(error('persona_overlay_forbidden', 'HNS forbids a large character overlay covering the main UI'))
        }
        if (Array.isArray(persona.occludes)) {
          const forbidden = persona.occludes.filter((region) => ['log', 'process', 'hardware', 'worker'].includes(String(region)))
          if (forbidden.length) {
            issues.push(error(
              'persona_occludes_critical_region',
              `persona must not occlude ${forbidden.join(', ')}`,
              { regions: forbidden }
            ))
          }
        }
      }
    } catch (parseError) {
      issues.push(error('persona_unparsable', `persona.json is not valid JSON: ${parseError.message}`))
    }
  }

  // ---- files: executables + asset presence + cross-theme references ----
  const files = listFiles(dir)
  for (const file of files) {
    if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(file))) {
      issues.push(error('executable_payload', `theme packages must be declarative; found executable file "${file}"`, { file }))
    }
  }

  // ---- surface plans (任务 1 / 任务 15) ----
  //
  // The plan documents are what a package *declares it will write*, so they are
  // the right place to refuse a write into the protected official renderer. They
  // are validated here — on the compiled artifact — because a hand-written or
  // imported package never passes through the builder's own gates.
  const planDocuments = {}
  for (const [name, supplied] of [['surface-plan.json', surfacePlan], ['overlay-plan.json', overlayPlan]]) {
    const file = path.join(dir, name)
    let documented = supplied
    if (documented === null || documented === undefined) {
      if (!fs.existsSync(file)) {
        issues.push(warn('plan_missing', `theme has no ${name}; the package does not declare which surfaces it writes`))
        continue
      }
      try {
        documented = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (parseError) {
        issues.push(error('plan_unparsable', `${name} is not valid JSON: ${parseError.message}`))
        continue
      }
    }
    planDocuments[name] = documented
    for (const hit of surfaceModule.violationsIn(documented, [])) {
      issues.push(error(
        'surface_protected',
        `${name}: ${hit.path} targets the PROTECTED official renderer (${hit.value})`,
        { ...hit, document: name }
      ))
    }
  }
  const declaredSurfaces = planDocuments['surface-plan.json']
  if (declaredSurfaces) {
    for (const entry of declaredSurfaces.surfaces || []) {
      if (!surfaceModule.isSurface(entry.surface)) {
        issues.push(error('surface_unknown', `surface-plan declares an unknown surface "${entry.surface}"`, { surface: entry.surface }))
        continue
      }
      if (entry.writes === true && !surfaceModule.isWritable(entry.surface)) {
        issues.push(error(
          'surface_write_denied',
          `surface-plan claims to write "${entry.surface}", which is ${surfaceModule.permissionOf(entry.surface)}`,
          { surface: entry.surface }
        ))
      }
      if (entry.surface === contract.SURFACE.OFFICIAL_RENDERER && entry.writes !== false) {
        issues.push(error('surface_protected', 'surface-plan must record the official renderer as not written'))
      }
    }
  }
  const declaredOverlay = planDocuments['overlay-plan.json']
  if (declaredOverlay && declaredOverlay.enabled === true) {
    for (const key of ['pointer', 'keyboard', 'focus', 'scroll']) {
      const value = declaredOverlay.input?.[key]
      if (value !== 'passthrough' && value !== 'none') {
        issues.push(error(
          'overlay_input_not_passthrough',
          `overlay-plan declares ${key}="${value}"; the overlay is visual-only and must pass every input through`,
          { input: key, value: value ?? null }
        ))
      }
    }
  }

  const declaredAssets = []
  const collectAssets = (node) => {
    if (typeof node === 'string') {
      if (isAssetReference(node)) declaredAssets.push(node)
      return
    }
    if (Array.isArray(node)) {
      node.forEach(collectAssets)
      return
    }
    if (node && typeof node === 'object') Object.values(node).forEach(collectAssets)
  }
  collectAssets(tokens)
  collectAssets(components)

  for (const reference of declaredAssets) {
    const relative = reference.slice('assets/'.length)
    const candidates = [
      path.join(dir, reference),
      path.join(dir, 'assets', relative)
    ]
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      issues.push(error('asset_missing', `declared asset is missing from the package: ${reference}`, { asset: reference }))
    }
  }

  for (const [name, document] of [['tokens', tokens], ['components', components]]) {
    if (!document) continue
    for (const hit of crossThemeReferences(document, [name])) {
      issues.push(error(
        'cross_theme_reference',
        `${name}.${hit.path} resolves outside the package: ${hit.value}`,
        hit
      ))
    }
  }

  const resolvedTokens = resolveTokens(tokens || {}, darkTokens)
  issues.push(...validateReadability(resolvedTokens))

  const metadata = manifest
    ? {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source: manifest.source,
        protected: manifest.protected === true,
        theme_api_version: manifest.theme_api_version,
        supported_apps: Array.isArray(manifest.supported_apps) ? manifest.supported_apps.slice() : []
      }
    : null

  const result = summarize(issues)
  result.files = files
  result.metadata = metadata
  result.resolvedTokens = resolvedTokens
  result.animation = normalizeAnimation(components && components.animation)
  return result
}

module.exports = {
  FORBIDDEN_MANIFEST_FIELDS,
  FORBIDDEN_FILE_PATTERNS,
  ASSET_DIRS,
  REQUIRED_MANIFEST_FIELDS,
  compareVersions,
  checkApiVersion,
  validateSlots,
  validateTokens,
  validateReadability,
  resolveTokens,
  normalizeAnimation,
  crossThemeReferences,
  listFiles,
  validatePackage
}
