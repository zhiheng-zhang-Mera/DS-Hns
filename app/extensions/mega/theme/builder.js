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
const planner = require('./assets/planner')
const generatorModule = require('./assets/generator')
const assetValidator = require('./assets/validator')

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

/** Plan asset kind -> the asset token it fills, for the plan-driven pass. */
const PLAN_TOKEN_MAP = Object.freeze(designer.ASSET_KIND_TOKEN)

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Generate every asset the plan asked for (任务 4 / 任务 5 / 任务 6 / 任务 17).
 *
 * This is the plan-driven pass: the *only* place assets are produced for a
 * theme, and the only place the fallback chain runs. Every outcome — produced,
 * degraded to the procedural fallback, or disabled — is returned so the package
 * can document it and the preview can report it.
 *
 * @returns {Promise<{assets: object[], byToken: object, byPlanPath: object, degraded: object[], disabled: object[], warnings: string[], generator: object|null}>}
 */
async function generatePlannedAssets({ draft, palette, style, seed, character, log = () => {} }) {
  const plan = draft.asset_plan || null
  const entries = plan?.asset_plan || []
  const assets = []
  const byToken = {}
  const byPlanPath = {}
  const degraded = []
  const disabled = []
  const warnings = []
  if (!entries.length) {
    return { assets, byToken, byPlanPath, degraded, disabled, warnings, generator: null }
  }

  const generator = generatorModule.createAssetGenerator({
    imageGenerator: draft.image_generator || null,
    log: (message) => log(`asset: ${message}`)
  })

  for (const entry of entries) {
    let result = null
    try {
      result = await generator.generate({ entry, palette, style, seed, character })
    } catch (error) {
      // The generator already swallows its own failures; this is the outer belt
      // for a bug in it. One asset must never be able to fail a theme build.
      result = {
        kind: entry.kind,
        surface: entry.surface,
        path: entry.path,
        buffer: null,
        disabled: true,
        degraded: true,
        reason: `asset pipeline error: ${error?.message || error}`,
        warnings: [],
        validation: null
      }
    }
    const record = {
      kind: result.kind || entry.kind,
      surface: result.surface || entry.surface,
      path: result.path || entry.path,
      bytes: result.buffer ? result.buffer.length : 0,
      provenance: result.provenance || null,
      degraded: Boolean(result.degraded),
      disabled: Boolean(result.disabled),
      reason: result.reason || null,
      validation: result.validation || null,
      buffer: result.buffer || null
    }
    assets.push(record)
    for (const warning of result.warnings || []) warnings.push(warning)
    if (record.disabled) {
      disabled.push(record)
      log(`asset ${record.kind} disabled: ${record.reason}`)
      continue
    }
    if (record.degraded) degraded.push(record)
    if (record.buffer && record.path) byPlanPath[record.path] = record.buffer
    const token = PLAN_TOKEN_MAP[record.kind]
    if (token && record.buffer) {
      byToken[token] = {
        dataUri: `data:image/png;base64,${record.buffer.toString('base64')}`,
        path: record.path,
        bytes: record.buffer.length,
        kind: record.kind,
        surface: record.surface
      }
    }
  }

  return { assets, byToken, byPlanPath, degraded, disabled, warnings, generator }
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

/** Shared CSS for the per-surface preview documents. Values are escaped data. */
function previewChrome({ name, surfaceId, permission, mode }) {
  return `    :root { color-scheme: ${mode === 'light' ? 'light' : 'dark'}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, "Segoe UI", sans-serif; background: #06070a; color: #e8ecf3; }
    .stage { display: grid; gap: 10px; padding: 14px; }
    .stage-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .stage-head h1 { margin: 0; font-size: 14px; }
    .stage-head span { font-size: 10px; opacity: .7; }
    .surface { position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,.16); border-radius: 10px; }
    .caption { font-size: 10px; opacity: .65; }
    .legend { display: flex; flex-wrap: wrap; gap: 6px; font-size: 10px; }
    .legend b { font-weight: 600; padding: 1px 6px; border: 1px solid rgba(255,255,255,.2); border-radius: 999px; }
    .protected { border-color: rgba(255,120,120,.5); }
`
}

function previewDocument({ name, title, surfaceId, permission, mode, body, extraCss = '', legend = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)} — ${escapeHtml(title)}</title>
<style>
${previewChrome({ name, surfaceId, permission, mode })}${extraCss}</style>
</head>
<body>
<div class="stage">
  <div class="stage-head">
    <h1>${escapeHtml(name)} · ${escapeHtml(title)}</h1>
    <span>surface=${escapeHtml(surfaceId)} · permission=${escapeHtml(permission)}</span>
  </div>
  <div class="legend">${legend.map((entry) => `<b>${escapeHtml(entry)}</b>`).join('')}</div>
${body}
</div>
</body>
</html>
`
}

/**
 * Per-surface previews (Update-Plan/General-Theme.md 任务 12 / 任务 13).
 *
 * Four documents, each showing exactly one thing:
 *
 *   hns-preview.html        the HNS dock wearing the theme
 *   official-shell-preview  the frame DS-Hns draws around the official renderer
 *   official-overlay-preview the visual layer above the official renderer
 *   composite-preview       all of it stacked in the real z-order
 *
 * They are self-contained: every asset is an inline data URI, there is no script,
 * and no value is fetched from anywhere. The composite preview is what a user
 * judges before approving, and the overlay preview draws the *placements the
 * layout produced*, so "the character sits bottom-right and does not cover the
 * input box" is visible rather than asserted.
 */
function buildSurfacePreviews({ name, mode, tokens, components, persona, surfacePlan = {}, overlayPlan = {}, assetPlan = {}, previewAssets = {} }) {
  const slot = (id) => components.slots?.[id] || {}
  const asset = (key) => (previewAssets[key] && previewAssets[key] !== 'none' ? `url("${previewAssets[key]}")` : 'none')
  const shell = slot('official.shell.frame')
  const overlayCharacter = slot('official.overlay.character_primary') || {}
  const overlaySkin = slot('official.overlay.skin') || {}
  const overlayTexture = slot('official.overlay.texture') || {}
  const overlayTint = slot('official.overlay.global_tint') || {}
  const overlayVignette = slot('official.overlay.vignette') || {}
  const overlayScanline = slot('official.overlay.scanline') || {}
  const character = slot('hns.character.primary') || {}
  const view = { width: 960, height: 600 }
  const characterBox = overlayPlan.components?.character_primary?.size || { width: 260, height: 390 }
  const anchor = overlayCharacter.anchor || overlayPlan.layout?.anchor || 'bottom-right'
  const placement = overlayPlan.layout || {}
  const positionCss = {
    'top-left': 'top:8px;left:8px',
    'top-center': 'top:8px;left:50%;transform:translateX(-50%)',
    'top-right': 'top:8px;right:8px',
    'center-left': 'top:50%;left:8px;transform:translateY(-50%)',
    center: 'top:50%;left:50%;transform:translate(-50%,-50%)',
    'center-right': 'top:50%;right:8px;transform:translateY(-50%)',
    'bottom-left': 'bottom:8px;left:8px',
    'bottom-center': 'bottom:8px;left:50%;transform:translateX(-50%)',
    'bottom-right': 'bottom:8px;right:8px'
  }[anchor] || 'bottom:8px;right:8px'

  const toggles = [
    ['global tint', overlayTint.opacity],
    ['gradient', slot('official.overlay.gradient')?.opacity],
    ['texture', overlayTexture.opacity],
    ['skin', overlaySkin.opacity],
    ['vignette', overlayVignette.opacity],
    ['scanline', overlayScanline.opacity],
    ['frame glow', slot('official.overlay.frame_glow')?.opacity],
    ['character', overlayCharacter.opacity]
  ].filter(([, value]) => Number(value) > 0).map(([label]) => label)

  const hnsStateChips = contract.HNS_STATES
    .map((state) => `<span class="chip" style="border-color:var(--hns-state-${state});color:var(--hns-state-${state})">${state}</span>`)
    .join('')

  const hnsDoc = previewDocument({
    name,
    title: 'HNS Preview',
    surfaceId: 'hns_native',
    permission: 'full',
    mode,
    legend: ['tokens', 'slots', persona?.enabled ? 'character' : 'no character'],
    body: `  <div class="surface hns" style="background:var(--hns-color-bg-base);background-image:${asset('wallpaper')};background-size:cover;padding:16px;min-height:340px;display:grid;gap:10px">
    <div class="panel" style="background:var(--hns-color-bg-layer1);border:1px solid var(--hns-color-border-l1);border-radius:var(--hns-radius-md);padding:12px;display:grid;gap:8px">
      <strong style="font-size:13px">${escapeHtml(name)}</strong>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${hnsStateChips}</div>
      <div style="display:flex;gap:8px"><input placeholder="new task" style="flex:1;background:var(--hns-color-bg-layer2);border:1px solid var(--hns-color-border-l1);border-radius:var(--hns-radius-sm);color:inherit;padding:6px 8px"><button style="background:var(--hns-color-accent-primary);color:var(--hns-color-accent-contrast);border:0;border-radius:var(--hns-radius-md);padding:7px 12px">Add</button></div>
    </div>
    ${character.asset && character.asset !== 'none'
      ? `<div style="align-self:end;justify-self:end;width:${Number(characterBox.width) || 200}px;max-width:38%;opacity:${Number(character.opacity) || 0.8};background-image:${asset('hns_character')};background-size:contain;background-repeat:no-repeat;background-position:bottom right;height:${Number(characterBox.height) || 300}px"></div>`
      : '<div class="caption">no HNS character asset in this theme</div>'}
  </div>
  <span class="caption">hns_native is a full-permission surface: tokens, slot styles, persona and the real character asset all apply here.</span>`,
    extraCss: `    .chip { border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px; font-size: 10px; }\n`
  })

  const shellDoc = previewDocument({
    name,
    title: 'Official Shell Preview',
    surfaceId: 'official_shell',
    permission: 'full',
    mode,
    legend: ['background', 'border', 'radius', 'shadow', 'separator', 'frame', 'outer padding'],
    body: `  <div class="surface" style="padding:${Number(tokens['official.shell.padding']?.replace('px', '')) || 6}px;background:${shell.background || 'var(--hns-color-bg-base)'}">
    <div style="position:relative;height:300px;border:${escapeHtml(shell.border || '1px solid var(--hns-color-border-l2)')};border-radius:${escapeHtml(shell.radius || '10px')};box-shadow:${escapeHtml(shell.shadow || 'var(--hns-shadow-l1)')};background:#0d1016;display:grid;place-items:center">
      <div style="text-align:center;color:#7b8698;font-size:11px;line-height:1.7">
        <div>official renderer area (never styled, never scripted, never captured)</div>
        <div style="opacity:.7">the shell draws the frame around it and reserves the outer padding</div>
      </div>
      <div style="position:absolute;top:50%;left:8px;right:8px;height:0;border-top:${escapeHtml(slot('official.shell.separator')?.border || '1px solid var(--hns-color-border-l1)')}"></div>
    </div>
  </div>
  <span class="caption">official_shell is written by DS-Hns around the official view: it is input-transparent, so every pixel of the official UI keeps its own input.</span>`
  })

  const overlayDoc = previewDocument({
    name,
    title: 'Official Overlay Preview',
    surfaceId: 'official_overlay',
    permission: 'visual-only',
    mode,
    legend: toggles.length ? toggles : ['overlay disabled'],
    body: `  <div class="surface" style="height:360px;background:#0d1016">
    <div style="position:absolute;inset:0;display:grid;place-items:center;color:#6f7885;font-size:11px">official content stays interactive underneath</div>
    <div style="position:absolute;inset:0;pointer-events:none">
      <div style="position:absolute;inset:0;background:${escapeHtml(overlayTint.color || '#0b0d12')};opacity:${Number(overlayTint.opacity) || 0};mix-blend-mode:${escapeHtml(overlayTint.blend || 'normal')}"></div>
      <div style="position:absolute;inset:0;background-image:${asset('official_overlay_texture')};background-repeat:repeat;opacity:${Number(overlayTexture.opacity) || 0}"></div>
      <div style="position:absolute;inset:0;background-image:${asset('official_skin')};background-size:100% 100%;opacity:${Number(overlaySkin.opacity) || 0}"></div>
      <div style="position:absolute;inset:0;box-shadow:inset 0 0 120px 30px rgba(0,0,0,${Number(overlayVignette.opacity) || 0})"></div>
      <div style="position:absolute;inset:0;background-image:repeating-linear-gradient(to bottom, rgba(0,0,0,${Number(overlayScanline.opacity) || 0}) 0 1px, transparent 1px ${Number(overlayScanline.spacing) || 4}px)"></div>
      <div style="position:absolute;inset:0;border:${Number(slot('official.overlay.frame_glow')?.width) || 2}px solid ${escapeHtml(slot('official.overlay.frame_glow')?.color || 'var(--hns-color-accent-primary)')};opacity:${Number(slot('official.overlay.frame_glow')?.opacity) || 0}"></div>
      ${overlayCharacter.asset && overlayCharacter.asset !== 'none'
        ? `<div style="position:absolute;${positionCss};width:${Number(characterBox.width) || 240}px;height:${Number(characterBox.height) || 360}px;max-height:82%;background-image:${asset('official_character')};background-size:contain;background-repeat:no-repeat;background-position:bottom ${anchor.includes('left') ? 'left' : 'right'};opacity:${Number(overlayCharacter.opacity) || 0.8}"></div>`
        : ''}
    </div>
    <div style="position:absolute;left:8px;right:8px;bottom:8px;height:52px;border:1px dashed rgba(255,255,255,.25);display:grid;place-items:center;color:#8b93a1;font-size:10px">critical region: input + send (character must not cover this)</div>
  </div>
  <span class="caption">official_overlay is VISUAL ONLY: pointer, keyboard, focus and scroll all pass through to the official renderer. Ceilings: opacity ${escapeHtml(String(overlayPlan.limits?.overlay_opacity ?? 0.22))}, vignette ${escapeHtml(String(overlayPlan.limits?.vignette ?? 0.15))}, character coverage ${escapeHtml(String(overlayPlan.limits?.character_coverage ?? 0.22))}.</span>`
  })

  const compositeDoc = previewDocument({
    name,
    title: 'Full Composite Preview',
    surfaceId: 'composite',
    permission: 'n/a',
    mode,
    legend: ['z: official_shell', 'z: official_renderer (protected)', 'z: official_overlay', 'z: hns_native'],
    body: `  <div style="display:grid;grid-template-columns:1fr 260px;gap:10px">
    <div class="surface" style="height:360px;background:${shell.background || 'var(--hns-color-bg-base)'};padding:${Number(tokens['official.shell.padding']?.replace('px', '')) || 6}px">
      <div style="position:relative;height:100%;border:${escapeHtml(shell.border || '1px solid var(--hns-color-border-l2)')};border-radius:${escapeHtml(shell.radius || '10px')};overflow:hidden;background:#0d1016">
        <div style="position:absolute;inset:0;background-image:${asset('wallpaper')};background-size:cover"></div>
        <div style="position:absolute;inset:0;display:grid;place-items:center;color:#6f7885;font-size:11px">official content (protected)</div>
        <div style="position:absolute;inset:0;pointer-events:none">
          <div style="position:absolute;inset:0;background:${escapeHtml(overlayTint.color || '#0b0d12')};opacity:${Number(overlayTint.opacity) || 0}"></div>
          <div style="position:absolute;inset:0;background-image:${asset('official_overlay_texture')};opacity:${Number(overlayTexture.opacity) || 0}"></div>
          <div style="position:absolute;inset:0;background-image:${asset('official_skin')};background-size:100% 100%;opacity:${Number(overlaySkin.opacity) || 0}"></div>
          ${overlayCharacter.asset && overlayCharacter.asset !== 'none'
            ? `<div style="position:absolute;${positionCss};width:${Number(characterBox.width) || 240}px;height:${Number(characterBox.height) || 330}px;max-height:88%;background-image:${asset('official_character')};background-size:contain;background-repeat:no-repeat;background-position:bottom ${anchor.includes('left') ? 'left' : 'right'};opacity:${Number(overlayCharacter.opacity) || 0.8}"></div>`
            : ''}
          <div style="position:absolute;left:8px;right:8px;bottom:8px;height:44px;border:1px dashed rgba(255,255,255,.25)"></div>
        </div>
      </div>
    </div>
    <div class="surface" style="background:var(--hns-color-bg-base);background-image:${asset('wallpaper')};background-size:cover;padding:10px;display:grid;gap:8px;align-content:start">
      <strong style="font-size:11px">HNS dock</strong>
      <div style="height:8px;background:var(--hns-color-bg-layer1);border-radius:4px"></div>
      <div style="height:8px;background:var(--hns-color-bg-layer2);border-radius:4px"></div>
      <div style="height:8px;background:var(--hns-color-accent-primary);border-radius:4px;opacity:.8"></div>
    </div>
  </div>
  <span class="caption">Composite: the official shell frames the protected renderer, the overlay stacks above it, the HNS dock sits beside it. Surfaces written: ${escapeHtml((surfacePlan.surfaces || []).filter((entry) => entry.writes).map((entry) => entry.surface).join(', ') || 'none')}. Assets: ${escapeHtml(String(assetPlan.count || 0))} planned, ${escapeHtml(String((assetPlan.assets || []).filter((entry) => entry.disabled).length))} disabled.</span>`
  })

  return {
    'hns-preview.html': hnsDoc,
    'official-shell-preview.html': shellDoc,
    'official-overlay-preview.html': overlayDoc,
    'official-preview.html': overlayDoc,
    'composite-preview.html': compositeDoc
  }
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

/** `var(--hns-asset-x)` -> the compiled asset token value. */
const ASSET_VAR_REFERENCE = /var\((--hns-asset-[a-z0-9-]+)\)/gi

/**
 * Resolve `var(--hns-asset-*)` references inside slot styles.
 *
 * The designer emits them so a plan-time slot style names an asset *token* rather
 * than a file, and the validator therefore never sees a second, file-shaped asset
 * reference. Compilation is where the reference becomes real.
 */
function resolveSlotAssetReferences(slots, tokens) {
  const tokenByCss = {}
  for (const tokenName of contract.TOKEN_NAMES) {
    if (contract.TOKENS[tokenName].kind !== contract.PROPERTY_KIND.ASSET) continue
    tokenByCss[contract.TOKENS[tokenName].css] = tokens[tokenName]
  }
  const out = {}
  for (const [slotId, payload] of Object.entries(slots)) {
    if (!payload || typeof payload !== 'object') {
      out[slotId] = payload
      continue
    }
    const next = {}
    for (const [property, value] of Object.entries(payload)) {
      if (typeof value !== 'string' || !value.includes('var(--hns-asset-')) {
        next[property] = value
        continue
      }
      next[property] = value.replace(ASSET_VAR_REFERENCE, (match, cssName) => tokenByCss[cssName] || 'none')
    }
    out[slotId] = next
  }
  return out
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
async function buildPackage(options) {
  const {
    draft, id, name, outDir, source = 'generated',
    revisionHistory = [], generatedPrompt = null, derivedFrom = null,
    darkTokens = null, author = 'HNS Theme Engine', protectedFlag = false,
    compiledBy = 'theme-builder', log = () => {}
  } = options || {}

  if (!draft || !draft.tokens || !draft.components) {
    return { ok: false, reason: 'draft_invalid', issues: [{ severity: 'error', code: 'draft_invalid', message: 'the builder needs a resolved design draft' }] }
  }
  if (!id || !outDir) {
    return { ok: false, reason: 'build_request_invalid', issues: [{ severity: 'error', code: 'build_request_invalid', message: 'id and outDir are required' }] }
  }

  // ---- assets ----
  //
  // Two passes, in this order:
  //   1. the plan-driven pipeline (assets/planner -> generator -> processor ->
  //      validator, with the procedural fallback inside it). It produces the real
  //      character, the official skin/texture/frame and the HNS character, and it
  //      is the pass that can *disable* a single asset without failing the theme.
  //   2. the legacy bundle, which fills whatever the plan does not cover (the tray
  //      glyph, the overlay ornament, the persona banner). Those kinds have no
  //      plan entry and no token of their own, but the packages that already ship
  //      them must keep working unchanged.
  const persona = draft.persona || { enabled: false }
  const palette = draft.palette_values || {}
  const style = draft.style_tag || draft.design_language
  const seed = `${draft.palette}:${draft.design_language}:${draft.intent?.density || 'compact'}`
  const generated = await generatePlannedAssets({
    draft,
    palette,
    style,
    seed,
    character: persona.character,
    log
  })
  const legacyBundle = assets.buildAssetBundle({ palette, style, seed, persona })
  const bundle = { ...legacyBundle, ...generated.byPlanPath }

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
      // A plan-produced asset wins over the legacy bundle for the same token.
      const planned = generated.byToken[tokenName]
      if (planned) {
        tokens[tokenName] = planned.dataUri
        assetFiles.push({ path: planned.path, bytes: planned.bytes })
        continue
      }
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
  //
  // Slot styles may reference a theme asset. At design time that reference is a
  // `var(--hns-asset-*)` token so the plans stay declarative; here it is resolved
  // to the compiled value, because a renderer treats a slot's `asset` property as
  // a URL, not as a custom-property reference.
  const animation = validator.normalizeAnimation(draft.components.animation || draft.animation)
  const components = {
    theme_api_version: contract.THEME_API_VERSION,
    generated_by: compiledBy,
    slots: resolveSlotAssetReferences(draft.components.slots || {}, tokens),
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

  // ---- plans (任务 15) ----
  //
  // Every package documents its own decisions: which surfaces it writes and with
  // what permission, which overlay features are on and how strongly, and one entry
  // per asset with where it came from, whether it degraded and what the validator
  // measured. The asset entries are recorded from the *results*, not the plan, so
  // the file on disk describes the package that exists.
  const assetPlanDocument = planner.recordAssetResults(draft.asset_plan, generated.assets.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    bytes: entry.bytes,
    provenance: entry.provenance,
    degraded: entry.degraded,
    disabled: entry.disabled,
    reason: entry.reason,
    validation: entry.validation
  })))
  const surfacePlanDocument = {
    version: 1,
    generated_at: new Date().toISOString(),
    ...(draft.surface_plan || {}),
    surfaces: (draft.surface_plan?.surfaces || []).map((surface) => ({
      ...surface,
      // The compiled package is the evidence that a surface was really written.
      asset_count: assetPlanDocument.assets.filter((asset) => asset.surface === surface.surface).length
    }))
  }
  const overlayPlanDocument = {
    version: 1,
    generated_at: new Date().toISOString(),
    ...(draft.overlay_plan || {}),
    // The enforced strengths, from the compiled tokens, are what the renderer
    // will actually use; the plan's own numbers are kept for comparison.
    compiled: {
      tint_opacity: Number(tokens['official.tint.opacity']) || 0,
      vignette_opacity: Number(tokens['official.vignette.opacity']) || 0,
      scanline_opacity: Number(tokens['official.scanline.opacity']) || 0,
      frame_glow_opacity: Number(tokens['official.frame_glow.opacity']) || 0,
      texture_opacity: Number(tokens['official.texture.opacity']) || 0,
      character_opacity: Number(tokens['official.character.opacity']) || 0,
      character_coverage: Number(tokens['official.character.coverage']) || 0
    }
  }
  const degradation = {
    degraded: generated.degraded.length > 0,
    disabled: generated.disabled.map((entry) => ({ kind: entry.kind, surface: entry.surface, reason: entry.reason })),
    degraded_assets: generated.degraded.map((entry) => ({ kind: entry.kind, surface: entry.surface, provenance: entry.provenance })),
    warnings: generated.warnings.slice(),
    image_generator: generated.generator ? generated.generator.describe() : { imageGenerator: false }
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
    writeJson(path.join(root, 'surface-plan.json'), surfacePlanDocument)
    writeJson(path.join(root, 'overlay-plan.json'), overlayPlanDocument)
    writeJson(path.join(root, 'asset-plan.json'), assetPlanDocument)
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
    // Per-surface previews (任务 13). They are compiled *into* the package, and
    // each one only shows the surface it names, so a user can judge the official
    // overlay without having to reason about the dock.
    const previewAssets = {}
    for (const [tokenName, value] of Object.entries(tokens)) {
      if (!isDataUri(value)) continue
      const key = tokenName.replace(/^asset\./, '')
      previewAssets[key] = value
    }
    for (const [file, data] of Object.entries(buildSurfacePreviews({
      name: manifest.name,
      mode: draft.mode,
      tokens,
      components,
      persona: personaDocument,
      surfacePlan: surfacePlanDocument,
      overlayPlan: overlayPlanDocument,
      assetPlan: assetPlanDocument,
      previewAssets
    }))) {
      writeFile(path.join(root, 'preview', file), data)
    }
    writeFile(path.join(root, 'README.md'), [
      `# ${manifest.name}`,
      '',
      `- id: \`${manifest.id}\``,
      `- source: \`${manifest.source}\``,
      `- theme_api_version: \`${manifest.theme_api_version}\``,
      `- design_language: \`${manifest.design_language}\``,
      `- palette: \`${manifest.palette}\``,
      `- generated from prompt: ${manifest.generated_prompt ? `\`${manifest.generated_prompt}\`` : '_not recorded_'}`,
      `- surfaces: ${(surfacePlanDocument.surfaces || []).filter((surface) => surface.writes).map((surface) => surface.surface).join(', ') || 'none'}`,
      `- assets: ${assetPlanDocument.count} planned, ${assetPlanDocument.assets.filter((asset) => asset.disabled).length} disabled`,
      '',
      'This package is self-contained: it has no runtime dependency on any other theme.',
      '`derived_from` is historical metadata only and never participates in asset resolution.',
      'The official renderer is never written by this package: `surface-plan.json` records it as protected.',
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
  const report = validator.validatePackage({ dir: root, darkTokens, expectedId: id, surfacePlan: surfacePlanDocument, overlayPlan: overlayPlanDocument })
  if (!report.ok) {
    return { ok: false, reason: 'validation_failed', issues: report.issues, dir: root, manifest }
  }
  if (degradation.warnings.length) {
    log(`theme ${id} built with ${degradation.warnings.length} asset warning(s)`)
  }

  return {
    ok: true,
    dir: root,
    manifest,
    tokens,
    components,
    persona: personaDocument,
    validation: report,
    assets: Object.keys(bundle),
    asset_plan: assetPlanDocument,
    surface_plan: surfacePlanDocument,
    overlay_plan: overlayPlanDocument,
    degradation
  }
}

/** Count the slots a compiled package actually writes. */
function countSlots(components) {
  return components && components.slots ? Object.keys(components.slots).length : 0
}

module.exports = {
  ASSET_LAYOUT,
  TOKEN_ASSET_MAP,
  PLAN_TOKEN_MAP,
  buildPackage,
  buildPreviewHtml,
  buildPreviewPng,
  buildSurfacePreviews,
  generatePlannedAssets,
  resolveSlotAssetReferences,
  countSlots,
  escapeHtml
}
