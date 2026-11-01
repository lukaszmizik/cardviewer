export type ClockMode = 'local' | 'utc'

export const DAY_MS = 24 * 3600 * 1000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function clockParts(ms: number, mode: ClockMode) {
  const d = new Date(ms)
  if (mode === 'utc') {
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      weekday: d.getUTCDay(),
    }
  }
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay(),
  }
}

export function weekStartMs(ms: number, mode: ClockMode): number {
  const parts = clockParts(ms, mode)
  const mondayOffset = parts.weekday === 0 ? 6 : parts.weekday - 1
  if (mode === 'utc') {
    return Date.UTC(parts.year, parts.month - 1, parts.day - mondayOffset)
  }
  return new Date(parts.year, parts.month - 1, parts.day - mondayOffset).getTime()
}

export function dayStartMs(ms: number, mode: ClockMode): number {
  const parts = clockParts(ms, mode)
  if (mode === 'utc') return Date.UTC(parts.year, parts.month - 1, parts.day)
  return new Date(parts.year, parts.month - 1, parts.day).getTime()
}

export function formatClockDate(ms: number, mode: ClockMode): string {
  const p = clockParts(ms, mode)
  return `${pad(p.day)}.${pad(p.month)}.${p.year}`
}

export function formatClockTime(ms: number, mode: ClockMode): string {
  const p = clockParts(ms, mode)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

export function formatClockDateTime(ms: number, mode: ClockMode): string {
  return `${formatClockDate(ms, mode)} ${formatClockTime(ms, mode)}`
}

export function addDays(ms: number, days: number, mode: ClockMode): number {
  const parts = clockParts(ms, mode)
  if (mode === 'utc') {
    return Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute)
  }
  return new Date(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute).getTime()
}

export function formatWeekRange(weekStartMsValue: number, mode: ClockMode): string {
  return `${formatClockDate(weekStartMsValue, mode)} – ${formatClockDate(addDays(weekStartMsValue, 6, mode), mode)}`
}

export function parseClockDateTime(timeStr: string, dateStr: string, mode: ClockMode): number {
  const [hh, mm] = timeStr.split(':').map(Number)
  const [d, m, y] = dateStr.split('.').map(Number)
  if (mode === 'utc') return Date.UTC(y, m - 1, d, hh ?? 0, mm ?? 0)
  return new Date(y, m - 1, d, hh ?? 0, mm ?? 0).getTime()
}

export function timeToX(dayStartMsValue: number, ms: number, mode: ClockMode): number {
  const dayEndMs = addDays(dayStartMsValue, 1, mode)
  if (ms >= dayEndMs) return 1
  if (ms <= dayStartMsValue) return 0
  const span = dayEndMs - dayStartMsValue
  if (span <= 0) return 0
  return Math.min(1, (ms - dayStartMsValue) / span)
}
