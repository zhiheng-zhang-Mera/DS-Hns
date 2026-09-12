'use strict'

/**
 * Procedural theme asset factory.
 *
 * A generated theme must be *self-contained* (engineering spec §11): wallpapers,
 * panel textures, personas, decorations and icons are all compiled into the
 * theme's own `assets/` tree. To keep a theme build deterministic and free of
 * external downloads, every asset here is synthesized from the theme palette.
 *
 * All generators are pure functions of (palette, style, seed), so re-running a
 * build for the same design intent produces byte-identical assets.
 */
const path = require('node:path')
const png = require('./png')
const color = require('./color')

/** Deterministic 32-bit RNG (mulberry32) so a seed always renders the same. */
function rngFrom(seed) {
  let state = 0
  const text = String(seed || 'hns')
  for (let index = 0; index < text.length; index += 1) {
    state = (state * 31 + text.charCodeAt(index)) >>> 0
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rgba(value, fallback) {
  const parsed = color.parseColor(value) || color.parseColor(fallback) || { r: 128, g: 128, b: 128, a: 1 }
  return { r: parsed.r, g: parsed.g, b: parsed.b }
}

/** Smooth 0..1 ramp. */
function smoothstep(edge0, edge1, x) {
  const t = color.clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Normalized palette the generators consume. */
function normalizePalette(palette = {}) {
  const base = rgba(palette.base, '#0f1115')
  const layer1 = rgba(palette.layer1 || palette.bgLayer1, '#151922')
  const layer2 = rgba(palette.layer2 || palette.bgLayer2, '#1b2130')
  const accent = rgba(palette.accent, '#4d93f8')
  const accent2 = rgba(palette.accentSecondary || palette.accent2, '#7aa7ff')
  const label = rgba(palette.label, '#e8ecf3')
  const state = palette.state && typeof palette.state === 'object' ? palette.state : {}
  return { base, layer1, layer2, accent, accent2, label, state }
}

/**
 * Wallpaper: layered vertical gradient + two accent glows + technical grid +
 * vignette. `style` shifts the structure rather than just the hue:
 *   research / station : dense grid, cold glows (default)
 *   cyber / hud        : scanlines, brighter rim light
 *   minimal            : no grid, single soft glow
 *   organic / anime    : soft blobs, no grid
 */
function renderWallpaper({ palette, style = 'research', width = 960, height = 600, seed = 'wallpaper' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const random = rngFrom(`${seed}:${style}`)
  const tag = String(style || '').toLowerCase()
  const minimal = /minimal|neutral|plain/.test(tag)
  const cyber = /cyber|hud|neon|tech/.test(tag)
  const organic = /organic|anime|soft|persona/.test(tag)

  const glows = organic
    ? [
        { x: 0.24, y: 0.3, radius: 0.62, color: colors.accent, alpha: 0.24 },
        { x: 0.78, y: 0.68, radius: 0.55, color: colors.accent2, alpha: 0.2 },
        { x: 0.55, y: 0.15, radius: 0.4, color: colors.layer2, alpha: 0.3 }
      ]
    : [
        { x: 0.18, y: 0.16, radius: 0.6, color: colors.accent, alpha: cyber ? 0.3 : 0.2 },
        { x: 0.86, y: 0.82, radius: 0.55, color: colors.accent2, alpha: cyber ? 0.26 : 0.16 }
      ]

  const top = color.toHex(color.shade(colors.layer1, 0.04) || colors.layer1)
  const bottom = color.toHex(color.shade(colors.base, -0.03) || colors.base)
  const topRgb = rgba(top)
  const bottomRgb = rgba(bottom)
  const gridRgb = rgba(color.toHex(color.shade(colors.label, -0.25) || colors.label))
  const gridSize = Math.max(18, Math.round(width / 34))

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1)
    const curved = Math.pow(v, 0.86)
    const rowColor = {
      r: topRgb.r + (bottomRgb.r - topRgb.r) * curved,
      g: topRgb.g + (bottomRgb.g - topRgb.g) * curved,
      b: topRgb.b + (bottomRgb.b - topRgb.b) * curved
    }
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1)
      // vignette
      const centeredX = (u - 0.5) * 2
      const centeredY = (v - 0.5) * 2
      const radial = Math.sqrt(centeredX * centeredX + centeredY * centeredY)
      const vignette = 1 - 0.34 * smoothstep(0.45, 1.35, radial)
      png.blendPixel(canvas, x, y, rowColor, 1)
      if (vignette < 1) png.blendPixel(canvas, x, y, { r: 0, g: 0, b: 0 }, (1 - vignette) * 0.8)
    }
  }

  // accent glows
  for (const glow of glows) {
    const cx = glow.x * width
    const cy = glow.y * height
    const radius = glow.radius * Math.max(width, height) * 0.5
    const minX = Math.max(0, Math.floor(cx - radius))
    const maxX = Math.min(width - 1, Math.ceil(cx + radius))
    const minY = Math.max(0, Math.floor(cy - radius))
    const maxY = Math.min(height - 1, Math.ceil(cy + radius))
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - cx
        const dy = y - cy
        const distance = Math.sqrt(dx * dx + dy * dy) / radius
        if (distance >= 1) continue
        const falloff = Math.pow(1 - distance, 2.4)
        png.blendPixel(canvas, x, y, glow.color, falloff * glow.alpha)
      }
    }
  }

  // structure layer
  if (!minimal && !organic) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const onGrid = x % gridSize === 0 || y % gridSize === 0
        if (onGrid) {
          const fade = 0.05 * (1 - Math.abs(y / height - 0.5))
          png.blendPixel(canvas, x, y, gridRgb, Math.max(0.006, fade * 0.35))
        }
      }
    }
  }
  if (cyber) {
    const scanRgb = colors.accent
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 1) png.blendPixel(canvas, x, y, scanRgb, 0.045)
    }
    // rim light
    for (let y = 0; y < height; y += 1) {
      const edge = 1 - smoothstep(0, 0.06, Math.min(1, y / height))
      if (edge > 0) {
        for (let x = 0; x < width; x += 1) png.blendPixel(canvas, x, y, colors.accent, edge * 0.08)
      }
    }
  }
  if (organic) {
    for (let index = 0; index < 14; index += 1) {
      const cx = random() * width
      const cy = random() * height
      const radius = (0.04 + random() * 0.1) * width
      const tint = random() > 0.5 ? colors.accent : colors.accent2
      for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y += 1) {
        for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x += 1) {
          const dx = x - cx
          const dy = y - cy
          const distance = Math.sqrt(dx * dx + dy * dy) / radius
          if (distance >= 1) continue
          png.blendPixel(canvas, x, y, tint, Math.pow(1 - distance, 2) * 0.12)
        }
      }
    }
  }

  return canvas
}

