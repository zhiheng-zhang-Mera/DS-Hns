'use strict'

/**
 * Instance Identity.
 *
 * DS-Hns is no longer assumed to be a single process tree on a machine. Two
 * checkouts, a scratch acceptance copy and the developer's own installation, may
 * legitimately run at the same time — and nothing about them may collide.
 *
 * This module is the one place that answers "which DS-Hns instance am I?" and
 * derives every filesystem and IPC name from that answer. Everything derived is:
 *
 *   - **stable**: the same root yields the same id on every run and every host,
 *     so ownership records, sockets and userData survive a restart;
 *   - **independent**: a different root yields a different id, so two instances
 *     cannot share a port, a pipe, a lock file or a browser profile;
 *   - **reversible**: the id is a pure function of the canonical root, so it can
 *     be recomputed rather than remembered, and a stale record can be proven to
 *     belong to this instance before anything is killed.
 *
 * The identity is a hash of the *canonical* root, not of the ambient path
 * spelling, so `D:\DS-Hns` and `d:\ds-hns\` and a subst drive all resolve to the
 * same instance. That is what makes the id safe to use as an ownership key.
 *
 * Nothing here requires Electron, and nothing here reads or writes the
 * environment globally: an instance is a value you pass around, not a global
 * side effect. That is what lets the Runtime Host and the Desktop Client agree on
 * an identity without either one owning the other.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')

/** The protocol the Runtime Host and the Desktop Client speak. */
const PROTOCOL_VERSION = 'dshns-runtime/v1'

/** Bumped when the derived layout changes in a way a reader must notice. */
const IDENTITY_VERSION = 1

/** The identity hash is 16 hex characters: long enough to avoid collisions, short enough to read. */
const INSTANCE_ID_LENGTH = 16

/**
 * Case-fold a Windows path for *comparison and hashing*.
 *
 * Windows path comparison is case-insensitive, so `D:\DS-Hns` and `D:\ds-hns`
 * are the same checkout and must produce the same instance id. A POSIX path is
 * case-sensitive and is left alone.
 *
 * This form is **never** used as a filesystem path. Lower-casing a path and then
 * opening it happens to work on a case-insensitive volume and silently fails on a
 * case-sensitive one, and — more importantly — it produces a path whose spelling
 * does not match what the operating system reports back, which makes two
 * processes disagree about where they are. `resolveRoot` is what produces a path
 * to *use*; this produces a path to *compare*.
 */
function canonicalize(target) {
  if (target === undefined || target === null || String(target).trim() === '') return ''
  let resolved
  try {
    resolved = path.resolve(String(target))
  } catch {
    return ''
  }
  const normalized = resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * A filesystem path for an instance root, in the operating system's own spelling.
 *
 * The tail of an instance root often does not exist yet — the installer, a test,
 * or a brand-new acceptance directory creates it later — so the path is resolved
 * by walking up to the deepest existing ancestor, taking *that* directory's real
 * spelling from the filesystem, and re-appending the missing segments. Two
 * processes therefore agree on the root whether or not it exists yet, on a
 * case-insensitive volume or a case-sensitive one.
 *
 * Falls back to plain `path.resolve` when nothing along the path exists, which is
 * the best available answer and is still consistent between processes.
 */
function resolveRoot(target) {
  if (target === undefined || target === null || String(target).trim() === '') return ''
  let resolved
  try {
    resolved = path.resolve(String(target))
  } catch {
    return ''
  }
  const tail = []
  let cursor = resolved
  for (;;) {
    try {
      const real = fs.realpathSync.native(cursor)
      const joined = tail.length ? path.join(real, ...tail.reverse()) : real
      return joined.replace(/[\\/]+$/, '') || real
    } catch {
      const parent = path.dirname(cursor)
      // Walked past the root of the volume without finding anything that exists.
      if (parent === cursor) return resolved.replace(/[\\/]+$/, '') || resolved
      tail.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/** A filesystem- and pipe-safe slug. Never empty, never contains a separator. */
function slugify(value, fallback = 'instance') {
  const text = String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return text || fallback
}

/**
 * The stable instance id: a hash of everything that makes two instances distinct.
 *
 * The inputs are exactly the things that change a derived path or endpoint:
 *
 *   root          which checkout
 *   dshHome       which data directory — so one checkout served from two homes is
 *                 two instances, not one
 *   appName       the run's name — so two differently-named runs of one checkout
 *                 do not share a lock or a pipe
 *   userDataDir   an explicit Electron userData — so a caller that names its own
 *                 does not collide with the derived one
 *
 * Leaving any of these out was a real bug found by running the code rather than
 * by reading it. The id names the IPC endpoint, the Electron `userData` and
 * therefore the single-instance lock, so two runs that differ in any input but
 * share an id would either attach to each other's Runtime or have the second
 * window silently refuse to start. Hashing all of them makes the id change
 * whenever any input does, which is the safe direction.
 *
 * The comparison form of each value is hashed (see `canonicalize`), so path
 * spelling and case cannot produce two ids for one instance. `instanceIdFor(root,
 * dshHome)` remains the two-argument shorthand for the common case.
 */
function instanceIdFor(root, dshHome, discriminator = {}) {
  const canonicalRoot = canonicalize(root)
  if (!canonicalRoot) return ''
  const canonicalHome = canonicalize(dshHome) || path.join(canonicalRoot, 'data')
  const appName = String(discriminator.appName || '').trim().toLowerCase()
  const userDataDir = canonicalize(discriminator.userDataDir)
  return crypto
    .createHash('sha256')
    .update([canonicalRoot, canonicalHome, appName, userDataDir].join('\n'), 'utf8')
    .digest('hex')
    .slice(0, INSTANCE_ID_LENGTH)
}

/**
 * Is another DS-Hns (or, in principle, anything) listening on this TCP port?
 *
 * This is a *bind* probe rather than a connect probe on purpose: the Harness port
 * may legitimately be free while something has a connect in flight, and the only
 * answer that matters for allocation is "can I own this port".
 */
function isPortFree(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {}
      resolve(value)
    }
    server.once('error', () => finish(false))
    server.once('listening', () => finish(true))
    try {
      server.listen({ port, host, exclusive: true })
    } catch {
      finish(false)
    }
    setTimeout(() => finish(false), timeoutMs).unref?.()
  })
}

/** Ask the OS for a port it will hand out, then immediately give it back. */
function ephemeralPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('the OS did not report a port'))))
    })
  })
}

