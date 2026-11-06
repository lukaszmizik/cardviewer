import type { Activity, DriverCardData } from '../types/tacho.ts'
import { buildDailyRestChain, type DailyRestChain, type UnrecordedInterval } from './dailyRestChain.ts'
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

export type DailyAnalysis =
  | {
      status: 'assessed'
      anchorUtc: number
      anchorOrigin: 'explicit' | 'proven_rest_end'
      chain: DailyRestChain
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
  const weeklyAssignment = buildWeeklyRestAssignment({ candidates: weeklyRestCandidates, unknownIntervals })
  const consecutiveWeeks = assessConsecutiveWeeks({
    assignment: weeklyAssignment,
    unknownIntervals,
    recordSpan: recordSpan(activities),
  })
  const explicitAnchor = typeof request.dailyAnchorUtc === 'number' && Number.isFinite(request.dailyAnchorUtc)
  const anchorUtc = explicitAnchor ? request.dailyAnchorUtc! : firstProvenRestEnd(restCandidates, unknownIntervals)
  const daily: DailyAnalysis =
    anchorUtc == null
      ? { status: 'requires_input', missing: ['daily_anchor'] }
      : {
          status: 'assessed',
          anchorUtc,
          anchorOrigin: explicitAnchor ? 'explicit' : 'proven_rest_end',
          chain: buildDailyRestChain(anchorUtc, restCandidates, unknownIntervals),
        }

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
      ),
    },
    notEvaluated: NOT_EVALUATED.map((item) => ({ ...item })),
    weeklyAssignment,
    consecutiveWeeks,
  }
}

function assessWeekly(
  weekly: ActivityAnalysisRequest['weekly'],
  candidates: readonly WeeklyRestCandidate[],
  unknownIntervals: readonly RecordedUnknownInterval[],
  dailyChain: DailyRestChain | null,
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
