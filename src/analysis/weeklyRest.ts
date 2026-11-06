import type { DailyRestChain } from './dailyRestChain.ts'
import type { RestCandidate } from './restCandidates.ts'
import type { RestIntervalUncertainty } from './restIntervals.ts'

const HOUR_MS = 60 * 60 * 1000
const TWENTY_FOUR_HOURS = 24 * HOUR_MS
const FORTY_FIVE_HOURS = 45 * HOUR_MS
const SIX_PERIODS = 6 * TWENTY_FOUR_HOURS

/** Délková způsobilost. Není to přidělená týdenní role. */
export type WeeklyLengthClass = 'regular' | 'reduced'

export type WeeklyRestCandidate = {
  startUtc: number
  endUtc: number
  durationMs: number
  durationMinutes: number
  sourceActivityIds: string[]
  manualEntry: boolean
  ambiguous: boolean
  /** false při nejednoznačném intervalu. Není to právní platnost. */
  established: boolean
  uncertainties: RestIntervalUncertainty[]
  lengthClass: WeeklyLengthClass
}

export type CalendarWeek = {
  id: string
  startUtc: number
  endUtc: number
}

/** Pondělní hranice dodá volající. Hodiny počítače se nepoužijí. */
export type WeekClock = {
  weeks: readonly CalendarWeek[]
}

export type WeeklyAttachment = 'single_week' | 'starting_week' | 'ending_week'

export type WeeklyCoveredWeek = {
  weekId: string
  overlapStartUtc: number
  overlapEndUtc: number
  overlapMs: number
}

export type WeeklyAssignment =
  | { status: 'assigned'; weekId: string; attachment: WeeklyAttachment }
  | { status: 'continuous_cover'; weeks: WeeklyCoveredWeek[] }
  | { status: 'rejected'; reason: 'week_not_overlapped' | 'both_weeks' }

export type WeeklyTiming =
  | { status: 'on_time'; latestStartUtc: number }
  | { status: 'late'; latestStartUtc: number }
  | { status: 'undetermined'; latestStartUtc: number | null }

export type WeeklyCompensation =
  | { status: 'recorded_unassigned'; deficitMs: number; deadlineUtc: number | null }
  | { status: 'not_recorded'; reason: 'regular_length' | 'not_accepted' }

export type TimeInterval = {
  startUtc: number
  endUtc: number
}

export type WeeklySelection = {
  candidate: WeeklyRestCandidate
  weekId: string
}

export type WeeklySelectionReport = {
  startUtc: number
  endUtc: number
  durationMs: number
  sourceActivityIds: string[]
  manualEntry: boolean
  established: boolean
  lengthClass: WeeklyLengthClass
  assignment: WeeklyAssignment
  timing: WeeklyTiming
  compensation: WeeklyCompensation
  /** Skutečný konec lze předat denní návaznosti. Není to závěr o souladu. */
  usableAsBoundary: boolean
}

export type DailyReducedBetweenWeeklyRests =
  | { status: 'summed'; fromUtc: number; toUtc: number; reducedCount: number }
  | { status: 'undecided' }

export type ReducedDailyIntervalReason =
  | 'anchor_mismatch'
  | 'unknown_interval'
  | 'insufficient_data'
  | 'history_incomplete'
  | 'window_unsatisfied'
  | 'analysis_gap'
  | 'paths_disagree'
  | 'unproven_rest'
  | 'uncovered'

export type CountedReducedDailyRest = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
}

/** Počet mezi dvěma sousedními předěly. Samotný počet není kontrola limitu. */
export type ReducedDailyInterval =
  | {
      status: 'summed'
      fromUtc: number
      toUtc: number
      reducedCount: number
      rests: CountedReducedDailyRest[]
      limitEvaluated: false
    }
  | {
      status: 'undecided'
      fromUtc: number
      toUtc: number
      reason: ReducedDailyIntervalReason
      limitEvaluated: false
    }