/** Panel texture: near-flat surface with a faint diagonal weave + noise. */
function renderPanel({ palette, width = 320, height = 128, seed = 'panel', weave = 0.05 }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const random = rngFrom(seed)
  const base = color.toHex(color.shade(colors.layer1, -0.015) || colors.layer1)
  const baseRgb = rgba(base)
  const accentRgb = colors.accent
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const weaveAlpha = ((x + y) % 8 === 0 ? 1 : 0) * weave
      png.blendPixel(canvas, x, y, baseRgb, 1)
      if (weaveAlpha > 0) png.blendPixel(canvas, x, y, accentRgb, weaveAlpha * 0.35)
      const noise = (random() - 0.5) * 0.016
      if (noise !== 0) png.blendPixel(canvas, x, y, noise > 0 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }, Math.abs(noise))
    }
  }
  return canvas
}

/**
 * Persona avatar: lightweight, HNS-legal (small operator/status avatar). Drawn
 * as an abstract portrait — head, hair mass, visor band, shoulders — tinted from
 * the theme palette so it never fights the state colours.
 */
function renderPersona({ palette, style = 'silver_hair_assistant', width = 128, height = 128 }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const tag = String(style || '').toLowerCase()
  const hairLight = /silver|white|platinum/.test(tag)
  const hair = hairLight ? rgba('#dfe6f2') : rgba(color.toHex(color.shade(colors.accent, -0.24) || '#33415c'))
  const skin = rgba('#e8d5c8')
  const cloth = rgba(color.toHex(color.shade(colors.layer2, -0.05) || colors.layer2))
  const rim = colors.accent
  const visor = /cyber|hud|android|mecha/.test(tag)

  const cx = width / 2
  const headCy = height * 0.42
  const headRx = width * 0.2
  const headRy = height * 0.235

  // shoulders / torso
  for (let y = Math.floor(height * 0.66); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (y - height * 0.66) / (height * 0.34)
      const halfWidth = width * (0.2 + 0.31 * smoothstep(0, 1, t))
      if (Math.abs(x - cx) <= halfWidth) png.blendPixel(canvas, x, y, cloth, 1)
    }
  }
  // head
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - cx) / headRx
      const dy = (y - headCy) / headRy
      if (dx * dx + dy * dy <= 1) png.blendPixel(canvas, x, y, skin, 1)
    }
  }
  // hair mass behind + above the head
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - cx) / (headRx * 1.34)
      const dy = (y - (headCy - headRy * 0.24)) / (headRy * 1.38)
      const outside = dx * dx + dy * dy > 1
      const above = y < headCy + headRy * 0.12
      if (!outside && above && y < headCy + headRy * 0.3) {
        // keep the face clear: only the outer band is hair
        const faceClear = Math.abs(x - cx) < headRx * 0.72 && y > headCy - headRy * 0.5
        if (!faceClear) png.blendPixel(canvas, x, y, hair, 1)
      }
      // side tails
      if (outside && Math.abs(dx) < 1.5 && dy > -0.4 && dy < 1.05 && Math.abs(x - cx) > headRx * 0.78) {
        png.blendPixel(canvas, x, y, hair, 0.92)
      }
    }
  }
  // face marks
  const eyeY = Math.round(headCy + headRy * 0.02)
  const eyeDx = Math.round(headRx * 0.42)
  const eyeColor = visor ? colors.accent : rgba('#31435f')
  for (const sign of [-1, 1]) {
    for (let y = -1; y <= 1; y += 1) {
      for (let x = -3; x <= 3; x += 1) {
        const px = Math.round(cx + sign * eyeDx + x)
        const py = eyeY + y
        if (x * x + y * y <= 7) png.blendPixel(canvas, px, py, eyeColor, 0.95)
      }
    }
  }
  if (visor) {
    for (let y = eyeY - 5; y <= eyeY + 5; y += 1) {
      for (let x = Math.round(cx - headRx * 1.02); x <= Math.round(cx + headRx * 1.02); x += 1) {
        const edge = Math.abs(x - cx) / (headRx * 1.02)
        png.blendPixel(canvas, x, y, colors.accent, 0.16 * (1 - edge * edge))
      }
    }
  }
  // rim light on the accent side
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (canvas.data[offset + 3] === 0) continue
      const dx = (x - cx) / headRx
      const dy = (y - headCy) / headRy
      const edge = Math.abs(Math.sqrt(Math.max(0, dx * dx + dy * dy)) - 1)
      if (edge < 0.16 && x > cx) png.blendPixel(canvas, x, y, rim, (1 - edge / 0.16) * 0.4)
    }
  }
  return canvas
}

