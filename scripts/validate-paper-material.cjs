'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseJsonText, countChecks, countFailures } = require('./evidence-consistency.cjs')

function readCatalog(root) {
  const base = path.join(root, 'docs/paper-material')
  return {
    claims: parseJsonText(fs.readFileSync(path.join(base, 'data/claims.json'), 'utf8')).claims,
    experiments: parseJsonText(fs.readFileSync(path.join(base, 'data/experiments.json'), 'utf8')).experiments,
    narrative: fs.readFileSync(path.join(base, '03-CONTRIBUTION-CLAIMS.md'), 'utf8'),
    matrix: fs.readFileSync(path.join(base, '04-CLAIM-EVIDENCE-MATRIX.md'), 'utf8')
  }
}

function validateCatalog(root, catalog) {
  const errors = []
  function local(file) {
    if (typeof file !== 'string' || !file) return null
    const resolved = path.resolve(root, file)
    const rel = path.relative(path.resolve(root), resolved)
    return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : resolved
  }
  const exists = file => { const p = local(file); return p && fs.existsSync(p) }
  function json(file) {
    if (!exists(file)) { errors.push(`EVIDENCE_NOT_FOUND:${file}`); return null }
    try { return parseJsonText(fs.readFileSync(local(file), 'utf8')) }
    catch { errors.push(`INVALID_EVIDENCE_JSON:${file}`); return null }
  }
  const experimentIds = new Set(catalog.experiments.map(e => e.id))
  if (experimentIds.size !== catalog.experiments.length) errors.push('DUPLICATE_EXPERIMENT_ID')
  const claimIds = new Set()
  const narrativeTitles = new Map([...catalog.narrative.matchAll(/\*\*(C\d+) — ([^*]+)\*\*/g)].map(m => [m[1], m[2].replace(/\.$/, '')]))
  const matrixTitles = new Map(catalog.matrix.split('\n').filter(line => /^\| C\d+ \|/.test(line)).map(line => { const cells = line.split('|').map(s => s.trim()); return [cells[1], cells[2]] }))
  for (const claim of catalog.claims) {
    if (claimIds.has(claim.id)) errors.push(`DUPLICATE_CLAIM_ID:${claim.id}`)
    claimIds.add(claim.id)
    if (!claim.title || narrativeTitles.get(claim.id) !== claim.title || matrixTitles.get(claim.id) !== claim.title) errors.push(`CLAIM_TITLE_MISMATCH:${claim.id}`)
    for (const file of [...claim.code, ...claim.tests, ...(claim.artifacts || [])]) if (!exists(file)) errors.push(`SOURCE_NOT_FOUND:${claim.id}:${file}`)
    for (const id of claim.experiments) if (!experimentIds.has(id)) errors.push(`UNKNOWN_EXPERIMENT:${claim.id}:${id}`)
    if (claim.status === 'SUPPORTED_ENGINEERING' && (!claim.code.length || !claim.tests.length || !claim.artifacts?.length)) errors.push(`UNSUPPORTED_EVIDENCE_CLAIM:${claim.id}`)
  }
  for (const experiment of catalog.experiments) {
    const evidence = experiment.evidence
    if (!evidence) {
      if (experiment.status.startsWith('PASS') && !exists(experiment.artifact)) errors.push(`UNBOUND_EXPERIMENT:${experiment.id}`)
      if (experiment.id === 'E-PHASE-C') {
        const report = json(experiment.artifact)
        if (report && report.gitSha !== experiment.commit) errors.push(`EXPERIMENT_SHA_MISMATCH:${experiment.id}`)
      }
      continue
    }
    const summary = json(evidence.summary)
    const report = json(experiment.artifact)
    if (!summary || !report) continue
    const child = summary.results.find(r => r.id === evidence.childId)
    if (!child) { errors.push(`CHILD_NOT_FOUND:${experiment.id}`); continue }
    if (experiment.commit !== summary.gitSha || evidence.runId !== summary.runId || evidence.gitTree !== summary.gitTree || child.gitSha !== summary.gitSha || child.runId !== summary.runId) errors.push(`EXPERIMENT_SHA_MISMATCH:${experiment.id}`)
    if (evidence.runPassed !== summary.passed) errors.push(`EXPERIMENT_RUN_VERDICT_MISMATCH:${experiment.id}`)
    if (experiment.status.startsWith('PASS') !== child.passed || child.passed !== (child.exitCode === 0)) errors.push(`EXPERIMENT_VERDICT_MISMATCH:${experiment.id}`)
    if (experiment.aggregate?.checks !== child.checks || experiment.aggregate?.failures !== child.failures) errors.push(`EXPERIMENT_COUNT_MISMATCH:${experiment.id}`)
    const reportChecks = countChecks(report), reportFailures = countFailures(report)
    if ((reportChecks !== null && reportChecks !== child.checks) || (reportFailures !== null && reportFailures !== child.failures)) errors.push(`REPORT_COUNT_MISMATCH:${experiment.id}`)
    for (const [file, expected] of [[evidence.summary, evidence.summarySha256], [experiment.artifact, evidence.reportSha256]]) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(local(file))).digest('hex')
      if (actual !== expected) errors.push(`EVIDENCE_HASH_MISMATCH:${experiment.id}:${file}`)
    }
  }
  return errors
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..')
    const errors = validateCatalog(root, readCatalog(root))
    console.log(JSON.stringify({ passed: errors.length === 0, errors }, null, 2))
    process.exitCode = errors.length ? 1 : 0
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { readCatalog, validateCatalog }