/** Kontrola jen čl. 8 odst. 4. Není to celkové potvrzení zákonnosti odpočinků. */
export type ReducedDailyLimitCheck =
  | {
      status: 'within_limit'
      fromUtc: number
      toUtc: number
      reducedCount: number
      limit: 3
      exceeded: false
      rule: 'ec_561_2006_article_8_4'
    }
  | {
      status: 'exceeded'
      fromUtc: number
      toUtc: number
      reducedCount: number
      limit: 3
      exceeded: true
      rule: 'ec_561_2006_article_8_4'
    }
  | {
      status: 'not_concluded'
      fromUtc: number
      toUtc: number
      reason: ReducedDailyIntervalReason
      rule: 'ec_561_2006_article_8_4'
    }

export type DailySegmentView =
  | { kind: 'analysis_gap'; startUtc: number; endUtc: number }
  | { kind: 'chain'; anchorUtc: number }

export type WeeklyRestMvp = {
  selections: WeeklySelectionReport[]
  /** Skutečné konce přijatých týdenních odpočinků, vzestupně. */
  boundaryEndsUtc: number[]
  consecutiveWeeks: 'not_evaluated'
  internationalRegime: 'not_evaluated'
  compensationTaken: 'not_evaluated'
  /** Souhrn jen pro přesně jedno období. Více období zůstává undecided. */
  dailyReduced: DailyReducedBetweenWeeklyRests
  /** Samostatný počet pro každou sousední dvojici použitelných předělů. */
  reducedDailyIntervals: ReducedDailyInterval[]
  /** Samostatná kontrola limitu tří pro stejná období. */
  reducedDailyLimitChecks: ReducedDailyLimitCheck[]
}

/**
 * Z každého souvislého odpočinku nejvýše jeden týdenní délkový záznam.
 * Kratší než 24 hodin se nevrací. Právní role se nepřiřazuje.
 */
export function classifyWeeklyRestCandidates(candidates: readonly RestCandidate[]): WeeklyRestCandidate[] {
  const classified: WeeklyRestCandidate[] = []
  for (const candidate of candidates) {
    const lengthClass = lengthClassOf(candidate.durationMs)
    if (lengthClass == null) continue
    classified.push({
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      durationMs: candidate.durationMs,
      durationMinutes: candidate.durationMinutes,
      sourceActivityIds: [...candidate.sourceActivityIds],
      manualEntry: candidate.manualEntry,
      ambiguous: candidate.ambiguous,
      established: candidate.established,
      uncertainties: [...candidate.uncertainties],
      lengthClass,
    })
  }
  return classified
}

/**
 * Vyhodnotí jen explicitně vybrané týdenní odpočinky.
 * Kombinace „použít / nepoužít“ negeneruje a přestupky nevytváří.
 */
export function assessWeeklyRests(input: {
  previousWeeklyEndUtc: number | null
  selections: readonly WeeklySelection[]
  clock: WeekClock
  dailyChain?: DailyRestChain | null
  unknownIntervals?: readonly TimeInterval[]
  /** Mezery a obnovené řetězce. Automatické týdenní návrhy se sem nepředávají. */
  dailySegments?: readonly DailySegmentView[]
}): WeeklyRestMvp {
  const unknowns = input.unknownIntervals ?? []
  const weeks = [...input.clock.weeks].sort((a, b) => a.startUtc - b.startUtc)
  const ordered = [...input.selections].sort(
    (a, b) => a.candidate.startUtc - b.candidate.startUtc || a.candidate.endUtc - b.candidate.endUtc,
  )
  const duplicateKeys = keysUsedMoreThanOnce(ordered)
  const reports: WeeklySelectionReport[] = []
  let previousEnd = input.previousWeeklyEndUtc

  for (const selection of ordered) {
    const report = reportSelection(selection, weeks, previousEnd, unknowns, duplicateKeys.has(identity(selection.candidate)))
    reports.push(report)
    if (report.usableAsBoundary) previousEnd = report.endUtc
  }

  const boundaryEndsUtc = reports.filter((report) => report.usableAsBoundary).map((report) => report.endUtc)
  const boundaryInstants = (input.previousWeeklyEndUtc == null ? boundaryEndsUtc : [input.previousWeeklyEndUtc, ...boundaryEndsUtc])
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left - right)
  const boundarySources = new Map<number, string[]>()
  for (const report of reports) {
    if (report.usableAsBoundary) boundarySources.set(report.endUtc, report.sourceActivityIds)
  }
  const reducedDailyIntervals = adjacentPairs(boundaryInstants).map(([fromUtc, toUtc]) =>
    countReducedInterval(fromUtc, toUtc, input.dailyChain ?? null, unknowns, input.dailySegments ?? [], boundarySources.get(toUtc) ?? []),
  )

  return {
    selections: reports,
    boundaryEndsUtc,
    consecutiveWeeks: 'not_evaluated',
    internationalRegime: 'not_evaluated',
    compensationTaken: 'not_evaluated',
    dailyReduced: legacyDailyReduced(boundaryInstants, reducedDailyIntervals),
    reducedDailyIntervals,
    reducedDailyLimitChecks: reducedDailyIntervals.map(checkReducedDailyLimit),
  }
}

