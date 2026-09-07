'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS, app, readJson } = require('../utils/paths')
const { loadProjectEnv } = require('../utils/env')

/**
 * Editable settings service.
 * - config/.env  (API key + telemetry + permission; gitignored)
 * - config/app.json (default model for the monitor/queue UI)
 * - runtime/dsh/cordis.patch.yml (agent default model for headless jobs)
 * - config/sound.json (sound on/off)
 */

const ENV_FILE = path.join(PATHS.CONFIG, '.env')
const APP_JSON = path.join(PATHS.CONFIG, 'app.json')
const SOUND_JSON = path.join(PATHS.CONFIG, 'sound.json')
const HOME_PATCH = path.join(PATHS.DSH_HOME, 'cordis.patch.yml')

function readEnvMap() {
  const map = new Map()
  let text = ''
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8')
  } catch {
    return { map, text: '' }
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const eq = line.indexOf('=')
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return { map, text }
}

function writeEnvFile(patch) {
  const current = readEnvMap()
  const lines = []
  const present = new Set()
  for (const rawLine of current.text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    const eq = trimmed.indexOf('=')
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim()
      if (key in patch) {
        const value = patch[key]
        if (value) {
          lines.push(`${key}=${value}`)
          present.add(key)
        } else {
          delete process.env[key]
        }
        continue
      }
    }
    lines.push(rawLine)
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value && !present.has(key)) lines.push(`${key}=${value}`)
  }
  const output = lines.join('\r\n').replace(/\r?\n+$/, '') + '\r\n'
  fs.writeFileSync(ENV_FILE, output, 'utf8')
  for (const [key, value] of Object.entries(patch)) {
    if (value) process.env[key] = value
    else delete process.env[key]
  }
  loadProjectEnv()
}

function maskKey() {
  const value = process.env.DEEPSEEK_API_KEY || readEnvMap().map.get('DEEPSEEK_API_KEY') || ''
  if (!value) return null
  return value.length <= 8 ? '*'.repeat(value.length) : value.slice(0, 4) + '••••' + value.slice(-4)
}

function validModels() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PATHS.PRICING, 'official-pricing.json'), 'utf8')).models.map((m) => m.id)
  } catch {
    return ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
  }
}

function readModelChoice() {
  const cfg = readJson('app.json', {})
  return cfg.harness?.defaultModel || 'deepseek-v4-flash'
}

function patchAgentDefaultModel(model) {
  if (!validModels().includes(model)) throw new Error(`unsupported model: ${model}`)
  const lines = fs.existsSync(HOME_PATCH)
    ? fs.readFileSync(HOME_PATCH, 'utf8').split(/\r?\n/)
    : []
  const kept = []
  let skip = 0
  for (let i = 0; i < lines.length; i++) {
    if (skip > 0) {
      skip--
      continue
    }
    if (/^\s*- id:\s*agent-default-model\s*$/.test(lines[i])) {
      // The block we generate has exactly config/provider/model.
      skip = 3
      continue
    }
    kept.push(lines[i])
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  kept.push('- id: agent-default-model', '  config:', `    provider: deepseek-official`, `    model: ${model}`)
  fs.writeFileSync(HOME_PATCH, kept.join('\r\n') + '\r\n', 'utf8')
}

function applyPatch({ model, soundEnabled } = {}) {
  const cfg = readJson('app.json', {})
  if (model) {
    patchAgentDefaultModel(model)
    cfg.harness = cfg.harness || {}
    cfg.harness.defaultModel = model
    fs.writeFileSync(APP_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  }
  if (typeof soundEnabled === 'boolean') {
    const sounds = readJson('sound.json', { enabled: true, events: {} })
    sounds.enabled = soundEnabled
    fs.writeFileSync(SOUND_JSON, JSON.stringify(sounds, null, 2) + '\n', 'utf8')
  }
}

function publicSettings() {
  const env = readEnvMap().map
  const sounds = readJson('sound.json', { enabled: true, events: {} })
  const model = readModelChoice()
  return {
    apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY || env.get('DEEPSEEK_API_KEY')),
    apiKeyMasked: maskKey(),
    telemetryMode: process.env.DSH_TELEMETRY_MODE || env.get('DSH_TELEMETRY_MODE') || 'DISABLED',
    permissionMode: process.env.DSH_PERMISSION_MODE || env.get('DSH_PERMISSION_MODE') || 'workspace-write',
    defaultModel: model,
    models: validModels(),
    soundEnabled: sounds.enabled !== false,
    ui: app.ui,
    version: app.version || '0.2.0',
    dshWeb: app.dshWeb,
    paths: PATHS
  }
}

module.exports = { publicSettings, writeEnvFile, applyPatch, readModelChoice, validModels }
