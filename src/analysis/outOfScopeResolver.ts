import type { Activity, ActivityKind, SpecificConditionEntry } from '../types/tacho.ts'

/**
 * Příprava aktivit k vyhodnocení režimu OUT podle nařízení 561/2006.
 * Značka OUT není důkaz oprávněné výjimky. Modul nemění původní aktivity,
 * odpočinky ani výpočet GN7.
 */

export type OutScopeUncertainty = 'missing_out_end' | 'orphan_out_end' | 'ambiguous_marks'

export type OutScopeInterval = {
  startUtc: number
  endUtc: number
}

export type OutScopeSegment = {
  sourceActivityId: string
  startUtc: number
  endUtc: number
  recordedKind: ActivityKind
  /** Uzavřený interval out–out_end. Neznamená to oprávněnou výjimku. */
  outActive: boolean
  /** Druh pro limity čl. 6 a 7, kdyby byl OUT oprávněný. */
  authorizedKind: ActivityKind
  /** Druh, když oprávnění OUT není prokázané. */
  unverifiedKind: ActivityKind
  uncertainty: OutScopeUncertainty | null
  isCrew?: boolean
  isManualEntry?: boolean
  slot?: 1 | 2
}

export type OutOfScopeResolution = {
  /** Jen páry se známým začátkem i koncem a bez rozporu ve značkách. */
  closedIntervals: OutScopeInterval[]
  openStarts: number[]
  orphanEnds: number[]
  ambiguousSpans: OutScopeInterval[]
  segments: OutScopeSegment[]
}

export function resolveOutOfScope(input: {
  activities: readonly Activity[]
  specificConditions?: readonly SpecificConditionEntry[]
  /** Konec dostupných dat. Otevřený OUT se jím neuzavírá. */
  recordEndUtc?: number | null
}): OutOfScopeResolution {
  const paired = clampOpenAmbiguity(pairOutMarks(input.specificConditions ?? []), horizonOf(input.activities, input.recordEndUtc))
  const segments: OutScopeSegment[] = []
  const activities = input.activities.filter((activity) => activity.endUtc > activity.startUtc)
  for (const activity of activities) {
    const bounds = cutPoints(activity.startUtc, activity.endUtc, paired)
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const startUtc = bounds[index]!
      const endUtc = bounds[index + 1]!
      if (endUtc <= startUtc) continue
      segments.push(toSegment(activity, startUtc, endUtc, paired))
    }
  }
  return {
    closedIntervals: paired.closed,
    openStarts: paired.openStarts,
    orphanEnds: paired.orphanEnds,
    ambiguousSpans: paired.ambiguous,
    segments,
  }
}

/** Uzavřený OUT, ve kterém je zaznamenané řízení. Jen tehdy se limity řízení liší. */
export function outScopeAffectsDrivingLimits(resolution: OutOfScopeResolution): boolean {
  return resolution.segments.some((segment) => segment.outActive && segment.recordedKind === 'driving')
}

/**
 * Kopie aktivit pro hypotézu oprávněného OUT.
 * Řízení uvnitř uzavřeného intervalu se počítá jako jiná práce.
 * Nepřerušuje nasčítané řízení, není přestávka ani odpočinek.
 * Mimo uzavřený interval zůstává původní druh, včetně neúplných značek.
 */
export function activitiesUnderAuthorizedOut(
  activities: readonly Activity[],
  resolution: OutOfScopeResolution,
): Activity[] {
  if (resolution.closedIntervals.length === 0) return activities.map((activity) => ({ ...activity }))
  return activities.flatMap((activity) => rewriteDriving(activity, resolution.closedIntervals))
}

type PairedMarks = {
  closed: OutScopeInterval[]
  openStarts: number[]
  orphanEnds: number[]
  ambiguous: OutScopeInterval[]
}

function pairOutMarks(conditions: readonly SpecificConditionEntry[]): PairedMarks {
  const events = conditions
    .filter((entry) => entry.kind === 'out' || entry.kind === 'out_end')
    .slice()
    .sort((left, right) => left.atUtc - right.atUtc)
  const closed: OutScopeInterval[] = []
  const openStarts: number[] = []
  const orphanEnds: number[] = []
  const ambiguous: OutScopeInterval[] = []
  let pending: number[] = []

  const discardPending = (endUtc: number) => {
    if (pending.length === 0) return
    ambiguous.push({ startUtc: pending[0]!, endUtc: Math.max(endUtc, pending[0]!) })
    pending = []
  }

  for (const event of events) {
    if (event.kind === 'out') {
      pending.push(event.atUtc)
      continue
    }
    if (pending.length === 1 && event.atUtc > pending[0]!) {
      closed.push({ startUtc: pending[0]!, endUtc: event.atUtc })
      pending = []
      continue
    }
    if (pending.length === 0) {
      orphanEnds.push(event.atUtc)
      continue
    }
    discardPending(event.atUtc)
  }
  if (pending.length === 1) openStarts.push(pending[0]!)
  else if (pending.length > 1) {
    ambiguous.push({ startUtc: pending[0]!, endUtc: Number.POSITIVE_INFINITY })
  }
  return { closed, openStarts, orphanEnds, ambiguous }
}