/** Persona banner: wide, low, mostly transparent strip with an accent crest. */
function renderBanner({ palette, width = 480, height = 72, seed = 'banner' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const left = colors.accent
  const right = colors.accent2
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1)
      const fade = smoothstep(0, 0.35, u) * (1 - smoothstep(0.75, 1, u))
      const mix = color.mix(color.toHex(left), color.toHex(right), u) || '#4d93f8'
      const rgb = rgba(mix)
      png.blendPixel(canvas, x, y, rgb, 0.22 * fade)
    }
  }
  // crest: three concentric arcs on the left third
  const cx = width * 0.18
  const cy = height * 0.62
  for (let ring = 0; ring < 3; ring += 1) {
    const radius = height * (0.2 + ring * 0.14)
    for (let angle = Math.PI; angle <= Math.PI * 2; angle += 0.01) {
      const x = Math.round(cx + Math.cos(angle) * radius)
      const y = Math.round(cy + Math.sin(angle) * radius * 0.72)
      png.blendPixel(canvas, x, y, colors.accent, 0.5 - ring * 0.12)
    }
  }
  return canvas
}

/** Decoration overlay: sparse corner ornaments, safe to composite over panels. */
function renderDecoration({ palette, width = 256, height = 256, seed = 'decoration', style = 'research' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const random = rngFrom(`${seed}:${style}`)
  const tag = String(style || '').toLowerCase()
  const corner = (originX, originY, scaleX, scaleY) => {
    const rings = /cyber|hud/.test(tag) ? 4 : 3
    for (let ring = 0; ring < rings; ring += 1) {
      const radius = width * (0.16 + ring * 0.11)
      for (let step = 0; step <= 90; step += 1) {
        const angle = (step / 90) * (Math.PI / 2)
        const x = Math.round(originX + Math.cos(angle) * radius * scaleX)
        const y = Math.round(originY + Math.sin(angle) * radius * scaleY)
        png.blendPixel(canvas, x, y, colors.accent, 0.4 - ring * 0.08)
      }
    }
    for (let dot = 0; dot < 6; dot += 1) {
      const x = Math.round(originX + random() * width * 0.3 * scaleX)
      const y = Math.round(originY + random() * height * 0.3 * scaleY)
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) png.blendPixel(canvas, x + dx, y + dy, colors.accent2, 0.5)
      }
    }
  }
  corner(0, 0, 1, 1)
  corner(width, height, -1, -1)
  return canvas
}

