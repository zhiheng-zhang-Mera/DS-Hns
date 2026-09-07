'use strict'

/**
 * PeakPricingEngine — pure pricing-period logic, decoupled from any UI.
 *
 * Official DeepSeek schedule (captured 2026-09-07):
 *   - billing clock: Asia/Shanghai
 *   - PEAK: Mon-Fri 09:00-12:00 and 14:00-18:00 (Beijing time)
 *   - everything else, including all weekends: OFF-PEAK
 */

const WEEKDAY_NAME = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }

const formatterCache = new Map()
function formatterFor(timeZone) {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    formatterCache.set(timeZone, fmt)
  }
  return fmt
}

function zonedParts(timeMs, timeZone) {
  const fmt = formatterFor(timeZone)
  const parts = {}
  for (const p of fmt.formatToParts(new Date(timeMs))) parts[p.type] = p.value
  return {
    weekday: WEEKDAY_NAME[parts.weekday] ?? -1,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  }
}

function minutesOfDay(timeMs, timeZone) {
  const p = zonedParts(timeMs, timeZone)
  return p.hour * 60 + p.minute
}

function toMin(hm) {
  const [h, m] = String(hm).split(':').map(Number)
  return h * 60 + m
}

function parseSchedule(schedule) {
  const timeZone = schedule?.timeZone || 'Asia/Shanghai'
  const weekdays = new Set(schedule?.weekdays ?? [1, 2, 3, 4, 5])
  const periods = (schedule?.peakPeriods ?? [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' }
  ]).map((p) => ({ start: toMin(p.start), end: toMin(p.end) }))
  return { timeZone, weekdays, periods }
}

function isPeakAt(timeMs, schedule) {
  const s = parseSchedule(schedule)
  const p = zonedParts(timeMs, s.timeZone)
  if (!s.weekdays.has(p.weekday)) return false
  const minutes = p.hour * 60 + p.minute
  return s.periods.some((r) => minutes >= r.start && minutes < r.end)
}

function statusAt(timeMs, schedule) {
  return isPeakAt(timeMs, schedule) ? 'PEAK' : 'OFF-PEAK'
}

/** Returns ISO time of the next period change strictly after timeMs. */
function nextChange(timeMs, schedule, maxSearchMs = 72 * 60 * 60 * 1000) {
  const s = parseSchedule(schedule)
  const start = Math.floor(timeMs)
  const current = isPeakAt(start, s)
  const step = 60 * 1000
  const limit = start + maxSearchMs
  for (let t = start + step; t <= limit; t += step) {
    if (isPeakAt(t, s) !== current) return new Date(t).toISOString()
  }
  return null
}

function nextChangeInfo(timeMs, schedule) {
  const next = nextChange(timeMs, schedule)
  if (!next) return null
  const nextMs = Date.parse(next)
  return {
    iso: next,
    ms: nextMs,
    statusAfter: statusAt(nextMs, schedule),
    secondsLeft: Math.max(0, Math.floor((nextMs - timeMs) / 1000))
  }
}

/** Returns the instant (epoch ms) of midnight of the billing-zone calendar day that contains timeMs. */
function dayStartInZone(timeMs, timeZone) {
  const p = zonedParts(timeMs, timeZone)
  const anchor = Date.UTC(p.year, p.month - 1, p.day)
  const min = anchor - 18 * 60 * 60 * 1000
  const max = anchor + 18 * 60 * 60 * 1000
  for (let t = min; t <= max; t += 60 * 1000) {
    const q = zonedParts(t, timeZone)
    if (q.year === p.year && q.month === p.month && q.day === p.day && q.hour === 0 && q.minute === 0) {
      return t
    }
  }
  return anchor
}

/**
 * Builds a full 24h timeline for the billing-zone day containing timeMs.
 * Peak windows are purely time-of-day on weekdays, so segments are computed
 * analytically after resolving the zone-local midnight.
 */
function buildTimeline(timeMs, schedule) {
  const s = parseSchedule(schedule)
  const dayStart = dayStartInZone(timeMs, s.timeZone)
  const dayEnd = dayStart + 24 * 60 * 60 * 1000
  const p = zonedParts(dayStart, s.timeZone)
  const weekdayPeak = s.weekdays.has(p.weekday)
  const windows = weekdayPeak ? s.periods : []
  const cut = [0]
  for (const w of windows) cut.push(w.start, w.end)
  cut.push(24 * 60)
  const ordered = [...new Set(cut)].sort((a, b) => a - b)
  const segments = []
  for (let i = 0; i < ordered.length - 1; i++) {
    const from = ordered[i]
    const until = ordered[i + 1]
    const fromMs = dayStart + from * 60 * 1000
    const untilMs = dayStart + until * 60 * 1000
    const peak = weekdayPeak && windows.some((w) => from >= w.start && until <= w.end)
    segments.push({ status: peak ? 'PEAK' : 'OFF-PEAK', fromMs, untilMs })
  }
  return {
    timeZone: s.timeZone,
    dayStartMs: dayStart,
    dayEndMs: dayEnd,
    segments
  }
}

function hhmmFromMinutes(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

function formatInZone(timeMs, timeZone, withSeconds = false) {
  const parts = zonedParts(timeMs, timeZone)
  const hm = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  return withSeconds ? `${hm}:${String(parts.second).padStart(2, '0')}` : hm
}

module.exports = {
  WEEKDAY_NAME,
  zonedParts,
  minutesOfDay,
  isPeakAt,
  statusAt,
  nextChange,
  nextChangeInfo,
  buildTimeline,
  hhmmFromMinutes,
  toMin,
  parseSchedule,
  dayStartInZone,
  formatInZone
}
