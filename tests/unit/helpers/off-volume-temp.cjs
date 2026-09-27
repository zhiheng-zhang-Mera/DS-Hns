'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function createOffVolumeTempRoot(workRoot) {
  const workDevice = fs.statSync(workRoot).dev
  const candidates = [
    os.tmpdir(),
    path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Temp')
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).dev !== workDevice) {
        fs.mkdirSync(candidate, { recursive: true })
        return candidate
      }
    } catch {
      // A missing candidate is not a usable alternate volume.
    }
  }

  throw new Error(`cross-volume tests require a temp root on a volume separate from ${workRoot}`)
}

module.exports = { createOffVolumeTempRoot }
