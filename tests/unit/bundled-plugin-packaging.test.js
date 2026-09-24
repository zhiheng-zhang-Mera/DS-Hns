'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolveTestRoot } = require('../../app/runtime/storage-roots.cjs')

const ROOT = path.resolve(__dirname, '../..')
const npmCandidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')
].filter(Boolean)

for (const directory of ['health-scheduler', 'restart-supervisor']) {
  test(`the packed ${directory} loads without the source checkout or junctions`, () => {
    const npmCli = npmCandidates.find(file => fs.existsSync(file))
    assert.ok(npmCli, 'packaging regression requires the repository Node/npm toolchain')
    const scratchRoot = resolveTestRoot(ROOT)
    fs.mkdirSync(scratchRoot, { recursive: true })
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'dsh-packed-plugin-'))
    const cache = path.join(scratch, 'npm-cache')
    const env = { ...process.env, npm_config_cache: cache, TEMP: scratch, TMP: scratch }
    try {
      // npm's actual package selection, not a copy of the whole source directory.
      const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {
        cwd: path.join(ROOT, 'app/plugins', directory), env, encoding: 'utf8', windowsHide: true, timeout: 60_000
      })
      assert.equal(packed.status, 0, packed.stderr || packed.error?.message)
      const archive = JSON.parse(packed.stdout)[0].filename
      assert.equal(path.basename(archive), archive)
      const extracted = spawnSync('tar', ['-xf', path.join(scratch, archive), '-C', scratch], {
        env, encoding: 'utf8', windowsHide: true, timeout: 30_000
      })
      assert.equal(extracted.status, 0, extracted.stderr || extracted.error?.message)
      const loaded = spawnSync(process.execPath, ['-e',
        "const assert=require('node:assert/strict');const plugin=require(process.argv[1]);assert.equal(typeof plugin.apply,'function');const contract=require(process.argv[1]+'/contract.cjs').contract();assert.equal(contract.source,'the plugin package itself');",
        path.join(scratch, 'package')], {
        cwd: scratch, env, encoding: 'utf8', windowsHide: true, timeout: 30_000
      })
      assert.equal(loaded.status, 0, loaded.stderr || loaded.error?.message)
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
}
