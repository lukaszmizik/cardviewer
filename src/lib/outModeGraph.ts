import { addDays, clockParts, formatClockDateTime, type ClockMode } from './clock.ts'
import type { OutModeEvent } from '../TachoTypes.ts'

export const OUT_MODE_GRAPH_COLOR = '#f97316'

export type OutModeGraphRange = {
  startMs: number
  endMs: number
  incomplete: boolean
  uncertain: boolean
}

export type OutModeOrphanEnd = {
  endMs: number
}

export type OutModeGraphModel = {
  ranges: OutModeGraphRange[]
  orphanEnds: OutModeOrphanEnd[]
}

/** Páruje out / out_end pro vykreslení. Neúplný interval končí na konci dostupných dat. */
export function buildOutModeGraphModel(
  events: readonly OutModeEvent[],
  recordEndUtc: number | null,
): OutModeGraphModel {
  const sorted = [...events].sort((left, right) => left.minuteStartUtc - right.minuteStartUtc)
  const ranges: OutModeGraphRange[] = []
  const orphanEnds: OutModeOrphanEnd[] = []
  let pendingStart: number | null = null
  let pairingUncertain = false

  const closeOpen = (uncertain: boolean) => {
    if (pendingStart == null || recordEndUtc == null || pendingStart >= recordEndUtc) return
    ranges.push({
      startMs: pendingStart,
      endMs: recordEndUtc,
      incomplete: true,
      uncertain: uncertain || pairingUncertain,
    })
    pendingStart = null
  }

  for (const event of sorted) {
    if (event.type === 'activation') {
      if (pendingStart != null) {
        pairingUncertain = true
        if (event.minuteStartUtc > pendingStart) {
          ranges.push({
            startMs: pendingStart,
            endMs: event.minuteStartUtc,
            incomplete: true,
            uncertain: true,
          })
        }
      }
      pendingStart = event.minuteStartUtc
      continue
    }
    if (pendingStart != null) {
      if (event.minuteStartUtc > pendingStart) {
        ranges.push({
          startMs: pendingStart,
          endMs: event.minuteStartUtc,
          incomplete: false,
          uncertain: pairingUncertain,
        })
        pendingStart = null
        pairingUncertain = false
      } else {
        pairingUncertain = true
      }
      continue
    }
    orphanEnds.push({ endMs: event.minuteStartUtc })
  }
  if (pendingStart != null) closeOpen(pairingUncertain)
  return { ranges, orphanEnds }
}

export function sliceOutRangeForDay(
  range: OutModeGraphRange,
  dayStartUtc: number,
  clockMode: ClockMode,
): { startMs: number; endMs: number } | null {
  const dayEndUtc = addDays(dayStartUtc, 1, clockMode)
  const startMs = Math.max(range.startMs, dayStartUtc)
  const endMs = Math.min(range.endMs, dayEndUtc)
  if (startMs >= endMs) return null
  return { startMs, endMs }
}

export function formatOutModeTooltip(
  startMs: number,
  endMs: number,
  clockMode: ClockMode,
  incomplete: boolean,
  uncertain: boolean,
): string {
  const time = formatOutModeTimeRange(startMs, endMs, clockMode)
  const status = incomplete
    ? uncertain ? `${time} (neúplný interval, nejisté párování)` : `${time} (neúplný interval)`
    : uncertain
      ? `${time} (nejisté párování)`
      : time
  return [
    'Režim OUT',
    '',
    status,
    '',
    'Tachograf byl v režimu mimo působnost.',
    '',
    'Oprávněnost použití OUT nelze ověřit jen z dat karty.',
  ].join('\n')
}

export function formatOutModeTimeRange(startMs: number, endMs: number, clockMode: ClockMode): string {
  const start = clockParts(startMs, clockMode)
  const end = clockParts(endMs, clockMode)
  const sameDay = start.day === end.day && start.month === end.month && start.year === end.year
  const timeOnly = (ms: number) => {
    const parts = clockParts(ms, clockMode)
    return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
  }
  if (sameDay) return `${timeOnly(startMs)}–${timeOnly(endMs)}`
  return `${formatClockDateTime(startMs, clockMode)}–${formatClockDateTime(endMs, clockMode)}`
}

export function latestActivityEndMs(days: readonly { activities: readonly { endMs: number }[] }[]): number | null {
  let best: number | null = null
  for (const day of days) {
    for (const activity of day.activities) {
      if (best == null || activity.endMs > best) best = activity.endMs
    }
  }
  return best
}