function horizonOf(activities: readonly Activity[], recordEndUtc: number | null | undefined): number | null {
  const ends = activities.map((activity) => activity.endUtc).filter((endUtc) => Number.isFinite(endUtc))
  const fromActivities = ends.length === 0 ? null : Math.max(...ends)
  if (recordEndUtc == null) return fromActivities
  if (fromActivities == null) return recordEndUtc
  return Math.max(recordEndUtc, fromActivities)
}

/** Neuzavřený rozpor značek nekončí domyšleným OUT. Nejistota ale sahá až do konce dat. */
function clampOpenAmbiguity(marks: PairedMarks, horizon: number | null): PairedMarks {
  return {
    ...marks,
    ambiguous: marks.ambiguous.map((span) => {
      if (span.endUtc !== Number.POSITIVE_INFINITY) return span
      const endUtc = horizon == null ? span.startUtc : Math.max(span.startUtc, horizon)
      return { startUtc: span.startUtc, endUtc }
    }),
  }
}

function cutPoints(startUtc: number, endUtc: number, marks: PairedMarks): number[] {
  const points = new Set<number>([startUtc, endUtc])
  const add = (atUtc: number) => {
    if (atUtc > startUtc && atUtc < endUtc) points.add(atUtc)
  }
  for (const interval of marks.closed) {
    add(interval.startUtc)
    add(interval.endUtc)
  }
  for (const interval of marks.ambiguous) {
    add(interval.startUtc)
    add(interval.endUtc)
  }
  for (const atUtc of marks.openStarts) add(atUtc)
  for (const atUtc of marks.orphanEnds) add(atUtc)
  return [...points].sort((left, right) => left - right)
}

function toSegment(activity: Activity, startUtc: number, endUtc: number, marks: PairedMarks): OutScopeSegment {
  const insideClosed = marks.closed.some((interval) => startUtc >= interval.startUtc && endUtc <= interval.endUtc)
  const ambiguous = marks.ambiguous.some((interval) => startUtc < interval.endUtc && interval.startUtc < endUtc)
  const missingEnd = marks.openStarts.some((atUtc) => atUtc <= startUtc)
  const orphan =
    marks.orphanEnds.some((atUtc) => atUtc >= startUtc && atUtc < endUtc) ||
    marks.orphanEnds.some((atUtc) => atUtc === endUtc && endUtc === activity.endUtc && startUtc < endUtc)
  const uncertainty: OutScopeUncertainty | null = ambiguous
    ? 'ambiguous_marks'
    : missingEnd
      ? 'missing_out_end'
      : orphan
        ? 'orphan_out_end'
        : null
  const outActive = insideClosed && uncertainty == null
  const recordedKind = activity.kind
  return {
    sourceActivityId: activity.id,
    startUtc,
    endUtc,
    recordedKind,
    outActive,
    authorizedKind: outActive && recordedKind === 'driving' ? 'work' : recordedKind,
    unverifiedKind: recordedKind,
    uncertainty,
    isCrew: activity.isCrew,
    isManualEntry: activity.isManualEntry,
    slot: activity.slot,
  }
}

function rewriteDriving(activity: Activity, intervals: readonly OutScopeInterval[]): Activity[] {
  if (activity.kind !== 'driving' || activity.endUtc <= activity.startUtc) return [{ ...activity }]
  const points = new Set<number>([activity.startUtc, activity.endUtc])
  for (const interval of intervals) {
    if (interval.startUtc > activity.startUtc && interval.startUtc < activity.endUtc) points.add(interval.startUtc)
    if (interval.endUtc > activity.startUtc && interval.endUtc < activity.endUtc) points.add(interval.endUtc)
  }
  const bounds = [...points].sort((left, right) => left - right)
  if (bounds.length === 2) {
    const inside = intervals.some((interval) => activity.startUtc >= interval.startUtc && activity.endUtc <= interval.endUtc)
    return [inside ? { ...activity, kind: 'work' } : { ...activity }]
  }
  const pieces: Activity[] = []
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const startUtc = bounds[index]!
    const endUtc = bounds[index + 1]!
    const inside = intervals.some((interval) => startUtc >= interval.startUtc && endUtc <= interval.endUtc)
    pieces.push({
      ...activity,
      id: `${activity.id}@${startUtc}`,
      startUtc,
      endUtc,
      durationMinutes: (endUtc - startUtc) / 60_000,
      kind: inside ? 'work' : activity.kind,
    })
  }
  return pieces
}