/** Icon set sheet: a small grid of geometric glyphs used by the dock rail. */
function renderIconSheet({ palette, width = 128, height = 128, cell = 32 }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const glyphColor = colors.label
  const accent = colors.accent
  const cols = Math.floor(width / cell)
  const rows = Math.floor(height / cell)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ox = col * cell
      const oy = row * cell
      const index = row * cols + col
      const kind = index % 5
      const padding = 8
      for (let y = padding; y < cell - padding; y += 1) {
        for (let x = padding; x < cell - padding; x += 1) {
          const centerX = cell / 2
          const centerY = cell / 2
          const dx = x - centerX
          const dy = y - centerY
          let hit = false
          if (kind === 0) hit = Math.abs(dy) < 1.5 // bar
          else if (kind === 1) hit = dx * dx + dy * dy < 36 // dot
          else if (kind === 2) hit = Math.abs(Math.abs(dx) + Math.abs(dy) - 8) < 1.5 // diamond
          else if (kind === 3) hit = Math.abs(dx) < 1.5 || Math.abs(dy) < 1.5 // cross
          else hit = Math.abs(dx) + Math.abs(dy) < 9 // triangle-ish
          if (hit) png.blendPixel(canvas, ox + x, oy + y, kind === 1 ? accent : glyphColor, 0.9)
        }
      }
    }
  }
  return canvas
}

/** 32x32 tray glyph: HNS "runner" mark. */
function renderTrayIcon({ palette, size = 32 }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(size, size)
  const accent = colors.accent
  const label = colors.label
  const cx = size / 2
  const cy = size / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > size * 0.46) continue
      png.blendPixel(canvas, x, y, accent, 0.9)
    }
  }
  // three ascending bars = workers
  const bars = [
    { x: cx - 7, height: 5 },
    { x: cx - 1, height: 9 },
    { x: cx + 5, height: 13 }
  ]
  for (const bar of bars) {
    for (let y = cy + 6 - bar.height; y <= cy + 6; y += 1) {
      for (let x = bar.x; x < bar.x + 4; x += 1) png.blendPixel(canvas, Math.round(x), Math.round(y), label, 0.95)
    }
  }
  return canvas
}

/**
 * Compile a complete asset bundle for a theme package.
 *
 * @returns {object} map of package-relative path -> PNG buffer
 */
function buildAssetBundle({ palette, style, seed, persona, sizes = {} }) {
  const bundle = {}
  const wallpaper = renderWallpaper({ palette, style, seed, width: sizes.wallpaperWidth || 960, height: sizes.wallpaperHeight || 600 })
  bundle['assets/wallpapers/main.png'] = png.canvasToPng(wallpaper)
  const panel = renderPanel({ palette, seed })
  bundle['assets/panels/panel.png'] = png.canvasToPng(panel)
  bundle['assets/decorations/corners.png'] = png.canvasToPng(renderDecoration({ palette, style, seed }))
  bundle['assets/icons/set.png'] = png.canvasToPng(renderIconSheet({ palette }))
  bundle['assets/icons/tray.png'] = png.canvasToPng(renderTrayIcon({ palette }))
  if (persona && persona.enabled) {
    const avatar = renderPersona({ palette, style: persona.character || style, width: 128, height: 128 })
    bundle['assets/persona/avatar.png'] = png.canvasToPng(avatar)
    bundle['assets/persona/banner.png'] = png.canvasToPng(renderBanner({ palette }))
  }
  return bundle
}

/** Inline data URIs for the runtime (the renderer never reads from disk). */
function buildInlineAssets({ palette, style, seed, persona }) {
  const inline = {
    wallpaper: png.canvasToDataUri(renderWallpaper({ palette, style, seed })),
    overlay: png.canvasToDataUri(renderDecoration({ palette, style, seed: `${seed}:overlay` })),
    panelTexture: png.canvasToDataUri(renderPanel({ palette, seed: `${seed}:panel` })),
    iconSet: png.canvasToDataUri(renderIconSheet({ palette })),
    trayIcon: png.canvasToDataUri(renderTrayIcon({ palette }))
  }
  if (persona && persona.enabled) {
    inline.personaAvatar = png.canvasToDataUri(renderPersona({ palette, style: persona.character || style }))
    inline.personaBanner = png.canvasToDataUri(renderBanner({ palette }))
  }
  return inline
}

/** Package-relative asset path helper used by the builder. */
function assetPath(...parts) {
  return path.posix.join('assets', ...parts)
}

module.exports = {
  rngFrom,
  smoothstep,
  normalizePalette,
  renderWallpaper,
  renderPanel,
  renderPersona,
  renderBanner,
  renderDecoration,
  renderIconSheet,
  renderTrayIcon,
  buildAssetBundle,
  buildInlineAssets,
  assetPath
}
