'use strict'

/**
 * Host Capability Profile.
 *
 * The requirement is explicit that a machine model table is the wrong answer, so
 * these tests are written against *measured facts plus a short calibration*: the
 * synthetic hosts below are described by what they do (cores, memory, measured
 * spawn latency) rather than by a name, and the assertions are that the policy
 * follows those facts.
 *
 * The rule being protected is one sentence long: a slow host may be classified
 * conservatively, and it must never be classified as broken.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const capability = require('../../app/runtime/host-capability.cjs')

/** A synthetic host, described the way a real one is: capability + measured cost. */
function host({ cores = 8, totalMB = 16384, availableMB = 8192, spawnP50 = 120, spawnP95 = 260, workerP95 = 1400 } = {}) {
  return capability.createCalibratedProfile({
    hardware: {
      logicalCores: cores,
      physicalCores: Math.max(1, Math.round(cores / 2)),
      architecture: 'x64',
      model: 'synthetic',
      speedMHz: 2400,
      totalMB,
      availableMB,
      memoryPressure: totalMB > 0 ? (totalMB - availableMB) / totalMB : 0
    },
    calibration: {
      nodeSpawnP50Ms: spawnP50,
      nodeSpawnP95Ms: spawnP95,
      nodeSpawnSamples: 5,
      workerColdStartP95Ms: workerP95
    },
    source: 'test-fixture'
  })
}

test('the profile records hardware, calibration and the derived policy together', () => {
  const profile = host()
  assert.equal(profile.version, capability.CAPABILITY_VERSION)
  assert.equal(profile.cpu.logicalCores, 8)
  assert.equal(profile.memory.totalMB, 16384)
  assert.equal(profile.calibration.nodeSpawnP95Ms, 260)
  assert.ok(capability.CAPACITY_CLASSES.includes(profile.capacity.class))
  assert.ok(profile.workers.recommended >= 1)
  // The budget block is what the installer and Runtime read instead of constants.
  for (const key of ['harnessStartup', 'workerStartup', 'ipcConnect', 'electronReady']) {
    assert.ok(profile.budgets[key], `no budget for ${key}`)
    assert.ok(profile.budgets[key].timeoutMs > 0)
    assert.ok(profile.budgets[key].deadlockMs >= profile.budgets[key].timeoutMs)
  }
})

test('a 2-core 4 GB host is conservative, not rejected', () => {
  const profile = host({ cores: 2, totalMB: 4096, availableMB: 1800, spawnP50: 420, spawnP95: 900, workerP95: 4200 })
  assert.ok(['LOW_CAPACITY', 'CONSERVATIVE'].includes(profile.capacity.class), `unexpected class ${profile.capacity.class}`)
  assert.equal(profile.workers.aggressiveScaling, false)
  assert.equal(profile.workers.recommended, 1)
  assert.ok(profile.workers.recommended >= 1, 'a host that can run one worker can work')
})

test('a 16+ core 32 GB host gets a higher ceiling and more aggressive scaling', () => {
  const profile = host({ cores: 32, totalMB: 65536, availableMB: 52000, spawnP50: 40, spawnP95: 70, workerP95: 300 })
  assert.equal(profile.capacity.class, 'HIGH_CAPACITY')
  assert.ok(profile.workers.recommended > 8)
  assert.equal(profile.workers.aggressiveScaling, true)
})

test('a fast host can be scored capable even when it is currently loaded', () => {
  // Cores and memory are what the host *is*; spawn latency is what it is doing
  // right now. A busy 16-core machine must not be classified as a small one.
  const busy = host({ cores: 16, totalMB: 32768, availableMB: 20000, spawnP50: 900, spawnP95: 1200, workerP95: 6000 })
  assert.ok(['BALANCED', 'CAPABLE', 'HIGH_CAPACITY'].includes(busy.capacity.class), `class was ${busy.capacity.class}`)
})

test('real memory pressure subtracts, and the reason names the measured values', () => {
  const starved = host({ cores: 8, totalMB: 16384, availableMB: 300, spawnP50: 120, spawnP95: 260 })
  const relaxed = host({ cores: 8, totalMB: 16384, availableMB: 12000, spawnP50: 120, spawnP95: 260 })
  assert.ok(starved.capacity.score < relaxed.capacity.score)
  assert.equal(starved.capacity.reasons.availableMB, 300)
  assert.equal(starved.capacity.reasons.nodeSpawnP95Ms, 260)
})

