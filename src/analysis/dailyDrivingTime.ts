import type { DailyChainInterpretation, DailyRestChain } from './dailyRestChain.ts'
import type { RestCandidate } from './restCandidates.ts'
import type { Activity } from '../types/tacho.ts'

const HOUR_MS = 60 * 60 * 1000
const NINE_HOURS = 9 * HOUR_MS
const TEN_HOURS = 10 * HOUR_MS

/** Mezi 9 a 10 hodinami se týdenní počet prodloužení nepočítá. */
export const WEEKLY_EXTENSION_CHECK_TEXT = 'vyžaduje kontrolu týdenního počtu prodloužení'

export type DailyDrivingResult =
  | 'up_to_9h'
  | 'over_9h_up_to_10h'
  | 'over_10h'
  | 'insufficient_data'
  | 'ambiguous_boundaries'

export type DailyDrivingUncertainty =
  | 'unknown_interval'
  | 'multiple_rest_boundaries'
  | 'unestablished_rest'
  | 'closing_rest_missing'
  | 'opening_rest_unmatched'

/** Hranice převzatá z existujícího odpočinku. Není to nová právní kategorie. */
export type DailyDrivingRestBoundary = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
}

export type DailyDrivingBoundaryAlternative = {
  closingStartUtc: number
  drivingMs: number
  sourceActivityIds: string[]
}

export type DailyDrivingPeriod = {
  startUtc: number
  endUtc: number | null
  drivingMs: number | null
  /**
   * Nejnižší a nejvyšší součet prokázaných alternativ téhož začátku.
   * null, když neznámý úsek nebo nejasný začátek brání přesnému rozsahu.
   * Není to vybraný závěr.
   */
  drivingSpanMs: { lowMs: number; highMs: number } | null
  openingRest: DailyDrivingRestBoundary | null
  closingRest: DailyDrivingRestBoundary | null
  result: DailyDrivingResult
  /** Vyplněno jen mezi 9 a 10 hodinami. Omezení dvakrát týdně se nehodnotí. */
  extensionNote: typeof WEEKLY_EXTENSION_CHECK_TEXT | null
  uncertainties: DailyDrivingUncertainty[]
  drivingSourceActivityIds: string[]
  /** Vyplněno, když řetězec má víc hranic. Žádná z nich není vybraný závěr. */
  boundaryAlternatives: DailyDrivingBoundaryAlternative[]
  /** false, dokud období neuzavře jedna dohodnutá hranice odpočinku. */
  closed: boolean
}

/**
 * Denní doba řízení mezi koncem jednoho odpočinku a začátkem dalšího.
 * Hranice bere z už sestaveného denního řetězce. Odpočinky znovu nerozpoznává.
 * Půlnoc ani přestávka podle čl. 7 období neukončí. Přestupek nevytváří.
 */
export function assessDailyDrivingTime(input: {
  activities: readonly Activity[]
  candidates: readonly RestCandidate[]
  chains: readonly DailyRestChain[]
}): DailyDrivingPeriod[] {
  const periods: DailyDrivingPeriod[] = []
  const seen = new Set<number>()
  for (const chain of input.chains) {
    for (const period of periodsFromChain(chain, input.activities, input.candidates)) {
      if (seen.has(period.startUtc)) continue
      seen.add(period.startUtc)
      periods.push(period)
    }
  }
  return periods.sort((a, b) => a.startUtc - b.startUtc)
}

function periodsFromChain(
  chain: DailyRestChain,
  activities: readonly Activity[],
  candidates: readonly RestCandidate[],
): DailyDrivingPeriod[] {
  const ordered = [...chain.nodes].sort((left, right) => left.anchorUtc - right.anchorUtc)
  const periods: DailyDrivingPeriod[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]!
    const interpretations = node.interpretations.filter((item) => item.parts.length > 0)
    if (interpretations.length === 0) {
      if (index !== ordered.length - 1) continue
      const open = openPeriod(node.anchorUtc, activities, candidates)
      if (open) periods.push(open)
      continue
    }
    const starts = unique(interpretations.map(closingStart))
    if (starts.length !== 1) {
      periods.push(ambiguousPeriod(node.anchorUtc, interpretations, activities, candidates))
      continue
    }
    periods.push(closedPeriod(node.anchorUtc, interpretations, activities, candidates))
  }
  return periods
}

