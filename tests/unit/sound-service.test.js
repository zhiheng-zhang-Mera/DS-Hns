'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), 'dsh-sound-test-' + process.pid)
process.env.DSH_ROOT = SCRATCH
const svc = require('../../app/extensions/mega/notifications/sound-service')
const cfgDir = path.join(SCRATCH, 'config')
const soundsDir = path.join(SCRATCH, 'assets', 'sounds')
const userDir = path.join(SCRATCH, 'data', 'sounds')
function seed(){ fs.rmSync(SCRATCH,{recursive:true,force:true}); [cfgDir,soundsDir,userDir].forEach(d=>fs.mkdirSync(d,{recursive:true})); ['completed.wav','failed.wav','interrupted.wav'].forEach(n=>fs.writeFileSync(path.join(soundsDir,n),Buffer.alloc(24))); fs.writeFileSync(path.join(cfgDir,'sound.json'),JSON.stringify(svc.defaults())) }

test('defaults and resolution work', () => { seed(); assert.equal(svc.loadSoundConfig().enabled,true); assert.ok(svc.resolveFile('COMPLETED')) })
test('master switch mutes', () => { seed(); svc.setMasterEnabled(false); assert.equal(svc.resolveBellAudio('COMPLETED'),null) })
