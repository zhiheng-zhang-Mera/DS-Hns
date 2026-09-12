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

/**
 * Shade a colour and hand back canvas-ready RGB.
 *
 * `color.shade()` already returns a `#rrggbb` string (it round-trips through
 * `toHex`), so wrapping it in `toHex` again produced `#NaNNaNNaN` and silently
 * collapsed every shaded surface to the grey fallback. This helper is the single
 * correct way to get from a palette colour to a shaded RGB triple.
 */
function shadeRgb(value, amount, options) {
  // Round-trip through hex so both a CSS string and a parsed palette colour work.
  const source = color.toHex(value) || '#808080'
  const shaped = color.shade(source, amount, options)
  return rgba(shaped, source)
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
  const gridRgb = shadeRgb(colors.label, -0.25)
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
  const base = color.shade(colors.layer1, -0.015) || '#151922'
  const baseRgb = rgba(base)
  const accentRgb = colors.accent
  // Two accent values, not one: a single-colour weave quantises to a flat image,
  // and a themed panel is supposed to read as a surface *material*.
  const accentSoft = shadeRgb(colors.accent, 0.18)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const weaveAlpha = ((x + y) % 8 === 0 ? 1 : 0) * weave
      png.blendPixel(canvas, x, y, baseRgb, 1)
      if (weaveAlpha > 0) png.blendPixel(canvas, x, y, (x + y) % 16 === 0 ? accentSoft : accentRgb, weaveAlpha * 0.35)
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
  const hair = hairLight ? rgba('#dfe6f2') : shadeRgb(colors.accent, -0.24)
  const skin = rgba('#e8d5c8')
  const cloth = shadeRgb(colors.layer2, -0.05)
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

/**
 * Real character asset renderer (Update-Plan/General-Theme.md 任务 5).
 *
 * This is a genuine figure drawn as alpha-composited layers — silhouette, hair
 * mass, torso, limbs, rim light, accent details — and *not* the abstract badge
 * `renderPersona` produces. The five required framings are supported:
 *
 *   avatar     head + shoulders, square, used for compact portraits
 *   bust       head + chest, portrait aspect
 *   half_body  head down to the hips, portrait aspect (the workhorse)
 *   full_body  the whole figure, tall portrait
 *   silhouette pure dark shape, no interior detail, used as a background figure
 *
 * Every pixel outside the figure keeps alpha 0, because a character is placed
 * over the official renderer (or the HNS dock) and must never paint a rectangle.
 *
 * `anchor` / `facing` / `styleTag` change the *pose and read*, not just the hue,
 * so "银发机械助手，半身，右下角" produces a visibly different asset from a
 * generic avatar: the framing comes from the declared asset kind, and the hair/
 * visor treatment comes from the character vocabulary.
 */
function renderCharacter({
  palette,
  framing = 'half_body',
  character = 'operator_assistant',
  style = 'research',
  width = null,
  height = null,
  seed = 'character',
  facing = 'left',
  silhouette = false
}) {
  const colors = normalizePalette(palette)
  const frame = String(framing || 'half_body').toLowerCase()
  const tag = String(character || '').toLowerCase()
  const styleTag = `${String(style || '').toLowerCase()} ${tag}`

  const portraits = {
    avatar: { width: 256, height: 256, coverage: 'head' },
    bust: { width: 384, height: 512, coverage: 'chest' },
    half_body: { width: 512, height: 768, coverage: 'hips' },
    full_body: { width: 512, height: 1024, coverage: 'feet' }
  }
  const spec = portraits[frame] || portraits.half_body
  const w = Math.max(64, Math.round(Number(width) || spec.width))
  const h = Math.max(64, Math.round(Number(height) || spec.height))
  const canvas = png.createCanvas(w, h)
  const random = rngFrom(`${seed}:${frame}:${tag}`)

  const robot = /android|mecha|robot|droid|machine|机械/.test(styleTag)
  const silverHair = /silver|white|platinum|银|white_hair/.test(styleTag)
  const anime = /anime|manga|persona|girl|boy|二次元|动漫/.test(styleTag)
  const light = color.isLight(palette?.label || '#e8ecf3')

  // Layer colours. A silhouette keeps only the deepest value so the figure reads
  // as a shape and can sit behind content without competing with it.
  const shade = (value, amount) => shadeRgb(value, amount)
  const outline = silhouette
    ? { r: 6, g: 8, b: 12 }
    : shade(colors.base, light ? -0.22 : -0.3)
  const cloth = silhouette ? outline : shade(colors.layer2, -0.06)
  const clothDark = silhouette ? outline : shade(colors.layer2, -0.16)
  const clothLight = silhouette ? outline : shade(colors.layer2, 0.1)
  const skin = silhouette ? outline : rgba(robot ? '#c9d3e2' : '#ecd8c9')
  const skinShade = silhouette ? outline : rgba(robot ? '#9fb0c6' : '#d5bcab')
  const hair = silhouette ? outline : rgba(silverHair ? '#e6ecf6' : (robot ? '#c2ccdb' : '#3b3f52'))
  const hairShade = silhouette ? outline : rgba(silverHair ? '#b9c4d6' : '#2a2e3d')
  const rim = silhouette ? outline : colors.accent
  const detail = silhouette ? outline : colors.accent2
  const visor = !silhouette && (robot || /cyber|hud|neon/.test(styleTag))

  // ---- geometry -----------------------------------------------------------
  // Vertical proportions are expressed as fractions of the *figure*, then mapped
  // into the requested crop, so a half body is the bust block enlarged rather
  // than a squashed full body.
  const crops = {
    head: { top: 0.16, bottom: 0.98, scale: 1 },
    chest: { top: 0.08, bottom: 0.99, scale: 1.08 },
    hips: { top: 0.04, bottom: 0.99, scale: 1.02 },
    feet: { top: 0.02, bottom: 0.99, scale: 1 }
  }
  const crop = crops[spec.coverage]
  // Figure occupies the middle 84% of the width: the remaining margin is what
  // keeps the silhouette from being clipped when the layout engine scales it.
  const figureHeight = h * (crop.bottom - crop.top)
  const unit = Math.min(w * 0.84, figureHeight * 0.30) // head height
  const cx = w * (facing === 'right' ? 0.46 : 0.54)
  const headCy = h * crop.top + unit * 0.58
  const headRx = unit * 0.42
  const headRy = unit * 0.52

  const ellipse = (ox, oy, rx, ry, colorRgb, alpha = 1) => {
    const minX = Math.max(0, Math.floor(ox - rx))
    const maxX = Math.min(w - 1, Math.ceil(ox + rx))
    const minY = Math.max(0, Math.floor(oy - ry))
    const maxY = Math.min(h - 1, Math.ceil(oy + ry))
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = (x - ox) / rx
        const dy = (y - oy) / ry
        if (dx * dx + dy * dy <= 1) png.blendPixel(canvas, x, y, colorRgb, alpha)
      }
    }
  }
  const capsule = (x0, y0, x1, y1, radius, colorRgb, alpha = 1) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps
      ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, radius, colorRgb, alpha)
    }
  }
  const band = (y0, y1, halfWidth, colorRgb, alpha = 1) => {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y += 1) {
      const t = (y - y0) / Math.max(1, y1 - y0)
      const bw = typeof halfWidth === 'function' ? halfWidth(t, y) : halfWidth
      for (let x = Math.max(0, Math.floor(cx - bw)); x <= Math.min(w - 1, Math.ceil(cx + bw)); x += 1) {
        png.blendPixel(canvas, x, y, colorRgb, alpha)
      }
    }
  }
  const polygon = (points, colorRgb, alpha = 1) => {
    if (!points.length) return
    const ys = points.map((point) => point[1])
    const minY = Math.max(0, Math.floor(Math.min(...ys)))
    const maxY = Math.min(h - 1, Math.ceil(Math.max(...ys)))
    for (let y = minY; y <= maxY; y += 1) {
      const crossings = []
      for (let index = 0; index < points.length; index += 1) {
        const [ax, ay] = points[index]
        const [bx, by] = points[(index + 1) % points.length]
        if ((ay <= y && by > y) || (by <= y && ay > y)) {
          crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
        }
      }
      crossings.sort((a, b) => a - b)
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        for (let x = Math.max(0, Math.floor(crossings[index])); x <= Math.min(w - 1, Math.ceil(crossings[index + 1])); x += 1) {
          png.blendPixel(canvas, x, y, colorRgb, alpha)
        }
      }
    }
  }

  // ---- hair mass behind the head (drawn first, so the face sits on top) ----
  const hairWidth = headRx * (anime ? 1.9 : 1.5)
  const hairLength = unit * (anime ? 1.55 : 0.85)
  polygon([
    [cx - hairWidth, headCy - headRy * 0.9],
    [cx + hairWidth, headCy - headRy * 0.9],
    [cx + hairWidth * 0.92, headCy + hairLength],
    [cx + headRx * 0.4, headCy + hairLength * 1.08],
    [cx - headRx * 0.5, headCy + hairLength * 0.98],
    [cx - hairWidth * 0.98, headCy + hairLength * 0.86]
  ], hairShade)

  // ---- torso: shoulders -> hips, tapered, with a collar notch ----
  const shoulderY = headCy + headRy * 1.16
  const torsoBottom = spec.coverage === 'head' ? shoulderY + unit * 0.5 : h * crop.bottom
  const shoulderHalf = unit * (robot ? 0.98 : 0.82)
  const waistHalf = unit * 0.56
  band(shoulderY, torsoBottom, (t) => shoulderHalf + (waistHalf - shoulderHalf) * Math.pow(t, 0.72), cloth)
  // chest plane reads as cloth, the shoulder caps catch the light
  band(shoulderY + (torsoBottom - shoulderY) * 0.06, shoulderY + (torsoBottom - shoulderY) * 0.34, (t) => shoulderHalf * (0.96 - t * 0.2), clothLight, 0.35)
  ellipse(cx - shoulderHalf * 0.86, shoulderY + unit * 0.06, unit * 0.2, unit * 0.17, clothLight, 0.85)
  ellipse(cx + shoulderHalf * 0.86, shoulderY + unit * 0.06, unit * 0.2, unit * 0.17, clothLight, 0.85)

  if (spec.coverage === 'hips' || spec.coverage === 'feet') {
    // Arms hang beside the torso; a mechanical character gets visibly jointed
    // segments so the "机械" part of the prompt is actually visible.
    const armTop = shoulderY + unit * 0.12
    const armBottom = spec.coverage === 'feet' ? h * 0.62 : torsoBottom - unit * 0.1
    for (const sign of [-1, 1]) {
      const x = cx + sign * (shoulderHalf * 0.92)
      capsule(x, armTop, x + sign * unit * 0.1, armBottom, unit * 0.135, clothDark)
      if (robot) {
        capsule(x + sign * unit * 0.06, armTop + unit * 0.34, x + sign * unit * 0.12, armBottom - unit * 0.24, unit * 0.16, clothLight, 0.55)
      }
      capsule(x + sign * unit * 0.1, armBottom, x + sign * unit * 0.12, armBottom + unit * 0.16, unit * 0.11, skin, 1)
    }
  }

  if (spec.coverage === 'feet') {
    const legTop = h * 0.60
    for (const sign of [-1, 1]) {
      capsule(cx + sign * waistHalf * 0.5, legTop, cx + sign * waistHalf * 0.62, h * 0.93, unit * 0.15, clothDark)
      capsule(cx + sign * waistHalf * 0.62, h * 0.9, cx + sign * waistHalf * 0.7, h * 0.97, unit * 0.09, shade(colors.base, -0.4))
    }
  }

  // ---- head ----
  ellipse(cx, headCy, headRx, headRy, skin)
  // jaw taper: shave the lower corners so the head is not a pure ellipse
  for (let y = Math.floor(headCy + headRy * 0.3); y <= Math.ceil(headCy + headRy); y += 1) {
    const t = (y - (headCy + headRy * 0.3)) / (headRy * 0.7)
    const cut = headRx * (0.98 - 0.42 * t * t)
    for (let x = 0; x < w; x += 1) {
      const dx = Math.abs(x - cx)
      if (dx > cut && dx <= headRx * 1.02) {
        const offset = (y * w + x) * 4
        if (canvas.data[offset + 3] > 0 && dx * dx + ((y - headCy) / headRy) ** 2 <= 1) {
          canvas.data[offset] = 0
          canvas.data[offset + 1] = 0
          canvas.data[offset + 2] = 0
          canvas.data[offset + 3] = 0
        }
      }
    }
  }
  // neck
  band(headCy + headRy * 0.7, shoulderY + unit * 0.1, headRx * 0.42, skinShade)

  // ---- face ----
  if (!silhouette && spec.coverage !== 'feet') {
    const eyeY = Math.round(headCy + headRy * 0.06)
    const eyeDx = Math.round(headRx * 0.44)
    const eyeColor = visor ? colors.accent : rgba('#2c3a52')
    for (const sign of [-1, 1]) {
      const eyeX = Math.round(cx + sign * eyeDx)
      if (anime) {
        // tall almond eye, the anime read
        ellipse(eyeX, eyeY, headRx * 0.15, headRy * 0.2, eyeColor, 0.96)
        ellipse(eyeX, eyeY - headRy * 0.07, headRx * 0.06, headRy * 0.07, rgba('#ffffff'), 0.85)
      } else {
        ellipse(eyeX, eyeY, headRx * 0.12, headRy * 0.06, eyeColor, 0.94)
      }
    }
    // brows
    for (const sign of [-1, 1]) {
      capsule(
        cx + sign * eyeDx - headRx * 0.12,
        eyeY - headRy * 0.3,
        cx + sign * eyeDx + headRx * 0.12,
        eyeY - headRy * 0.34,
        Math.max(1, headRy * 0.03),
        hairShade,
        0.8
      )
    }
    // mouth
    capsule(cx - headRx * 0.12, headCy + headRy * 0.52, cx + headRx * 0.12, headCy + headRy * 0.52, Math.max(1, headRy * 0.025), skinShade, 0.9)
  }

  // ---- hair front / fringe ----
  if (!silhouette) {
    const fringeDepth = headRy * (anime ? 0.62 : 0.42)
    polygon([
      [cx - headRx * 1.06, headCy - headRy * 0.18],
      [cx - headRx * 1.02, headCy - headRy * 0.92],
      [cx + headRx * 1.02, headCy - headRy * 0.92],
      [cx + headRx * 1.06, headCy - headRy * 0.1],
      [cx + headRx * 0.44, headCy - headRy * 0.34],
      [cx + headRx * 0.1, headCy + fringeDepth * 0.36],
      [cx - headRx * 0.34, headCy - headRy * 0.28]
    ], hair)
    // side locks, longer on the facing-away side
    for (const sign of [-1, 1]) {
      const length = sign === (facing === 'right' ? -1 : 1) ? unit * 0.95 : unit * 0.6
      capsule(cx + sign * headRx * 0.98, headCy - headRy * 0.2, cx + sign * headRx * 1.04, headCy + length, headRx * 0.2, hairShade, 0.95)
    }
    if (silverHair) {
      // highlight band: the "银发" read comes from a bright specular stripe
      capsule(cx - headRx * 0.7, headCy - headRy * 0.66, cx + headRx * 0.5, headCy - headRy * 0.74, Math.max(1, headRy * 0.06), rgba('#ffffff'), 0.5)
    }
  }

  // ---- mechanical / visor detail ----
  if (visor) {
    const visorY = headCy + headRy * 0.04
    polygon([
      [cx - headRx * 1.04, visorY - headRy * 0.2],
      [cx + headRx * 1.04, visorY - headRy * 0.26],
      [cx + headRx * 1.02, visorY + headRy * 0.18],
      [cx - headRx * 1.02, visorY + headRy * 0.24]
    ], colors.accent, 0.42)
    capsule(cx - headRx * 1.0, visorY + headRy * 0.2, cx + headRx * 1.0, visorY + headRy * 0.16, Math.max(1, headRy * 0.035), detail, 0.75)
  }
  if (robot && !silhouette) {
    // ear units + a chest core
    for (const sign of [-1, 1]) ellipse(cx + sign * headRx * 1.06, headCy + headRy * 0.05, headRx * 0.16, headRy * 0.22, detail, 0.85)
    ellipse(cx, shoulderY + unit * 0.42, unit * 0.11, unit * 0.11, colors.accent, 0.9)
    ellipse(cx, shoulderY + unit * 0.42, unit * 0.06, unit * 0.06, rgba('#ffffff'), 0.7)
  }
  if (!silhouette) {
    // belt / seam so the figure is not a flat slab
    capsule(cx - waistHalf * 0.9, shoulderY + (torsoBottom - shoulderY) * 0.78, cx + waistHalf * 0.9, shoulderY + (torsoBottom - shoulderY) * 0.78, Math.max(1, unit * 0.03), detail, 0.5)
  }

  // ---- rim light along the light side ----
  if (!silhouette) {
    for (let y = 0; y < h; y += 1) {
      let firstSolid = -1
      let lastSolid = -1
      for (let x = 0; x < w; x += 1) {
        if (canvas.data[(y * w + x) * 4 + 3] > 8) {
          if (firstSolid < 0) firstSolid = x
          lastSolid = x
        }
      }
      if (firstSolid < 0) continue
      const edgeX = facing === 'right' ? firstSolid : lastSolid
      const direction = facing === 'right' ? 1 : -1
      for (let step = 0; step < 4; step += 1) {
        const x = edgeX + direction * step
        if (x < 0 || x >= w) break
        if (canvas.data[(y * w + x) * 4 + 3] <= 8) break
        png.blendPixel(canvas, x, y, rim, 0.4 * (1 - step / 4))
        png.blendPixel(canvas, x, y, rim, 0.18 * (1 - step / 4))
      }
    }
    // a couple of drifting accents so the figure is not perfectly symmetric
    for (let index = 0; index < 8; index += 1) {
      const px = Math.round(cx + (random() - 0.5) * unit * 2.4)
      const py = Math.round(headCy + random() * (torsoBottom - headCy))
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      if (canvas.data[(py * w + px) * 4 + 3] === 0) continue
      png.blendPixel(canvas, px, py, detail, 0.22)
    }
  }

  return canvas
}

