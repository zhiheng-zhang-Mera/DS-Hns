'use strict'
/**
 * The Harness profile's copy of the plugin DS-Hns ships, refreshed before the Harness starts.
 *
 * DS-Hns ships one client plugin (`app/plugins/mega-core`) into the Harness' own profile install
 * (`data/profiles/<profile>/node_modules/dsh-plugin-mega-core`), and nothing has kept the two in
 * step on its own: pnpm materialises a `file:` dependency as a plain copy, so a rebuilt host half
 * or a rebuilt browser bundle reaches the profile only when something copies it there. The previous
 * round did that by hand — its own note says the profile's `lib/` "已同步为新的 index.js /
 * client.js" — and the same hand carried the package manifest into `lib/` along with the two halves.
 *
 * That stray file is not cosmetic. The Harness composes a client plugin's bundle by walking up from
 * the module it mounted until it finds a manifest that names the package
 * (`@deepseek-ai/dsh-client-modules`, `nearestPackage`). A manifest *inside* the package is nearer
 * than the package's own, so the walk stops one directory too high and the bundle is looked for at
 * `dsh-plugin-mega-core/lib/lib/client.js`. The plugin tree then fails to compose, the Harness exits
 * 1 before it announces its URL, and the window opens on a shell with no official UI behind it.
 *
 * So the launch refreshes this one package: the files the package declares are written in, and
 * anything the package does not declare is removed — including any manifest below the root that
 * repeats the package's own name, wherever it sits. This is the only place the shell writes into
 * another application's install, and it is confined to DS-Hns' own plugin's own files: the profile
 * copy is exactly the shipped package, or the product ships one thing and runs another.
 */
const fs = require('node:fs')
const path = require('node:path')

/** Directories never walked when looking for a manifest that shadows a package root. */
const WALK_SKIP = new Set(['node_modules', '.git'])

/** Parse a manifest, or `null` when it is missing or is not an object. */
function readManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Whether two files hold the same bytes (a missing file is never equal). */
function sameContent(left, right) {
  try {
    const a = fs.readFileSync(left)
    const b = fs.readFileSync(right)
    return a.length === b.length && a.equals(b)
  } catch {
    return false
  }
}

/**
 * The relative files a package manifest says the package ships.
 *
 * A `files` entry that is a directory or a glob is skipped: this sync copies named files, and a
 * pattern would make "what the package ships" a question the copy would have to guess at.
 */
function shippedFiles(manifest) {
  const declared = Array.isArray(manifest?.files) ? manifest.files : []
  return declared
    .map((entry) => String(entry).replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((entry) => entry && !entry.endsWith('/') && !/[*?[\]]/.test(entry) && !path.isAbsolute(entry) && !entry.split('/').includes('..'))
}

/**
 * Every manifest below `packageDir` (its root manifest excepted) that claims to be the package.
 *
 * Such a file is what stops the Harness' bundle walk early, so it is the thing to find rather than
 * to live with. Directories that cannot hold a package of their own (`node_modules`, `.git`) are
 * not walked.
 *
 * @param packageDir - the package's installed directory.
 * @param packageName - the name its root manifest declares.
 * @returns absolute paths of the shadowing manifests.
 */
function shadowManifests(packageDir, packageName) {
  const found = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) walk(full)
        continue
      }
      if (entry.name !== 'package.json') continue
      const manifest = readManifest(full)
      if (manifest && manifest.name === packageName) found.push(full)
    }
  }
  for (const entry of readDirectory(packageDir)) {
    if (entry.isDirectory()) {
      if (!WALK_SKIP.has(entry.name)) walk(path.join(packageDir, entry.name))
    }
  }
  return found
}

/** `readdirSync` with types, answering an empty list for anything unreadable. */
function readDirectory(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Make the profile's copy of a shipped package hold exactly what the package declares.
 *
 * @param options.sourceDir - the package DS-Hns ships (`app/plugins/mega-core`).
 * @param options.modulesDir - the profile's `node_modules`, where a package of that name is looked for.
 * @param options.log - sink for a repair that could not be made; the launch continues either way.
 * @returns the target-relative paths that changed, in the order they were brought into line.
 */
function syncShippedPackage({ sourceDir, modulesDir, log = () => {} }) {
  const sourceManifest = readManifest(path.join(sourceDir, 'package.json'))
  if (!sourceManifest || typeof sourceManifest.name !== 'string' || !sourceManifest.name) return []
  const targetDir = path.join(modulesDir, sourceManifest.name)
  // A profile that has not installed the package is not this function's business: installing is the
  // Harness' own CLI's job, and a copy that does not exist cannot be stale.
  if (!fs.existsSync(targetDir)) return []

  const changed = []
  const shipped = shippedFiles(sourceManifest)

  const write = (relative) => {
    const from = path.join(sourceDir, relative)
    const to = path.join(targetDir, relative)
    let stat
    try {
      stat = fs.statSync(from)
    } catch {
      return
    }
    if (!stat.isFile()) return
    if (sameContent(from, to)) return
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      changed.push(relative)
    } catch (error) {
      log(`[profile] ${relative} could not be refreshed: ${error?.message || error}`)
    }
  }

  // The manifest first: every other path in the package is resolved from it, and the Harness reads
  // it to find the bundle this same repair exists to keep findable.
  write('package.json')
  for (const relative of shipped) write(relative)

  // A manifest that repeats the package's own name below its root.
  for (const shadow of shadowManifests(targetDir, sourceManifest.name)) {
    const relative = path.relative(targetDir, shadow).replace(/\\/g, '/')
    try {
      fs.rmSync(shadow, { force: true })
      changed.push(`${relative} (a second manifest for this package)`)
    } catch (error) {
      log(`[profile] ${relative} could not be removed: ${error?.message || error}`)
    }
  }

  // Leftovers in the directories that hold shipped files: a stale half from an earlier sync, or a
  // copy that arrived with one. Only files are removed, and only where the package said what belongs.
  for (const dir of new Set(shipped.map((relative) => path.posix.dirname(relative)).filter((dir) => dir && dir !== '.'))) {
    const kept = new Set(shipped.filter((relative) => path.posix.dirname(relative) === dir).map((relative) => path.posix.basename(relative)))
    for (const entry of readDirectory(path.join(targetDir, dir))) {
      if (!entry.isFile() || kept.has(entry.name)) continue
      const relative = `${dir}/${entry.name}`
      try {
        fs.rmSync(path.join(targetDir, dir, entry.name), { force: true })
        changed.push(`${relative} (not part of the shipped package)`)
      } catch (error) {
        log(`[profile] ${relative} could not be removed: ${error?.message || error}`)
      }
    }
  }

  return changed
}

module.exports = { syncShippedPackage, shadowManifests, shippedFiles }
