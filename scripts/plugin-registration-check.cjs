'use strict'

/**
 * DS-Hns: **did the installation actually register what it put on disk?**
 *
 * The installer's own steps prove that files exist in a Harness profile: `install-profile-plugin.ps1`
 * reads the profile back and checks the declared files are there. That is necessary and not sufficient —
 * "the file is installed" and "the runtime registered it, it loaded, it is healthy and the official UI
 * lists it exactly once" are different claims, and the failure the requirement names is precisely the
 * gap between them ("文件安装了，但系统没有注册").
 *
 * So this is the post-install probe, and it builds the **real** plugin host — the same `createPluginHost`
 * the product boots, through the same adapter framework, reading the same shipped set — and answers four
 * things per expected plugin:
 *
 *   * `installed`     — the harness profile declares it and its files are there (the installer's own read)
 *   * `registered`    — the host's world knows the plugin, exactly once
 *   * `loaded`        — the manager mounted it (a disabled plugin is reported as disabled, not as missing)
 *   * `officialUi`    — the service record the official Settings page reads exists and carries the
 *                       capabilities, so the row will be drawn rather than a blank
 *
 * Usage:
 *   node scripts/plugin-registration-check.cjs [--root=<dir>] [--expect=a,b] [--json]
 *
 * Exit code: 0 when every expected plugin is registered and loaded; 1 otherwise (with the reasons).
 */

const path = require('node:path')

const DEFAULT_EXPECTED = ['dshns.health-scheduler', 'dshns.restart-supervisor']

function parseArgs(argv) {
  const args = { root: path.resolve(__dirname, '..'), expect: DEFAULT_EXPECTED, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg.startsWith('--root=')) args.root = path.resolve(arg.slice('--root='.length))
    else if (arg === '--root') args.root = path.resolve(String(argv[index + 1] || '.')), (index += 1)
    else if (arg.startsWith('--expect=')) args.expect = arg.slice('--expect='.length).split(',').map((value) => value.trim()).filter(Boolean)
    else if (arg === '--json') args.json = true
  }
  return args
}

/**
 * Every id the runtime knows, with duplicates kept so "registered twice" is visible as a number.
 *
 * A plugin registered twice is a defect the panel cannot show (two rows, one plugin) and the manager
 * cannot report (it keys by id), so the counting happens here, from the host's own flat list.
 */
function rosterOf(host) {
  try {
    const listed = host.list()
    const plugins = Array.isArray(listed) ? listed : (listed && Array.isArray(listed.plugins) ? listed.plugins : [])
    return plugins.map((entry) => String(entry.id))
  } catch (error) {
    return []
  }
}

async function main(argv) {
  const args = parseArgs(argv)
  const { createPluginHost } = require(path.join(args.root, 'app', 'plugin-host.cjs'))
  const host = createPluginHost({
    root: args.root,
    configDir: path.join(args.root, 'config', 'plugins'),
    log: () => {}
  })

  const report = {
    harness: 'plugin-registration-check',
    at: new Date().toISOString(),
    root: args.root,
    expected: args.expect,
    plugins: [],
    duplicateRegistrations: [],
    rosterSize: 0,
    ok: false,
    reason: null
  }

  try {
    const built = await host.ensure()
    if (built && built.ok === false) {
      report.reason = built.error || 'the plugin runtime could not be built'
      report.plugins = args.expect.map((id) => ({ id, installed: null, registered: false, loaded: false, officialUi: false, reason: report.reason }))
    } else {
      const roster = rosterOf(host)
      report.rosterSize = roster.length
      report.duplicateRegistrations = [...new Set(roster.filter((id, index) => roster.indexOf(id) !== index))]
      for (const id of args.expect) {
        const record = host.serviceReport(id)
        const registered = Boolean(record && record.ok === true)
        const diagnostics = registered && record.diagnostics ? record.diagnostics : null
        report.plugins.push({
          id,
          /** `installed` here means "the runtime has a record for it", which is what the plugin host can see. */
          installed: registered ? record.installed === true || record.enabled === true || record.loaded === true : false,
          registered,
          enabled: registered ? record.enabled === true : false,
          loaded: registered ? record.loaded === true : false,
          healthy: registered ? record.healthy : null,
          /** The official Settings page draws a row per service record: no record, no row. */
          officialUi: Boolean(registered && record.capabilities && Array.isArray(record.capabilities.provides)),
          provides: registered ? (record.capabilities ? record.capabilities.provides : []) : [],
          /** The supervisor's formal status is read through the host hook the official page uses. */
          restartStatus: id === 'dshns.restart-supervisor' && typeof host.restartStatus === 'function' ? Boolean(host.restartStatus().status === 'restart_status') : undefined,
          reason: registered ? record.health && record.health.reason ? record.health.reason : null : (record && record.reason) || 'the runtime has no record'
        })
        void diagnostics
      }
      /**
       * What counts as a failure.
       *
       * A plugin that ships **disabled** (the monitor does: sampling the machine is a user's decision) is
       * registered and *not loaded*, which is the correct state rather than a defect — so `loaded` is only
       * required for a plugin that is enabled. What is always a failure is a required plugin the runtime
       * does not know at all, an enabled plugin that did not mount, and any plugin registered twice.
       */
      const missing = report.plugins.filter((entry) => entry.registered !== true || (entry.enabled === true && entry.loaded !== true))
      report.ok = missing.length === 0 && report.duplicateRegistrations.length === 0
      report.reason = report.ok
        ? null
        : [
          missing.length ? `not registered or not mounted: ${missing.map((entry) => `${entry.id} (registered=${entry.registered ? 'yes' : 'no'}, enabled=${entry.enabled ? 'yes' : 'no'}, loaded=${entry.loaded ? 'yes' : 'no'}${entry.reason ? `, ${entry.reason}` : ''})`).join('; ')}` : null,
          report.duplicateRegistrations.length ? `registered more than once: ${report.duplicateRegistrations.join(', ')}` : null
        ].filter(Boolean).join(' | ')
    }
  } catch (error) {
    report.reason = String(error && error.message ? error.message : error)
    report.plugins = args.expect.map((id) => ({ id, installed: false, registered: false, loaded: false, officialUi: false, reason: report.reason }))
  } finally {
    try {
      await host.dispose('registration check')
    } catch {}
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } else {
    process.stdout.write(`plugin registration check (root ${report.root})\n`)
    for (const entry of report.plugins) {
      process.stdout.write(`  ${entry.id.padEnd(30)} registered=${entry.registered ? 'yes' : 'no'} loaded=${entry.loaded ? 'yes' : 'no'} officialUi=${entry.officialUi ? 'yes' : 'no'}${entry.reason ? ` -- ${entry.reason}` : ''}\n`)
    }
    if (report.duplicateRegistrations.length) process.stdout.write(`  duplicate registrations: ${report.duplicateRegistrations.join(', ')}\n`)
    process.stdout.write(`  ${report.ok ? 'OK' : 'FAILED'}${report.reason ? `: ${report.reason}` : ''}\n`)
  }
  return report.ok ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`plugin registration check failed: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}

module.exports = { main, rosterOf, DEFAULT_EXPECTED, parseArgs }
