import type { RestCandidate } from './restCandidates'
import {
  DAILY_WINDOW_MS,
  intersectRestWithDailyWindow,
  type RestWindowIntersection,
} from './restWindowIntersection.ts'

const HOUR_MS = 60 * 60 * 1000
const THREE_HOURS = 3 * HOUR_MS

/** Možná podoba denního odpočinku. Není to právní nález. */
export type DailyRestVariantKind = 'continuous_regular' | 'continuous_reduced' | 'split_regular'

export type DailyRestOptionPart = {
  startUtc: number
  endUtc: number
  candidateMinutes: number
  restMinutesInsideWindow: number
  intersectionStartUtc: number | null
  intersectionEndUtc: number | null
  sourceActivityIds: string[]
  manualEntry: boolean
  ambiguous: boolean
}

export type DailyRestOption = {
  kind: DailyRestVariantKind
  windowStartUtc: number
  windowEndUtc: number
  /** false, když je některý použitý interval nejednoznačný. Není to právní platnost. */
  established: boolean
  parts: DailyRestOptionPart[]
}

type MeasuredCandidate = {
  candidate: RestCandidate
  intersection: RestWindowIntersection
  overlapMs: number
}

/**
 * Všechny délkově možné varianty denního odpočinku v jednom zadaném okně.
 * Počátek okna musí dodat volající. Funkce žádnou variantu nevolí.
 */
export function findDailyRestOptions(
  candidates: readonly RestCandidate[],
  windowStartUtc: number,
): DailyRestOption[] {
  const measured = candidates.map((candidate) => measure(candidate, windowStartUtc))
  const windowEndUtc = windowStartUtc + DAILY_WINDOW_MS
  const options: DailyRestOption[] = []

  for (const item of measured) {
    if (item.intersection.reaches11h) options.push(continuous('continuous_regular', item))
    else if (item.intersection.reaches9h) options.push(continuous('continuous_reduced', item))
  }

  for (const first of measured) {
    if (first.overlapMs < THREE_HOURS) continue
    for (const second of measured) {
      if (first.candidate === second.candidate) continue
      if (first.candidate.endUtc > second.candidate.startUtc) continue
      if (!second.intersection.reaches9h) continue
      options.push({
        kind: 'split_regular',
        windowStartUtc,
        windowEndUtc,
        established: !first.candidate.ambiguous && !second.candidate.ambiguous,
        parts: [toPart(first), toPart(second)],
      })
    }
  }

  return options
}

function measure(candidate: RestCandidate, windowStartUtc: number): MeasuredCandidate {
  const intersection = intersectRestWithDailyWindow(candidate, windowStartUtc)
  const overlapMs =
    intersection.intersectionStartUtc == null || intersection.intersectionEndUtc == null
      ? 0
      : intersection.intersectionEndUtc - intersection.intersectionStartUtc
  return { candidate, intersection, overlapMs }
}

function continuous(kind: DailyRestVariantKind, item: MeasuredCandidate): DailyRestOption {
  return {
    kind,
    windowStartUtc: item.intersection.windowStartUtc,
    windowEndUtc: item.intersection.windowEndUtc,
    established: !item.candidate.ambiguous,
    parts: [toPart(item)],
  }
}

function toPart(item: MeasuredCandidate): DailyRestOptionPart {
  return {
    startUtc: item.candidate.startUtc,
    endUtc: item.candidate.endUtc,
    candidateMinutes: item.intersection.candidateMinutes,
    restMinutesInsideWindow: item.intersection.restMinutesInsideWindow,
    intersectionStartUtc: item.intersection.intersectionStartUtc,
    intersectionEndUtc: item.intersection.intersectionEndUtc,
    sourceActivityIds: [...item.candidate.sourceActivityIds],
    manualEntry: item.candidate.manualEntry,
    ambiguous: item.candidate.ambiguous,
  }
}
