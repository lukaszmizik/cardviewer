import type { DailyDrivingPeriod } from './dailyDrivingTime.ts'
import type { Activity, ActivityKind, Location, LocationRecordType } from '../types/tacho.ts'

/**
 * Kontrola značek země na už určených směnách.
 * Nemění činnosti, odpočinky ani jejich délky. Počítá jen v UTC.
 * Odpočinek kratší než hranice denního řetězce sám směnu neuzavře:
 * modul nepřebírá jiné hranice než dodané pracovní úseky.
 */

const WORK_KINDS: readonly ActivityKind[] = ['driving', 'work', 'availability']

export type WorkPeriodMarkerIssue =
  | 'missing_start_country'
  | 'missing_end_country'
  | 'uncertain_start_country'
  | 'uncertain_end_country'
  | 'start_country_timing_uncertain'
  | 'end_country_timing_uncertain'

export type CardInsertion = {
  fromUtc: number
  toUtc: number
}

export type WorkPeriodMarkerEvidence = {
  locationIds: string[]
  /** GNSS, přechod hranice a další body, které značku země nenahrazují. */
  disregardedLocationIds: string[]
  activityIds: string[]
  cardInsertionUtc: number[]
}

export type WorkPeriodMarkerFinding = {
  issue: WorkPeriodMarkerIssue
  atUtc: number
  shiftStartUtc: number
  shiftEndUtc: number | null
  reason: string
  evidence: WorkPeriodMarkerEvidence
}

const ISSUE_ORDER: Record<WorkPeriodMarkerIssue, number> = {
  missing_start_country: 0,
  missing_end_country: 1,
  uncertain_start_country: 2,
  uncertain_end_country: 3,
  start_country_timing_uncertain: 4,
  end_country_timing_uncertain: 5,
}

/**
 * Pro každou spolehlivě uzavřenou směnu ověří značku začátku a konce.
 * Další START ani další vložení karty v téže směně novou směnu nezaloží.
 * Neúplná nebo nejednoznačná hranice vrací nejistotu, ne potvrzené chybění.
 */
export function assessDailyWorkPeriodMarkers(input: {
  periods: readonly DailyDrivingPeriod[]
  locations: readonly Location[]
  activities: readonly Activity[]
  cardInsertions?: readonly CardInsertion[]
  recordEndUtc?: number | null
}): WorkPeriodMarkerFinding[] {
  const insertions = input.cardInsertions ?? []
  const findings: WorkPeriodMarkerFinding[] = []
  const seen = new Set<string>()

  for (const period of input.periods) {
    const limit = period.endUtc ?? Number.POSITIVE_INFINITY
    const insertionUtc = unique(
      insertions
        .map((item) => item.fromUtc)
        .filter((utc) => utc >= period.startUtc && utc < limit),
    ).sort((a, b) => a - b)
    const shiftStartUtc = documentedShiftStart(period, input.activities, insertionUtc)
    if (shiftStartUtc == null) continue

    const shiftEndUtc = period.endUtc
    const evidence = evidenceFor(period, input.locations, input.activities, insertionUtc, shiftStartUtc, shiftEndUtc)
    const startKnown = startBoundaryKnown(period, input.recordEndUtc ?? null, shiftStartUtc)
    const endKnown = endBoundaryKnown(period, input.recordEndUtc ?? null)

    const startMarkers = placedMarkers(input.locations, 'start_country', shiftStartUtc, shiftEndUtc, 'start')
    const endMarkers = placedMarkers(input.locations, 'end_country', shiftStartUtc, shiftEndUtc, 'end')

    if (!startKnown) {
      pushOnce(findings, seen, {
        issue: 'uncertain_start_country',
        atUtc: shiftStartUtc,
        shiftStartUtc,
        shiftEndUtc,
        reason: 'Začátek směny není spolehlivě určen nebo záznam začátek nepokrývá.',
        evidence,
      })
    } else if (startMarkers.onBoundary.length === 0 && startMarkers.inside.length > 0) {
      pushOnce(findings, seen, {
        issue: 'start_country_timing_uncertain',
        atUtc: startMarkers.inside[0]!.recordedAtUtc,
        shiftStartUtc,
        shiftEndUtc,
        reason: 'Značka výchozí země ve směně je, ale není na začátku pracovní doby. Není to prokázané porušení.',
        evidence,
      })
    } else if (startMarkers.onBoundary.length === 0) {
      pushOnce(findings, seen, {
        issue: 'missing_start_country',
        atUtc: shiftStartUtc,
        shiftStartUtc,
        shiftEndUtc,
        reason: 'Ve směně chybí značka výchozí země.',
        evidence,
      })
    }

    if (!endKnown) {
      pushOnce(findings, seen, {
        issue: 'uncertain_end_country',
        atUtc: shiftEndUtc ?? input.recordEndUtc ?? shiftStartUtc,
        shiftStartUtc,
        shiftEndUtc,
        reason: 'Konec směny není spolehlivě určen, směna je otevřená, nebo záznam konec nepokrývá.',
        evidence,
      })
    } else if (endMarkers.onBoundary.length === 0 && endMarkers.inside.length > 0) {
      pushOnce(findings, seen, {
        issue: 'end_country_timing_uncertain',
        atUtc: endMarkers.inside[0]!.recordedAtUtc,
        shiftStartUtc,
        shiftEndUtc,
        reason: 'Značka cílové země ve směně je, ale není na konci pracovní doby. Není to prokázané porušení.',
        evidence,
      })
    } else if (endMarkers.onBoundary.length === 0) {
      pushOnce(findings, seen, {
        issue: 'missing_end_country',
        atUtc: shiftEndUtc!,
        shiftStartUtc,
        shiftEndUtc,
        reason: 'Ve směně chybí značka cílové země.',
        evidence,
      })
    }
  }

  return findings.sort(
    (a, b) => a.shiftStartUtc - b.shiftStartUtc || ISSUE_ORDER[a.issue] - ISSUE_ORDER[b.issue],
  )
}

