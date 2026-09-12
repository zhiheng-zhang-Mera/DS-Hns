'use strict'

/**
 * Theme Builder.
 *
 * Only runs after the design has passed preview and the user approved it
 * (engineering spec §9.2 / §10.1 / §16):
 *
 *   Approved Design
 *     -> compile tokens / components / persona / assets / preview
 *     -> self-contained package under data/theme-workspace/temp/<draft-id>/
 *     -> Package Validator
 *     -> register
 *     -> install into data/themes/user/<theme-id>/
 *
 * The Builder never writes straight into the production theme directory: a
 * package is validated in `theme-workspace/temp/` first and only then promoted
 * with a directory rename, so a failed build cannot leave a half-written theme
 * in the user's theme list (THEME_INTERFACE_SPEC §5).
 */
const fs = require('node:fs')
const path = require('node:path')

const contract = require('./contract')
const validator = require('./validator')
const assets = require('./asset-factory')
const png = require('./png')
const color = require('./color')
const designer = require('./designer')

/** Package-relative asset paths written by the Builder. */
const ASSET_LAYOUT = Object.freeze({
  wallpaper: 'assets/wallpapers/main.png',
  overlay: 'assets/decorations/overlay.png',
  panelTexture: 'assets/panels/panel.png',
  iconSet: 'assets/icons/set.png',
  trayIcon: 'assets/icons/tray.png',
  personaAvatar: 'assets/persona/avatar.png',
  personaBanner: 'assets/persona/banner.png',
  decoration: 'assets/decorations/corners.png'
})

/** Token -> asset file mapping. Assets are embedded as data URIs at runtime. */
const TOKEN_ASSET_MAP = Object.freeze({
  'asset.wallpaper': 'wallpaper',
  'asset.overlay': 'overlay',
  'asset.panel_texture': 'panelTexture',
  'asset.icon_set': 'iconSet',
  'asset.persona_avatar': 'personaAvatar',
  'asset.persona_banner': 'personaBanner',
  'asset.decoration': 'decoration'
})

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Render the theme as a small standalone mock dock so a preview exists inside the
 * package itself (self-contained: the preview is compiled in, not referenced).
 */
function buildPreviewHtml({ name, mode, tokens, components, persona }) {
  const slot = (id) => components.slots?.[id] || {}
  const shell = slot('hns.window.shell')
  const worker = slot('hns.worker.card')
  const queue = slot('hns.process.queue')
  const badge = slot('hns.status.badge')
  const button = slot('common.button.primary')
  const input = slot('common.input.default')
  const states = contract.HNS_STATES
  const cssVars = contract.TOKEN_NAMES
    .filter((tokenName) => contract.TOKENS[tokenName].kind !== contract.PROPERTY_KIND.ASSET)
    .map((tokenName) => `      ${contract.TOKENS[tokenName].css}: ${tokens[tokenName]};`)
    .join('\n')
  const assetVars = Object.entries(TOKEN_ASSET_MAP)
    .map(([tokenName, key]) => `      ${contract.TOKENS[tokenName].css}: ${tokens[tokenName] || 'none'};`)
    .join('\n')
  const personaBlock = persona && persona.enabled
    ? `<div class="persona"><img alt="operator" src="${tokens['asset.persona_avatar'] || ''}"><span>${escapeHtml(persona.character || 'operator')}</span></div>`
    : '<div class="persona empty">persona off</div>'
  const stateChips = states.map((state) => (
    `<span class="chip" style="border-color:var(--hns-state-${state.replace(/_/g, '-')});color:var(--hns-state-${state.replace(/_/g, '-')})">${state}</span>`
  )).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)} — HNS theme preview</title>
