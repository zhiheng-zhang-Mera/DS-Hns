'use strict'
/**
 * Theme engine test support: the sandbox prelude and the two runners.
 *
 * Kept out of the test file so the test file itself stays declarative: it lists
 * scenarios as data, which is what makes the assertions readable.
 */
const assert = require('node:assert/strict')
const { runInSandbox, stepsScript, runScenarios } = require('./theme-sandbox.cjs')

/** Child-process setup injected into every scenario. */
const SANDBOX_MODULES = `
  const app = APP
  const engineModule = requireApp('extensions/mega/theme')
  const contract = requireApp('extensions/mega/theme/contract')
  const surfaceModule = requireApp('extensions/mega/theme/surface')
  const pngModule = requireApp('extensions/mega/theme/png')
  const assetValidator = requireApp('extensions/mega/theme/assets/validator')
  const overlayLayout = requireApp('extensions/mega/theme/official/overlay-layout')
  const overlaySafety = requireApp('extensions/mega/theme/official/overlay-safety')
  const crypto = require('node:crypto')
  const fs = require('node:fs')
  const path = require('node:path')
`

/**
 * Run a single scenario (a map of stepId -> code) in its own throwaway root and
 * return the results flattened by step id.
 *
 * @param {Record<string, string>} steps
 * @returns {Record<string, any>}
 */
function runOne(steps) {
  const stepList = Object.keys(steps).map((id) => ({ id, code: steps[id] }))
  const result = runInSandbox(stepsScript(stepList, SANDBOX_MODULES))
  assert.ok(
    result.ok,
    `sandbox run failed (status ${result.status})\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`
  )
  return result.value
}

/**
 * Run one scenario per throwaway project root.
 *
 * Installing a theme is a filesystem side effect, so every scenario starts from a
 * fresh project root; sharing one would let an earlier scenario's installed theme
 * leak into a later one's assertions.
 *
 * @param {Record<string, Record<string, string>>} scenarios
 * @returns {Record<string, any>} flattened by step id
 */
function runEach(scenarios) {
  return runScenarios(scenarios, SANDBOX_MODULES)
}

module.exports = { SANDBOX_MODULES, runOne, runEach }
