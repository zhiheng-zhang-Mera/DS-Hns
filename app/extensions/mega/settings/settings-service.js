'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS, app, readJson } = require('../utils/paths')
const { loadProjectEnv } = require('../utils/env')
const soundService = require('../notifications/sound-service')
const notificationService = require('../notifications/notification-service')

/**
 * Editable settings service.
 * - config/.env  (API key + telemetry + permission; gitignored)
 * - config/app.json (default model for the monitor/queue UI)
 * - <DSH_HOME>\cordis.patch.yml (agent default model; DSH_HOME = <root>\data)
 * - config/sound.json (ringtone: master switch, volume, per-event switch/file)
 * - config/notifications.json (desktop terminal notifications)
 */

const ENV_FILE = path.join(PATHS.CONFIG, '.env')
const APP_JSON = path.join(PATHS.CONFIG, 'app.json')
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

function applyPatch({ model, soundEnabled, sound, notifications } = {}) {
  const cfg = readJson('app.json', {})
  if (model) {
    patchAgentDefaultModel(model)
    cfg.harness = cfg.harness || {}
    cfg.harness.defaultModel = model
    fs.writeFileSync(APP_JSON, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  }
  if (typeof soundEnabled === 'boolean') {
    soundService.setMasterEnabled(soundEnabled)
  }
  if (sound && typeof sound === 'object') {
    const next = soundService.loadSoundConfig()
    if (typeof sound.enabled === 'boolean') next.enabled = sound.enabled
    if (sound.volume != null) {
      const v = Number(sound.volume)
      if (Number.isFinite(v)) next.volume = Math.min(1, Math.max(0, v))
    }
    for (const [name, patch] of Object.entries(sound.events || {})) {
      if (!next.events[name]) continue
      if (typeof patch.enabled === 'boolean') next.events[name].enabled = patch.enabled
      if (typeof patch.file === 'string' && patch.file) {
        if (!soundService.validFileName(patch.file) || !soundService.fileExists(patch.file)) {
          throw new Error(`铃声文件不存在或文件名非法: ${patch.file}`)
        }
        next.events[name].file = patch.file
      }
    }
    soundService.saveSoundConfig(next)
  }
  if (notifications && typeof notifications === 'object') {
    const patch = {}
    for (const key of ['enabled', 'onCompleted', 'onFailed', 'onCancelled', 'silent']) {
      if (typeof notifications[key] === 'boolean') patch[key] = notifications[key]
    }
    // Legacy/alternate alias accepted on input only.
    if (typeof notifications.notifyOnCancelled === 'boolean' && !('onCancelled' in patch)) {
      patch.onCancelled = notifications.notifyOnCancelled
    }
    notificationService.updateConfig(patch)
  }
}

function publicSettings() {
  const env = readEnvMap().map
  const model = readModelChoice()
  return {
    apiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY || env.get('DEEPSEEK_API_KEY')),
    apiKeyMasked: maskKey(),
    telemetryMode: process.env.DSH_TELEMETRY_MODE || env.get('DSH_TELEMETRY_MODE') || 'DISABLED',
    permissionMode: process.env.DSH_PERMISSION_MODE || env.get('DSH_PERMISSION_MODE') || 'workspace-write',
    defaultModel: model,
    models: validModels(),
    sound: soundService.describeSounds(),
    notifications: notificationService.describe(),
    ui: app.ui,
    version: app.version || '0.2.0',
    dshWeb: app.dshWeb,
    paths: PATHS
  }
}

module.exports = { publicSettings, writeEnvFile, applyPatch, readModelChoice, validModels }
