'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

/**
 * MEGA-05: one canonical boot path, one icon source (repository-root icon.jpg)
 * and an icon failure that can only degrade the icon, never the launcher.
 */

test('every entrance points at the single Harness entry point', () => {
  const pkg = JSON.parse(read('app/package.json'))
  assert.equal(pkg.main, 'desktop-main.cjs')

  const cmd = read('Start-DeepSeek-Harness.cmd')
  assert.match(cmd, /desktop-main\.cjs/)

  const shortcuts = read('scripts/shortcuts.ps1')
  assert.match(shortcuts, /\$entry = "\$root\\app\\desktop-main\.cjs"/)
  assert.match(shortcuts, /-Arguments "`"\$entry`""/)

  const run = read('scripts/run.ps1')
  assert.match(run, /\$entry = "\$ROOT\\app\\desktop-main\.cjs"/)
  assert.match(run, /-ArgumentList @\("`"\$entry`""\)/)

  // No entrance grows its own alternate bootstrap.
  for (const [name, source] of [['Start-DeepSeek-Harness.cmd', cmd], ['scripts/shortcuts.ps1', shortcuts], ['scripts/run.ps1', run]]) {
    assert.equal(/\bnpm ci\b/.test(source), false, `${name} must not install its own dependencies`)
    assert.equal(/app\\monitor/.test(source), false, `${name} must not reference the removed legacy app`)
  }
})

test('icon.jpg is the only source asset for the launcher icon', () => {
  const generator = read('assets/icon/generate-icon.ps1')
  assert.match(generator, /Join-Path \$root 'icon\.jpg'/)
  assert.match(generator, /ds-harness\.ico/)

  const ensure = read('scripts/ensure-icon.ps1')
  assert.match(ensure, /\$source = Join-Path \$root 'icon\.jpg'/)
  assert.match(ensure, /\$ico = Join-Path \$iconDir 'ds-harness\.ico'/)
  assert.match(ensure, /generate-icon\.ps1/)

  const shortcuts = read('scripts/shortcuts.ps1')
  assert.match(shortcuts, /ensure-icon\.ps1/)
  assert.match(shortcuts, /-Icon \$appIcon/)

  // No second, hand-maintained source icon exists.
  const rootFiles = fs.readdirSync(ROOT)
  assert.equal(rootFiles.includes('icon.jpg'), true)
  assert.equal(rootFiles.includes('icon.ico'), false)
  assert.equal(rootFiles.includes('icon.png'), false)
})

test('an icon failure degrades to an iconless launcher instead of failing the install', () => {
  const shortcuts = read('scripts/shortcuts.ps1')
  // The icon path must not be a hard failure any more.
  assert.equal(/throw "App icon missing/.test(shortcuts), false)
  assert.doesNotMatch(shortcuts, /throw[^\r\n]*ds-harness\.ico/)
  assert.match(shortcuts, /\$appIcon = ''/)
  assert.match(shortcuts, /if \(\$Icon\) \{ \$sc\.IconLocation = \$Icon \}/)
  assert.match(shortcuts, /Write-Warning 'No launcher icon available/)

  const ensure = read('scripts/ensure-icon.ps1')
  // Failure exits with a status the caller can degrade on, it does not throw.
  assert.match(ensure, /exit 1/)
  assert.match(ensure, /Write-Warning "no launcher icon available/)

  // The still-fatal case is a genuinely incomplete installation.
  assert.match(shortcuts, /throw "Electron not installed/)
})

test('installer runs the icon step before creating shortcuts and stays ASCII-only', () => {
  const install = read('scripts/install.ps1')
  assert.match(install, /ensure-icon\.ps1/)
  assert.ok(install.indexOf('ensure-icon.ps1') < install.indexOf("'shortcuts.ps1'"))
  assert.match(install, /Launcher icon could not be generated/)
  assert.equal(/[^\x00-\x7F]/.test(install.replace(/^\uFEFF/, '')), false, 'install.ps1 must stay ASCII-only')
  const ensure = read('scripts/ensure-icon.ps1').replace(/^\uFEFF/, '')
  assert.equal(/[^\x00-\x7F]/.test(ensure), false, 'ensure-icon.ps1 must stay ASCII-only')
})

test('Electron shell, tray and notifications read the same generated icon', () => {
  const main = read('app/desktop-main.cjs')
  assert.match(main, /function resolveAppIcon/)
  assert.match(main, /path\.join\(ROOT, 'assets', 'icon', 'ds-harness\.ico'\)/)
  assert.match(main, /icon: resolveAppIcon\(\)/)

  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /path\.join\(PATHS\.ICON, 'ds-harness\.ico'\)/)

  const paths = read('app/extensions/mega/utils/paths.js')
  assert.match(paths, /ICON: paths\.ICON \|\| path\.join\(ROOT, 'assets', 'icon'\)/)
})
