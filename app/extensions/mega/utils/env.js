'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { ROOT } = require('./paths')

/**
 * Minimal .env loader. Applies only variables that are not already present in
 * process.env so a caller-provided environment always wins.
 */
function loadEnvFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const applied = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
      applied.push(key)
    }
  }
  return applied
}

/** Loads <project root>\config\.env when present (no secret output). */
function loadProjectEnv() {
  return loadEnvFile(path.join(ROOT, 'config', '.env'))
}

module.exports = { loadEnvFile, loadProjectEnv }
