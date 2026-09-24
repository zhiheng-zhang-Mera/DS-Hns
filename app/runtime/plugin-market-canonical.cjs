'use strict'

const fs = require('node:fs')
const path = require('node:path')

const SUPPORTED_VERSION = '0.4.7'
const SERVER_MARKER = '/* dshns:canonical-installed-rows */'
const CLIENT_MARKER = '/* dshns:installed-row-providers */'

/** One market identity, retaining every discovery provider as provenance. */
function canonicalizeInstalledRows(rows) {
  const aliases = {
    'dshns.health-scheduler': 'dsh-health-scheduler',
    'dshns.restart-supervisor': 'dsh-restart-supervisor',
    'dshns.mega': 'dsh-plugin-mega-core',
    mega: 'dsh-plugin-mega-core'
  }
  const canonical = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const local = String(row?.localName || '').toLowerCase()
    const key = row?.pluginId ? `market:${String(row.pluginId).toLowerCase()}` : `package:${aliases[local] || local}`
    const provider = row?.source || 'unknown'
    if (!canonical.has(key)) canonical.set(key, { ...row, providers: [provider] })
    else {
      const kept = canonical.get(key)
      if (!kept.providers.includes(provider)) kept.providers.push(provider)
      if (!kept.plugin && row.plugin) kept.plugin = row.plugin
      if (!kept.version && row.version) kept.version = row.version
    }
  }
  return [...canonical.values()]
}

function replaceOnce(source, before, after, file) {
  if (source.includes(after)) return source
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Plugin Market ${SUPPORTED_VERSION} patch signature drifted in ${file}`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function writeAtomic(file, content) {
  const temporary = `${file}.dshns-${process.pid}.tmp`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, file)
}

/**
 * Patch only the pinned materialized package. This is deliberately version- and
 * signature-gated: an upstream update must be reviewed instead of silently
 * receiving a transform written for another build.
 */
function patchPluginMarket({ profileDir, log = () => {} } = {}) {
  const packageDir = path.join(String(profileDir || ''), 'node_modules', '@dsh-market', 'plugin')
  const manifestFile = path.join(packageDir, 'package.json')
  if (!fs.existsSync(manifestFile)) return { state: 'absent', changed: false }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(`Plugin Market canonical identity supports ${SUPPORTED_VERSION}, found ${manifest.version || 'unknown'}`)
  }

  const serverFile = path.join(packageDir, 'lib', 'index.js')
  const clientFile = path.join(packageDir, 'lib', 'client.js')
  let server = fs.readFileSync(serverFile, 'utf8')
  let client = fs.readFileSync(clientFile, 'utf8')
  const alreadyPatched = server.includes(SERVER_MARKER) && client.includes(CLIENT_MARKER)
  if (alreadyPatched) return { state: 'patched', changed: false, version: manifest.version }

  const applySignature = 'function apply(ctx) {'
  const canonicalSource = `${SERVER_MARKER}\nconst canonicalInstalled = ${canonicalizeInstalledRows.toString()}\n`
  server = replaceOnce(server, applySignature, `${canonicalSource}${applySignature}`, serverFile)
  server = replaceOnce(
    server,
    'case "installed": return (await market()).plugins && scanInstalled(cfg, await market()).map((i) => ({',
    'case "installed": return (await market()).plugins && canonicalInstalled(scanInstalled(cfg, await market())).map((i) => ({',
    serverFile
  )

  const oldMeta = '`${i.version ?? "未知版本"} · ${i.source === "skills" ? "skill" : "profile"}`'
  const newMeta = '`${i.version ?? "未知版本"} · ${(i.providers?.length ? i.providers : [i.source === "skills" ? "skill" : "profile"]).join(" + ")}`'
  client = replaceOnce(client, oldMeta, `${CLIENT_MARKER}${newMeta}`, clientFile)

  writeAtomic(serverFile, server)
  writeAtomic(clientFile, client)
  log(`[plugin-market] canonical installed identity patch applied to ${manifest.version}`)
  return { state: 'patched', changed: true, version: manifest.version }
}

module.exports = { SUPPORTED_VERSION, canonicalizeInstalledRows, patchPluginMarket }