/**
 * Choose the port this instance will serve the Harness on.
 *
 * The rule the requirement names:
 *
 *   requested port -> available? yes -> use it
 *                             no  -> allocate a safe free port
 *
 * A requested port is honoured when it is free. When it is taken the instance
 * does **not** fail and does **not** take the port: it walks a bounded window
 * above the requested port, and only then asks the OS. The chosen port is
 * returned so the caller can persist it; nothing here writes to disk.
 *
 * `3080` is a *preference*, never a requirement, and `3081` is not special-cased
 * anywhere: an instance asked for 3081 gets 3081 when it is free and something
 * else when it is not.
 *
 * @returns {Promise<{port: number, requested: number, reused: boolean, allocated: boolean, candidates: number[]}>}
 */
async function allocateHarnessPort({ requested, host = '127.0.0.1', window = 40 } = {}) {
  const preferred = Number.isInteger(Number(requested)) && Number(requested) >= 1024 && Number(requested) <= 65535
    ? Number(requested)
    : 3080
  const candidates = []
  for (let offset = 0; offset <= window; offset += 1) {
    const candidate = preferred + offset
    if (candidate > 65535) break
    candidates.push(candidate)
  }
  for (const candidate of candidates) {
    if (await isPortFree(candidate, host)) {
      return { port: candidate, requested: preferred, reused: candidate === preferred, allocated: candidate !== preferred, candidates }
    }
  }
  // Every candidate in the window is taken. The OS still knows a free port.
  const fallback = await ephemeralPort(host)
  return { port: fallback, requested: preferred, reused: false, allocated: true, candidates }
}

/**
 * The named pipe (Windows) or Unix domain socket (POSIX) this instance's Runtime
 * Host listens on.
 *
 * A pipe name carries the instance id, so two instances on one machine cannot
 * collide, and the protocol version, so a client built against another revision
 * fails loudly at connect time rather than misreading a handshake.
 */
function ipcEndpointFor(instanceId, platform = process.platform) {
  const id = slugify(instanceId, 'unknown')
  if (platform === 'win32') return `\\\\.\\pipe\\dsh-hns-${id}`
  // A Unix socket path is length-limited (~104 bytes on macOS), so it lives in the
  // per-user runtime directory rather than under a possibly deep checkout.
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir()
  return path.join(base, `dsh-hns-${id}.sock`)
}