function closedPeriod(
  anchorUtc: number,
  interpretations: readonly DailyChainInterpretation[],
  activities: readonly Activity[],
  candidates: readonly RestCandidate[],
): DailyDrivingPeriod {
  const interpretation = interpretations[0]!
  const closing = closingBoundary(interpretation)
  const endUtc = closing.startUtc
  const driven = drivingBetween(activities, anchorUtc, endUtc)
  const uncertainties: DailyDrivingUncertainty[] = []
  const opening = openingBoundary(anchorUtc, candidates, uncertainties)
  if (
    (interpretations.some((item) => !item.established) || closingUnestablished(closing, candidates)) &&
    !uncertainties.includes('unestablished_rest')
  ) {
    uncertainties.push('unestablished_rest')
  }
  if (hasUnknown(activities, anchorUtc, endUtc)) uncertainties.push('unknown_interval')

  const result: DailyDrivingResult = uncertainties.includes('unestablished_rest')
    ? 'ambiguous_boundaries'
    : uncertainties.includes('unknown_interval')
      ? 'insufficient_data'
      : classify(driven.ms)

  return {
    startUtc: anchorUtc,
    endUtc,
    drivingMs: driven.ms,
    drivingSpanMs: null,
    openingRest: opening,
    closingRest: closing,
    result,
    extensionNote: result === 'over_9h_up_to_10h' ? WEEKLY_EXTENSION_CHECK_TEXT : null,
    uncertainties,
    drivingSourceActivityIds: driven.ids,
    boundaryAlternatives: [],
    closed: result === 'up_to_9h' || result === 'over_9h_up_to_10h' || result === 'over_10h',
  }
}

function ambiguousPeriod(
  anchorUtc: number,
  interpretations: readonly DailyChainInterpretation[],
  activities: readonly Activity[],
  candidates: readonly RestCandidate[],
): DailyDrivingPeriod {
  const uncertainties: DailyDrivingUncertainty[] = ['multiple_rest_boundaries']
  const opening = openingBoundary(anchorUtc, candidates, uncertainties)
  const alternatives = uniqueInterpretations(interpretations).map((interpretation) => {
    const closing = closingBoundary(interpretation)
    return {
      closingStartUtc: closing.startUtc,
      drivingMs: drivingBetween(activities, anchorUtc, closing.startUtc).ms,
      sourceActivityIds: closing.sourceActivityIds,
    }
  })
  const earliest = alternatives.reduce<number | null>(
    (min, item) => (min == null || item.closingStartUtc < min ? item.closingStartUtc : min),
    null,
  )
  const latest = alternatives.reduce<number | null>(
    (max, item) => (max == null || item.closingStartUtc > max ? item.closingStartUtc : max),
    null,
  )
  const unknown = latest != null && hasUnknown(activities, anchorUtc, latest)
  const startKnown = !uncertainties.includes('unestablished_rest') && !uncertainties.includes('opening_rest_unmatched')
  const proven = interpretations.every((item) => item.established)
  if (!proven && !uncertainties.includes('unestablished_rest')) uncertainties.push('unestablished_rest')
  if (unknown) uncertainties.push('unknown_interval')
  const comparable = startKnown && proven && !unknown && alternatives.length > 1
  const lowMs = comparable ? Math.min(...alternatives.map((item) => item.drivingMs)) : null
  const highMs = comparable ? Math.max(...alternatives.map((item) => item.drivingMs)) : null
  const sameDriving = comparable && lowMs === highMs
  const sharedDriving = sameDriving ? drivingBetween(activities, anchorUtc, earliest ?? anchorUtc) : null
  return {
    startUtc: anchorUtc,
    endUtc: earliest,
    drivingMs: sharedDriving?.ms ?? null,
    drivingSpanMs: lowMs == null || highMs == null ? null : { lowMs, highMs },
    openingRest: opening,
    closingRest: null,
    result: unknown ? 'insufficient_data' : 'ambiguous_boundaries',
    extensionNote: null,
    uncertainties,
    drivingSourceActivityIds: comparable && latest != null ? drivingBetween(activities, anchorUtc, latest).ids : [],
    boundaryAlternatives: alternatives.sort((left, right) => left.closingStartUtc - right.closingStartUtc),
    closed: false,
  }
}