/**
 * Official skin: the re-skin of the official renderer's *frame*. Drawn as a
 * transparent-edged plate with a corner treatment and a faint centre wash, so
 * the official content underneath stays readable (Update-Plan 任务 6).
 */
function renderOfficialSkin({ palette, style = 'research', width = 1280, height = 800, seed = 'skin' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const random = rngFrom(`${seed}:skin`)
  const tag = String(style || '').toLowerCase()
  const cyber = /cyber|hud|neon|tech/.test(tag)
  const minimal = /minimal|neutral|plain/.test(tag)

  const dark = shadeRgb(colors.base, -0.03)
  const edge = Math.max(6, Math.round(Math.min(width, height) * 0.05))
  const thin = Math.max(1, Math.round(Math.min(width, height) * 0.004))

  // Frame band: opaque enough to read as a skin, but only along the edges.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const edgeDistance = Math.min(x, y, width - 1 - x, height - 1 - y)
      if (edgeDistance > edge) continue
      const t = 1 - edgeDistance / edge
      const alpha = Math.pow(t, 0.8) * (minimal ? 0.5 : 0.72)
      png.blendPixel(canvas, x, y, dark, alpha)
      const accentLine = edgeDistance <= thin * 2
      if (accentLine && !minimal) png.blendPixel(canvas, x, y, colors.accent, 0.42 * t)
      if (cyber && edgeDistance % 4 === 0 && edgeDistance <= edge * 0.5) {
        png.blendPixel(canvas, x, y, colors.accent2, 0.16 * t)
      }
    }
  }
  // centre wash: a very light gradient, never enough to fight the content
  const wash = minimal ? 0.05 : 0.11
  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1)
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1)
      const radial = Math.hypot(u - 0.5, v - 0.55) / 0.72
      const falloff = Math.max(0, 1 - radial)
      if (falloff <= 0) continue
      png.blendPixel(canvas, x, y, colors.layer2, falloff * wash)
    }
  }
  // corner brackets
  const bracket = Math.round(Math.min(width, height) * 0.11)
  const drawBracket = (ox, oy, sx, sy) => {
    for (let step = 0; step <= bracket; step += 1) {
      png.blendPixel(canvas, ox + sx * step, oy, colors.accent, 0.6)
      png.blendPixel(canvas, ox + sx * step, oy + sy, colors.accent, 0.3)
      png.blendPixel(canvas, ox, oy + sy * step, colors.accent, 0.6)
      png.blendPixel(canvas, ox + sx, oy + sy * step, colors.accent, 0.3)
    }
  }
  drawBracket(thin * 3, thin * 3, 1, 1)
  drawBracket(width - 1 - thin * 3, thin * 3, -1, 1)
  drawBracket(thin * 3, height - 1 - thin * 3, 1, -1)
  drawBracket(width - 1 - thin * 3, height - 1 - thin * 3, -1, -1)
  if (cyber) {
    for (let index = 0; index < 24; index += 1) {
      const px = Math.round(random() * width)
      const py = Math.round(thin * 3 + random() * bracket)
      png.blendPixel(canvas, px, py, colors.accent2, 0.35)
    }
  }
  return canvas
}