<style>
  :root {
${cssVars}
${assetVars}
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 18px; font-family: var(--hns-font-family);
    font-size: var(--hns-font-size-body); color: var(--hns-color-label-primary);
    background-color: var(--hns-color-bg-base);
    background-image: var(--hns-asset-wallpaper);
    background-size: cover;
  }
  .shell { background: ${shell.background || 'var(--hns-color-bg-layer1)'}; border: 1px solid var(--hns-color-border-l1);
    border-radius: var(--hns-radius-md); padding: var(--hns-space-panel); display: grid; gap: var(--hns-space-gap); }
  h1 { font-size: var(--hns-font-size-title); font-weight: var(--hns-font-weight-title); margin: 0; }
  h2 { font-size: var(--hns-font-size-caption); text-transform: uppercase; letter-spacing: .08em;
    color: var(--hns-color-label-tertiary); margin: 0 0 6px; }
  .grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--hns-space-gap); }
  .card { background: ${worker.background || 'var(--hns-color-bg-layer1)'}; border: ${worker.border || '1px solid var(--hns-color-border-l1)'};
    border-radius: ${worker.radius || 'var(--hns-radius-md)'}; box-shadow: ${worker.shadow || 'none'}; padding: var(--hns-space-panel); }
  .queue { background: ${queue.background || 'var(--hns-color-bg-layer2)'}; border: ${queue.border || '1px solid var(--hns-color-border-l1)'};
    border-radius: ${queue.radius || 'var(--hns-radius-sm)'}; padding: 8px; }
  .badge { background: ${badge.background || 'var(--hns-color-bg-layer2)'}; border: ${badge.border || '1px solid var(--hns-color-border-l1)'};
    border-radius: ${badge.radius || 'var(--hns-radius-sm)'}; padding: 2px 8px; font-size: var(--hns-font-size-caption); }
  button { background: ${button.background || 'var(--hns-color-accent-primary)'}; color: ${button.label || 'var(--hns-color-accent-contrast)'};
    border: 0; border-radius: ${button.radius || 'var(--hns-radius-md)'}; padding: 7px 12px; font: inherit; cursor: pointer; }
  input, textarea { background: ${input.background || 'var(--hns-color-bg-layer2)'}; color: var(--hns-color-label-primary);
    border: ${input.border || '1px solid var(--hns-color-border-l1)'}; border-radius: ${input.radius || 'var(--hns-radius-sm)'};
    padding: 6px 8px; font: inherit; width: 100%; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px; font-size: var(--hns-font-size-caption); }
  .persona { display: flex; align-items: center; gap: 8px; font-size: var(--hns-font-size-caption);
    color: var(--hns-color-label-secondary); }
  .persona img { width: 28px; height: 28px; border-radius: 50%; }
  .persona.empty { opacity: .5; }
  .rails { display: flex; gap: var(--hns-space-gap); color: var(--hns-color-label-tertiary); font-size: var(--hns-font-size-caption); }
</style>
</head>
<body>
  <div class="shell">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <h1>${escapeHtml(name)}</h1>
      <span class="badge">${escapeHtml(mode)}</span>
    </div>
    <div class="rails"><span>WORKER</span><span>PROCESS</span><span>HARDWARE</span><span>LOG</span><span>SETTINGS</span></div>
    <div class="grid">
      <div class="card">
        <h2>Worker / process</h2>
        <div class="chips">${stateChips}</div>
        <div class="queue" style="margin-top:10px">queue item · queued · worker #2</div>
      </div>
      <div class="card">
        <h2>Hardware</h2>
        <div style="color:var(--hns-color-label-secondary)">CPU 42% · RAM 61% · GPU 18% · POWER 220W</div>
        ${personaBlock}
      </div>
    </div>
    <div style="display:flex;gap:8px"><input placeholder="new task"><button>Add</button></div>
  </div>