test('the worker ceiling takes the minimum of cores and available memory', () => {
  const cpuBound = capability.deriveWorkerCeiling({
    hardware: { logicalCores: 4, availableMB: 64000, totalMB: 65536 },
    capacity: { class: 'CAPABLE' }
  })
  const memoryBound = capability.deriveWorkerCeiling({
    hardware: { logicalCores: 32, availableMB: 2048, totalMB: 65536 },
    capacity: { class: 'CAPABLE' }
  })
  // With plenty of memory, the CPU is the binding constraint.
  assert.equal(cpuBound.cpuBound, 3)
  assert.ok(cpuBound.memoryBound >= cpuBound.cpuBound)
  assert.equal(cpuBound.recommended, cpuBound.cpuBound)
  // With plenty of cores, memory is.
  assert.ok(memoryBound.memoryBound < memoryBound.cpuBound, 'memory must be the binding constraint here')
  assert.equal(memoryBound.recommended, memoryBound.memoryBound)
  assert.ok(memoryBound.recommended >= 1)
})

test('the ceiling is per worker cost, not a fixed number', () => {
  const cheap = capability.deriveWorkerCeiling({
    hardware: { logicalCores: 16, availableMB: 16000, totalMB: 32000 },
    capacity: { class: 'CAPABLE' },
    perWorkerMemoryMB: 256
  })
  const expensive = capability.deriveWorkerCeiling({
    hardware: { logicalCores: 16, availableMB: 16000, totalMB: 32000 },
    capacity: { class: 'CAPABLE' },
    perWorkerMemoryMB: 4096
  })
  assert.ok(cheap.recommended > expensive.recommended, 'a heavier worker must lower the ceiling')
})

test('the initial adaptive state names the existing runtime vocabulary', () => {
  const low = host({ cores: 2, totalMB: 4096, availableMB: 1800, spawnP50: 420, spawnP95: 900 })
  const high = host({ cores: 32, totalMB: 65536, availableMB: 52000, spawnP50: 40, spawnP95: 70 })
  // The Runtime already has BOOST/NORMAL/THROTTLED/SAFE_MODE; a new ceiling must
  // not invent a second vocabulary for the same idea.
  for (const profile of [low, high]) {
    assert.ok(['BOOST', 'NORMAL', 'THROTTLED', 'SAFE_MODE'].includes(profile.workers.initialAdaptiveState))
  }
  assert.equal(low.workers.initialAdaptiveState, 'THROTTLED')
})

test('calibration tolerates a host that cannot spawn at all', () => {
  const spawn = capability.measureNodeSpawn({ samples: 2, nodeExe: path('definitely-not-a-real-binary') })
  assert.equal(spawn.samples, 0)
  assert.equal(spawn.p50Ms, 0)
  // A failed measurement must not become a zero budget downstream.
  const profile = capability.createCalibratedProfile({
    hardware: { logicalCores: 4, totalMB: 8192, availableMB: 4096 },
    calibration: { nodeSpawnP50Ms: 0, nodeSpawnP95Ms: 0 }
  })
  assert.ok(profile.budgets.harnessStartup.timeoutMs > 0)
})

test('a fixture profile is loadable from disk and classified the same way', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-fixture-'))
  const file = path.join(dir, 'low.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      cpu: { logicalCores: 2, physicalCores: 2, architecture: 'x64', model: 'fixture' },
      memory: { totalMB: 4096, availableMB: 1800 },
      calibration: { nodeSpawnP50Ms: 420, nodeSpawnP95Ms: 900, workerColdStartP95Ms: 4200 }
    })
  )
  const profile = capability.loadProfileFixture(file)
  assert.equal(profile.cpu.logicalCores, 2)
  assert.match(profile.source, /fixture:low\.json/)
  assert.ok(['LOW_CAPACITY', 'CONSERVATIVE'].includes(profile.capacity.class))
})

function path(value) {
  return require('node:path').join(process.env.WINDIR || 'C:\\Windows', value)
}

test('the profile cache is keyed by version and expires', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const p = require('node:path')
  const home = fs.mkdtempSync(p.join(os.tmpdir(), 'dshns-profile-'))
  const profile = host()
  assert.equal(capability.writeCachedProfile(home, profile), true)
  const cached = capability.readCachedProfile(home)
  assert.ok(cached, 'a freshly written profile must be readable')
  assert.equal(cached.capacity.class, profile.capacity.class)

  // A profile captured long ago is not a budget for now.
  const stale = { ...profile, capturedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }
  capability.writeCachedProfile(home, stale)
  assert.equal(capability.readCachedProfile(home), null)
})

test('collecting on this host always produces a usable profile', () => {
  const profile = capability.collectHostProfile({ spawnSamples: 2 })
  assert.ok(profile.cpu.logicalCores >= 1)
  assert.ok(profile.memory.totalMB > 0)
  assert.ok(capability.CAPACITY_CLASSES.includes(profile.capacity.class))
  assert.ok(profile.workers.recommended >= 1)
  assert.equal(profile.source, 'measured')
})
