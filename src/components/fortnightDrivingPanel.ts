import { assessFortnightDrivingTime, type FortnightDrivingTime } from '../analysis/fortnightDrivingTime.ts'
import { utcWeekStart } from '../analysis/dailyDrivingTime.ts'
import { formatClockDateTime } from '../lib/clock.ts'
import type { Activity } from '../types/tacho.ts'

export type FortnightDrivingRow = {
  title: 'Doba řízení za dva po sobě jdoucí týdny'
  rangeText: string
  valueText: string
  statusText: string
  tone: 'clear' | 'over' | 'open'
  notes: string[]
  result: FortnightDrivingTime
}

const PROGRESS_NOTE = 'Průběžný součet do konce vybraného dne. Období dvou týdnů není uzavřeno.'
const OPEN_NOTE = 'Součet nemusí být konečný.'

/**
 * Průběžný součet předchozího týdne a aktuálního týdne do konce vybraného dne.
 * `within_90h` nastane jen u uzavřeného a úplného dvoutýdenního období.
 */
export function buildFortnightDrivingRow(input: {
  activities: readonly Activity[]
  dayEndUtc: number
}): FortnightDrivingRow {
  const result = assessFortnightDrivingTime({
    activities: input.activities,
    laterWeekStartUtc: utcWeekStart(input.dayEndUtc - 1),
    untilUtc: input.dayEndUtc,
  })
  const notes: string[] = []
  if (!result.fortnightClosed && result.status !== 'over_90h') notes.push(PROGRESS_NOTE)
  if (!result.dataComplete) notes.push(OPEN_NOTE)
  return {
    title: 'Doba řízení za dva po sobě jdoucí týdny',
    rangeText: `${weekText(result.earlierWeekStartUtc, result.laterWeekStartUtc)} a ${weekText(result.laterWeekStartUtc, result.periodEndUtc)} UTC`,
    valueText: `${durationText(result.drivingMs)} / 90 h`,
    statusText: statusText(result),
    tone: result.status === 'over_90h' ? 'over' : result.status === 'within_90h' ? 'clear' : 'open',
    notes,
    result,
  }
}

function weekText(startUtc: number, endUtc: number): string {
  return `${formatClockDateTime(startUtc, 'utc')}–${formatClockDateTime(endUtc, 'utc')}`
}

function statusText(result: FortnightDrivingTime): string {
  if (result.status === 'over_90h') return 'Překročení limitu 90 h.'
  if (result.status === 'insufficient_data') return 'Dodržení limitu nelze potvrdit.'
  if (result.status === 'within_90h') return 'V limitu 90 h.'
  if (result.dataComplete) return 'Průběžný součet.'
  return 'Údaj není úplný.'
}

function durationText(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}
