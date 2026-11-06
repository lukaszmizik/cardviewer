import { assessDrivingBreaks, type BreakActivity, type DrivingBreakPeriod, type QualifyingDrivingBreak } from '../analysis/drivingBreaks.ts'
import { clockParts, formatClockDateTime, formatClockTime, type ClockMode } from '../lib/clock.ts'

export type DayDrivingActivity = BreakActivity & {
  isCrew?: boolean
}

export type DayDrivingRow = {
  label: string
  value: string
}

const UNRELIABLE = 'Nelze spolehlivě vyhodnotit.'
/** Delší odpočinek se v tabulce nevypisuje jako přestávka. Není to denní ani týdenní kategorie. */
const CYCLE_REST_MS = 24 * 60 * 60 * 1000
const CYCLE_ENDED = 'Cyklus řízení ukončen odpočinkem.'

/**
 * Řádky pod denní graf. Přestávky počítá z celé předané osy, ne jen z jednoho dne.
 * Denní součet řízení je informativní a není kontrola podle čl. 6.
 */
export function buildDayDrivingRows(input: {
  activities: readonly DayDrivingActivity[]
  dayStartUtc: number
  dayEndUtc: number
  clockMode?: ClockMode
}): DayDrivingRow[] {
  const clockMode = input.clockMode ?? 'utc'
  const periods = assessDrivingBreaks(input.activities)
  const relevant = periods.filter((period) => overlaps(period.startUtc, period.endUtc, input.dayStartUtc, input.dayEndUtc))
  const shownBreaks = breakLines(relevant, input.activities, clockMode)
  const rows: DayDrivingRow[] = [
    {
      label: 'Celková zaznamenaná doba řízení',
      value: `${lengthText(drivingOnDay(input.activities, input.dayStartUtc, input.dayEndUtc))}. Informativní údaj, není vyhodnocení podle čl. 6.`,
    },
    {
      label: 'Bezpečnostní přestávky',
      value: shownBreaks.breaks.length > 0 ? shownBreaks.breaks.join(', ') : '—',
    },
  ]
  if (shownBreaks.cycleEndedByRest) {
    rows.push({ label: 'Ukončení cyklu řízení', value: CYCLE_ENDED })
  }
  rows.push({
    label: 'Výsledek přestávek v řízení',
    value: resultText(relevant, input.activities),
  })
  const longest = evaluated(relevant).reduce((max, period) => Math.max(max, period.drivingMs), 0)
  if (evaluated(relevant).length > 0) {
    rows.push({ label: 'Nejdelší úsek řízení mezi přestávkami', value: lengthText(longest) })
  }
  return rows
}

function resultText(periods: readonly DrivingBreakPeriod[], activities: readonly DayDrivingActivity[]): string {
  const crew = periods.some((period) => activities.some((activity) => activity.isCrew === true && overlaps(activity.startUtc, activity.endUtc, period.startUtc, period.endUtc)))
  if (crew || periods.some((period) => period.status === 'insufficient_data')) return UNRELIABLE
  if (periods.some((period) => period.status === 'exceeded')) return 'Limit 4 h 30 min překročen.'
  return 'V limitu 4 h 30 min.'
}

function breakLines(
  periods: readonly DrivingBreakPeriod[],
  activities: readonly DayDrivingActivity[],
  clockMode: ClockMode,
): { breaks: string[]; cycleEndedByRest: boolean } {
  const breaks: string[] = []
  let cycleEndedByRest = false
  for (const period of periods) {
    if (period.qualifyingBreak == null) continue
    for (const [startUtc, endUtc] of breakSpans(period.qualifyingBreak, activities)) {
      if (endUtc - startUtc > CYCLE_REST_MS) {
        cycleEndedByRest = true
        continue
      }
      breaks.push(`${lengthText(endUtc - startUtc)} (${rangeText(startUtc, endUtc, clockMode)})`)
    }
  }
  return { breaks, cycleEndedByRest }
}

function breakSpans(item: QualifyingDrivingBreak, activities: readonly DayDrivingActivity[]): Array<[number, number]> {
  const ids = new Set(item.sourceActivityIds)
  const rests = activities
    .filter((activity) => ids.has(activity.id) && activity.kind === 'rest' && activity.endUtc > activity.startUtc)
    .map((activity) => [activity.startUtc, activity.endUtc] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: Array<[number, number]> = []
  for (const [startUtc, endUtc] of rests) {
    const last = merged[merged.length - 1]
    if (last != null && startUtc <= last[1]) last[1] = Math.max(last[1], endUtc)
    else merged.push([startUtc, endUtc])
  }
  return merged.length > 0 ? merged : [[item.startUtc, item.completedAtUtc]]
}

function rangeText(startUtc: number, endUtc: number, clockMode: ClockMode): string {
  const start = clockParts(startUtc, clockMode)
  const end = clockParts(endUtc, clockMode)
  const sameDay = start.day === end.day && start.month === end.month && start.year === end.year
  if (sameDay) return `${formatClockTime(startUtc, clockMode)}–${formatClockTime(endUtc, clockMode)}`
  return `${formatClockDateTime(startUtc, clockMode)}–${formatClockDateTime(endUtc, clockMode)}`
}

function evaluated(periods: readonly DrivingBreakPeriod[]): DrivingBreakPeriod[] {
  return periods.filter((period) => period.status !== 'insufficient_data')
}

function drivingOnDay(activities: readonly DayDrivingActivity[], dayStartUtc: number, dayEndUtc: number): number {
  const parts = activities
    .filter((activity) => activity.kind === 'driving')
    .map((activity) => [Math.max(activity.startUtc, dayStartUtc), Math.min(activity.endUtc, dayEndUtc)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: Array<[number, number]> = []
  for (const [start, end] of parts) {
    const last = merged[merged.length - 1]
    if (last != null && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged.reduce((sum, [start, end]) => sum + (end - start), 0)
}

function lengthText(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}

function overlaps(startUtc: number, endUtc: number, otherStartUtc: number, otherEndUtc: number): boolean {
  return startUtc < otherEndUtc && otherStartUtc < endUtc
}
