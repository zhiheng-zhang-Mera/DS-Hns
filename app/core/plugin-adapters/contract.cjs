'use strict'

/**
 * DS-Hns Core: the plugin *adapter* contract.
 *
 * The platform has one plugin model (`dshns.plugin/v1`) and will keep having one. What it did
 * not have is a stated way for anything that is *not* already in that model to become part of
 * it. Compatibility mode was the first attempt and it proved the shape of the problem: the
 * knowledge of "what a Cordis bundle looks like" leaked into the host, so every new external
 * format would have meant another branch in `plugin-host.cjs`.
 *
 * This module is the contract that replaces those branches. An adapter is a small, declarative
 * thing that answers three questions and does one job:
 *
 *   * **which types does it take** (`supports`) and, optionally, **does it take *this* one**
 *     (`accepts`) — that is how selection works;
 *   * **how does a plugin of that type become a `dshns.plugin/v1` plugin** (`adapt`), returning
 *     the standard descriptor the manager consumes.
 *
 * Four rules are enforced here rather than documented, because each one is a failure this
 * platform has already paid for once:
 *
 *   1. **An adapter may not invent a manifest.** Its output is validated against the same
 *      `dshns.plugin/v1` contract as a plugin that declared it by hand — the adapter is a
 *      translator, never a second source of truth.
 *   2. **An adapter may not widen its own authority.** The permissions a plugin ends up holding
 *      are decided by the *platform* from the adapter's proposal and the deployment policy, not
 *      by the adapter, and never by the plugin itself.
 *   3. **An adapter may not claim an isolation it does not provide.** Each runtime kind carries
 *      the enforcement it actually has (`advisory`, `process-boundary`, `declared-only`,
 *      `protocol`), because "the plugin declared it" and "the plugin cannot do otherwise" are
 *      different claims and the panel shows both.
 *   4. **An adapter failure is a value, never an exception.** Everything an adapter can get
 *      wrong is reported as a coded refusal, so the caller's loop over plugins cannot be broken
 *      by one bad adapter.
 */

const { PLUGIN_API_VERSION, FAULT_LEVELS, validateManifest } = require('../contracts/plugin.cjs')

/** The version an adapter declares to be loadable by this framework. */
const ADAPTER_API_VERSION = 'dshns.adapter/v1'

/**
 * How a plugin actually runs, and — the part that matters — what that buys.
 *
 * `enforcement` is the honest answer to "if this plugin ignores its permission declaration, what
 * stops it". A single "isolation: true/false" flag would blur an advisory declaration and a real
 * process boundary into one word.
 */
const RUNTIME_KINDS = Object.freeze({
  IN_PROCESS: Object.freeze({
    id: 'in-process',
    enforcement: 'advisory',
    isolation: 'none',
    summary: 'runs inside the shell process',
    detail: 'the declaration is recorded and shown, but nothing enforces it: in-process code has the process\'s own rights'
  }),
  ISOLATED_PROCESS: Object.freeze({
    id: 'isolated-process',
    enforcement: 'process-boundary',
    isolation: 'process',
    summary: 'runs in its own child process',
    detail: 'an import-time throw, a process.exit, a hang or a later crash stay in the child; the declaration is a record of what it may reach, not a sandbox'
  }),
  /**
   * A long-lived background process the host starts, watches and stops, and reaches over a declared
   * protocol. Unlike `isolated-process`, which is a plugin the host *loads*, this is a plugin the
   * host *runs*: it has its own lifetime, its own heartbeat and its own exit codes, and what it
   * offers is reached by sending it a message rather than by calling into it.
   */
  MANAGED_PROCESS: Object.freeze({
    id: 'managed-process',
    enforcement: 'protocol',
    isolation: 'process',
    summary: 'runs as a separately managed background process',
    detail: 'the host starts, watches, restarts and stops it; everything it offers is reached over a declared transport, so no host object is handed over and its capabilities are declared in its manifest rather than discovered at runtime'
  }),
  DECLARATIVE: Object.freeze({
    id: 'declarative',
    enforcement: 'declared-only',
    isolation: 'none',
    summary: 'contributes configuration and no code',
    detail: 'there is nothing to execute, so the permissions describe intent only'
  }),
  REMOTE: Object.freeze({
    id: 'remote',
    enforcement: 'protocol',
    isolation: 'network',
    summary: 'runs outside this machine behind a protocol',
    detail: 'the boundary is the protocol, and its permissions are the protocol\'s own surface'
  })
})

