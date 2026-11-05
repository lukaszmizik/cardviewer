import type { RestInterval, RestIntervalUncertainty } from './restIntervals'

const HOUR_MS = 60 * 60 * 1000

/** Délková role. Není to potvrzení, že odpočinek právně platí. */
export type RestCandidateKind =
  | 'daily_reduced'
  | 'daily_regular'
  | 'daily_split_first'
  | 'daily_split_second'
  | 'weekly_reduced'
  | 'weekly_regular'

export type RestCandidate = {
  startUtc: number
  endUtc: number
  durationMs: number
  durationMinutes: number
  slot: RestInterval['slot']
  sourceActivityIds: string[]
  /** Alespoň jeden zdrojový úsek je ruční. Samo o sobě kandidáta nevyřazuje. */
  manualEntry: boolean
  ambiguous: boolean
  /**
   * false, když je zdrojový interval nejednoznačný.
   * true neznamená právní platnost, jen že délka vychází z nekonfliktního intervalu.
   */
  established: boolean
  uncertainties: RestIntervalUncertainty[]
  overlappingNonRestKinds: RestInterval['overlappingNonRestKinds']
  /**
   * Všechny splněné délkové role jednoho souvislého intervalu.
   * `daily_split_first` a `daily_split_second` jsou jen způsobilost částí pro pozdější párování.
   */
  kinds: RestCandidateKind[]
}

const THREE_HOURS = 3 * HOUR_MS
const NINE_HOURS = 9 * HOUR_MS
const ELEVEN_HOURS = 11 * HOUR_MS
const TWENTY_FOUR_HOURS = 24 * HOUR_MS
const FORTY_FIVE_HOURS = 45 * HOUR_MS

function lengthKinds(durationMs: number): RestCandidateKind[] {
  const kinds: RestCandidateKind[] = []
  if (durationMs >= NINE_HOURS) kinds.push('daily_reduced')
  if (durationMs >= ELEVEN_HOURS) kinds.push('daily_regular')
  if (durationMs >= THREE_HOURS) kinds.push('daily_split_first')
  if (durationMs >= NINE_HOURS) kinds.push('daily_split_second')
  if (durationMs >= TWENTY_FOUR_HOURS) kinds.push('weekly_reduced')
  if (durationMs >= FORTY_FIVE_HOURS) kinds.push('weekly_regular')
  return kinds
}

/**
 * Z každého souvislého odpočinku udělá jeden kandidátní záznam.
 * Dlouhý interval se nedělí na víc denních ani týdenních odpočinků.
 */
export function classifyRestCandidates(intervals: readonly RestInterval[]): RestCandidate[] {
  return intervals.map((interval) => ({
    startUtc: interval.startUtc,
    endUtc: interval.endUtc,
    durationMs: interval.durationMs,
    durationMinutes: interval.durationMinutes,
    slot: interval.slot,
    sourceActivityIds: [...interval.sourceActivityIds],
    manualEntry: interval.uncertainties.includes('manual_entry'),
    ambiguous: interval.ambiguous,
    established: !interval.ambiguous,
    uncertainties: [...interval.uncertainties],
    overlappingNonRestKinds: [...interval.overlappingNonRestKinds],
    kinds: lengthKinds(interval.durationMs),
  }))
}