/** Overlay texture: a tileable pattern the overlay paints at low opacity. */
function renderOverlayTexture({ palette, style = 'research', width = 512, height = 512, seed = 'texture' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const random = rngFrom(`${seed}:texture`)
  const tag = String(style || '').toLowerCase()
  const cyber = /cyber|hud|neon|tech/.test(tag)
  const grid = Math.max(24, Math.round(width / 16))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const noise = (random() - 0.5) * 0.1
      if (noise > 0) png.blendPixel(canvas, x, y, colors.label, noise * 0.5)
      else png.blendPixel(canvas, x, y, { r: 0, g: 0, b: 0 }, -noise * 0.5)
      if (x % grid === 0 || y % grid === 0) png.blendPixel(canvas, x, y, colors.accent, 0.14)
      if (cyber && y % 3 === 0) png.blendPixel(canvas, x, y, colors.accent2, 0.05)
    }
  }
  // weave: diagonal highlight so the texture is visible at low opacity
  for (let index = -height; index < width; index += 12) {
    for (let y = 0; y < height; y += 1) {
      const x = index + y
      if (x < 0 || x >= width) continue
      png.blendPixel(canvas, x, y, colors.accent, 0.06)
    }
  }
  return canvas
}

/** HUD decoration: a corner-anchored bracket cluster, transparent elsewhere. */
function renderHudDecoration({ palette, style = 'research', width = 512, height = 512, seed = 'hud' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const tag = String(style || '').toLowerCase()
  const heavy = /cyber|hud|neon|industrial|console/.test(tag)
  const arm = width * (heavy ? 0.42 : 0.32)
  const thickness = Math.max(2, Math.round(width * 0.008))
  // Two accent values so the ornament reads as a drawn bracket rather than a
  // single flat glyph (and so a quantised colour count sees real structure).
  const outer = colors.accent
  const inner = shadeRgb(colors.accent, 0.22)
  const segment = (x0, y0, x1, y1, alpha, colorRgb = outer) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)))
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps
      const px = Math.round(x0 + (x1 - x0) * t)
      const py = Math.round(y0 + (y1 - y0) * t)
      for (let dy = 0; dy < thickness; dy += 1) {
        for (let dx = 0; dx < thickness; dx += 1) {
          png.blendPixel(canvas, px + dx, py + dy, colorRgb, alpha)
        }
      }
    }
  }
  segment(0, 0, arm, 0, 0.85)
  segment(0, 0, 0, arm, 0.85)
  segment(0, arm * 0.6, arm * 0.6, arm * 0.6, 0.4, inner)
  segment(arm * 0.6, 0, arm * 0.6, arm * 0.6, 0.4, inner)
  if (heavy) {
    segment(arm * 0.18, arm * 0.18, arm * 0.75, arm * 0.18, 0.3, inner)
    segment(arm * 0.18, arm * 0.18, arm * 0.18, arm * 0.75, 0.3, inner)
    for (let index = 0; index < 10; index += 1) {
      const px = Math.round(arm * 0.9 + index * (width * 0.02))
      png.blendPixel(canvas, px, Math.round(arm * 0.2), colors.accent2, 0.6)
    }
  }
  return canvas
}