/** Every runtime kind id, for validation and for the panel's vocabulary. */
const RUNTIME_KIND_IDS = Object.freeze(Object.values(RUNTIME_KINDS).map((kind) => kind.id))

/**
 * The permission vocabulary: closed, documented, and the only thing an adapter may propose.
 *
 * A closed list is the point. "The plugin asked for `filesystem`" cannot be enforced, reviewed or
 * displayed; "the plugin asked for `fs.write`" can be all three. An adapter that proposes a name
 * outside this list is refused rather than accommodated, because a vocabulary that grows by
 * accident is not a vocabulary.
 */
const PERMISSIONS = Object.freeze({
  'fs.read': Object.freeze({ summary: 'read files', detail: 'read files under its own directory' }),
  'fs.write': Object.freeze({ summary: 'write files', detail: 'create or modify files under its own directory' }),
  'process.spawn': Object.freeze({ summary: 'start processes', detail: 'start child processes, which inherit this user\'s rights' }),
  network: Object.freeze({ summary: 'use the network', detail: 'make outbound connections' }),
  'bus.emit': Object.freeze({ summary: 'publish events', detail: 'publish on the shared event bus' }),
  'bus.subscribe': Object.freeze({ summary: 'subscribe to events', detail: 'subscribe to events on the shared event bus' }),
  'capability.provide': Object.freeze({ summary: 'provide capabilities', detail: 'register a capability other plugins may resolve' }),
  'capability.consume': Object.freeze({ summary: 'consume capabilities', detail: 'resolve capabilities provided by other plugins' }),
  'config.read': Object.freeze({ summary: 'read its configuration', detail: 'read its own resolved configuration block' }),
  'settings.write': Object.freeze({ summary: 'register settings', detail: 'register a settings namespace the user can edit' }),
  'worker.control': Object.freeze({ summary: 'control concurrency', detail: 'change how much work runs at once' }),
  'ui.render': Object.freeze({ summary: 'render UI', detail: 'draw into a surface the user sees' })
})

/** Every permission name, sorted, for validation and for the panel. */
const PERMISSION_IDS = Object.freeze(Object.keys(PERMISSIONS).sort())

/**
 * The fault vocabulary of the framework itself.
 *
 * These are the codes an adapter or the framework can report. They are deliberately distinct from
 * `LOAD_REASONS` in the plugin contract: "the manager refused to load a plugin" and "no adapter
 * could turn this directory into a plugin" are different support tickets.
 */
const ADAPTER_FAULT_CODES = Object.freeze({
  /** The artifact did not yield enough evidence to name a type. */
  UNDETECTED: 'ADAPTER_UNDETECTED',
  /** A type was named, but no registered adapter accepts it. */
  NO_ADAPTER: 'ADAPTER_NONE_REGISTERED',
  /** Adapters accept the type, and every one of them refused this artifact. */
  REFUSED: 'ADAPTER_REFUSED',
  /** The adapter threw instead of returning a refusal. */
  THREW: 'ADAPTER_THREW',
  /** The adapter returned something that is not a standard descriptor. */
  INVALID_OUTPUT: 'ADAPTER_INVALID_OUTPUT',
  /** The adapter's output carried a manifest the platform's own contract rejects. */
  INVALID_MANIFEST: 'ADAPTER_INVALID_MANIFEST',
  /** The plugin declared a permission that is not in the vocabulary. */
  UNKNOWN_PERMISSION: 'ADAPTER_UNKNOWN_PERMISSION',
  /** The deployment policy refused a permission the plugin declared. */
  PERMISSION_DENIED: 'ADAPTER_PERMISSION_DENIED',
  /** The adapter itself is malformed and could not be registered. */
  BAD_ADAPTER: 'ADAPTER_BAD_DEFINITION',
  /** A detector threw while examining the artifact. */
  DETECTOR_THREW: 'ADAPTER_DETECTOR_THREW',
  /** The artifact was not something any adapter could be asked about. */
  BAD_ARTIFACT: 'ADAPTER_BAD_ARTIFACT',
  /** A budget (time or count) stopped the work before it finished. */
  BUDGET_EXCEEDED: 'ADAPTER_BUDGET_EXCEEDED'
})

