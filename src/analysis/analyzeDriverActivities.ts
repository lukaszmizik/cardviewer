import type { Activity, DriverCardData } from '../types/tacho.ts'
import {
  buildDailyRestChain,
  type DailyChainNode,
  type DailyRestChain,
  type UnrecordedInterval,
} from './dailyRestChain.ts'
import { classifyRestCandidates, type RestCandidate } from './restCandidates.ts'
import { findRestIntervals, type RestInterval } from './restIntervals.ts'
import { assessConsecutiveWeeks, type ConsecutiveWeeksResult } from './consecutiveWeeks.ts'
import { buildWeeklyRestAssignment, type WeeklyAutomaticAssignment } from './weeklyRestAssignment.ts'
import {
  assessWeeklyRests,
  classifyWeeklyRestCandidates,
  type WeekClock,
  type WeeklyRestCandidate,
  type WeeklyRestMvp,
  type WeeklySelection,
} from './weeklyRest.ts'

export type RecordedActivity = {
  id: string
  kind: Activity['kind']
  startUtc: number
  endUtc: number
  durationMinutes: number
  isManualEntry: boolean
  slot: Activity['slot']
}

export type RecordedUnknownInterval = UnrecordedInterval & {
  sourceActivityIds: string[]
}

export type AnalysisInputGap = 'daily_anchor' | 'weekly_selection' | 'week_clock' | 'weekly_selection_not_on_card'

/** Samostatný úsek denní analýzy. Není to právní nález. */
export type DailyAnalysisSegment =
  | {
      kind: 'analysis_gap'
      startUtc: number
      endUtc: number
      stoppedAnchorUtc: number
      stoppedStatus: 'window_unsatisfied'
    }
  | {
      kind: 'chain'
      anchorUtc: number
      anchorOrigin: 'proven_rest_end_after_stopped_chain'
      sourceActivityIds: string[]
      chain: DailyRestChain
    }

export type DailyAnalysis =
  | {
      status: 'assessed'
      anchorUtc: number
      anchorOrigin: 'explicit' | 'proven_rest_end'
      /** Původní řetězec. Obnovené úseky k němu nejsou připojené. */
      chain: DailyRestChain
      /** Mezery a případné další řetězce. Prázdné pole znamená, že obnovení nevzniklo. */
      segments: DailyAnalysisSegment[]
    }
  | { status: 'requires_input'; missing: ['daily_anchor'] }

export type WeeklyAnalysis =
  | { status: 'assessed'; result: WeeklyRestMvp }
  | { status: 'requires_input'; missing: AnalysisInputGap[] }

export type NotEvaluatedTopic = 'infringements' | 'international_regime' | 'compensation_taken'

export type ActivityAnalysis = {
  recorded: {
    activities: RecordedActivity[]
    unknownIntervals: RecordedUnknownInterval[]
  }
  candidates: {
    restIntervals: RestInterval[]
    restCandidates: RestCandidate[]
    weeklyRestCandidates: WeeklyRestCandidate[]
  }
  assessed: {
    /** Návaznost od ruční kotvy, nebo od konce prvního prokázaného odpočinku. Stav assessed nepokryje sám o sobě celou historii. */
    daily: DailyAnalysis
    weekly: WeeklyAnalysis
  }
  notEvaluated: Array<{ topic: NotEvaluatedTopic; status: 'not_evaluated' }>
  /** Automatické návaznosti. Nevyžadují ruční výběr ani denní kotvu a nejsou právní potvrzení. */
  weeklyAssignment: WeeklyAutomaticAssignment
  /** Klouzavá kontrola dvou sousedních týdnů. Není to přestupek. */
  consecutiveWeeks: ConsecutiveWeeksResult
  /**
   * Denní řetězec od technického návrhu dvojice. Není to právní posouzení
   * a nevstupuje do kontroly zkrácených denních odpočinků.
   */
  boundaryPairDaily: BoundaryPairDailyDiagnostic
}

/** Diagnostika od navržených předělů. Právně určené týdenní odpočinky to nejsou. */
export type BoundaryPairDailyDiagnostic =
  | { status: 'not_run'; reason: 'boundary_pair_undecided' }
  | {
      status: 'diagnostic'
      basis: 'technical_boundary_proposal'
      legalDetermination: false
      firstBoundaryEndUtc: number
      secondBoundaryEndUtc: number
      chain: DailyRestChain
      reachesSecondBoundary: boolean
    }

export type ActivityAnalysisRequest = {
  card: DriverCardData
  /**
   * Skutečný konec předchozího denního nebo týdenního odpočinku.
   * Bez něj se použije konec prvního prokázaného odpočinku dlouhého alespoň 11 hodin.
   */
  dailyAnchorUtc?: number | null
  weekly?: {
    previousWeeklyEndUtc: number | null
    selections: readonly WeeklySelection[]
    clock?: WeekClock | null
  } | null
}

const NOT_EVALUATED: ActivityAnalysis['notEvaluated'] = [
  { topic: 'infringements', status: 'not_evaluated' },
  { topic: 'international_regime', status: 'not_evaluated' },
  { topic: 'compensation_taken', status: 'not_evaluated' },
]