/**
 * Frame decoration for the official shell: a full-frame border with bracket and
 * rule details, transparent in the middle so the official view is untouched.
 */
function renderFrameDecoration({ palette, style = 'research', width = 1280, height = 800, seed = 'frame' }) {
  const colors = normalizePalette(palette)
  const canvas = png.createCanvas(width, height)
  const tag = String(style || '').toLowerCase()
  const cyber = /cyber|hud|neon|tech/.test(tag)
  const thickness = Math.max(2, Math.round(Math.min(width, height) * 0.005))
  // A second, softer accent for the inner lip, so the frame is a drawn moulding
  // rather than one flat stroke.
  const inner = shadeRgb(colors.accent2, -0.1)
  for (let x = 0; x < width; x += 1) {
    for (let d = 0; d < thickness; d += 1) {
      png.blendPixel(canvas, x, d, colors.accent, 0.7 - d / thickness * 0.4)
      png.blendPixel(canvas, x, height - 1 - d, colors.accent, 0.7 - d / thickness * 0.4)
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let d = 0; d < thickness; d += 1) {
      png.blendPixel(canvas, d, y, colors.accent, 0.55 - d / thickness * 0.3)
      png.blendPixel(canvas, width - 1 - d, y, colors.accent, 0.55 - d / thickness * 0.3)
    }
  }
  for (let x = 0; x < width; x += 1) {
    png.blendPixel(canvas, x, thickness, inner, 0.4)
    png.blendPixel(canvas, x, height - 1 - thickness, inner, 0.4)
  }
  for (let y = 0; y < height; y += 1) {
    png.blendPixel(canvas, thickness, y, inner, 0.32)
    png.blendPixel(canvas, width - 1 - thickness, y, inner, 0.32)
  }
  if (cyber) {
    for (let x = 0; x < width; x += 8) {
      png.blendPixel(canvas, x, 0, colors.accent2, 0.5)
      png.blendPixel(canvas, x, height - 1, colors.accent2, 0.5)
    }
  }
  return canvas
}

