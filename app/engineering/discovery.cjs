'use strict'

/**
 * Engineering Runtime: project discovery.
 *
 * Discovery answers three questions before any code is touched:
 *
 *   what kind of project is this?      (adapters)
 *   what does *this* project require?  (instruction precedence)
 *   what command does each operation run, and how sure are we? (the command table)
 *
 * The precedence is the one the plan states and it is not negotiable:
 *
 *   Execution Contract  >  repository instructions  >  project configuration  >  runtime defaults
 *
 * A contract that names `npm test` wins over a `Makefile` that says `make check`.
 * A repository that says "run `scripts/verify.ps1` before committing" is read
 * before the runtime's own convention. Where a command is *inferred* rather than
 * declared, the inference and its evidence are both recorded, because an inferred
 * command the runtime cannot explain is a command nobody can trust.
 */

const path = require('node:path')
const fs = require('node:fs')
const { defaultAdapters, OPERATIONS, CONFIDENCE } = require('./adapters/index.cjs')
const repository = require('./repository.cjs')

/**
 * Detect the project type.
 *
 * Every adapter is asked, the best score wins, and the runner-up is kept so the
 * record shows what else the repository looked like.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {object[]} [options.adapters]
 * @returns {{adapter:object, id:string, language:string, detections:object[]}}
 */
function detectProject(root, options = {}) {
  const adapters = Array.isArray(options.adapters) && options.adapters.length ? options.adapters : defaultAdapters()
  const detections = []
  for (const adapter of adapters) {
    let result = null
    try {
      result = adapter.detect(root)
    } catch (error) {
      result = null
    }
    if (result) detections.push({ id: adapter.id, score: result.score, evidence: result.evidence, adapter })
  }
  detections.sort((a, b) => b.score - a.score)
  const best = detections[0] || { id: 'generic', language: 'unknown', evidence: 'nothing to detect', adapter: adapters[adapters.length - 1] }
  return {
    id: best.id,
    language: best.language,
    evidence: best.evidence,
    adapter: best.adapter,
    // The runner-up is context, not a fallback: the runtime does not switch
    // adapters mid-episode because a command failed.
    others: detections.slice(1).map((entry) => ({ id: entry.id, score: entry.score, evidence: entry.evidence }))
  }
}

/**
 * Read the repository's engineering instructions, in precedence order.
 *
 * Each entry carries a bounded excerpt: the runtime's context is not a place to
 * paste a repository.
 */
function discoverInstructions(root, snapshot = null) {
  const source = snapshot || repository.snapshot({ root })
  const priority = {
    'AGENTS.md': 1,
    'CLAUDE.md': 2,
    'CONTRIBUTING.md': 3,
    'README.md': 4,
    'README': 4,
    'CODE_OF_CONDUCT.md': 5
  }
  return source.instructions
    .map((entry) => ({ ...entry, priority: priority[entry.file] || (entry.file.startsWith('docs/') ? 6 : 7) }))
    .sort((a, b) => a.priority - b.priority || a.file.localeCompare(b.file))
    .map((entry) => ({ ...entry, kind: 'repository-instruction', source: 'repository' }))
}

/**
 * Build the command table for one repository.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {object} [input.project] output of `detectProject`
 * @param {object} [input.contract] the execution contract's `engineering` block
 * @returns {{operations:object, packages:object, project:object, sources:object}}
 */
function discoverCommands(input = {}) {
  const root = input.root
  const project = input.project || detectProject(root)
  let adapterCommands = {}
  try {
    adapterCommands = project.adapter.commands(root) || {}
  } catch (error) {
    adapterCommands = {}
  }
  const declared = input.contract && typeof input.contract === 'object' ? input.contract : {}
  const operations = {}
  const sources = {}
  for (const name of OPERATIONS) {
    const fromContract = declared[name]
    if (fromContract) {
      operations[name] = normalizeCommand(fromContract, name, 'contract')
      sources[name] = 'contract'
      continue
    }
    const fromAdapter = adapterCommands[name]
    if (fromAdapter) {
      operations[name] = normalizeCommand(fromAdapter, name, 'project')
      sources[name] = fromAdapter.confidence || CONFIDENCE.DECLARED
    }
  }
  return {
    project: { id: project.id, language: project.language, evidence: project.evidence, others: project.others },
    operations,
    sources,
    /** The adapter's own names for the same things, for the episode record. */
    adapterId: project.id
  }
}

/** Normalize a command into the one shape the supervisor executes. */
function normalizeCommand(input, operation, origin) {
  if (typeof input === 'string') {
    return {
      operation,
      command: input,
      cwd: null,
      acceptsFocus: operation === 'focusedTest',
      longRunning: false,
      confidence: origin === 'contract' ? CONFIDENCE.DECLARED : CONFIDENCE.CONVENTION,
      evidence: `${origin} declares ${operation}`,
      origin
    }
  }
  return {
    operation,
    command: String(input.command || ''),
    cwd: input.cwd ? String(input.cwd) : null,
    acceptsFocus: input.acceptsFocus === true,
    longRunning: input.longRunning === true,
    confidence: origin === 'contract' ? CONFIDENCE.DECLARED : (input.confidence || CONFIDENCE.DECLARED),
    evidence: input.evidence || `${origin} declares ${operation}`,
    origin
  }
}

/**
 * Full discovery: the repository snapshot, the project, the instructions and the
 * command table, in one object the episode carries.
 */
function discover(root, options = {}) {
  const snapshot = options.snapshot || repository.snapshot({ root, now: options.now })
  const project = detectProject(root, options)
  const commands = discoverCommands({
    root,
    project,
    contract: options.contract ? options.contract.commands || options.contract : null
  })
  return {
    root,
    snapshot,
    project: commands.project,
    instructions: discoverInstructions(root, snapshot),
    commands: commands.operations,
    commandSources: commands.sources,
    /** Every command the repository declares, whether or not the loop needs it. */
    ci: snapshot.ci,
    packageScripts: snapshot.packageScripts,
    /** Where the evidence for each command came from, for the record. */
    evidence: {
      project: project.evidence,
      otherProjects: project.others,
      manifests: snapshot.manifests,
      instructions: snapshot.instructions.map((entry) => entry.file),
      ci: snapshot.ci
    }
  }
}

/** The instruction files the runtime is required to have read, for the record. */
function requiredInstructions(root) {
  return repository.INSTRUCTION_FILES.filter((name) => fs.existsSync(path.join(root, name)))
}

module.exports = {
  OPERATIONS,
  CONFIDENCE,
  detectProject,
  discoverInstructions,
  discoverCommands,
  normalizeCommand,
  discover,
  requiredInstructions
}