/**
 * Jednorázový průchod původních aktivit karty.
 * Týdenní výběr nedoplňuje. Přestupky nevytváří.
 */
export function analyzeDriverActivities(request: ActivityAnalysisRequest): ActivityAnalysis {
  const activities = request.card.activities
  const unknownIntervals = unknownSpans(activities)
  const restIntervals = findRestIntervals(activities)
  const restCandidates = classifyRestCandidates(restIntervals)
  const weeklyRestCandidates = classifyWeeklyRestCandidates(restCandidates)
  const span = recordSpan(activities)
  const weeklyAssignment = buildWeeklyRestAssignment({
    candidates: weeklyRestCandidates,
    unknownIntervals,
    recordEndUtc: span?.endUtc ?? null,
  })
  const consecutiveWeeks = assessConsecutiveWeeks({
    assignment: weeklyAssignment,
    unknownIntervals,
    recordSpan: span,
  })
  const explicitAnchor = typeof request.dailyAnchorUtc === 'number' && Number.isFinite(request.dailyAnchorUtc)
  const anchorUtc = explicitAnchor ? request.dailyAnchorUtc! : firstProvenRestEnd(restCandidates, unknownIntervals)
  const recordEndUtc = span?.endUtc ?? null
  const daily: DailyAnalysis =
    anchorUtc == null
      ? { status: 'requires_input', missing: ['daily_anchor'] }
      : assessedDaily(anchorUtc, explicitAnchor, restCandidates, unknownIntervals, recordEndUtc)

  return {
    recorded: {
      activities: activities.map(recordedActivity),
      unknownIntervals,
    },
    candidates: { restIntervals, restCandidates, weeklyRestCandidates },
    assessed: {
      daily,
      weekly: assessWeekly(
        request.weekly,
        weeklyRestCandidates,
        unknownIntervals,
        daily.status === 'assessed' ? daily.chain : null,
        daily.status === 'assessed' ? daily.segments : [],
      ),
    },
    notEvaluated: NOT_EVALUATED.map((item) => ({ ...item })),
    weeklyAssignment,
    consecutiveWeeks,
    boundaryPairDaily: diagnoseBoundaryPairDaily(
      weeklyAssignment,
      restCandidates,
      unknownIntervals,
      recordEndUtc,
    ),
  }
}

function diagnoseBoundaryPairDaily(
  assignment: WeeklyAutomaticAssignment,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[],
  recordEndUtc: number | null,
): BoundaryPairDailyDiagnostic {
  const pair = assignment.boundaryPair
  if (pair.status !== 'pair') return { status: 'not_run', reason: 'boundary_pair_undecided' }
  const first = assignment.nodes.find((node) => node.id === pair.nodeIds[0])
  const second = assignment.nodes.find((node) => node.id === pair.nodeIds[1])
  if (first == null || second == null) return { status: 'not_run', reason: 'boundary_pair_undecided' }
  const chain = buildDailyRestChain(first.endUtc, candidates, unknownIntervals, recordEndUtc)
  return {
    status: 'diagnostic',
    basis: 'technical_boundary_proposal',
    legalDetermination: false,
    firstBoundaryEndUtc: first.endUtc,
    secondBoundaryEndUtc: second.endUtc,
    chain,
    reachesSecondBoundary: chain.paths.some((path) => path.steps.some((step) => step.anchorUtc === second.endUtc)),
  }
}

function assessWeekly(
  weekly: ActivityAnalysisRequest['weekly'],
  candidates: readonly WeeklyRestCandidate[],
  unknownIntervals: readonly RecordedUnknownInterval[],
  dailyChain: DailyRestChain | null,
  dailySegments: readonly DailyAnalysisSegment[],
): WeeklyAnalysis {
  if (weekly == null || weekly.selections.length === 0) {
    return { status: 'requires_input', missing: ['weekly_selection'] }
  }
  if (weekly.clock == null || weekly.clock.weeks.length === 0) {
    return { status: 'requires_input', missing: ['week_clock'] }
  }
  const selections = weekly.selections.map((selection) => {
    const matched = candidates.find((candidate) => sameWeeklyCandidate(candidate, selection.candidate))
    return matched == null ? null : { candidate: matched, weekId: selection.weekId }
  })
  if (selections.some((selection) => selection == null)) {
    return { status: 'requires_input', missing: ['weekly_selection_not_on_card'] }
  }
  return {
    status: 'assessed',
    result: assessWeeklyRests({
      previousWeeklyEndUtc: weekly.previousWeeklyEndUtc,
      selections: selections.filter((selection): selection is WeeklySelection => selection != null),
      clock: weekly.clock,
      dailyChain,
      unknownIntervals,
      dailySegments,
    }),
  }
}

const ELEVEN_HOURS_MS = 11 * 60 * 60 * 1000

