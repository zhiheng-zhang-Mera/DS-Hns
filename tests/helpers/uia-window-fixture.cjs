'use strict'
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

async function startUiaWindowFixture(t) {
  const title = `HNS-owned-UIA-${process.pid}-${require('node:crypto').randomUUID()}`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'uia-window-fixture.ps1'), '-Title', title], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const ready = await new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => finish(new Error(`Owned UIA fixture did not become ready: ${stderr}`)), 15000)
    const finish = (error, value) => {
      clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      child.stdout.removeListener('data', onData)
      error ? reject(error) : resolve(value)
    }
    const onError = error => finish(error)
    const onExit = (code, signal) => finish(new Error(`Owned UIA fixture exited ${code}/${signal}: ${stderr}`))
    const onData = chunk => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      try { finish(null, JSON.parse(stdout.slice(0, newline))) } catch (error) { finish(error) }
    }
    child.on('error', onError).on('exit', onExit)
    child.stdout.setEncoding('utf8').on('data', onData)
  })
  if (ready.processId !== child.pid || ready.title !== title || !/^\d+$/.test(ready.handle)) throw new Error('Owned UIA fixture identity mismatch')
  return ready
}

module.exports = { startUiaWindowFixture }
