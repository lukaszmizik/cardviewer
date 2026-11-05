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

export type WeeklyAssignment =
  | { status: 'assigned'; weekId: string; attachment: WeeklyAttachment }
  | { status: 'rejected'; reason: 'week_not_overlapped' | 'both_weeks' | 'more_than_two_weeks' }

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

export type WeeklyRestMvp = {
  selections: WeeklySelectionReport[]
  /** Skutečné konce přijatých týdenních odpočinků, vzestupně. */
  boundaryEndsUtc: number[]
  consecutiveWeeks: 'not_evaluated'
  internationalRegime: 'not_evaluated'
  compensationTaken: 'not_evaluated'
  dailyReduced: DailyReducedBetweenWeeklyRests
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
  const boundaryInstants = input.previousWeeklyEndUtc == null ? boundaryEndsUtc : [input.previousWeeklyEndUtc, ...boundaryEndsUtc]

  return {
    selections: reports,
    boundaryEndsUtc,
    consecutiveWeeks: 'not_evaluated',
    internationalRegime: 'not_evaluated',
    compensationTaken: 'not_evaluated',
    dailyReduced: sumDailyReduced(boundaryInstants, input.dailyChain ?? null, unknowns),
  }
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
  const assignment = assignmentFor(selection.weekId, overlapped, usedForBothWeeks)
  const crossesUnknown =
    intersectsAny(candidate.startUtc, candidate.endUtc, unknowns) ||
    (previousEnd != null && intersectsAny(previousEnd, candidate.startUtc, unknowns))
  const timing = timingFor(candidate.startUtc, previousEnd, crossesUnknown)
  const usableAsBoundary = assignment.status === 'assigned' && !intersectsAny(candidate.startUtc, candidate.endUtc, unknowns)
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
  weekId: string,
  overlapped: readonly CalendarWeek[],
  usedForBothWeeks: boolean,
): WeeklyAssignment {
  if (usedForBothWeeks) return { status: 'rejected', reason: 'both_weeks' }
  if (overlapped.length > 2) return { status: 'rejected', reason: 'more_than_two_weeks' }
  const chosen = overlapped.find((week) => week.id === weekId)
  if (chosen == null) return { status: 'rejected', reason: 'week_not_overlapped' }
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

function sumDailyReduced(
  boundaries: readonly number[],
  chain: DailyRestChain | null,
  unknowns: readonly TimeInterval[],
): DailyReducedBetweenWeeklyRests {
  if (boundaries.length !== 2 || chain == null) return { status: 'undecided' }
  const fromUtc = boundaries[0]!
  const toUtc = boundaries[1]!
  if (!(fromUtc < toUtc)) return { status: 'undecided' }
  if (chain.startAnchorUtc !== fromUtc) return { status: 'undecided' }
  if (intersectsAny(fromUtc, toUtc, unknowns)) return { status: 'undecided' }
  if (chain.nodes.some((node) => node.anchorUtc >= fromUtc && node.anchorUtc < toUtc && node.status === 'insufficient_data')) {
    return { status: 'undecided' }
  }

  const counts: number[] = []
  for (const path of chain.paths) {
    const reached = path.steps.some((step) => step.anchorUtc === toUtc)
    const starts = path.steps.some((step) => step.anchorUtc === fromUtc)
    if (!starts || !reached) continue
    let count = 0
    for (const step of path.steps) {
      if (step.anchorUtc < fromUtc || step.anchorUtc >= toUtc) continue
      count += reducedDelta(chain, step.anchorUtc, step.interpretationId)
    }
    counts.push(count)
  }
  if (counts.length === 0) return { status: 'undecided' }
  if (counts.some((count) => count !== counts[0])) return { status: 'undecided' }
  return { status: 'summed', fromUtc, toUtc, reducedCount: counts[0]! }
}

function reducedDelta(chain: DailyRestChain, anchorUtc: number, interpretationId: string | null): number {
  if (interpretationId == null) return 0
  const node = chain.nodes.find((item) => item.anchorUtc === anchorUtc)
  const interpretation = node?.interpretations.find((item) => item.id === interpretationId)
  return interpretation?.reducedDelta ?? 0
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