function openPeriod(
  anchorUtc: number,
  activities: readonly Activity[],
  candidates: readonly RestCandidate[],
): DailyDrivingPeriod | null {
  const driven = drivingBetween(activities, anchorUtc, Number.POSITIVE_INFINITY)
  const unknown = hasUnknown(activities, anchorUtc, Number.POSITIVE_INFINITY)
  if (driven.ms === 0 && !unknown) return null
  const uncertainties: DailyDrivingUncertainty[] = ['closing_rest_missing']
  const opening = openingBoundary(anchorUtc, candidates, uncertainties)
  if (unknown) uncertainties.push('unknown_interval')
  const startKnown = !unknown && !uncertainties.includes('unestablished_rest') && !uncertainties.includes('opening_rest_unmatched')
  return {
    startUtc: anchorUtc,
    endUtc: null,
    drivingMs: startKnown ? driven.ms : null,
    drivingSpanMs: null,
    openingRest: opening,
    closingRest: null,
    result: startKnown ? classify(driven.ms) : 'insufficient_data',
    extensionNote: null,
    uncertainties,
    drivingSourceActivityIds: startKnown ? driven.ids : [],
    boundaryAlternatives: [],
    closed: false,
  }
}

function classify(drivingMs: number): DailyDrivingResult {
  if (drivingMs <= NINE_HOURS) return 'up_to_9h'
  if (drivingMs <= TEN_HOURS) return 'over_9h_up_to_10h'
  return 'over_10h'
}

/**
 * U děleného odpočinku 3 + 9 hodin denní dobu řízení ukončuje začátek druhé části.
 * První část sama hranicí není. Souvislý odpočinek má jedinou část, takže hranice zůstává její začátek.
 */
function closingStart(interpretation: DailyChainInterpretation | null): number | null {
  return completingPart(interpretation)?.startUtc ?? null
}

function closingBoundary(interpretation: DailyChainInterpretation): DailyDrivingRestBoundary {
  const completing = completingPart(interpretation)!
  return {
    startUtc: completing.startUtc,
    endUtc: completing.endUtc,
    sourceActivityIds: unique(interpretation.parts.flatMap((part) => part.sourceActivityIds)),
  }
}

function completingPart(
  interpretation: DailyChainInterpretation | null,
): { startUtc: number; endUtc: number } | null {
  const parts = interpretation?.parts
  if (parts == null || parts.length === 0) return null
  return parts[parts.length - 1]!
}

function closingUnestablished(closing: DailyDrivingRestBoundary, candidates: readonly RestCandidate[]): boolean {
  return candidates.some(
    (candidate) =>
      candidate.startUtc === closing.startUtc &&
      candidate.endUtc === closing.endUtc &&
      !candidate.established,
  )
}

function openingBoundary(
  anchorUtc: number,
  candidates: readonly RestCandidate[],
  uncertainties: DailyDrivingUncertainty[],
): DailyDrivingRestBoundary | null {
  const matches = candidates.filter((candidate) => candidate.endUtc === anchorUtc)
  if (matches.length === 0) {
    uncertainties.push('opening_rest_unmatched')
    return null
  }
  if (matches.some((candidate) => !candidate.established)) uncertainties.push('unestablished_rest')
  return {
    startUtc: Math.min(...matches.map((candidate) => candidate.startUtc)),
    endUtc: anchorUtc,
    sourceActivityIds: unique(matches.flatMap((candidate) => candidate.sourceActivityIds)),
  }
}

function drivingBetween(
  activities: readonly Activity[],
  fromUtc: number,
  toUtc: number,
): { ms: number; ids: string[] } {
  const slices: Array<{ startUtc: number; endUtc: number; id: string }> = []
  for (const activity of activities) {
    if (activity.kind !== 'driving') continue
    const startUtc = Math.max(activity.startUtc, fromUtc)
    const endUtc = Math.min(activity.endUtc, toUtc)
    if (endUtc <= startUtc) continue
    slices.push({ startUtc, endUtc, id: activity.id })
  }
  slices.sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
  let ms = 0
  let cursor = Number.NEGATIVE_INFINITY
  const ids: string[] = []
  for (const slice of slices) {
    if (!ids.includes(slice.id)) ids.push(slice.id)
    const startUtc = Math.max(slice.startUtc, cursor)
    if (slice.endUtc > startUtc) ms += slice.endUtc - startUtc
    if (slice.endUtc > cursor) cursor = slice.endUtc
  }
  return { ms, ids }
}