/**
 * Is this a *foreign* record, or this instance's own?
 *
 * Two separate questions, and both have to hold: the id must match (this is the
 * same instance) **and** the recorded root must match (the record was not copied
 * here from somewhere else). A record written before the id included the home
 * directory has a shorter derivation and simply will not match, so it is treated
 * as foreign and ignored — which is correct: its port and endpoint belong to a
 * naming scheme this build no longer uses.
 */
/**
 * Is this record this instance's own?
 *
 * Two questions, and both have to hold:
 *
 *   1. **the id matches** — this is the same *derivation*, so the same root, the
 *      same data directory, the same run name and the same userData choice;
 *   2. **the recorded root and userData match** — the record was not copied here
 *      from somewhere else, and the inputs it was written under have not moved.
 *
 * The second check is what catches a `data` directory that was copied, a checkout
 * that was moved, or a `DSH_USER_DATA_DIR` that changed since the record was
 * written. A record written by an earlier naming scheme matches neither, so it is
 * treated as foreign and cleared — which is correct: its port and endpoint belong
 * to a scheme this build no longer uses.
 */
function recordBelongsToInstance(record, instance) {
  if (!record || !instance) return false
  if (String(record.instanceId || '') !== instance.instanceId) return false
  const recordRoot = canonicalize(record.root)
  if (!recordRoot || recordRoot !== canonicalize(instance.root)) return false
  // A record that does not name a userData is from before the field existed, or
  // from a writer that predates this build: either way it is not proof of *this*
  // instance's layout, so it is not trusted as one.
  const recordUserData = canonicalize(record.userData)
  if (!recordUserData) return false
  return recordUserData === canonicalize(instance.paths?.userData)
}

/**
 * Electron's userData directory for an instance.
 *
 * Two rules, and the difference between them matters:
 *
 *   - an **isolated** instance (a second checkout, `DSH_USER_DATA_DIR`, an
 *     explicit `DSH_APP_NAME`) gets `<home>/electron/<instanceId>`. It is keyed
 *     by the instance id so it is provably unique, and it is deliberately NOT
 *     Electron's default, which would be shared with every other DS-Hns on the
 *     machine — along with Cookies, Local Storage, the GPU cache, and the
 *     single-instance lock that would then make the second instance silently
 *     refuse to start.
 *
 *   - the **primary** instance keeps the historical `<home>/desktop-shell`.
 *     That path is already specific to this checkout's own `data` directory, so
 *     it is isolated in the way that matters — and it is where every existing
 *     user's window state, cache and login already are. Moving it would be a
 *     migration with no isolation benefit, which is not what this change is for.
 */
function userDataFor({ root, dshHome, isolated, explicit, slug }) {
  if (explicit) return path.resolve(explicit)
  const home = dshHome
  if (isolated) return path.join(home, 'electron', instanceIdFor(root, home))
  return path.join(home, 'desktop-shell')
}

/**
 * The complete derived layout for one instance.
 *
 * Every path is under the instance's own root or its own `DSH_HOME`; nothing is
 * shared with another instance, and nothing is placed in a machine-global
 * location.
 */
function describeInstance({
  root,
  dshHome,
  appName,
  requestedPort,
  isolated,
  userDataDir,
  platform = process.platform
} = {}) {
  const instanceRoot = resolveRoot(root)
  if (!instanceRoot) throw new Error('an instance needs a root')
  const home = resolveRoot(dshHome) || path.join(instanceRoot, 'data')
  const slug = slugify(appName || path.basename(instanceRoot), 'ds-hns')
  const isIsolated = isolated === undefined ? Boolean(appName) : Boolean(isolated)
  /**
   * The id covers every input that changes a derived path, which is why it is
   * derived here rather than from the root and home alone: an instance named
   * differently, or given its own userData, is a different instance and must not
   * share an endpoint or a lock with the one it resembles.
   */
  const instanceId = instanceIdFor(instanceRoot, home, { appName, userDataDir })
  return {
    version: IDENTITY_VERSION,
    protocol: PROTOCOL_VERSION,
    instanceId,
    root: instanceRoot,
    dshHome: home,
    appName: appName || path.basename(path.resolve(instanceRoot)) || 'DS-Harness',
    slug,
    isolated: isIsolated,
    ipcEndpoint: ipcEndpointFor(instanceId, platform),
    requestedPort: Number.isInteger(Number(requestedPort)) ? Number(requestedPort) : null,
    paths: {
      /** The instance's own record of itself: id, protocol, chosen port, endpoint. */
      identityFile: path.join(home, 'state', 'instance.json'),
      /** Both ownership record kinds live under the instance's `runtime/`. */
      runtimeDir: path.join(instanceRoot, 'runtime'),
      stateDir: path.join(home, 'state'),
      logsDir: path.join(instanceRoot, 'logs'),
      tempDir: path.join(instanceRoot, 'temp'),
      cacheDir: path.join(instanceRoot, 'cache'),
      /**
       * Electron's userData: per-instance, and never Electron's default. See
       * `userDataFor` for why the primary instance keeps its historical name.
       */
      userData: userDataFor({ root: instanceRoot, dshHome: home, isolated: isIsolated, explicit: userDataDir, slug }),
      /** Where the Runtime Host writes its own log, separate from the UI's. */
      runtimeLog: path.join(instanceRoot, 'logs', 'runtime-host.log'),
      /** Where the Desktop Client writes its own log. */
      desktopLog: path.join(instanceRoot, 'logs', 'desktop-runtime.log'),
      /**
       * A browser profile per instance. The Electron session partition AND any
       * Computer Use browser context key off this, so a page driven in one
       * instance is never the page of the other.
       */
      browserProfile: path.join(home, 'browser', instanceId)
    }
  }
}