/** The phases an adapter fault can be attributed to, so a report says where it happened. */
const ADAPTER_PHASES = Object.freeze({
  DETECT: 'detect',
  SELECT: 'select',
  ADAPT: 'adapt',
  VALIDATE: 'validate',
  PERMISSIONS: 'permissions',
  LIFECYCLE: 'lifecycle',
  RUNTIME: 'runtime'
})

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** A coded refusal, in one shape, so no caller has to parse a message to branch on it. */
function adapterFault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

/**
 * Validate one adapter definition.
 *
 * Registration is the only place this runs, so a malformed adapter is refused once, loudly, at
 * the point somebody wrote it — rather than throwing on the first plugin that happens to select
 * it, which is how an adapter bug becomes a plugin bug.
 *
 * @param {object} adapter
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateAdapter(adapter) {
  const errors = []
  if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['an adapter must be an object'] }
  const id = String(adapter.id || '')
  if (!ID_PATTERN.test(id)) errors.push(`id "${id}" is not a valid adapter id (lowercase letters, digits, dot, dash, underscore)`)
  if (!SEMVER_PATTERN.test(String(adapter.version || ''))) errors.push(`version "${adapter.version}" is not a semantic version`)
  if (adapter.api_version !== ADAPTER_API_VERSION) {
    errors.push(`api_version must be ${ADAPTER_API_VERSION}, got ${adapter.api_version === undefined ? 'nothing' : adapter.api_version}`)
  }
  if (typeof adapter.adapt !== 'function') errors.push('adapt must be a function')
  const supports = adapter.supports
  if (!Array.isArray(supports) || supports.length === 0) {
    errors.push('supports must be a non-empty array of plugin type names')
  } else if (supports.some((type) => typeof type !== 'string' || !type.trim())) {
    errors.push('supports must contain non-empty type names')
  }
  for (const hook of ['accepts', 'describe']) {
    if (adapter[hook] !== undefined && typeof adapter[hook] !== 'function') errors.push(`${hook} must be a function when it is present`)
  }
  if (adapter.priority !== undefined && !Number.isFinite(adapter.priority)) errors.push('priority must be a number when it is present')
  return { ok: errors.length === 0, errors }
}

/** Apply the documented defaults to an adapter, so nothing downstream has to guess. */
function normalizeAdapter(adapter) {
  return {
    id: String(adapter.id),
    version: String(adapter.version),
    api_version: ADAPTER_API_VERSION,
    name: adapter.name ? String(adapter.name) : String(adapter.id),
    summary: adapter.summary ? String(adapter.summary) : null,
    supports: [...new Set((adapter.supports || []).map((type) => String(type).trim()).filter(Boolean))],
    // A higher priority wins when two adapters accept the same artifact. The default is 0, and
    // the framework never reorders equal priorities by registration time — a tie is resolved by
    // *refusing* to guess, which is stated in `select()`.
    priority: Number.isFinite(adapter.priority) ? Number(adapter.priority) : 0,
    /** The runtime kind the adapter produces, declared so selection can reason about it. */
    runtime_kind: adapter.runtime_kind ? String(adapter.runtime_kind) : RUNTIME_KINDS.IN_PROCESS.id,
    /** What the adapter promises about the plugins it produces, shown in the panel. */
    guarantees: Array.isArray(adapter.guarantees) ? adapter.guarantees.map(String) : [],
    adapt: adapter.adapt,
    accepts: typeof adapter.accepts === 'function' ? adapter.accepts : null,
    describe: typeof adapter.describe === 'function' ? adapter.describe : null
  }
}

