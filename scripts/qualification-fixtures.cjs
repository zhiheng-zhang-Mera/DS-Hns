'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const DEST = path.resolve(process.argv[2] || path.join(process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts'), 'qualification-fixtures'))
const REPORT = process.argv[3] ? path.resolve(process.argv[3]) : null
const SOURCES = Object.freeze([
  { id: 'dsh-restart', url: 'https://github.com/zhiheng-zhang-Mera/dsh-restart.git', sha: 'e20fb6cc43e27cedf6303471e5b8ee18e1383ecd', dest: 'dsh-restart' },
  { id: 'dsh-market', url: 'https://github.com/zhu1090093659/dsh-web.git', sha: 'c5679ffd0a070797bcdfaee89a27cafab19c41be', dest: path.join('samples', 'dsh-web') },
  { id: 'wallpaper', url: 'https://github.com/elysia395/dsh-wallpaper-engine.git', sha: 'b3937a3a15537bd890df825ce685244c5fa8a856', dest: path.join('samples', 'wallpaper-engine-dsh') }
])

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`)
  return String(result.stdout).trim()
}

function tool(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${String(result.stderr || result.stdout).trim()}`)
}

function bootstrap(source, dest) {
  if (source.id === 'dsh-restart') {
    tool('npm', ['ci', '--ignore-scripts'], dest)
    tool('npm', ['run', 'build'], dest)
    if (!fs.existsSync(path.join(dest, 'lib', 'supervisor', 'index.js'))) throw new Error('dsh-restart build did not produce lib/supervisor/index.js')
    return 'npm ci + npm run build (package-lock.json)'
  }
  if (source.id === 'dsh-market') {
    tool('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--filter', '@linxin666/dsh-client-ui-market...'], dest)
    if (!fs.existsSync(path.join(dest, 'packages', 'dsh-market', 'node_modules', 'schemastery'))) throw new Error('dsh-market pnpm install did not materialize schemastery')
    return 'corepack pnpm install --frozen-lockfile (pnpm@11.24.0)'
  }
  if (source.id === 'wallpaper') {
    tool('npm', ['ci', '--ignore-scripts', '--omit=dev'], dest)
    return 'npm ci --omit=dev (package-lock.json)'
  }
  throw new Error(`no bootstrap contract for ${source.id}`)
}

function materialize(source) {
  const dest = path.join(DEST, source.dest)
  if (fs.existsSync(dest)) throw new Error(`qualification fixture destination is not fresh: ${dest}`)
  fs.mkdirSync(dest, { recursive: true })
  git(['init', '--quiet'], dest)
  git(['remote', 'add', 'origin', source.url], dest)
  git(['fetch', '--quiet', '--depth=1', 'origin', source.sha], dest)
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dest)
  const actual = git(['rev-parse', 'HEAD'], dest)
  if (actual !== source.sha) throw new Error(`${source.id}: expected ${source.sha}, got ${actual}`)
  const toolchain = bootstrap(source, dest)
  return { id: source.id, url: source.url, expectedSha: source.sha, actualSha: actual, path: dest, toolchain }
}

function main() {
  const startedAt = new Date().toISOString()
  const fixtures = SOURCES.map(materialize)
  const report = { passed: true, checks: fixtures.length, failures: 0, startedAt, completedAt: new Date().toISOString(), root: DEST, fixtures }
  if (REPORT) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true })
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

try { main() } catch (error) {
  const report = { passed: false, checks: SOURCES.length, failures: 1, completedAt: new Date().toISOString(), root: DEST, error: String(error.stack || error) }
  if (REPORT) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true })
    fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  process.stderr.write(`${report.error}\n`)
  process.exitCode = 1
}