const REDUCED_DAILY_LIMIT = 3 as const

function checkReducedDailyLimit(interval: ReducedDailyInterval): ReducedDailyLimitCheck {
  const rule = 'ec_561_2006_article_8_4' as const
  if (interval.status === 'undecided') {
    return { status: 'not_concluded', fromUtc: interval.fromUtc, toUtc: interval.toUtc, reason: interval.reason, rule }
  }
  const exceeded = interval.reducedCount > REDUCED_DAILY_LIMIT
  return exceeded
    ? { status: 'exceeded', fromUtc: interval.fromUtc, toUtc: interval.toUtc, reducedCount: interval.reducedCount, limit: REDUCED_DAILY_LIMIT, exceeded: true, rule }
    : { status: 'within_limit', fromUtc: interval.fromUtc, toUtc: interval.toUtc, reducedCount: interval.reducedCount, limit: REDUCED_DAILY_LIMIT, exceeded: false, rule }
}

function reportSelection(
  selection: WeeklySelection,
  weeks: readonly CalendarWeek[],
  previousEnd: number | null,
  unknowns: readonly TimeInterval[],
  usedForBothWeeks: boolean,
): WeeklySelectionReport {
  const candidate = selection.candidate
  const overlapped = weeks.filter((week) => rangesOverlap(candidate.startUtc, candidate.endUtc, week.startUtc, week.endUtc))
  const assignment = assignmentFor(candidate, selection.weekId, overlapped, usedForBothWeeks)
  const crossesUnknown =
    intersectsAny(candidate.startUtc, candidate.endUtc, unknowns) ||
    (previousEnd != null && intersectsAny(previousEnd, candidate.startUtc, unknowns))
  const timing = timingFor(candidate.startUtc, previousEnd, crossesUnknown)
  const usableAsBoundary =
    (assignment.status === 'assigned' || assignment.status === 'continuous_cover') &&
    !intersectsAny(candidate.startUtc, candidate.endUtc, unknowns)
  const compensation = compensationFor(candidate, assignment, weeks)

  return {
    startUtc: candidate.startUtc,
    endUtc: candidate.endUtc,
    durationMs: candidate.durationMs,
    sourceActivityIds: [...candidate.sourceActivityIds],
    manualEntry: candidate.manualEntry,
    established: candidate.established,
    lengthClass: candidate.lengthClass,
    assignment,
    timing,
    compensation,
    usableAsBoundary,
  }
}

function lengthClassOf(durationMs: number): WeeklyLengthClass | null {
  if (durationMs >= FORTY_FIVE_HOURS) return 'regular'
  if (durationMs >= TWENTY_FOUR_HOURS) return 'reduced'
  return null
}

function assignmentFor(
  candidate: WeeklyRestCandidate,
  weekId: string,
  overlapped: readonly CalendarWeek[],
  usedForBothWeeks: boolean,
): WeeklyAssignment {
  if (usedForBothWeeks) return { status: 'rejected', reason: 'both_weeks' }
  const chosen = overlapped.find((week) => week.id === weekId)
  if (chosen == null) return { status: 'rejected', reason: 'week_not_overlapped' }
  if (overlapped.length > 2) {
    return {
      status: 'continuous_cover',
      weeks: overlapped.map((week) => {
        const overlapStartUtc = Math.max(candidate.startUtc, week.startUtc)
        const overlapEndUtc = Math.min(candidate.endUtc, week.endUtc)
        return { weekId: week.id, overlapStartUtc, overlapEndUtc, overlapMs: overlapEndUtc - overlapStartUtc }
      }),
    }
  }
  if (overlapped.length === 1) return { status: 'assigned', weekId, attachment: 'single_week' }
  const earlier = overlapped[0]!
  return {
    status: 'assigned',
    weekId,
    attachment: chosen.id === earlier.id ? 'starting_week' : 'ending_week',
  }
}