/**
 * Check a permission list against the vocabulary.
 *
 * `declared` keeps *everything* the plugin asked for, including names the platform has no word
 * for, and `unknown` is the subset it cannot honour. Dropping the unknown ones from `declared`
 * would make an unenforceable request invisible on the surface that exists to show requests —
 * which is the opposite of what a permission display is for.
 */
function declarePermissions(list) {
  const declared = []
  const unknown = []
  for (const entry of Array.isArray(list) ? list : []) {
    const name = String(entry || '').trim()
    if (!name) continue
    if (!declared.includes(name)) declared.push(name)
    if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, name) && !unknown.includes(name)) unknown.push(name)
  }
  return { declared: declared.sort(), unknown: unknown.sort() }
}

/**
 * Decide the permissions a plugin actually holds.
 *
 * The platform decides, from three inputs and in this order: the vocabulary (is this a thing we
 * can name), the deployment's policy (does this deployment allow it), and the adapter's proposal.
 * An adapter cannot grant; a plugin cannot grant itself; a policy can only narrow.
 *
 * @param {object} input
 * @param {string[]} [input.proposed] what the adapter asked for on the plugin's behalf
 * @param {string[]} [input.declared] what the plugin declared for itself
 * @param {object} [input.policy] `{ allow?: string[], deny?: string[] }`
 */
function resolvePermissions(input = {}) {
  // A plugin's own declaration and its adapter's proposal are unioned: an adapter that knows the
  // format can see a capability the plugin never wrote down, and a plugin that is explicit is not
  // overruled by an adapter that forgot.
  const proposed = declarePermissions([...(input.proposed || []), ...(input.declared || [])])
  const policy = input.policy && typeof input.policy === 'object' ? input.policy : {}
  const allow = Array.isArray(policy.allow) ? policy.allow.map(String) : null
  const deny = new Set(Array.isArray(policy.deny) ? policy.deny.map(String) : [])

  const granted = []
  const refused = []
  for (const permission of proposed.declared) {
    // The vocabulary is checked first: a name nothing can enforce is refused for that reason,
    // whatever the policy happens to say about it.
    if (proposed.unknown.includes(permission)) {
      refused.push({ permission, reason: 'it is not in the platform\'s permission vocabulary, so nothing can honour or enforce it' })
    } else if (deny.has(permission)) {
      refused.push({ permission, reason: 'the deployment policy denies it' })
    } else if (allow && !allow.includes(permission)) {
      refused.push({ permission, reason: 'the deployment policy does not allow it' })
    } else {
      granted.push(permission)
    }
  }
  return {
    declared: proposed.declared,
    unknown: proposed.unknown,
    granted,
    refused,
    /** True when nothing was refused: the declaration is exactly what the plugin holds. */
    complete: refused.length === 0
  }
}

/**
 * The standard runtime block.
 *
 * `runtime_info` is the *live* half and is filled by the lifecycle wrapper; this is the static
 * half a manifest can carry before anything runs.
 */
function standardizeRuntime(input = {}) {
  const kind = RUNTIME_KIND_IDS.includes(String(input.kind)) ? String(input.kind) : RUNTIME_KINDS.IN_PROCESS.id
  const definition = Object.values(RUNTIME_KINDS).find((candidate) => candidate.id === kind)
  return {
    kind,
    enforcement: definition.enforcement,
    isolation: definition.isolation,
    entry: input.entry ? String(input.entry) : null,
    /** Where it came from: a repository, a local path, a built-in set. */
    source: input.source ? String(input.source) : null,
    /** What the adapter will hand the plugin, stated before it runs. */
    provides: Array.isArray(input.provides) ? input.provides.map(String) : []
  }
}

/**
 * Turn whatever an adapter produced into the one structure the platform stores.
 *
 * This is the "standardised manifest" requirement made concrete: the adapter's manifest is passed
 * through the platform's own `validateManifest` — the same one a hand-written plugin faces — and
 * the three new sections are attached to the normalized result. An adapter therefore cannot
 * smuggle in a manifest the platform would have refused from anybody else.
 *
 * @param {object} input
 * @param {object} input.manifest the adapter's proposed `dshns.plugin/v1` manifest
 * @param {object} [input.adapter] `{ id, version }` of the adapter that produced it
 * @param {string[]} [input.permissions] the adapter's proposal
 * @param {object} [input.runtime] static runtime description
 * @param {object} [input.policy] the deployment's permission policy
 * @param {object} [input.health] static health description
 * @param {number} [input.now]
 * @returns {{ok:boolean, code?:string, reason?:string, manifest?:object, permissions?:object}}
 */
