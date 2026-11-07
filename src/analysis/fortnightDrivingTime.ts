import { utcWeekStart } from './dailyDrivingTime.ts'
import {
  assessWeeklyDrivingTime,
  type WeeklyDrivingTime,
  type WeeklyDrivingUncertainty,
} from './weeklyDrivingTime.ts'
import type { Activity } from '../types/tacho.ts'

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS

/** Doba řízení dvou po sobě jdoucích týdnů podle čl. 6 odst. 3. Přesně 90 hodin je ještě v limitu. */
export const FORTNIGHT_DRIVING_LIMIT_MS = 90 * HOUR_MS

export type FortnightDrivingStatus = 'within_90h' | 'over_90h' | 'incomplete' | 'insufficient_data'

export type FortnightDrivingTime = {
  earlierWeekStartUtc: number
  laterWeekStartUtc: number
  /** Pondělí 00:00 UTC dřívějšího týdne. */
  periodStartUtc: number
  /** Následující pondělí 00:00 UTC po pozdějším týdnu, tedy neděle 24:00 UTC. */
  periodEndUtc: number
  /** Známý součet obou týdnů. Při neúplných nebo neznámých datech je to dolní mez. */
  drivingMs: number
  status: FortnightDrivingStatus
  /**
   * Dosud hodnocená okna obou týdnů jsou pokrytá, bez vnitřní mezery a bez neznámého úseku.
   * Neznamená to, že je uzavřené celé dvoutýdenní období.
   */
  dataComplete: boolean
  /** Součet sahá až do neděle 24:00 UTC pozdějšího týdne. */
  fortnightClosed: boolean
  evaluatedUntilUtc: number
  limitMs: typeof FORTNIGHT_DRIVING_LIMIT_MS
  earlier: WeeklyDrivingTime
  later: WeeklyDrivingTime
  uncertainties: WeeklyDrivingUncertainty[]
}

/**
 * Součet řízení v týdnu před `laterWeekStartUtc` a v týdnu od tohoto pondělí.
 * Oba týdny počítá `assessWeeklyDrivingTime`, takže minuta na pondělí 00:00 UTC patří jen pozdějšímu týdnu.
 * `untilUtc` utne jen pozdější týden. Průběžný součet tím neuzavře celé dvoutýdenní období.
 * Přestupek nevytváří.
 */
export function assessFortnightDrivingTime(input: {
  activities: readonly Activity[]
  laterWeekStartUtc: number
  untilUtc?: number
}): FortnightDrivingTime {
  const laterWeekStartUtc = utcWeekStart(input.laterWeekStartUtc)
  const earlierWeekStartUtc = laterWeekStartUtc - WEEK_MS
  const earlier = assessWeeklyDrivingTime({
    activities: input.activities,
    weekStartUtc: earlierWeekStartUtc,
  })
  const later = assessWeeklyDrivingTime({
    activities: input.activities,
    weekStartUtc: laterWeekStartUtc,
    untilUtc: input.untilUtc,
  })
  const drivingMs = earlier.drivingMs + later.drivingMs
  const dataComplete = earlier.dataComplete && later.dataComplete
  const fortnightClosed = later.evaluatedUntilUtc === later.weekEndUtc
  const unknown = earlier.uncertainties.includes('unknown_interval') || later.uncertainties.includes('unknown_interval')
  const status: FortnightDrivingStatus =
    drivingMs > FORTNIGHT_DRIVING_LIMIT_MS
      ? 'over_90h'
      : unknown
        ? 'insufficient_data'
        : dataComplete && fortnightClosed
          ? 'within_90h'
          : 'incomplete'

  return {
    earlierWeekStartUtc,
    laterWeekStartUtc,
    periodStartUtc: earlier.weekStartUtc,
    periodEndUtc: later.weekEndUtc,
    drivingMs,
    status,
    dataComplete,
    fortnightClosed,
    evaluatedUntilUtc: later.evaluatedUntilUtc,
    limitMs: FORTNIGHT_DRIVING_LIMIT_MS,
    earlier,
    later,
    uncertainties: union(earlier.uncertainties, later.uncertainties),
  }
}

/**
 * Každá sousední dvojice týdnů, do kterých záznam zasahuje: 1+2, 2+3, 3+4.
 * Pevné dvojice 1+2 a 3+4 se nepoužívají.
 */
export function assessAdjacentFortnightDrivingTimes(input: {
  activities: readonly Activity[]
}): FortnightDrivingTime[] {
  const present = input.activities.filter((activity) => activity.endUtc > activity.startUtc)
  if (present.length === 0) return []
  const first = utcWeekStart(Math.min(...present.map((activity) => activity.startUtc)))
  const last = utcWeekStart(Math.max(...present.map((activity) => activity.endUtc - 1)))
  const results: FortnightDrivingTime[] = []
  for (let week = first; week < last; week += WEEK_MS) {
    results.push(assessFortnightDrivingTime({ activities: input.activities, laterWeekStartUtc: week + WEEK_MS }))
  }
  return results
}

function union(left: readonly WeeklyDrivingUncertainty[], right: readonly WeeklyDrivingUncertainty[]): WeeklyDrivingUncertainty[] {
  const result: WeeklyDrivingUncertainty[] = []
  for (const item of [...left, ...right]) {
    if (!result.includes(item)) result.push(item)
  }
  return result
}
