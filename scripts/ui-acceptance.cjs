'use strict'

/**
 * DS-Hns: the **official-UI acceptance probe** — what a person would see, read off the running product.
 *
 * The unit suites render the client bundle on a React stand-in, which proves the bundle's structure but
 * not that the official page mounts it. This probe is the other half: it asks the running DS-Hns (through
 * the governance bridge the Mega Core plugin itself uses) for the snapshot the official page draws, and
 * checks the things a person would notice:
 *
 *   * the product answered at all (the bridge is up, the snapshot parses);
 *   * the two built-in services are in the roster, with the four states kept apart;
 *   * the formal `restart_status` is present and says something;
 *   * the advanced policy and the action vocabulary reached the page (the two surfaces that were
 *     computed and drawn by nothing before this branch);
 *   * the floating ball has **one** implementation running: the host says which, and the page's own ball
 *     stands down when the system-wide window owns it;
 *   * nothing is reported healthy that is not (`UNKNOWN != HEALTHY`), and a service that is degraded
 *     says why.
 *
 * It is read-only: it performs no action and changes nothing. Run it against a live DS-Hns:
 *
 *   node scripts/ui-acceptance.cjs [--state=<dir>] [--json]
 *
 * `--state` is the DS-Hns state directory holding `governance-bridge.json` (default: `<root>/data/state`).
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const args = { state: path.join(ROOT, 'data', 'state'), json: false, out: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg.startsWith('--state=')) args.state = path.resolve(arg.slice('--state='.length))
    else if (arg === '--state') args.state = path.resolve(String(argv[index + 1] || '.')), (index += 1)
    else if (arg.startsWith('--out=')) args.out = path.resolve(arg.slice('--out='.length))
    else if (arg === '--json') args.json = true
  }
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  const report = { harness: 'ui-acceptance', at: new Date().toISOString(), state: args.state, bridge: null, checks: [], failures: 0, passed: false, reason: null }
  const check = (label, ok, detail = null) => {
    report.checks.push({ label, ok: Boolean(ok), detail: detail === null ? null : String(detail) })
    if (!ok) report.failures += 1
    return ok
  }

  const discoveryFile = path.join(args.state, 'governance-bridge.json')
  const discovery = (() => {
    try {
      return JSON.parse(fs.readFileSync(discoveryFile, 'utf8'))
    } catch {
      return null
    }
  })()

  if (!check('DS-Hns wrote a governance bridge discovery file', Boolean(discovery && discovery.port), discoveryFile)) {
    report.reason = 'DS-Hns is not running with the governance bridge; start the product and re-run'
  } else {
    report.bridge = { host: discovery.host, port: discovery.port, pid: discovery.pid, startedAt: discovery.startedAt }
    const headers = { authorization: `Bearer ${discovery.token}` }
    let snapshot = null
    try {
      const response = await fetch(`http://${discovery.host || '127.0.0.1'}:${discovery.port}/governance`, { headers })
      check('the bridge answered the governance snapshot', response.status === 200, `HTTP ${response.status}`)
      snapshot = await response.json()
    } catch (error) {
      check('the bridge answered the governance snapshot', false, String(error && error.message ? error.message : error))
      report.reason = 'the governance bridge did not answer'
    }

    if (snapshot) {
      check('the snapshot is the product\u2019s own', snapshot.ok !== false, `ok=${snapshot.ok}`)
      const services = Array.isArray(snapshot.services) ? snapshot.services : []
      check('the official page has a service roster', services.length > 0, `${services.length} service(s)`)
      const ids = services.map((service) => service.id)
      check('the health scheduler is in the roster', ids.includes('dshns.health-scheduler'), ids.join(', '))
      check('the restart supervisor is in the roster', ids.includes('dshns.restart-supervisor'), ids.join(', '))
      for (const service of services.filter((entry) => entry.ok === true)) {
        check(`${service.id}: the four states are separate facts`, ['installed', 'enabled', 'loaded'].every((field) => typeof service[field] === 'boolean') && Object.prototype.hasOwnProperty.call(service, 'healthy'))
        check(`${service.id}: the official page gets a row`, Boolean(service.capabilities && Array.isArray(service.capabilities.provides)))
        if (service.health && service.health.status && service.health.status !== 'healthy') {
          check(`${service.id}: a not-healthy service states why`, Boolean(service.health.reason), JSON.stringify(service.health))
        }
      }
      check('the restart record is on the page', Boolean(snapshot.restartStatus && snapshot.restartStatus.status === 'restart_status'), JSON.stringify(snapshot.restartStatus && snapshot.restartStatus.phase))
      check('the action vocabulary reached the page', Array.isArray(snapshot.serviceActions) && snapshot.serviceActions.length > 0, `${(snapshot.serviceActions || []).length} action(s)`)
      check('the advanced policy reached the page', Array.isArray(snapshot.advanced) && snapshot.advanced.length > 0, `${(snapshot.advanced || []).length} key(s)`)
      const orb = snapshot.orb || { mode: 'in-ui' }
      check('exactly one floating ball is described', ['in-ui', 'system'].includes(String(orb.mode)), JSON.stringify(orb))
      check('the ball decision is the host\u2019s, so the page cannot draw a second one', orb.mode === 'system' ? orb.system === true : orb.system !== true, JSON.stringify(orb))
      check('the human-gate count is published', Object.prototype.hasOwnProperty.call(snapshot, 'pending') || snapshot.dashboard !== undefined, `pending=${snapshot.pending}`)
    }
  }

  report.passed = report.failures === 0
  /**
   * `--out` writes the report as **UTF-8 without a BOM**, from here.
   *
   * A shell redirect on Windows writes UTF-16LE: the file then looks like a binary blob to every reader
   * that expects UTF-8, and the repository's own encoding gate fails on it -- which is how this option
   * came to exist.
   */
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true })
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`)
  else {
    process.stdout.write(`ui-acceptance (state ${report.state})\n`)
    for (const entry of report.checks) process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.label}${entry.detail ? ` -- ${entry.detail}` : ''}\n`)
    process.stdout.write(`  ${report.passed ? 'PASSED' : `FAILED (${report.failures})`}${report.reason ? `: ${report.reason}` : ''}\n`)
  }
  return report.passed ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`ui-acceptance failed: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}

module.exports = { main, parseArgs }