function standardizeManifest(input = {}) {
  const validated = validateManifest(input.manifest)
  if (!validated.ok) {
    return adapterFault(ADAPTER_FAULT_CODES.INVALID_MANIFEST, `the adapter produced a manifest the platform refuses: ${validated.errors.join('; ')}`, {
      phase: ADAPTER_PHASES.VALIDATE,
      errors: validated.errors
    })
  }
  const manifest = validated.manifest

  // The plugin's own declaration lives under `manifest.permissions`; the adapter's proposal is
  // separate input. Both are honoured, and the resolution is the platform's.
  //
  // The manifest here has already been through the platform's `validateManifest`, so its
  // permission block is the *normalised* one: an author's `declares` has been folded into
  // `declared` by then, which is the spelling to read.
  const own = manifest.permissions && Array.isArray(manifest.permissions.declared) ? manifest.permissions.declared : []
  const permissions = resolvePermissions({
    proposed: input.permissions,
    declared: own,
    policy: input.policy
  })

  manifest.permissions = permissions
  manifest.runtime = standardizeRuntime({
    ...(input.runtime || {}),
    kind: (input.runtime && input.runtime.kind) || (input.adapter && input.adapter.runtime_kind) || RUNTIME_KINDS.IN_PROCESS.id
  })
  manifest.adapter = {
    id: input.adapter ? String(input.adapter.id) : 'dshns.native',
    version: input.adapter ? String(input.adapter.version) : '0.0.0',
    api_version: ADAPTER_API_VERSION,
    /** When the artifact was not in the platform's own format, say which format it was. */
    source_format: input.sourceFormat ? String(input.sourceFormat) : null,
    adapted_at: typeof input.now === 'function' ? input.now() : Date.now()
  }
  manifest.health = {
    contract: input.health && input.health.contract ? String(input.health.contract) : 'none',
    detail: input.health && input.health.detail ? String(input.health.detail) : 'the plugin implements no healthCheck'
  }
  return { ok: true, manifest, permissions }
}

/**
 * Check the object an adapter returned, before the framework attaches anything to it.
 *
 * An adapter's output is untrusted in exactly the way a plugin is: it is third-party code that
 * runs before the platform has decided anything. Everything the framework needs is required here,
 * by name, so a malformed adapter is a coded refusal rather than a `undefined is not a function`
 * three frames later.
 */
function validateAdapterOutput(output, adapterId) {
  if (!output || typeof output !== 'object') {
    return adapterFault(ADAPTER_FAULT_CODES.INVALID_OUTPUT, `adapter ${adapterId} returned ${output === null ? 'null' : typeof output} instead of a descriptor`)
  }
  if (!output.manifest || typeof output.manifest !== 'object') {
    return adapterFault(ADAPTER_FAULT_CODES.INVALID_OUTPUT, `adapter ${adapterId} returned a descriptor with no manifest`)
  }
  for (const hook of ['install', 'load', 'unload', 'healthCheck', 'runtimeInfo']) {
    if (output[hook] !== undefined && typeof output[hook] !== 'function') {
      return adapterFault(ADAPTER_FAULT_CODES.INVALID_OUTPUT, `adapter ${adapterId} returned a ${hook} that is not a function`)
    }
  }
  return { ok: true }
}

module.exports = {
  ADAPTER_API_VERSION,
  ADAPTER_FAULT_CODES,
  ADAPTER_PHASES,
  RUNTIME_KINDS,
  RUNTIME_KIND_IDS,
  PERMISSIONS,
  PERMISSION_IDS,
  PLUGIN_API_VERSION,
  FAULT_LEVELS,
  adapterFault,
  validateAdapter,
  normalizeAdapter,
  declarePermissions,
  resolvePermissions,
  standardizeRuntime,
  standardizeManifest,
  validateAdapterOutput
}
