import { utcWeekStart } from './dailyDrivingTime.ts'
import type { Activity } from '../types/tacho.ts'

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS

/** Týdenní doba řízení podle čl. 6 odst. 2. Přesně 56 hodin je ještě v limitu. */
export const WEEKLY_DRIVING_LIMIT_MS = 56 * HOUR_MS

export type WeeklyDrivingStatus = 'within_56h' | 'over_56h' | 'incomplete' | 'insufficient_data'

export type WeeklyDrivingUncertainty = 'record_incomplete' | 'unknown_interval' | 'overlapping_records' | 'activity_gap'

/** Úsek řízení po oříznutí na týden. Překryv stejného času je sloučený. */
export type WeeklyDrivingInterval = {
  startUtc: number
  endUtc: number
  durationMs: number
  sourceActivityIds: string[]
}

export type WeeklyDrivingTime = {
  weekStartUtc: number
  weekEndUtc: number
  /** Známý součet řízení. Při neúplných nebo neznámých datech je to dolní mez, ne uzavřený týden. */
  drivingMs: number
  status: WeeklyDrivingStatus
  /** Řez pokrývá celé hodnocené okno, bez vnitřní mezery a bez neznámého úseku. */
  dataComplete: boolean
  /** Konec součtu. Bez řezu je to konec týdne. */
  evaluatedUntilUtc: number
  limitMs: typeof WEEKLY_DRIVING_LIMIT_MS
  intervals: WeeklyDrivingInterval[]
  uncertainties: WeeklyDrivingUncertainty[]
}

/**
 * Týdenní doba řízení od pondělí 00:00 UTC do následujícího pondělí 00:00 UTC.
 * `untilUtc` součet utne na konec vybraného dne, ne však za koncem týdne.
 * Sčítá jen činnost řízení. Mezera v záznamu není odpočinek ani nulové řízení.
 * Hranice odpočinků ani pracovních období nepoužívá. Přestupek nevytváří.
 */
export function assessWeeklyDrivingTime(input: {
  activities: readonly Activity[]
  weekStartUtc: number
  untilUtc?: number
}): WeeklyDrivingTime {
  const weekStartUtc = utcWeekStart(input.weekStartUtc)
  const weekEndUtc = weekStartUtc + WEEK_MS
  const evaluatedUntilUtc =
    input.untilUtc == null ? weekEndUtc : Math.min(weekEndUtc, Math.max(weekStartUtc, input.untilUtc))
  const present = input.activities.filter((activity) => activity.endUtc > activity.startUtc)
  const recordStartUtc = present.length === 0 ? null : Math.min(...present.map((activity) => activity.startUtc))
  const recordEndUtc = present.length === 0 ? null : Math.max(...present.map((activity) => activity.endUtc))
  const recordCoversWindow =
    recordStartUtc != null && recordEndUtc != null && recordStartUtc <= weekStartUtc && recordEndUtc >= evaluatedUntilUtc

  const slices = weekSlices(present, weekStartUtc, evaluatedUntilUtc)
  const intervals = drivingIntervals(slices)
  const drivingMs = intervals.reduce((sum, interval) => sum + interval.durationMs, 0)
  const unknown = slices.some((slice) => slice.unknown)
  const gap = slices.some((slice) => slice.gap)
  const overlapping = slices.some((slice) => slice.drivingIds.length > 1)
  const uncertainties: WeeklyDrivingUncertainty[] = []
  if (!recordCoversWindow) uncertainties.push('record_incomplete')
  if (gap) uncertainties.push('activity_gap')
  if (unknown) uncertainties.push('unknown_interval')
  if (overlapping) uncertainties.push('overlapping_records')

  const dataComplete = recordCoversWindow && !gap && !unknown
  const status: WeeklyDrivingStatus =
    drivingMs > WEEKLY_DRIVING_LIMIT_MS
      ? 'over_56h'
      : unknown
        ? 'insufficient_data'
        : dataComplete
          ? 'within_56h'
          : 'incomplete'

  return {
    weekStartUtc,
    weekEndUtc,
    drivingMs,
    status,
    dataComplete,
    evaluatedUntilUtc,
    limitMs: WEEKLY_DRIVING_LIMIT_MS,
    intervals,
    uncertainties,
  }
}

type Slice = {
  startUtc: number
  endUtc: number
  unknown: boolean
  gap: boolean
  drivingIds: string[]
}

function weekSlices(activities: readonly Activity[], weekStartUtc: number, weekEndUtc: number): Slice[] {
  const overlapping = activities.filter((activity) => activity.startUtc < weekEndUtc && activity.endUtc > weekStartUtc)
  const points = new Set<number>([weekStartUtc, weekEndUtc])
  for (const activity of overlapping) {
    points.add(Math.max(activity.startUtc, weekStartUtc))
    points.add(Math.min(activity.endUtc, weekEndUtc))
  }
  const bounds = [...points].sort((left, right) => left - right)
  const slices: Slice[] = []
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const startUtc = bounds[index]!
    const endUtc = bounds[index + 1]!
    const here = overlapping.filter((activity) => activity.startUtc < endUtc && activity.endUtc > startUtc)
    slices.push({
      startUtc,
      endUtc,
      unknown: here.some((activity) => activity.kind === 'unknown'),
      gap: here.length === 0,
      drivingIds: here.filter((activity) => activity.kind === 'driving').map((activity) => activity.id),
    })
  }
  return slices
}

function drivingIntervals(slices: readonly Slice[]): WeeklyDrivingInterval[] {
  const intervals: WeeklyDrivingInterval[] = []
  for (const slice of slices) {
    if (slice.unknown || slice.drivingIds.length === 0) continue
    const last = intervals[intervals.length - 1]
    if (last != null && last.endUtc === slice.startUtc) {
      last.endUtc = slice.endUtc
      last.durationMs += slice.endUtc - slice.startUtc
      for (const id of slice.drivingIds) {
        if (!last.sourceActivityIds.includes(id)) last.sourceActivityIds.push(id)
      }
      continue
    }
    intervals.push({
      startUtc: slice.startUtc,
      endUtc: slice.endUtc,
      durationMs: slice.endUtc - slice.startUtc,
      sourceActivityIds: [...slice.drivingIds],
    })
  }
  return intervals
}
