'use strict'
/**
 * Compile the built-in Demo themes through the real Theme Builder pipeline.
 *
 * Run from `app/`:
 *   node extensions/mega/theme/builtin/generate-demos.cjs
 *
 * This is the same code path a user-generated theme takes (intent -> design ->
 * build -> validate), so the demos double as a build-time smoke test of the
 * whole designer/builder/validator chain.
 */
const fs = require('node:fs')
const path = require('node:path')

const designer = require('../designer')
const builder = require('../builder')

const HERE = __dirname

const DEMOS = [
  {
    id: 'hns.demo.minimal',
    name: 'Minimal Neutral',
    dir: path.join(HERE, 'demo', 'minimal-neutral'),
    prompt: '极简、干净的浅色中性主题，低装饰，不要角色，文字清晰优先',
    intentOverrides: {
      design_language: 'minimal_neutral',
      style_tag: 'minimal',
      // `silver` is the light-palette entry: the designer derives a light surface
      // from it and pairs it with dark labels, which is what a neutral light
      // theme needs. `charcoal` would derive a dark accent and a light base
      // hint, producing an unreadable light-on-light combination.
      palette: ['silver'],
      palette_label: '中性浅色',
      base_hint: '#f4f6f9',
      density: 'normal',
      density_scale: 1,
      motion: 'none',
      decoration: 'none',
      readability_priority: 'high',
      persona: { enabled: false, prominence: 0, character: null }
    }
  },
  {
    id: 'hns.demo.anime-persona',
    name: 'Anime Persona Demo',
    dir: path.join(HERE, 'demo', 'anime-persona'),
    prompt: '二次元银发角色，紫蓝冷色调，轻量人物挂件，装饰中等偏低',
    intentOverrides: {
      design_language: 'anime_persona',
      style_tag: 'organic',
      palette: ['violet'],
      palette_label: '紫蓝',
      base_hint: '#1a1730',
      density: 'compact',
      density_scale: 0.86,
      motion: 'subtle',
      decoration: 'medium_low',
      readability_priority: 'high',
      persona: { enabled: true, prominence: 0.22, character: 'silver_hair_assistant' }
    }
  },
  {
    id: 'hns.demo.cyber-hud',
    name: 'Cyber HUD Demo',
    dir: path.join(HERE, 'demo', 'cyber-hud'),
    prompt: '赛博全息 HUD，黑灰蓝，扫描线，微光，人物不要抢屏',
    intentOverrides: {
      design_language: 'cyber_hud',
      style_tag: 'cyber',
      palette: ['steel_blue'],
      palette_label: '钢蓝',
      base_hint: '#0c1018',
      density: 'compact',
      density_scale: 0.86,
      motion: 'subtle',
      decoration: 'high',
      readability_priority: 'high',
      persona: { enabled: true, prominence: 0.16, character: 'android_operator' }
    }
  }
]

let failures = 0
for (const demo of DEMOS) {
  const interpreted = designer.interpret(demo.prompt)
  const intent = { ...interpreted, ...demo.intentOverrides, persona: { ...interpreted.persona, ...demo.intentOverrides.persona } }
  const draft = designer.design({ intent, withAssets: false })
  const result = builder.buildPackage({
    draft,
    id: demo.id,
    name: demo.name,
    outDir: demo.dir,
    source: 'builtin-demo',
    generatedPrompt: demo.prompt,
    author: 'HNS Theme Engine'
  })
  if (!result.ok) {
    failures += 1
    console.error(`FAILED ${demo.id}: ${result.reason}`)
    for (const issue of result.issues || []) console.error(`   [${issue.severity}] ${issue.code}: ${issue.message}`)
    continue
  }
  // The demos are factory-resettable, so they stay editable/deletable.
  const manifestPath = path.join(demo.dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.protected = false
  manifest.deletable = true
  manifest.editable = true
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`built ${demo.id} -> ${demo.dir} (slots=${builder.countSlots(result.components)}, warnings=${result.validation.warnings.length})`)
}

if (failures) {
  console.error(`${failures} demo theme(s) failed to build`)
  process.exitCode = 1
}
