'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS } = require('../utils/paths')
const { readJson } = require('../utils/paths')

/**
 * DS-Harness ringtone service.
 *
 * Single source of truth: config\sound.json
 *   { enabled, volume, events: { EVENT: { enabled, file, label } } }
 *
 * - enabled      master switch (总开关)
 * - events.*.enabled  per-event switch
 * - events.*.file     file name inside assets\sounds (presets, git-tracked)
 *                     or data\sounds (user uploads, gitignored) — wav/mp3
 *
 * Playback never blocks dsh execution; the service only resolves audio and
 * validates files.
 */

const DEFAULT_FILE = {
  COMPLETED: 'completed.wav',
  FAILED: 'failed.wav',
  INTERRUPTED: 'interrupted.wav'
}

const DEFAULT_LABELS = {
  COMPLETED: '任务完成',
  FAILED: '任务失败',
  INTERRUPTED: '任务中断'
}

const SOUND_EXTS = new Set(['.wav', '.mp3'])
const NAME_RE = /^[A-Za-z0-9._-]+$/

const SOUND_JSON = path.join(PATHS.CONFIG, 'sound.json')

function defaultEvents() {
  return Object.fromEntries(
    Object.keys(DEFAULT_FILE).map((name) => [
      name,
      { enabled: true, file: DEFAULT_FILE[name], label: DEFAULT_LABELS[name] }
    ])
  )
}

function defaults() {
  return { enabled: true, volume: 0.8, events: defaultEvents() }
}

/** Normalizes stored config (accepts the legacy flat `events: {EVENT: file}` shape). */
function normalize(cfg) {
  const base = defaults()
  if (!cfg || typeof cfg !== 'object') return base
  const events = {}
  for (const [name, spec] of Object.entries(cfg.events || {})) {
    if (!(name in base.events)) continue
    if (typeof spec === 'string') {
      events[name] = { ...base.events[name], file: validFileName(spec) ? spec : base.events[name].file }
    } else if (spec && typeof spec === 'object') {
      events[name] = {
        ...base.events[name],
        enabled: spec.enabled !== false,
        file: validFileName(spec.file) ? spec.file : base.events[name].file
      }
    }
  }
  const vol = Number(cfg.volume)
  return {
    enabled: cfg.enabled !== false,
    volume: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : base.volume,
    events: Object.assign(base.events, events)
  }
}

function loadSoundConfig() {
  return normalize(readJson('sound.json', null))
}

function saveSoundConfig(cfg) {
  const out = normalize(cfg)
  fs.mkdirSync(PATHS.CONFIG, { recursive: true })
  fs.writeFileSync(SOUND_JSON, JSON.stringify(out, null, 2) + '\n', 'utf8')
  return out
}

function validFileName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 120 &&
    NAME_RE.test(name) &&
    SOUND_EXTS.has(path.extname(name).toLowerCase())
  )
}

function listFilesIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => validFileName(f) && fs.statSync(path.join(dir, f)).isFile())
  } catch {
    return []
  }
}

/** Every playable ringtone: built-in presets first, then user uploads. */
function listSoundFiles() {
  const out = []
  for (const f of listFilesIn(PATHS.SOUNDS)) {
    out.push({ name: f, kind: 'preset', url: `/sounds/${f}` })
  }
  for (const f of listFilesIn(PATHS.USER_SOUNDS)) {
    out.push({ name: f, kind: 'user', url: `/sounds/${f}` })
  }
  return out
}

function fileExists(name) {
  if (!validFileName(name)) return false
  return (
    fs.existsSync(path.join(PATHS.SOUNDS, name)) ||
    fs.existsSync(path.join(PATHS.USER_SOUNDS, name))
  )
}

function resolveFile(eventName) {
  const cfg = loadSoundConfig()
  const ev = cfg.events?.[eventName]
  if (!cfg.enabled || !ev || ev.enabled === false) return null
  if (!fileExists(ev.file)) return null
  return path.join(
    fs.existsSync(path.join(PATHS.USER_SOUNDS, ev.file)) ? PATHS.USER_SOUNDS : PATHS.SOUNDS,
    ev.file
  )
}

/** Playback payload for a bell event; null when muted/unavailable. */
function resolveBellAudio(eventName) {
  const file = resolveFile(eventName)
  if (!file) return null
  const cfg = loadSoundConfig()
  return { file, name: path.basename(file), url: `/sounds/${path.basename(file)}`, volume: cfg.volume }
}

/** Compact per-event state for the UI (no full directory scan). */
function describeSounds() {
  const cfg = loadSoundConfig()
  const events = {}
  for (const [name, ev] of Object.entries(cfg.events)) {
    events[name] = {
      enabled: ev.enabled !== false,
      file: ev.file,
      label: ev.label,
      url: ev.file && fileExists(ev.file) ? `/sounds/${ev.file}` : null
    }
  }
  return { enabled: cfg.enabled !== false, volume: cfg.volume, events }
}

function updateEvent(name, patch = {}) {
  if (!(name in DEFAULT_FILE)) throw new Error(`unknown sound event: ${name}`)
  const cfg = loadSoundConfig()
  const ev = cfg.events[name]
  if (typeof patch.enabled === 'boolean') ev.enabled = patch.enabled
  if (patch.file != null) {
    if (!validFileName(patch.file) || !fileExists(patch.file)) {
      throw new Error(`铃声文件不存在或文件名非法: ${patch.file}`)
    }
    ev.file = patch.file
  }
  if (typeof patch.label === 'string' && patch.label.trim()) ev.label = patch.label.trim().slice(0, 40)
  return saveSoundConfig(cfg)
}

function setMasterEnabled(enabled) {
  const cfg = loadSoundConfig()
  cfg.enabled = Boolean(enabled)
  return saveSoundConfig(cfg)
}

function setVolume(volume) {
  const v = Number(volume)
  if (!Number.isFinite(v)) throw new Error(`invalid volume: ${volume}`)
  const cfg = loadSoundConfig()
  cfg.volume = Math.min(1, Math.max(0, v))
  return saveSoundConfig(cfg)
}

/** Stores a user-uploaded ringtone under data\sounds and returns its record. */
function saveUpload(rawName, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('empty upload')
  if (buffer.length > 8 * 1024 * 1024) throw new Error('上传文件过大(上限 8MB)')
  const ext = path.extname(String(rawName || '')).toLowerCase()
  if (!SOUND_EXTS.has(ext)) throw new Error('仅支持 wav / mp3 音频文件')
  const stem = path.basename(String(rawName || ''), ext).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)
  const name = `${stem || 'ringtone'}${ext}`
  const dir = PATHS.USER_SOUNDS
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, name)
  if (fs.existsSync(target)) throw new Error(`同名文件已存在: ${name} (请重命名后重试)`)
  fs.writeFileSync(target, buffer)
  return { name, kind: 'user', url: `/sounds/${name}` }
}

module.exports = {
  DEFAULT_FILE,
  DEFAULT_LABELS,
  SOUND_EXTS,
  defaults,
  loadSoundConfig,
  saveSoundConfig,
  describeSounds,
  resolveFile,
  resolveBellAudio,
  updateEvent,
  setMasterEnabled,
  setVolume,
  listSoundFiles,
  saveUpload,
  validFileName,
  fileExists
}