/**
 * Persist the instance record so a later `attach` can find the port and endpoint
 * without recomputing the choice — and so a human can read which instance owns
 * what. The write is atomic (a rename) because a half-written identity file would
 * read as "a different instance".
 */
function writeInstanceRecord(instance, extra = {}) {
  const record = {
    version: IDENTITY_VERSION,
    protocol: PROTOCOL_VERSION,
    instanceId: instance.instanceId,
    root: instance.root,
    dshHome: instance.dshHome,
    appName: instance.appName,
    ipcEndpoint: instance.ipcEndpoint,
    userData: instance.paths.userData,
    harnessPort: instance.harnessPort ?? null,
    updatedAt: new Date().toISOString(),
    ...extra
  }
  try {
    fs.mkdirSync(path.dirname(instance.paths.identityFile), { recursive: true })
    const temporary = `${instance.paths.identityFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf8')
    fs.renameSync(temporary, instance.paths.identityFile)
    return record
  } catch {
    return null
  }
}

function readInstanceRecord(instance) {
  try {
    const value = JSON.parse(fs.readFileSync(instance.paths.identityFile, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Does a persisted record belong to this instance?
 *
 * Defined next to `ipcEndpointFor` above; the single definition is what keeps
 * "the id matches" and "the root matches" from drifting apart as two different
 * answers.
 */

/**
 * Resolve an instance and the port it should serve on, in one step.
 *
 * A five-step order, and the precedence is the interesting part:
 *
 *   1. an explicit `DSH_HARNESS_PORT` is a *request*;
 *   2. otherwise a port this instance already persisted is a request — an instance
 *      that chose 3093 last run should still be on 3093;
 *   3. otherwise the canonical 3080 is the request;
 *   4. a request is always subject to availability (see `allocateHarnessPort`);
 *   5. the answer is persisted before it is returned.
 *
 * Step 2 is what stops an instance from silently drifting to a new port on every
 * restart just because its own previous Harness had not released the port yet.
 *
 * Identity options are **not** re-derived here: they are passed straight through
 * to `describeInstance`, which is still the single place that decides a name, a
 * slug and a userData path. Resolving identity twice is how the two answers drift
 * apart — and a userData path that changes between "before Electron was ready" and
 * "after the port was chosen" would silently move the single-instance lock.
 */
async function resolveInstance(options = {}) {
  const instance = describeInstance(options)
  const persisted = readInstanceRecord(instance)
  const fromRecord = recordBelongsToInstance(persisted, instance) ? Number(persisted.harnessPort) : NaN
  const requested =
    instance.requestedPort ??
    (Number.isInteger(fromRecord) && fromRecord > 0 ? fromRecord : options.defaultPort ?? 3080)
  const allocation = await allocateHarnessPort({ requested, host: options.host, window: options.window })
  const resolved = { ...instance, harnessPort: allocation.port, portAllocation: allocation }
  writeInstanceRecord(resolved)
  return resolved
}

module.exports = {
  PROTOCOL_VERSION,
  IDENTITY_VERSION,
  INSTANCE_ID_LENGTH,
  canonicalize,
  resolveRoot,
  slugify,
  instanceIdFor,
  isPortFree,
  ephemeralPort,
  allocateHarnessPort,
  ipcEndpointFor,
  describeInstance,
  writeInstanceRecord,
  readInstanceRecord,
  recordBelongsToInstance,
  resolveInstance
}
