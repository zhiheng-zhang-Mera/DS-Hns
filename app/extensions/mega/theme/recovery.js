'use strict'

/**
 * Recovery Manager.
 *
 * The single guaranteed behaviour of the theme system: a theme failure degrades
 * to Dark, and a theme failure can never stop DS-Harness, break a business
 * feature or leave the UI unstyled (engineering spec §18 / §23.3).
 *
 * Every load path funnels through `guard()`:
 *   resolve -> validate -> load -> (failure) -> Dark -> (failure) -> built-in
 *   Dark constants compiled into this module.
 *
 * The last stage exists because "recover to Dark" must not itself depend on a
 * readable file: even if `builtin/system/dark` were deleted, the dock still
 * renders with the hard-coded Dark token constants below.
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const validator = require('./validator')

/**
 * Hard-coded last-resort token set. Intentionally duplicated from
 * `builtin/system/dark/tokens.json`: a recovery target that shares a failure
 * domain with the thing it is recovering from is not a recovery target.
 */
const FALLBACK_TOKEN_VALUES = Object.freeze(
  contract.TOKEN_NAMES.reduce((acc, name) => {
    acc[name] = contract.TOKENS[name].fallback
    return acc
  }, {})
)

/** Hard-coded last-resort slot styles (flat, readable, no assets). */
const FALLBACK_COMPONENTS = Object.freeze({
  slots: {
    'hns.window.background': { background: 'var(--hns-color-bg-base)', overlay: 'none' },
    'hns.window.overlay': { background: 'none', opacity: 0, blur: '0px', blend: 'normal' },
    'hns.worker.card': {
      background: 'var(--hns-color-bg-layer1)',
      border: '1px solid var(--hns-color-border-l1)',
      radius: 'var(--hns-radius-md)',
      shadow: 'none',
      label: 'var(--hns-color-label-primary)'
    },
    'hns.worker.status': { background: 'transparent', label: 'var(--hns-color-label-secondary)', border: '1px solid var(--hns-color-border-l1)' },
    'hns.process.panel': { background: 'var(--hns-color-bg-layer1)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-md)', shadow: 'none' },
    'hns.process.queue': { background: 'var(--hns-color-bg-layer2)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-sm)', label: 'var(--hns-color-label-secondary)' },
    'hns.hardware.cpu': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-color-accent-primary)' },
    'hns.hardware.gpu': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-color-accent-secondary)' },
    'hns.hardware.memory': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-color-accent-primary)' },
    'hns.hardware.power': { background: 'transparent', label: 'var(--hns-color-label-secondary)', color: 'var(--hns-state-warning)' },
    'hns.log.panel': { background: 'var(--hns-color-bg-layer1)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-sm)', label: 'var(--hns-color-label-secondary)' },
    'hns.log.level': { color: 'var(--hns-color-label-secondary)', label: 'var(--hns-color-label-secondary)', weight: '500' },
    'hns.status.badge': { background: 'var(--hns-color-bg-layer2)', label: 'var(--hns-color-label-primary)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-sm)' },
    'hns.window.shell': { background: 'var(--hns-color-bg-layer1)', label: 'var(--hns-color-label-primary)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-md)' },
    'hns.operator.avatar': { asset: 'none', size: '24px' },
    'hns.operator.widget': { background: 'transparent', opacity: 0, position: 'corner-bottom-right', size: 'compact', animation: 'none' },
    'hns.persona.banner': { asset: 'none', opacity: 0, position: 'top', height: '0px' },
    'hns.persona.status_avatar': { asset: 'none', size: '24px', position: 'top-right' },
    'hns.persona.decoration': { asset: 'none', opacity: 0, animation: 'none', position: 'corners' },
    'common.button.primary': { background: 'var(--hns-color-accent-primary)', label: 'var(--hns-color-accent-contrast)', radius: 'var(--hns-radius-md)', glow: 0 },
    'common.button.secondary': { background: 'var(--hns-color-bg-layer2)', label: 'var(--hns-color-label-primary)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-md)' },
    'common.input.default': { background: 'var(--hns-color-bg-layer2)', label: 'var(--hns-color-label-primary)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-sm)', placeholder: 'var(--hns-color-label-tertiary)' },
    'common.dialog.default': { background: 'var(--hns-color-bg-layer1)', border: '1px solid var(--hns-color-border-l2)', radius: 'var(--hns-radius-lg)', shadow: 'none', overlay: 'var(--hns-color-bg-overlay)' },
    'common.notification.default': { background: 'var(--hns-color-bg-layer2)', border: '1px solid var(--hns-color-border-l1)', label: 'var(--hns-color-label-primary)', radius: 'var(--hns-radius-sm)' },
    'common.tooltip.default': { background: 'var(--hns-color-bg-raised)', label: 'var(--hns-color-label-primary)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-sm)' },
    'common.scrollbar.default': { thumb: 'var(--hns-color-border-l2)', track: 'transparent', width: '8px' },
    'common.navigation.sidebar': { background: 'var(--hns-color-bg-layer2)', border: '1px solid var(--hns-color-border-l1)', radius: '0' },
    'common.navigation.topbar': { background: 'var(--hns-color-bg-layer1)', border: '1px solid var(--hns-color-border-l1)', label: 'var(--hns-color-label-primary)' },
    'common.panel.background': { background: 'var(--hns-color-bg-layer1)', border: '1px solid var(--hns-color-border-l1)', radius: 'var(--hns-radius-md)', shadow: 'none' },
    'common.panel.border': { border: '1px solid var(--hns-color-border-l1)' },
    'common.window.background': { background: 'var(--hns-color-bg-base)', overlay: 'none' }
  },
  animation: { type: 'none', intensity: 0 }
})

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Load one theme package into a runtime-ready `ResolvedTheme`.
 *
 * @returns {{ok: true, theme: object} | {ok: false, reason: string, issues: object[]}}
 */
