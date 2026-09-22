'use strict'

const fs = require('node:fs')
const path = require('node:path')

function countChecks(report) {
  if (Array.isArray(report?.checks)) return report.checks.length
  if (Number.isFinite(report?.checks)) return Number(report.checks)
  if (Number.isFinite(report?.summary?.checks)) return Number(report.summary.checks)
  return null
}

function countFailures(report) {
  if (Number.isFinite(report?.failures)) return Number(report.failures)
  if (Number.isFinite(report?.summary?.failed)) return Number(report.summary.failed)
  if (Array.isArray(report?.checks)) return report.checks.filter((entry) => entry?.ok === false).length
  return null
}

function reportPassed(report) {
  if (typeof report?.passed === 'boolean') return report.passed
  if (report?.summary?.verdict) return report.summary.verdict === 'ACCEPTED'
  const failures = countFailures(report)
  return failures === null ? null : failures === 0
}

function validateQualification(summary, { runDir } = {}) {
  const errors = []
  const absoluteRunDir = path.resolve(runDir || '.')
  const start = Date.parse(summary?.startedAt)
  const end = Date.parse(summary?.completedAt)
  if (!summary?.runId) errors.push('summary runId is missing')
  if (!/^[0-9a-f]{40}$/i.test(String(summary?.gitSha || ''))) errors.push('summary gitSha is invalid')
  if (!/^[0-9a-f]{40}$/i.test(String(summary?.gitTree || ''))) errors.push('summary gitTree is invalid')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) errors.push('summary timestamps are invalid')
  if (!Array.isArray(summary?.results) || summary.results.length === 0) errors.push('summary has no child results')

  for (const result of summary?.results || []) {
    const label = result?.id || '<unnamed>'
    if (result.runId !== summary.runId) errors.push(`${label}: runId mismatch`)
    if (result.gitSha !== summary.gitSha) errors.push(`${label}: gitSha mismatch`)
    if (result.gitTree !== summary.gitTree) errors.push(`${label}: gitTree mismatch`)
    const childStart = Date.parse(result.startedAt)
    const childEnd = Date.parse(result.completedAt)
    if (!Number.isFinite(childStart) || !Number.isFinite(childEnd) || childEnd < childStart || childStart < start || childEnd > end) {
      errors.push(`${label}: timestamps fall outside the qualification run`)
    }
    if (!Number.isInteger(result.exitCode)) errors.push(`${label}: exitCode is missing`)
    if (result.passed !== (result.exitCode === 0)) errors.push(`${label}: passed contradicts exitCode`)

    if (result.report) {
      const reportFile = path.resolve(result.report)
      const relative = path.relative(absoluteRunDir, reportFile)
      if (relative.startsWith('..') || path.isAbsolute(relative)) errors.push(`${label}: report is outside the immutable run directory`)
      else if (!fs.existsSync(reportFile)) errors.push(`${label}: report does not exist`)
      else {
        let report
        try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) } catch { errors.push(`${label}: report is not valid JSON`) }
        if (report) {
          const artifactPass = reportPassed(report)
          if (artifactPass !== null && artifactPass !== (result.exitCode === 0)) errors.push(`${label}: child report passed state contradicts exitCode`)
          const checks = countChecks(report)
          const failures = countFailures(report)
          if (result.checks !== null && checks !== null && result.checks !== checks) errors.push(`${label}: checks total mismatch`)
          if (result.failures !== null && failures !== null && result.failures !== failures) errors.push(`${label}: failure total mismatch`)
          if (checks !== null && failures !== null && (failures < 0 || failures > checks)) errors.push(`${label}: impossible check/failure totals`)
        }
      }
    }
  }

  const mandatoryFailures = (summary?.results || []).filter((entry) => entry.mandatory !== false && !entry.passed).length
  if (summary?.mandatoryFailures !== mandatoryFailures) errors.push('top-level mandatory failure count mismatch')
  if (summary?.passed !== (mandatoryFailures === 0)) errors.push('top-level passed state contradicts mandatory child results')
  return { ok: errors.length === 0, code: errors.length ? 'QUALIFICATION_EVIDENCE_INCONSISTENT' : 'PASS', errors }
}

function main(argv) {
  const file = argv[0]
  if (!file) throw new Error('usage: node scripts/evidence-consistency.cjs <summary.json>')
  const absolute = path.resolve(file)
  const summary = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  const result = validateQualification(summary, { runDir: path.dirname(absolute) })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.ok ? 0 : 1
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    process.exitCode = 1
  }
}

module.exports = { countChecks, countFailures, reportPassed, validateQualification }
