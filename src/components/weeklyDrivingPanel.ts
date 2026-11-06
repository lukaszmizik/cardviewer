import { assessWeeklyDrivingTime, WEEKLY_DRIVING_LIMIT_MS, type WeeklyDrivingTime } from '../analysis/weeklyDrivingTime.ts'
import { formatClockDateTime } from '../lib/clock.ts'
import type { Activity } from '../types/tacho.ts'

export type WeeklyDrivingPanel = {
  title: 'Týdenní doba řízení'
  rangeText: string
  valueText: string
  /** Podíl známého součtu vůči 56 h, nejvýše 1. */
  fill: number
  tone: 'fill' | 'over'
  notes: string[]
  result: WeeklyDrivingTime
}

const OVER_NOTE = 'Překročení limitu 56 h.'
const OPEN_NOTE = 'Součet nemusí být konečný.'
const FILL_NOTE = 'Ukazatel vyjadřuje jen podíl vůči limitu 56 h.'

/**
 * Průběžný součet od pondělí 00:00 UTC do konce vybraného kalendářního dne.
 * Stejná funkce jako celý týden, jen s řezem na konci dne.
 */
export function buildWeeklyDrivingPanel(input: {
  activities: readonly Activity[]
  dayEndUtc: number
}): WeeklyDrivingPanel {
  const result = assessWeeklyDrivingTime({
    activities: input.activities,
    weekStartUtc: input.dayEndUtc - 1,
    untilUtc: input.dayEndUtc,
  })
  const notes = [FILL_NOTE]
  if (result.status === 'over_56h') notes.unshift(OVER_NOTE)
  if (!result.dataComplete) notes.unshift(OPEN_NOTE)
  return {
    title: 'Týdenní doba řízení',
    rangeText: `${formatClockDateTime(result.weekStartUtc, 'utc')}–${formatClockDateTime(result.weekEndUtc, 'utc')} UTC`,
    valueText: `${durationText(result.drivingMs)} / 56 h`,
    fill: Math.min(1, result.drivingMs / WEEKLY_DRIVING_LIMIT_MS),
    tone: result.status === 'over_56h' ? 'over' : 'fill',
    notes,
    result,
  }
}

function durationText(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}
