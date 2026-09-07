'use strict'
const os = require('node:os')

/**
 * Local machine resource probe. Lets the queue compute a safe concurrent-job
 * ceiling from real CPU/RAM availability and re-check it periodically.
 */

let lastCpuSample = null

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

function cpuUsagePercent() {
  const nowSample = cpuTimes()
  if (!lastCpuSample) {
    lastCpuSample = nowSample
    return 0
  }
  const idleDelta = nowSample.idle - lastCpuSample.idle
  const totalDelta = nowSample.total - lastCpuSample.total
  lastCpuSample = nowSample
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100))
}

function memoryGb(bytes) {
  return bytes / (1024 ** 3)
}

function probe() {
  return {
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || 'unknown',
      arch: os.arch(),
      usagePercent: cpuUsagePercent()
    },
    memory: {
      totalGb: Number(memoryGb(os.totalmem()).toFixed(2)),
      freeGb: Number(memoryGb(os.freemem()).toFixed(2)),
      usedPercent: Number(((1 - os.freemem() / os.totalmem()) * 100).toFixed(1))
    },
    hostname: os.hostname(),
    platform: os.platform(),
    uptimeSeconds: Math.floor(os.uptime())
  }
}

/**
 * Dynamic concurrency recommendation.
 * - at least one worker
 * - roughly half of logical cores is enough for dsh agents
 * - leave >= 2.5 GB free RAM per running worker
 * - user-configured min/max act as hard bounds
 */
function computeMaxConcurrent(sys, config) {
  const min = Math.max(1, Number(config.minConcurrent || 1))
  const max = Math.max(min, Number(config.maxConcurrent || 4))
  const byCpu = Math.max(1, Math.floor(sys.cpu.cores / 2))
  const ramBudget = Math.max(0, sys.memory.freeGb - 1)
  const byRam = Math.max(1, Math.floor(ramBudget / 2.5))
  const suggested = Math.min(byCpu, byRam)
  return { min, max, byCpu, byRam, suggested, current: Math.min(max, Math.max(min, suggested)) }
}

module.exports = { probe, cpuUsagePercent, computeMaxConcurrent }