/** Icon set sheet: a small grid of geometric glyphs used by the dock rail. */function renderIconSheet({ palette, width = 128, height = 128, cell = 32 }) {
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

/**
 * Asset kind vocabulary (Update-Plan 任务 5 + 任务 6).
 *
 * Every entry is the *specification* of one real, placeable asset: what surface
 * it targets, the framing/framing-independent size, whether it must carry real
 * transparency, which layout mode places it, and a prompt fragment the image
 * generator receives. The planner consumes this table and nothing else, so a new
 * asset kind is added here and is immediately plannable, generatable, placeable
 * and previewable.
 */
const REAL_ASSET_CATALOG = Object.freeze({
  wallpaper: {
    kind: 'wallpaper',
    label: 'Wallpaper',
    surface: 'hns_native',
    framing: 'background',
    width: 1440,
    height: 900,
    transparent: false,
    layout: 'background',
    anchor: 'center',
    requiresCharacter: false,
    prompt: 'full-bleed abstract wallpaper in the theme palette, no text, no watermark'
  },
  official_skin: {
    kind: 'official_skin',
    label: 'Official Skin',
    surface: 'official_overlay',
    framing: 'plate',
    width: 1600,
    height: 1000,
    transparent: true,
    layout: 'framed',
    anchor: 'center',
    requiresCharacter: false,
    prompt: 'edge and frame skin for an application window, transparent centre, no text'
  },
  official_overlay_texture: {
    kind: 'official_overlay_texture',
    label: 'Overlay Texture',
    surface: 'official_overlay',
    framing: 'tile',
    width: 512,
    height: 512,
    transparent: true,
    layout: 'background',
    anchor: 'center',
    requiresCharacter: false,
    prompt: 'seamless technical texture tile, subtle, transparent-friendly, no text'
  },
  hns_character: {
    kind: 'hns_character',
    label: 'HNS Character',
    surface: 'hns_native',
    framing: 'half_body',
    width: 512,
    height: 768,
    transparent: true,
    layout: 'corner',
    anchor: 'bottom-right',
    requiresCharacter: true,
    prompt: 'character portrait, transparent background, full figure inside the frame'
  },
  official_character: {
    kind: 'official_character',
    label: 'Official Character',
    surface: 'official_overlay',
    framing: 'half_body',
    width: 512,
    height: 768,
    transparent: true,
    layout: 'corner',
    anchor: 'bottom-right',
    requiresCharacter: true,
    prompt: 'character portrait for an overlay, transparent background, no text, must not cover the centre'
  },
  hud_decoration: {
    kind: 'hud_decoration',
    label: 'HUD Decoration',
    surface: 'official_overlay',
    framing: 'corner',
    width: 512,
    height: 512,
    transparent: true,
    layout: 'corner',
    anchor: 'bottom-right',
    requiresCharacter: false,
    prompt: 'corner HUD bracket ornament, transparent elsewhere, no text'
  },
  frame_decoration: {
    kind: 'frame_decoration',
    label: 'Frame Decoration',
    surface: 'official_shell',
    framing: 'frame',
    width: 1600,
    height: 1000,
    transparent: true,
    layout: 'framed',
    anchor: 'center',
    requiresCharacter: false,
    prompt: 'window frame ornament with transparent centre, no text'
  },
  panel_texture: {
    kind: 'panel_texture',
    label: 'Panel Texture',
    surface: 'hns_native',
    framing: 'tile',
    width: 320,
    height: 128,
    transparent: false,
    layout: 'background',
    anchor: 'center',
    requiresCharacter: false,
    prompt: 'subtle panel texture, no text'
  },
  icon_set: {
    kind: 'icon_set',
    label: 'Icon Set',
    surface: 'hns_native',
    framing: 'sheet',
    width: 128,
    height: 128,
    transparent: true,
    layout: 'background',
    anchor: 'center',
    requiresCharacter: false,
    prompt: 'geometric icon sheet, transparent background, no text'
  },
  persona_avatar: {
    kind: 'persona_avatar',
    label: 'Persona Avatar',
    surface: 'hns_native',
    framing: 'avatar',
    width: 256,
    height: 256,
    transparent: true,
    layout: 'corner',
    anchor: 'bottom-right',
    requiresCharacter: true,
    prompt: 'character avatar, transparent background, head and shoulders'
  }
})

/** Every asset kind the generator can produce. */
const REAL_ASSET_KINDS = Object.freeze(Object.keys(REAL_ASSET_CATALOG))

/** Character framings required by 任务 5. */
const CHARACTER_FRAMINGS = Object.freeze(['avatar', 'bust', 'half_body', 'full_body', 'silhouette'])

/** Map a character framing onto the on-screen body the framing implies. */
function framingOf(kind) {
  const normalized = String(kind || '').toLowerCase()
  if (CHARACTER_FRAMINGS.includes(normalized)) return normalized
  return REAL_ASSET_CATALOG[normalized]?.framing || 'half_body'
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
  renderCharacter,
  renderOfficialSkin,
  renderOverlayTexture,
  renderHudDecoration,
  renderFrameDecoration,
  buildAssetBundle,
  buildInlineAssets,
  assetPath,
  REAL_ASSET_CATALOG,
  REAL_ASSET_KINDS,
  CHARACTER_FRAMINGS,
  framingOf
}