function documentedShiftStart(
  period: DailyDrivingPeriod,
  activities: readonly Activity[],
  insertionUtc: readonly number[],
): number | null {
  const limit = period.endUtc ?? Number.POSITIVE_INFINITY
  let earliestWork: number | null = null
  for (const activity of activities) {
    if (!WORK_KINDS.includes(activity.kind)) continue
    if (activity.endUtc <= period.startUtc || activity.startUtc >= limit) continue
    const at = Math.max(activity.startUtc, period.startUtc)
    if (earliestWork == null || at < earliestWork) earliestWork = at
  }
  const earliestInsertion = insertionUtc.find((utc) => utc >= period.startUtc && utc < limit) ?? null
  if (earliestWork == null) return earliestInsertion
  if (earliestInsertion != null && earliestInsertion < earliestWork) return earliestInsertion
  return earliestWork
}

function startBoundaryKnown(
  period: DailyDrivingPeriod,
  recordEndUtc: number | null,
  shiftStartUtc: number,
): boolean {
  if (recordEndUtc != null && recordEndUtc < shiftStartUtc) return false
  if (period.result === 'insufficient_data') return false
  return (
    !period.uncertainties.includes('opening_rest_unmatched') &&
    !period.uncertainties.includes('unestablished_rest') &&
    !period.uncertainties.includes('unknown_interval')
  )
}

function endBoundaryKnown(period: DailyDrivingPeriod, recordEndUtc: number | null): boolean {
  if (period.endUtc == null || !period.closed) return false
  if (recordEndUtc != null && recordEndUtc < period.endUtc) return false
  if (period.result === 'ambiguous_boundaries' || period.result === 'insufficient_data') return false
  return (
    !period.uncertainties.includes('closing_rest_missing') &&
    !period.uncertainties.includes('multiple_rest_boundaries') &&
    !period.uncertainties.includes('unestablished_rest') &&
    !period.uncertainties.includes('unknown_interval')
  )
}

function placedMarkers(
  locations: readonly Location[],
  recordType: 'start_country' | 'end_country',
  shiftStartUtc: number,
  shiftEndUtc: number | null,
  edge: 'start' | 'end',
): { onBoundary: Location[]; inside: Location[] } {
  const onBoundary: Location[] = []
  const inside: Location[] = []
  for (const location of locations) {
    if (location.recordType !== recordType) continue
    const at = location.recordedAtUtc
    if (edge === 'start') {
      if (at === shiftStartUtc) onBoundary.push(location)
      else if (at > shiftStartUtc && (shiftEndUtc == null || at < shiftEndUtc)) inside.push(location)
      continue
    }
    if (shiftEndUtc == null) continue
    if (at === shiftEndUtc) onBoundary.push(location)
    else if (at > shiftStartUtc && at < shiftEndUtc) inside.push(location)
  }
  inside.sort((a, b) => a.recordedAtUtc - b.recordedAtUtc)
  return { onBoundary, inside }
}

function evidenceFor(
  period: DailyDrivingPeriod,
  locations: readonly Location[],
  activities: readonly Activity[],
  insertionUtc: readonly number[],
  shiftStartUtc: number,
  shiftEndUtc: number | null,
): WorkPeriodMarkerEvidence {
  const end = shiftEndUtc ?? Number.POSITIVE_INFINITY
  const inShift = (at: number) => at >= shiftStartUtc && at <= end
  const countryIds: string[] = []
  const disregarded: string[] = []
  for (const location of locations) {
    if (!inShift(location.recordedAtUtc)) continue
    if (location.recordType === 'start_country' || location.recordType === 'end_country') {
      countryIds.push(location.id)
    } else if (isDisregarded(location.recordType)) {
      disregarded.push(location.id)
    }
  }
  const activityIds = unique([
    ...period.drivingSourceActivityIds,
    ...activities
      .filter((activity) => WORK_KINDS.includes(activity.kind) && activity.endUtc > shiftStartUtc && activity.startUtc < end)
      .map((activity) => activity.id),
  ])
  return {
    locationIds: countryIds,
    disregardedLocationIds: disregarded,
    activityIds,
    cardInsertionUtc: [...insertionUtc],
  }
}

function isDisregarded(recordType: LocationRecordType | undefined): boolean {
  return (
    recordType === 'gps' ||
    recordType === 'border_crossing' ||
    recordType === 'load' ||
    recordType === 'unload' ||
    recordType === 'load_unload'
  )
}

function pushOnce(
  findings: WorkPeriodMarkerFinding[],
  seen: Set<string>,
  finding: WorkPeriodMarkerFinding,
): void {
  const key = `${finding.shiftStartUtc}:${finding.shiftEndUtc ?? 'open'}:${finding.issue}`
  if (seen.has(key)) return
  seen.add(key)
  findings.push(finding)
}

function unique<T>(values: readonly T[]): T[] {
  const result: T[] = []
  for (const value of values) {
    if (!result.includes(value)) result.push(value)
  }
  return result
}
