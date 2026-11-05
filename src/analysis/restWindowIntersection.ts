import type { RestCandidate } from './restCandidates'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export const DAILY_WINDOW_MS = 24 * HOUR_MS

/** Technický průnik odpočinku se zadaným oknem. Není to právní platnost. */
export type RestWindowIntersection = {
  windowStartUtc: number
  windowEndUtc: number
  intersectionStartUtc: number | null
  intersectionEndUtc: number | null
  restMinutesInsideWindow: number
  candidateMinutes: number
  reaches9h: boolean
  reaches11h: boolean
  ambiguous: boolean
}

/**
 * Průnik [candidate.startUtc, candidate.endUtc) s oknem [windowStartUtc, windowStartUtc + 24 h).
 * Počátek okna musí dodat volající. Devět a jedenáct hodin jsou jen délky průniku.
 */
export function intersectRestWithDailyWindow(
  candidate: RestCandidate,
  windowStartUtc: number,
): RestWindowIntersection {
  const windowEndUtc = windowStartUtc + DAILY_WINDOW_MS
  const intersectionStartUtc = Math.max(candidate.startUtc, windowStartUtc)
  const intersectionEndUtc = Math.min(candidate.endUtc, windowEndUtc)
  const overlapMs = intersectionEndUtc - intersectionStartUtc
  const hasOverlap = overlapMs > 0
  const restMinutesInsideWindow = hasOverlap ? Math.round(overlapMs / MINUTE_MS) : 0

  return {
    windowStartUtc,
    windowEndUtc,
    intersectionStartUtc: hasOverlap ? intersectionStartUtc : null,
    intersectionEndUtc: hasOverlap ? intersectionEndUtc : null,
    restMinutesInsideWindow,
    candidateMinutes: Math.round(candidate.durationMs / MINUTE_MS),
    reaches9h: hasOverlap && overlapMs >= 9 * HOUR_MS,
    reaches11h: hasOverlap && overlapMs >= 11 * HOUR_MS,
    ambiguous: candidate.ambiguous,
  }
}
