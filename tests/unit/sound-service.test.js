'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// Isolate every file operation: point the module tree at a scratch project
// root inside the project's cache\temp (test-all.ps1 sets TEMP there).
const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), 'dsh-sound-test-' + process.pid)
process.env.DSH_ROOT = SCRATCH

const svc = require('../../app/monitor/notifications/sound-service')

const cfgDir = path.join(SCRATCH, 'config')
const soundsDir = path.join(SCRATCH, 'assets', 'sounds')
const userDir = path.join(SCRATCH, 'data', 'sounds')

function writeCfg(obj) {
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(path.join(cfgDir, 'sound.json'), JSON.stringify(obj, null, 2))
}

function seed() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  for (const dir of [soundsDir, userDir]) fs.mkdirSync(dir, { recursive: true })
  for (const n of ['completed.wav', 'failed.wav', 'interrupted.wav', 'ding-soft.wav']) {
    fs.writeFileSync(path.join(soundsDir, n), Buffer.alloc(24))
  }
  writeCfg(svc.defaults())
}

test('defaults: master on, volume 0.8, three events mapped to defaults', () => {
  seed()
  const cfg = svc.loadSoundConfig()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.volume, 0.8)
  assert.deepEqual(Object.keys(cfg.events), ['COMPLETED', 'FAILED', 'INTERRUPTED'])
  assert.equal(cfg.events.COMPLETED.file, 'completed.wav')
  assert.equal(cfg.events.COMPLETED.enabled, true)
})

test('legacy flat config (events: {EVENT: file}) is normalized', () => {
  seed()
  writeCfg({ enabled: false, events: { COMPLETED: 'completed.wav', FAILED: 'failed.wav' } })
  const cfg = svc.loadSoundConfig()
  assert.equal(cfg.enabled, false)
  assert.equal(typeof cfg.events.COMPLETED, 'object')
  assert.equal(cfg.events.COMPLETED.file, 'completed.wav')
  // Missing events fall back to defaults instead of disappearing.
  assert.equal(cfg.events.INTERRUPTED.enabled, true)
  assert.equal(cfg.events.INTERRUPTED.file, 'interrupted.wav')
})

test('resolveFile obeys master switch, per-event switch and file existence', () => {
  seed()
  assert.ok(svc.resolveFile('COMPLETED') && svc.resolveFile('COMPLETED').endsWith('completed.wav'))
  writeCfg({ ...svc.defaults(), enabled: false })
  assert.equal(svc.resolveFile('COMPLETED'), null)
  seed()
  const cfg = svc.defaults()
  cfg.events.COMPLETED.enabled = false
  writeCfg(cfg)
  assert.equal(svc.resolveFile('COMPLETED'), null)
  seed()
  const cfg2 = svc.defaults()
  cfg2.events.COMPLETED.file = 'missing.wav'
  writeCfg(cfg2)
  assert.equal(svc.resolveFile('COMPLETED'), null)
})

test('resolveBellAudio returns payload with url + volume; null when muted', () => {
  seed()
  const audio = svc.resolveBellAudio('COMPLETED')
  assert.equal(audio.name, 'completed.wav')
  assert.equal(audio.url, '/sounds/completed.wav')
  assert.equal(audio.volume, 0.8)
  svc.setMasterEnabled(false)
  assert.equal(svc.resolveBellAudio('COMPLETED'), null)
})

test('updateEvent switches file/enabled per event and validates input', () => {
  seed()
  assert.throws(() => svc.updateEvent('BOGUS', {}), /unknown sound event/)
  assert.throws(() => svc.updateEvent('COMPLETED', { file: '../evil.wav' }), /非法|不存在/)
  assert.throws(() => svc.updateEvent('COMPLETED', { file: 'nope.wav' }), /非法|不存在/)
  svc.updateEvent('COMPLETED', { file: 'ding-soft.wav', enabled: false })
  const cfg = svc.loadSoundConfig()
  assert.equal(cfg.events.COMPLETED.file, 'ding-soft.wav')
  assert.equal(cfg.events.COMPLETED.enabled, false)
})

test('volume clamps to 0..1 and persists', () => {
  seed()
  svc.setVolume(0.35)
  assert.equal(svc.loadSoundConfig().volume, 0.35)
  svc.setVolume(5)
  assert.equal(svc.loadSoundConfig().volume, 1)
  svc.setVolume(-1)
  assert.equal(svc.loadSoundConfig().volume, 0)
  assert.throws(() => svc.setVolume('loud'), /invalid volume/)
})

test('saveUpload stores sanitized wav/mp3 under data\\sounds and rejects bad input', () => {
  seed()
  const rec = svc.saveUpload('my ring!?.wav', Buffer.alloc(64))
  assert.equal(rec.kind, 'user')
  assert.ok(rec.name.startsWith('my_ring_'))
  assert.ok(fs.existsSync(path.join(userDir, rec.name)))
  assert.equal(rec.url, '/sounds/' + rec.name)
  assert.throws(() => svc.saveUpload('bad.exe', Buffer.alloc(8)), /wav \/ mp3/)
  assert.throws(() => svc.saveUpload('bad.wav', Buffer.alloc(0)), /empty upload/)
  assert.throws(() => svc.saveUpload('bad.wav', Buffer.alloc(10 * 1024 * 1024)), /过大/)
  svc.saveUpload('dup.wav', Buffer.alloc(16))
  assert.throws(() => svc.saveUpload('dup.wav', Buffer.alloc(16)), /同名/)
})

test('listSoundFiles enumerates presets then user files (no path traversal)', () => {
  seed()
  fs.writeFileSync(path.join(userDir, 'custom.mp3'), Buffer.alloc(16))
  const files = svc.listSoundFiles()
  const names = files.map((f) => f.name)
  assert.ok(names.includes('completed.wav'))
  assert.ok(names.includes('custom.mp3'))
  const presets = files.filter((f) => f.kind === 'preset').length
  const users = files.filter((f) => f.kind === 'user').length
  assert.equal(users, 1)
  assert.ok(presets >= 3)
  assert.equal(svc.validFileName('../x.wav'), false)
  assert.equal(svc.validFileName('a b.wav'), false)
  assert.equal(svc.validFileName('ring-tone_2.mp3'), true)
})
