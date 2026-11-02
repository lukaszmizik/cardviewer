import { addDays, dayStartMs } from '../lib/clock'
import type { ClockMode } from '../lib/clock'
import type { VehicleUse } from '../types/tacho'

export type DailyDistanceRecord = {
  dayStartMs: number
  kilometers: number
}

/** Den zobrazeného týdne s nejvyšším počtem ujetých kilometrů. */
export function bestDailyDistance(
  uses: VehicleUse[],
  weekStart: number,
  mode: ClockMode,
): DailyDistanceRecord | null {
  const weekEnd = addDays(weekStart, 7, mode)
  const totals = new Map<number, number>()
  for (let day = weekStart; day < weekEnd; day = addDays(day, 1, mode)) totals.set(day, 0)

  for (const use of uses) {
    if (use.kilometers == null || use.kilometers <= 0) continue
    if (use.toUtc <= weekStart || use.fromUtc >= weekEnd) continue
    const span = use.toUtc - use.fromUtc
    if (span <= 0) {
      const day = dayStartMs(use.fromUtc, mode)
      if (totals.has(day)) totals.set(day, (totals.get(day) ?? 0) + use.kilometers)
      continue
    }
    let cursor = Math.max(use.fromUtc, weekStart)
    const end = Math.min(use.toUtc, weekEnd)
    while (cursor < end) {
      const day = dayStartMs(cursor, mode)
      const next = addDays(day, 1, mode)
      const sliceEnd = Math.min(end, next)
      const share = (use.kilometers * (sliceEnd - cursor)) / span
      if (totals.has(day)) totals.set(day, (totals.get(day) ?? 0) + share)
      if (sliceEnd <= cursor) break
      cursor = sliceEnd
    }
  }

  let best: DailyDistanceRecord | null = null
  for (const [day, kilometers] of totals) {
    const rounded = Math.round(kilometers)
    if (rounded <= 0) continue
    if (best == null || rounded > best.kilometers || (rounded === best.kilometers && day > best.dayStartMs)) {
      best = { dayStartMs: day, kilometers: rounded }
    }
  }
  return best
}
