'use strict'

const { runE0 } = require('./lib/engineering-recovery-e0.cjs')

if (require.main === module) {
  runE0().then((result) => {
    process.exitCode = result.ok ? 0 : 1
  }).catch((error) => {
    process.stderr.write(`[E0] fatal: ${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { runE0 }
