import { assessDrivingBreaks, type BreakActivity, type DrivingBreakPeriod } from '../analysis/drivingBreaks.ts'

export type DayDrivingActivity = BreakActivity & {
  isCrew?: boolean
}

export type DayDrivingRow = {
  label: string
  value: string
}

const UNRELIABLE = 'Nelze spolehlivě vyhodnotit.'

/**
 * Řádky pod denní graf. Přestávky počítá z celé předané osy, ne jen z jednoho dne.
 * Denní součet řízení je informativní a není kontrola podle čl. 6.
 */
export function buildDayDrivingRows(input: {
  activities: readonly DayDrivingActivity[]
  dayStartUtc: number
  dayEndUtc: number
}): DayDrivingRow[] {
  const periods = assessDrivingBreaks(input.activities)
  const relevant = periods.filter((period) => overlaps(period.startUtc, period.endUtc, input.dayStartUtc, input.dayEndUtc))
  const rows: DayDrivingRow[] = [
    {
      label: 'Celková zaznamenaná doba řízení',
      value: `${lengthText(drivingOnDay(input.activities, input.dayStartUtc, input.dayEndUtc))}. Informativní údaj, není vyhodnocení podle čl. 6.`,
    },
    {
      label: 'Bezpečnostní přestávky',
      value: breakText(relevant),
    },
    {
      label: 'Kontrola čl. 7',
      value: resultText(relevant, input.activities),
    },
  ]
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

function breakText(periods: readonly DrivingBreakPeriod[]): string {
  const labels = periods.flatMap((period) => {
    if (period.qualifyingBreak == null) return []
    return [period.qualifyingBreak.kind === 'split_15_30' ? '15 + 30 min' : '45 min']
  })
  return labels.length > 0 ? labels.join(', ') : '—'
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