function timingFor(startUtc: number, previousEnd: number | null, crossesUnknown: boolean): WeeklyTiming {
  if (previousEnd == null || crossesUnknown) {
    return { status: 'undetermined', latestStartUtc: previousEnd == null ? null : previousEnd + SIX_PERIODS }
  }
  const latestStartUtc = previousEnd + SIX_PERIODS
  return startUtc <= latestStartUtc ? { status: 'on_time', latestStartUtc } : { status: 'late', latestStartUtc }
}

function compensationFor(
  candidate: WeeklyRestCandidate,
  assignment: WeeklyAssignment,
  weeks: readonly CalendarWeek[],
): WeeklyCompensation {
  if (assignment.status === 'rejected') return { status: 'not_recorded', reason: 'not_accepted' }
  if (assignment.status === 'continuous_cover') return { status: 'not_recorded', reason: 'regular_length' }
  if (assignment.status !== 'assigned') return { status: 'not_recorded', reason: 'not_accepted' }
  if (candidate.lengthClass !== 'reduced') return { status: 'not_recorded', reason: 'regular_length' }
  const index = weeks.findIndex((week) => week.id === assignment.weekId)
  const deadlineWeek = index >= 0 ? weeks[index + 3] : undefined
  return {
    status: 'recorded_unassigned',
    deficitMs: FORTY_FIVE_HOURS - candidate.durationMs,
    deadlineUtc: deadlineWeek?.endUtc ?? null,
  }
}

function adjacentPairs(values: readonly number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (let index = 0; index < values.length - 1; index += 1) {
    const fromUtc = values[index]!
    const toUtc = values[index + 1]!
    if (fromUtc < toUtc) pairs.push([fromUtc, toUtc])
  }
  return pairs
}

function legacyDailyReduced(
  boundaries: readonly number[],
  intervals: readonly ReducedDailyInterval[],
): DailyReducedBetweenWeeklyRests {
  const interval = intervals[0]
  if (boundaries.length !== 2 || interval == null || interval.status !== 'summed') return { status: 'undecided' }
  return { status: 'summed', fromUtc: interval.fromUtc, toUtc: interval.toUtc, reducedCount: interval.reducedCount }
}

/**
 * Počet zkrácených denních odpočinků mezi dvěma předěly.
 * Právní kontrolu limitu neprovádí. Volá ji i diagnostika technického návrhu.
 */
export function countReducedInterval(
  fromUtc: number,
  toUtc: number,
  chain: DailyRestChain | null,
  unknowns: readonly TimeInterval[],
  segments: readonly DailySegmentView[],
  boundarySourceIds: readonly string[],
): ReducedDailyInterval {
  const open = { fromUtc, toUtc, limitEvaluated: false as const }
  if (segments.some((segment) => segmentIntersects(segment, fromUtc, toUtc))) {
    return { ...open, status: 'undecided', reason: 'analysis_gap' }
  }
  if (chain == null || chain.startAnchorUtc > fromUtc) return { ...open, status: 'undecided', reason: 'anchor_mismatch' }
  if (!chain.paths.some((path) => path.steps.some((step) => step.anchorUtc === fromUtc))) {
    return { ...open, status: 'undecided', reason: chain.startAnchorUtc === fromUtc ? 'uncovered' : 'anchor_mismatch' }
  }
  if (intersectsAny(fromUtc, toUtc, unknowns)) return { ...open, status: 'undecided', reason: 'unknown_interval' }
  const inside = chain.nodes.filter((node) => node.anchorUtc >= fromUtc && node.anchorUtc < toUtc)
  const blocked = inside.find((node) => node.status === 'insufficient_data' || node.status === 'history_incomplete' || node.status === 'window_unsatisfied')
  if (blocked != null && blocked.status !== 'evaluated') return { ...open, status: 'undecided', reason: blocked.status }

  const tallies = chain.paths
    .filter((path) => path.steps.some((step) => step.anchorUtc === fromUtc) && path.steps.some((step) => step.anchorUtc === toUtc))
    .map((path) => restsOnPath(chain, path.steps, fromUtc, toUtc, boundarySourceIds))
  if (tallies.length === 0) return { ...open, status: 'undecided', reason: 'uncovered' }
  if (tallies.some((tally) => tally.unproven)) return { ...open, status: 'undecided', reason: 'unproven_rest' }
  const first = tallies[0]!
  const same = tallies.every((tally) => tally.key === first.key)
  if (!same) return { ...open, status: 'undecided', reason: 'paths_disagree' }
  return { ...open, status: 'summed', reducedCount: first.rests.length, rests: first.rests }
}