</body>
</html>
`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render a PNG preview of the same mock so the theme list can show a picture
 * without a browser. Intentionally simple and deterministic.
 */
function buildPreviewPng({ name, mode, tokens }) {
  const width = 480
  const height = 300
  const canvas = png.createCanvas(width, height)
  const parse = (value, fallback) => {
    const parsed = color.parseColor(value)
    if (parsed) return { r: parsed.r, g: parsed.g, b: parsed.b }
    const fallbackParsed = color.parseColor(fallback)
    return fallbackParsed ? { r: fallbackParsed.r, g: fallbackParsed.g, b: fallbackParsed.b } : { r: 0, g: 0, b: 0 }
  }
  const bg = parse(tokens['color.bg.base'], '#0f1115')
  const layer1 = parse(tokens['color.bg.layer1'], '#151922')
  const layer2 = parse(tokens['color.bg.layer2'], '#1b2130')
  const accent = parse(tokens['color.accent.primary'], '#4d93f8')
  const label = parse(tokens['color.label.primary'], '#e8ecf3')

  // backdrop with a diagonal accent wash
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / width) * 0.6 + (y / height) * 0.4
      const rgb = {
        r: bg.r + (layer2.r - bg.r) * t * 0.6,
        g: bg.g + (layer2.g - bg.g) * t * 0.6,
        b: bg.b + (layer2.b - bg.b) * t * 0.6
      }
      png.blendPixel(canvas, x, y, rgb, 1)
    }
  }
  const washBand = Math.round(height * 0.1)
  for (let y = 0; y < height; y += 1) {
    const edge = Math.max(0, 1 - Math.abs(y - height * 0.18) / washBand)
    if (edge > 0) {
      for (let x = 0; x < width; x += 1) png.blendPixel(canvas, x, y, accent, edge * 0.18)
    }
  }
  const panel = (x0, y0, w, h, colorRgb, alpha = 1) => {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) png.blendPixel(canvas, x, y, colorRgb, alpha)
    }
  }
  panel(20, 20, width - 40, height - 40, layer2, 0.9)
  panel(32, 40, width - 64, 26, layer1, 1)
  panel(32, 80, Math.round((width - 64) * 0.62), height - 150, layer1, 1)
  panel(32 + Math.round((width - 64) * 0.66), 80, Math.round((width - 64) * 0.34), height - 150, layer2, 1)
  panel(32, height - 60, 150, 24, accent, 0.9)
  // a few state stripes
  const stripeColors = contract.HNS_STATES.map((state) => tokens[`state.${state}`])
  stripeColors.forEach((value, index) => {
    const rgb = parse(value, '#4d93f8')
    panel(44 + index * 26, 96, 18, 6, rgb, 1)
  })
  // label bars
  for (let index = 0; index < 4; index += 1) {
    panel(44, 130 + index * 18, 120 - index * 12, 5, label, 0.32)
  }
  panel(44, 220, 60, 5, label, 0.2)
  // mode marker: light themes get a bright top-right notch
  if (String(mode) === 'light') panel(width - 60, 28, 20, 8, accent, 1)

  return png.canvasToPng(canvas)
}

function isDataUri(value) {
  return typeof value === 'string' && value.startsWith('data:image/')
}

/**
 * Compile a draft design into a self-contained package on disk.
 *
 * @param {object} options
 * @param {object} options.draft        output of designer.design()
 * @param {string} options.id           theme id
 * @param {string} options.name         display name
 * @param {string} options.outDir       target package directory
 * @param {string} [options.source]     manifest.source
 * @param {number} [options.revisionOf] previous revision number
 * @param {object[]} [options.revisionHistory]
 * @param {string} [options.generatedPrompt]
 * @param {string} [options.derivedFrom]
 * @param {object} [options.darkTokens]
 */
function buildPackage(options) {
  const {
    draft, id, name, outDir, source = 'generated',
    revisionHistory = [], generatedPrompt = null, derivedFrom = null,
    darkTokens = null, author = 'HNS Theme Engine', protectedFlag = false,
    compiledBy = 'theme-builder'
  } = options || {}

  if (!draft || !draft.tokens || !draft.components) {
    return { ok: false, reason: 'draft_invalid', issues: [{ severity: 'error', code: 'draft_invalid', message: 'the builder needs a resolved design draft' }] }
  }
  if (!id || !outDir) {
    return { ok: false, reason: 'build_request_invalid', issues: [{ severity: 'error', code: 'build_request_invalid', message: 'id and outDir are required' }] }
  }

  // ---- assets ----
  const persona = draft.persona || { enabled: false }
  const bundle = assets.buildAssetBundle({
    palette: draft.palette_values || {},
    style: draft.style_tag || draft.design_language,
    seed: `${draft.palette}:${draft.design_language}:${draft.intent?.density || 'compact'}`,
    persona
  })

  // ---- tokens ----
  //
  // Asset tokens are embedded as data URIs so the runtime never has to touch the
  // filesystem to paint a theme (spec §11.1 self-contained + §21 no main-thread
  // blocking). The same bytes are also written into `assets/` so the package
  // carries its real, inspectable source assets on disk; `manifest.asset_files`
  // declares those on-disk paths.
  const tokens = {}
  const assetFiles = []
  for (const tokenName of contract.TOKEN_NAMES) {
    const definition = contract.TOKENS[tokenName]
    const provided = draft.tokens[tokenName]
    if (definition.kind === contract.PROPERTY_KIND.ASSET) {
      const key = TOKEN_ASSET_MAP[tokenName]
      const assetPathKey = key ? ASSET_LAYOUT[key] : null
      const buffer = assetPathKey ? bundle[assetPathKey] : null
      if (buffer) {
        tokens[tokenName] = `data:image/png;base64,${buffer.toString('base64')}`
        assetFiles.push({ path: assetPathKey, bytes: buffer.length })
      } else if (isDataUri(provided)) {
        tokens[tokenName] = provided
      } else {
        tokens[tokenName] = 'none'
      }
      continue
    }
    if (provided !== undefined && provided !== null && provided !== '') {
      tokens[tokenName] = provided
      continue
    }
    const fallback = darkTokens && darkTokens[tokenName]
    tokens[tokenName] = fallback !== undefined ? fallback : definition.fallback
  }

  // ---- components ----
  const animation = validator.normalizeAnimation(draft.components.animation || draft.animation)
  const components = {
    theme_api_version: contract.THEME_API_VERSION,
    generated_by: compiledBy,
    slots: draft.components.slots || {},
    animation: { type: animation.type, intensity: animation.intensity }
  }

  // ---- persona ----
  const personaDocument = {
    enabled: Boolean(persona.enabled),
    prominence: Number(persona.prominence) || 0,
    character: persona.character || null,
    states: persona.states || {},
    occludes: persona.occludes || [],
    overlay_main: false,
    sounds: persona.sounds || [],
    avatar: persona.enabled ? ASSET_LAYOUT.personaAvatar : null,
    banner: persona.enabled ? ASSET_LAYOUT.personaBanner : null,
    notes: persona.notes || null
  }

  // ---- manifest ----
  const revision = revisionHistory.length + 1
  const manifest = {
    id,
    name: name || id,
    author,
    version: `1.0.${revision}`,
    source,
    protected: protectedFlag === true,
    deletable: protectedFlag !== true,
    editable: protectedFlag !== true,
    system_theme: source === 'system',
    theme_api_version: contract.THEME_API_VERSION,
    required_theme_api: '>=1.0',
    supported_apps: ['hns'],
    created_at: new Date().toISOString(),
    installed_at: null,
    generated_prompt: generatedPrompt,
    revision_history: revisionHistory.concat([{
      revision,
      at: new Date().toISOString(),
      prompt: generatedPrompt,
      design_language: draft.design_language,
      palette: draft.palette,
      density: draft.intent?.density || null,
      motion: draft.intent?.motion || null,
      decoration: draft.intent?.decoration || null,
      persona: persona.enabled ? { character: persona.character, prominence: persona.prominence } : { enabled: false }
    }]),
    derived_from: derivedFrom,
    official_palette: draft.mode === 'light' ? 'light' : 'dark',
    animation: { type: animation.type, intensity: animation.intensity },
    preview: 'preview.png',
    preview_html: 'preview.html',
    asset_files: assetFiles,
    design_language: draft.design_language,
    palette: draft.palette,
    mode: draft.mode
  }

  // ---- materialize ----
  const root = path.resolve(outDir)
  try {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    for (const [assetPathKey, buffer] of Object.entries(bundle)) {
      writeFile(path.join(root, assetPathKey), buffer)
    }
    for (const dirName of validator.ASSET_DIRS) {
      fs.mkdirSync(path.join(root, 'assets', dirName), { recursive: true })
    }
    writeJson(path.join(root, 'manifest.json'), manifest)
    writeJson(path.join(root, 'tokens.json'), tokens)
    writeJson(path.join(root, 'components.json'), components)
    writeJson(path.join(root, 'persona.json'), personaDocument)
    writeFile(path.join(root, 'preview.html'), buildPreviewHtml({
      name: manifest.name,
      mode: draft.mode,
      tokens,
      components,
      persona: personaDocument
    }))
    writeFile(path.join(root, 'preview.png'), buildPreviewPng({
      name: manifest.name,
      mode: draft.mode,
      tokens
    }))
    writeFile(path.join(root, 'README.md'), [
      `# ${manifest.name}`,
      '',
      `- id: \`${manifest.id}\``,
      `- source: \`${manifest.source}\``,
      `- theme_api_version: \`${manifest.theme_api_version}\``,
      `- design_language: \`${manifest.design_language}\``,
      `- palette: \`${manifest.palette}\``,
      `- generated from prompt: ${manifest.generated_prompt ? `\`${manifest.generated_prompt}\`` : '_not recorded_'}`,
      '',
      'This package is self-contained: it has no runtime dependency on any other theme.',
      '`derived_from` is historical metadata only and never participates in asset resolution.',
      ''
    ].join('\n'))
  } catch (error) {
    return {
      ok: false,
      reason: 'write_failed',
      issues: [{ severity: 'error', code: 'write_failed', message: String(error?.message || error) }]
    }
  }

  // ---- validate the compiled artifact, not the intent ----
  const report = validator.validatePackage({ dir: root, darkTokens, expectedId: id })
  if (!report.ok) {
    return { ok: false, reason: 'validation_failed', issues: report.issues, dir: root, manifest }
  }

  return {
    ok: true,
    dir: root,
    manifest,
    tokens,
    components,
    persona: personaDocument,
    validation: report,
    assets: Object.keys(bundle)
  }
}

/** Count the slots a compiled package actually writes. */
function countSlots(components) {
  return components && components.slots ? Object.keys(components.slots).length : 0
}

module.exports = {
  ASSET_LAYOUT,
  TOKEN_ASSET_MAP,
  buildPackage,
  buildPreviewHtml,
  buildPreviewPng,
  countSlots,
  escapeHtml
}