function loadPackage(dir, id) {
  if (!dir || !id) return { ok: false, reason: 'invalid_request', issues: [] }
  try {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      return { ok: false, reason: 'manifest_missing', issues: [] }
    }
  } catch (error) {
    return { ok: false, reason: `package_unreadable: ${error.message}`, issues: [] }
  }

  const report = validator.validatePackage({ dir, darkTokens: null, expectedId: id })
  if (!report.ok) {
    return { ok: false, reason: 'validation_failed', issues: report.issues }
  }

  let manifest = null
  let tokens = {}
  let components = { slots: {} }
  let persona = { enabled: false }
  try {
    manifest = readJson(path.join(dir, 'manifest.json'))
  } catch (error) {
    return { ok: false, reason: `manifest_unparsable: ${error.message}`, issues: report.issues }
  }
  try {
    const file = path.join(dir, 'tokens.json')
    tokens = fs.existsSync(file) ? readJson(file) : {}
  } catch (error) {
    return { ok: false, reason: `tokens_unparsable: ${error.message}`, issues: report.issues }
  }
  try {
    const file = path.join(dir, 'components.json')
    components = fs.existsSync(file) ? readJson(file) : { slots: {} }
  } catch (error) {
    return { ok: false, reason: `components_unparsable: ${error.message}`, issues: report.issues }
  }
  try {
    const file = path.join(dir, 'persona.json')
    persona = fs.existsSync(file) ? readJson(file) : { enabled: false }
  } catch {
    // A broken persona file degrades to "no persona" — never a theme failure.
    persona = { enabled: false }
  }

  return {
    ok: true,
    theme: {
      id,
      manifest,
      tokens: validator.resolveTokens(tokens, null),
      declaredTokens: tokens,
      components: { slots: components.slots || {}, animation: validator.normalizeAnimation(components.animation) },
      persona,
      dir,
      validation: report
    }
  }
}

/** The always-available recovery theme, built from constants in this module. */
function fallbackTheme(id) {
  return {
    id: id || 'hns.system.dark',
    manifest: {
      id: id || 'hns.system.dark',
      name: 'Dark',
      source: 'system',
      protected: true,
      deletable: false,
      editable: false,
      system_theme: true,
      official_palette: 'dark',
      theme_api_version: contract.THEME_API_VERSION,
      supported_apps: ['hns'],
      recovery: true
    },
    tokens: { ...FALLBACK_TOKEN_VALUES },
    declaredTokens: {},
    components: { slots: { ...FALLBACK_COMPONENTS.slots }, animation: { type: 'none', intensity: 0 } },
    persona: { enabled: false, prominence: 0, character: null, occludes: [], overlay_main: false },
    dir: null,
    validation: { ok: true, errors: [], warnings: [{ code: 'recovery_constants', message: 'resolved from built-in recovery constants' }], issues: [] }
  }
}

function createRecoveryManager({ log = () => {}, resolveDir, darkThemeDir } = {}) {
  const events = []

  function record(entry) {
    events.push({ at: new Date().toISOString(), ...entry })
    if (events.length > 64) events.splice(0, events.length - 64)
    log(`theme recovery: ${entry.from} -> ${entry.to} (${entry.reason})`)
  }

  /**
   * Load a theme by id, recovering to Dark on any failure.
   *
   * @returns {{theme: object, recovered: boolean, reason: string|null, issues: object[]}}
   */
  function guard(id) {
    const target = id || 'hns.system.dark'
    let dir = null
    try {
      dir = typeof resolveDir === 'function' ? resolveDir(target) : null
    } catch (error) {
      dir = null
      log(`theme dir resolution failed for ${target}: ${error?.message || error}`)
    }

    if (dir) {
      const loaded = loadPackage(dir, target)
      if (loaded.ok) return { theme: loaded.theme, recovered: false, reason: null, issues: [] }
      record({ from: target, to: 'hns.system.dark', reason: loaded.reason, issues: loaded.issues.slice(0, 8) })
      const dark = loadPackage(darkThemeDir, 'hns.system.dark')
      if (dark.ok) return { theme: dark.theme, recovered: true, reason: loaded.reason, issues: loaded.issues }
      record({ from: 'hns.system.dark', to: 'recovery-constants', reason: dark.reason, issues: [] })
      return { theme: fallbackTheme('hns.system.dark'), recovered: true, reason: loaded.reason, issues: loaded.issues }
    }

    record({ from: target, to: 'hns.system.dark', reason: 'package_missing', issues: [] })
    const dark = loadPackage(darkThemeDir, 'hns.system.dark')
    if (dark.ok) return { theme: dark.theme, recovered: true, reason: 'package_missing', issues: [] }
    record({ from: 'hns.system.dark', to: 'recovery-constants', reason: dark.reason, issues: [] })
    return { theme: fallbackTheme('hns.system.dark'), recovered: true, reason: 'package_missing', issues: [] }
  }

  return {
    guard,
    fallbackTheme,
    history: () => events.slice(),
    clearHistory: () => { events.length = 0 },
    FALLBACK_TOKEN_VALUES,
    FALLBACK_COMPONENTS
  }
}

module.exports = {
  FALLBACK_TOKEN_VALUES,
  FALLBACK_COMPONENTS,
  loadPackage,
  fallbackTheme,
  createRecoveryManager
}