/**
 * Diagnostický počet nad řetězcem technického návrhu.
 * Uzavře ho jen když všechny cesty od počátečního předělu dorazí na koncový
 * a shodnou se na prokázaných zkrácených odpočincích.
 */
export function diagnoseProposedReducedCount(
  fromUtc: number,
  toUtc: number,
  chain: DailyRestChain,
  unknowns: readonly TimeInterval[],
  boundarySourceIds: readonly string[],
): ReducedDailyInterval {
  const counted = countReducedInterval(fromUtc, toUtc, chain, unknowns, [], boundarySourceIds)
  if (counted.status !== 'summed') return counted
  const relevant = chain.paths.filter((path) => path.steps.some((step) => step.anchorUtc === fromUtc))
  const everyPathCovers = relevant.length > 0 && relevant.every((path) => path.steps.some((step) => step.anchorUtc === toUtc))
  if (!everyPathCovers) return { status: 'undecided', fromUtc, toUtc, reason: 'uncovered', limitEvaluated: false }
  return counted
}

function segmentIntersects(segment: DailySegmentView, fromUtc: number, toUtc: number): boolean {
  if (segment.kind === 'analysis_gap') return segment.startUtc < toUtc && segment.endUtc > fromUtc
  return segment.anchorUtc > fromUtc && segment.anchorUtc < toUtc
}

function restsOnPath(
  chain: DailyRestChain,
  steps: DailyRestChain['paths'][number]['steps'],
  fromUtc: number,
  toUtc: number,
  boundarySourceIds: readonly string[],
): { unproven: boolean; key: string; rests: CountedReducedDailyRest[] } {
  const rests: CountedReducedDailyRest[] = []
  for (const step of steps) {
    if (step.anchorUtc < fromUtc || step.anchorUtc >= toUtc || step.interpretationId == null) continue
    const node = chain.nodes.find((item) => item.anchorUtc === step.anchorUtc)
    const interpretation = node?.interpretations.find((item) => item.id === step.interpretationId)
    if (interpretation == null || interpretation.reducedDelta <= 0) continue
    const boundaryRest = interpretation.parts.some((part) =>
      part.endUtc === toUtc || part.sourceActivityIds.some((id) => boundarySourceIds.includes(id)),
    )
    if (boundaryRest) continue
    if (!interpretation.established) return { unproven: true, key: '', rests: [] }
    const part = interpretation.parts[0]
    rests.push(
      part == null
        ? { startUtc: step.anchorUtc, endUtc: interpretation.nextAnchorUtc ?? step.anchorUtc, sourceActivityIds: [] }
        : { startUtc: part.startUtc, endUtc: part.endUtc, sourceActivityIds: [...part.sourceActivityIds] },
    )
  }
  return {
    unproven: false,
    key: rests.map((rest) => `${rest.startUtc}:${rest.endUtc}:${rest.sourceActivityIds.join(',')}`).join('|'),
    rests,
  }
}

function keysUsedMoreThanOnce(selections: readonly WeeklySelection[]): Set<string> {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const selection of selections) {
    const key = identity(selection.candidate)
    if (seen.has(key)) duplicated.add(key)
    seen.add(key)
  }
  return duplicated
}

function identity(candidate: WeeklyRestCandidate): string {
  return `${candidate.startUtc}:${candidate.endUtc}:${candidate.sourceActivityIds.join(',')}`
}

function intersectsAny(startUtc: number, endUtc: number, intervals: readonly TimeInterval[]): boolean {
  return intervals.some((interval) => rangesOverlap(startUtc, endUtc, interval.startUtc, interval.endUtc))
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}
