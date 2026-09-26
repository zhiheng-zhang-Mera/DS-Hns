'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createCrossVolumeTempRegistry } = require('../../app/engineering/cross-volume-cleanup.cjs')
const { createEngineeringSupervisor } = require('../../app/engineering/supervisor.cjs')

const WORK_ROOT = path.resolve(__dirname, '..', '..')
const OFF_VOLUME_TEMP = path.join(process.env.LOCALAPPDATA || 'C:\\Users\\15601\\AppData\\Local', 'Temp')

function externalPath(label, extension = '') {
  return path.join(OFF_VOLUME_TEMP, `codex-cross-volume-${label}-${process.pid}-${crypto.randomUUID()}${extension}`)
}

function registry(episodeId = 'cleanup-fixture', onChange = () => {}) {
  return createCrossVolumeTempRegistry({ episodeId, workRoot: WORK_ROOT, onChange })
}

test('a task-owned off-volume directory is registered with an ownership marker and removed only at terminal cleanup', () => {
  const root = externalPath('directory')
  const changes = []
  const store = registry('cleanup-directory', (entries) => changes.push(entries))
  try {
    const created = store.createTaskDirectory({ path: root, purposeClass: 'build' })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(fs.existsSync(path.join(root, '.dshns-episode-owner.json')), true)
    const output = store.createRegisteredFile({ path: path.join(root, 'build.tmp'), purposeClass: 'build', content: 'owned output' })
    assert.equal(output.ok, true, JSON.stringify(output))
    assert.equal(changes.length >= 1, true)

    const interrupted = store.cleanupTerminal({ terminal: false, reason: 'unclean_exit' })
    assert.equal(interrupted.ok, true)
    assert.equal(fs.existsSync(root), true, 'recoverable interruptions must preserve scratch')

    const cleaned = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned))
    assert.equal(cleaned.residuals.length, 0)
    assert.equal(fs.existsSync(root), false)
    assert.equal(store.list()[0].cleanupState, 'DELETED')
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a pre-existing directory sentinel cannot be registered or deleted', () => {
  const root = externalPath('sentinel')
  fs.mkdirSync(root)
  const sentinel = path.join(root, 'keep.txt')
  fs.writeFileSync(sentinel, 'pre-existing user data', 'utf8')
  const store = registry('cleanup-sentinel')
  try {
    const refused = store.createTaskDirectory({ path: root, purposeClass: 'cache' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'TEMP_PATH_ALREADY_EXISTS')
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'pre-existing user data')
    assert.deepEqual(store.list(), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a mismatched ownership marker blocks cleanup and reports the exact residual', () => {
  const root = externalPath('marker')
  const store = registry('cleanup-marker')
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'test' }).ok, true)
    fs.writeFileSync(path.join(root, '.dshns-episode-owner.json'), JSON.stringify({ episodeId: 'someone-else' }), 'utf8')
    const result = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(result.ok, false)
    assert.equal(result.residuals.length, 1)
    assert.equal(result.residuals[0].path, root)
    assert.equal(store.list()[0].cleanupState, 'CLEANUP_BLOCKED')
    assert.equal(fs.existsSync(root), true)
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unregistered foreign file inside an owned directory blocks recursive cleanup', () => {
  const root = externalPath('foreign-child')
  const store = registry('cleanup-foreign-child')
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'build' }).ok, true)
    fs.writeFileSync(path.join(root, 'foreign.keep'), 'do not delete this', 'utf8')
    const result = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(result.ok, false)
    assert.equal(result.residuals[0].path, root)
    assert.equal(fs.readFileSync(path.join(root, 'foreign.keep'), 'utf8'), 'do not delete this')
    assert.equal(store.list()[0].cleanupState, 'CLEANUP_BLOCKED')
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a task-owned file is removed exactly without deleting its containing directory', () => {
  const parent = externalPath('file-parent')
  const file = path.join(parent, 'single.log')
  fs.mkdirSync(parent)
  const parentSentinel = path.join(parent, 'keep.txt')
  fs.writeFileSync(parentSentinel, 'keep', 'utf8')
  const store = registry('cleanup-file')
  try {
    const created = store.createRegisteredFile({ path: file, purposeClass: 'log', content: 'episode output' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const cleaned = store.cleanupTerminal({ terminal: true, reason: 'cancelled' })
    assert.equal(cleaned.ok, true, JSON.stringify(cleaned))
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.readFileSync(parentSentinel, 'utf8'), 'keep')
  } finally {
    if (fs.existsSync(parent)) fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('a symlink/reparse entry inside a registered root blocks recursive deletion', (t) => {
  const root = externalPath('reparse')
  const store = registry('cleanup-reparse')
  const target = externalPath('reparse-target')
  try {
    assert.equal(store.createTaskDirectory({ path: root, purposeClass: 'unpack' }).ok, true)
    fs.mkdirSync(target)
    try {
      fs.symlinkSync(target, path.join(root, 'escape'), 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`junction creation is unavailable: ${error.code}`)
      throw error
    }
    const result = store.cleanupTerminal({ terminal: true, reason: 'completed' })
    assert.equal(result.ok, false)
    assert.equal(store.list()[0].cleanupState, 'CLEANUP_BLOCKED')
    assert.equal(fs.existsSync(root), true)
    assert.equal(fs.existsSync(target), true)
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
  }
})

test('successful supervisor completion runs the durable cross-volume cleanup gate', async () => {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-cleanup-supervisor-'))
  const root = externalPath('supervisor-terminal')
  const logs = []
  const supervisor = createEngineeringSupervisor({
    episodeId: `cleanup-success-${process.pid}-${crypto.randomUUID()}`,
    workspace: WORK_ROOT,
    goal: 'verify terminal scratch cleanup',
    contract: {
      commands: { test: 'node --test tests/unit/engineering-recovery-schema.test.js' },
      steps: [{ kind: 'report' }],
      lockWorkspace: false,
      tests: ['full-verify']
    },
    checkpointRoot: path.join(holder, 'runtime', 'engineering', 'checkpoints'),
    workRoot: path.parse(WORK_ROOT).root,
    log: (event) => logs.push(event)
  })
  try {
    const running = supervisor.run()
    const created = supervisor.crossVolumeTemp.createTaskDirectory({ path: root, purposeClass: 'build' })
    assert.equal(created.ok, true, JSON.stringify(created))
    const artifact = supervisor.crossVolumeTemp.createRegisteredFile({ path: path.join(root, 'artifact.tmp'), purposeClass: 'build', content: 'task scratch' })
    assert.equal(artifact.ok, true, JSON.stringify(artifact))

    const report = await running
    assert.equal(report.result, 'COMPLETED', JSON.stringify({ validation: report.validation, logs }))
    assert.equal(fs.existsSync(root), false, 'terminal completion must not leave owned scratch')
    assert.equal(report.cleanup.ok, true)
    const checkpoint = supervisor.checkpoints.latest(supervisor.id)
    assert.equal(checkpoint.recovery.lifecycleState, 'COMPLETED')
    assert.equal(checkpoint.recovery.crossVolumeTemp[0].cleanupState, 'DELETED')
  } finally {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(holder, { recursive: true, force: true })
  }
})