function hasUnknown(activities: readonly Activity[], fromUtc: number, toUtc: number): boolean {
  return activities.some(
    (activity) => activity.kind === 'unknown' && activity.startUtc < toUtc && activity.endUtc > fromUtc,
  )
}

function uniqueInterpretations(interpretations: readonly DailyChainInterpretation[]): DailyChainInterpretation[] {
  const seen = new Set<number>()
  const result: DailyChainInterpretation[] = []
  for (const interpretation of interpretations) {
    const startUtc = closingStart(interpretation)
    if (startUtc == null || seen.has(startUtc)) continue
    seen.add(startUtc)
    result.push(interpretation)
  }
  return result
}

const WEEK_MS = 7 * 24 * HOUR_MS
export const WEEKLY_EXTENSION_LIMIT = 2

export type WeeklyExtensionStatus = 'counted' | 'undecided'

/** Počet prodloužení nad 9 hodin v jednom kalendářním týdnu. Není to závěr o přestupku. */
export type WeeklyDrivingExtensions = {
  weekStartUtc: number
  weekEndUtc: number
  status: WeeklyExtensionStatus
  /** null, když počet nelze uzavřít. Chybějící data nejsou nula. */
  used: number | null
  remaining: number | null
  limit: typeof WEEKLY_EXTENSION_LIMIT
}

/**
 * Pondělí 00:00 UTC týdne, do kterého okamžik patří.
 * Týden končí následujícím pondělím 00:00 UTC.
 */
export function utcWeekStart(utc: number): number {
  const date = new Date(utc)
  const mondayOffset = (date.getUTCDay() + 6) % 7
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset)
}

/**
 * Sečte už vyhodnocené denní doby řízení nad 9 hodin.
 * Celé období patří týdnu svého začátku. Přes pondělní půlnoc se nedělí.
 * Nařízení ten okamžik pro období přes hranici týdne výslovně neurčuje.
 */
export function assessWeeklyDrivingExtensions(input: {
  periods: readonly DailyDrivingPeriod[]
  weekStartUtc: number
  recordStartUtc: number | null
  recordEndUtc: number | null
}): WeeklyDrivingExtensions {
  const weekEndUtc = input.weekStartUtc + WEEK_MS
  const base = {
    weekStartUtc: input.weekStartUtc,
    weekEndUtc,
    limit: WEEKLY_EXTENSION_LIMIT as typeof WEEKLY_EXTENSION_LIMIT,
  }
  const inWeek = input.periods.filter((period) => period.startUtc >= input.weekStartUtc && period.startUtc < weekEndUtc)
  const coverage = assessedCoverage(input.periods)
  const recordCoversWeek =
    input.recordStartUtc != null &&
    input.recordEndUtc != null &&
    input.recordStartUtc <= input.weekStartUtc &&
    input.recordEndUtc >= weekEndUtc
  const coversWeek = coverage != null && coverage.startUtc <= input.weekStartUtc && coverage.endUtc >= weekEndUtc
  const uncertain = inWeek.some(
    (period) =>
      period.drivingMs == null || period.result === 'insufficient_data' || period.result === 'ambiguous_boundaries',
  )
  if (!recordCoversWeek || !coversWeek || uncertain) {
    return { ...base, status: 'undecided', used: null, remaining: null }
  }
  const used = inWeek.filter((period) => period.result === 'over_9h_up_to_10h' || period.result === 'over_10h').length
  return {
    ...base,
    status: 'counted',
    used,
    remaining: Math.max(0, WEEKLY_EXTENSION_LIMIT - used),
  }
}

function assessedCoverage(periods: readonly DailyDrivingPeriod[]): { startUtc: number; endUtc: number } | null {
  if (periods.length === 0) return null
  const first = periods[0]!
  const last = periods[periods.length - 1]!
  const endUtc = last.closingRest?.endUtc ?? last.endUtc
  if (endUtc == null) return null
  return { startUtc: first.openingRest?.startUtc ?? first.startUtc, endUtc }
}

function unique<T>(values: readonly (T | null)[]): T[] {
  const result: T[] = []
  for (const value of values) {
    if (value == null || result.includes(value)) continue
    result.push(value)
  }
  return result
}