/** Konec prvního nejednoznačností nezatíženého odpočinku dlouhého alespoň 11 hodin. */
function firstProvenRestEnd(
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[],
): number | null {
  const proven = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= ELEVEN_HOURS_MS)
    .filter((candidate) => !intersectsUnknown(candidate, unknownIntervals))
    .sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)
  return proven[0]?.endUtc ?? null
}

function assessedDaily(
  anchorUtc: number,
  explicitAnchor: boolean,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[],
  recordEndUtc: number | null,
): DailyAnalysis {
  const chain = buildDailyRestChain(anchorUtc, candidates, unknownIntervals, recordEndUtc)
  return {
    status: 'assessed',
    anchorUtc,
    anchorOrigin: explicitAnchor ? 'explicit' : 'proven_rest_end',
    chain,
    segments: resumeAfterStoppedWindow(chain, candidates, unknownIntervals, recordEndUtc),
  }
}

/**
 * Obnovení se opakuje, dokud aktuální řetězec končí ve stejném úplném okně bez varianty
 * a po jeho konci existuje další prokázaný odpočinek. Každý nový řetězec je samostatný.
 */
function resumeAfterStoppedWindow(
  chain: DailyRestChain,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[],
  recordEndUtc: number | null,
): DailyAnalysisSegment[] {
  const segments: DailyAnalysisSegment[] = []
  const usedAnchors = new Set<number>([chain.startAnchorUtc])
  let current = chain
  let previousAnchor = chain.startAnchorUtc

  while (true) {
    const stopped = soleUnsatisfiedWindow(current)
    if (stopped == null) break
    const next = candidates
      .filter((candidate) => candidate.established && candidate.durationMs >= ELEVEN_HOURS_MS)
      .filter((candidate) => candidate.startUtc >= stopped.windowEndUtc)
      .filter((candidate) => !intersectsUnknown(candidate, unknownIntervals))
      .filter((candidate) => candidate.endUtc > previousAnchor && !usedAnchors.has(candidate.endUtc))
      .sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)[0]
    if (next == null) break
    usedAnchors.add(next.endUtc)
    previousAnchor = next.endUtc
    const resumed = buildDailyRestChain(next.endUtc, candidates, unknownIntervals, recordEndUtc)
    segments.push({
      kind: 'analysis_gap',
      startUtc: stopped.windowEndUtc,
      endUtc: next.endUtc,
      stoppedAnchorUtc: stopped.anchorUtc,
      stoppedStatus: 'window_unsatisfied',
    })
    segments.push({
      kind: 'chain',
      anchorUtc: next.endUtc,
      anchorOrigin: 'proven_rest_end_after_stopped_chain',
      sourceActivityIds: [...next.sourceActivityIds],
      chain: resumed,
    })
    current = resumed
  }

  return segments
}

function soleUnsatisfiedWindow(chain: DailyRestChain): DailyChainNode | null {
  if (chain.paths.length === 0) return null
  const ends = chain.paths.map((path) => path.steps[path.steps.length - 1])
  if (ends.some((step) => step == null || step.interpretationId != null)) return null
  const anchorUtc = ends[0]!.anchorUtc
  if (ends.some((step) => step.anchorUtc !== anchorUtc)) return null
  const node = chain.nodes.find((item) => item.anchorUtc === anchorUtc)
  if (node == null || node.status !== 'window_unsatisfied' || node.interpretations.length !== 0) return null
  return node
}

function intersectsUnknown(candidate: RestCandidate, unknownIntervals: readonly UnrecordedInterval[]): boolean {
  return unknownIntervals.some((interval) =>
    candidate.startUtc < interval.endUtc && interval.startUtc < candidate.endUtc,
  )
}

function recordSpan(activities: readonly Activity[]): { startUtc: number; endUtc: number } | null {
  const finite = activities.filter((activity) => activity.endUtc > activity.startUtc)
  if (finite.length === 0) return null
  return {
    startUtc: Math.min(...finite.map((activity) => activity.startUtc)),
    endUtc: Math.max(...finite.map((activity) => activity.endUtc)),
  }
}

function recordedActivity(activity: Activity): RecordedActivity {
  return {
    id: activity.id,
    kind: activity.kind,
    startUtc: activity.startUtc,
    endUtc: activity.endUtc,
    durationMinutes: activity.durationMinutes,
    isManualEntry: activity.isManualEntry === true,
    slot: activity.slot,
  }
}

function unknownSpans(activities: readonly Activity[]): RecordedUnknownInterval[] {
  return activities
    .filter((activity) => activity.kind === 'unknown' && activity.endUtc > activity.startUtc)
    .map((activity) => ({
      startUtc: activity.startUtc,
      endUtc: activity.endUtc,
      sourceActivityIds: [activity.id],
    }))
}

function sameWeeklyCandidate(left: WeeklyRestCandidate, right: WeeklyRestCandidate): boolean {
  return (
    left.startUtc === right.startUtc &&
    left.endUtc === right.endUtc &&
    left.sourceActivityIds.length === right.sourceActivityIds.length &&
    left.sourceActivityIds.every((id, index) => id === right.sourceActivityIds[index])
  )
}
