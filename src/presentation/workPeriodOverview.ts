import { assessWorkPeriodsFromCard } from '../analysis/workPeriods.ts'
import type { Activity, ActivityKind, DriverCardData } from '../types/tacho.ts'
import type { DailyRecordCoverageGap } from '../types/coverage.ts'
import type { DailyRestVariantKind } from '../analysis/dailyRestOptions.ts'
import {
  findQualifiedRestBoundaries,
  type QualifiedRestBoundary,
  type RestBoundaryEvidenceBasis,
  type RestBoundaryInterpretation,
  type RestBoundaryPart,
} from './qualifiedRestBoundaries.ts'

export type BoundaryReliability = 'confirmed' | 'preliminary' | 'open'

export type ActivityKindSummary = {
  drivingMinutes: number
  workMinutes: number
  availabilityMinutes: number
  restMinutes: number
  unknownMinutes: number
}

export type PresentedActivityRow = {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
  durationMinutes: number
  slot: 1 | 2 | null
}

export type CoverageGapSummary = {
  id: string
  startUtc: number
  endUtc: number
  calendarDaysBetween: number
}

export type SeparatingRestPartView = RestBoundaryPart

export type SeparatingRestAlternative = {
  variant: DailyRestVariantKind
  label: string
  parts: SeparatingRestPartView[]
}

export type SeparatingRestSummary = {
  variant: DailyRestVariantKind
  /** U souvislého odpočinku jeho začátek. U děleného začátek uzavírající části. */
  startUtc: number
  endUtc: number
  durationMs: number
  durationCategoryText: string
  /** Jedna část u souvislého odpočinku, dvě samostatné části u 3+9. */
  parts: SeparatingRestPartView[]
  /** Ostatní kandidáty. Nejsou právní potvrzení. */
  alternatives: SeparatingRestAlternative[]
  kinds: string[]
  slot: 1 | 2 | null
  evidenceBasis: RestBoundaryEvidenceBasis
  cardPresentSupport: QualifiedRestBoundary['cardPresentSupport']
}

export type WorkPeriodPresentationItem = {
  id: string
  index: number
  startUtc: number
  endUtc: number
  durationMs: number
  startBoundaryReliability: BoundaryReliability
  endBoundaryReliability: BoundaryReliability
  separatingRest: SeparatingRestSummary | null
  summary: ActivityKindSummary
  activities: PresentedActivityRow[]
  overlappingCoverageGaps: CoverageGapSummary[]
  preliminaryBoundaryNotes: string[]
}

export type WorkPeriodOverviewModel = {
  envelopeStartUtc: number | null
  envelopeEndUtc: number | null
  dataComplete: boolean
  restBoundaryCount: number
  periods: WorkPeriodPresentationItem[]
}

const HOUR_MS = 60 * 60 * 1000

function halfOpenOverlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

function restBoundaryReliability(boundary: QualifiedRestBoundary): BoundaryReliability {
  if (boundary.evidenceBasis === 'coverage_gap' || boundary.evidenceBasis === 'unknown_affected') {
    return 'preliminary'
  }
  if (boundary.preliminaryNotes.some((note) => note.includes('ruční'))) return 'preliminary'
  if (boundary.preliminaryNotes.some((note) => note.includes('jiném slotu'))) return 'preliminary'
  if (!boundary.established) return 'preliminary'
  return 'confirmed'
}

function durationCategoryText(variant: DailyRestVariantKind, durationMs: number): string {
  if (variant === 'split_regular') return 'dělený 3+9 h (kandidát)'
  if (durationMs >= 45 * HOUR_MS) return '≥45 h (kandidát týdenního)'
  if (durationMs >= 24 * HOUR_MS) return '≥24 h (delší souvislý)'
  if (variant === 'continuous_regular' || durationMs >= 11 * HOUR_MS) return '≥11 h (kandidát denního)'
  return '≥9 h (kandidát zkráceného denního)'
}

function alternativeLabel(interpretation: RestBoundaryInterpretation): string {
  return `alternativní kandidát: ${durationCategoryText(interpretation.variant, interpretation.durationMs)}`
}

function separatingRestSummary(boundary: QualifiedRestBoundary): SeparatingRestSummary {
  const alternatives = boundary.interpretations.filter(
    (interpretation) => interpretation.variant !== boundary.variant || !sameParts(interpretation.parts, boundary.parts),
  )
  return {
    variant: boundary.variant,
    startUtc: boundary.restStartUtc,
    endUtc: boundary.restEndUtc,
    durationMs: boundary.durationMs,
    durationCategoryText: durationCategoryText(boundary.variant, boundary.durationMs),
    parts: boundary.parts.map((part) => ({ ...part })),
    alternatives: alternatives.map((interpretation) => ({
      variant: interpretation.variant,
      label: alternativeLabel(interpretation),
      parts: interpretation.parts.map((part) => ({ ...part })),
    })),
    kinds: boundary.kinds,
    slot: boundary.slot,
    evidenceBasis: boundary.evidenceBasis,
    cardPresentSupport: boundary.cardPresentSupport,
  }
}

function sameParts(left: readonly RestBoundaryPart[], right: readonly RestBoundaryPart[]): boolean {
  return left.length === right.length && left.every((part, index) => part.startUtc === right[index]!.startUtc && part.endUtc === right[index]!.endUtc)
}

function overlapMs(start: number, end: number, act: Activity): number {
  const from = Math.max(start, act.startUtc)
  const to = Math.min(end, act.endUtc)
  return Math.max(0, to - from)
}

function summarizeActivities(
  activities: readonly Activity[],
  startUtc: number,
  endUtc: number,
): { summary: ActivityKindSummary; rows: PresentedActivityRow[] } {
  const summary: ActivityKindSummary = {
    drivingMinutes: 0,
    workMinutes: 0,
    availabilityMinutes: 0,
    restMinutes: 0,
    unknownMinutes: 0,
  }
  const rows: PresentedActivityRow[] = []

  for (const activity of activities) {
    if (!halfOpenOverlaps(startUtc, endUtc, activity.startUtc, activity.endUtc)) continue
    const overlap = overlapMs(startUtc, endUtc, activity)
    const minutes = Math.round(overlap / 60_000)
    if (minutes <= 0 && activity.endUtc <= activity.startUtc) continue

    rows.push({
      id: activity.id,
      kind: activity.kind,
      startUtc: activity.startUtc,
      endUtc: activity.endUtc,
      durationMinutes: activity.durationMinutes,
      slot: activity.slot === 1 || activity.slot === 2 ? activity.slot : null,
    })

    switch (activity.kind) {
      case 'driving':
        summary.drivingMinutes += minutes
        break
      case 'work':
        summary.workMinutes += minutes
        break
      case 'availability':
        summary.availabilityMinutes += minutes
        break
      case 'rest':
        summary.restMinutes += minutes
        break
      default:
        summary.unknownMinutes += minutes
        break
    }
  }

  rows.sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc || a.id.localeCompare(b.id))
  return { summary, rows }
}

function coverageInRange(
  gaps: readonly DailyRecordCoverageGap[] | undefined,
  startUtc: number,
  endUtc: number,
): CoverageGapSummary[] {
  if (!gaps) return []
  return gaps
    .filter((gap) => halfOpenOverlaps(startUtc, endUtc, gap.startUtc, gap.endUtc))
    .map((gap) => ({
      id: gap.id,
      startUtc: gap.startUtc,
      endUtc: gap.endUtc,
      calendarDaysBetween: gap.calendarDaysBetween,
    }))
}

/**
 * Prezentační model: obálka práce + rozdělení podle kvalifikovaných odpočinků (nezávislé na card_present řezu).
 */
export function buildWorkPeriodOverview(card: DriverCardData): WorkPeriodOverviewModel {
  const envelope = assessWorkPeriodsFromCard(card)
  const boundaries = findQualifiedRestBoundaries({
    activities: card.activities,
    dailyRecordCoverageGaps: card.dailyRecordCoverageGaps,
    cardPresentEdges: card.cardPresentEdges,
    envelopeStartUtc: envelope.startUtc ?? undefined,
    envelopeEndUtc: envelope.endUtc ?? undefined,
  })

  if (envelope.startUtc == null || envelope.endUtc == null) {
    return {
      envelopeStartUtc: null,
      envelopeEndUtc: null,
      dataComplete: envelope.dataComplete,
      restBoundaryCount: 0,
      periods: [],
    }
  }

  const segments: Array<{
    startUtc: number
    endUtc: number
    followingBoundary: QualifiedRestBoundary | null
    endReliability: BoundaryReliability
    startReliability: BoundaryReliability
    preliminaryNotes: string[]
  }> = []

  if (boundaries.length === 0) {
    segments.push({
      startUtc: envelope.startUtc,
      endUtc: envelope.endUtc,
      followingBoundary: null,
      startReliability: 'open',
      endReliability: 'open',
      preliminaryNotes: envelope.dataComplete ? [] : ['obálka: dataComplete=false'],
    })
  } else {
    const first = boundaries[0]!
    const firstEndRel = restBoundaryReliability(first)
    segments.push({
      startUtc: envelope.startUtc,
      endUtc: first.workPeriodEndUtc,
      followingBoundary: first,
      startReliability: 'open',
      endReliability: firstEndRel,
      preliminaryNotes: [...first.preliminaryNotes],
    })

    for (let index = 1; index < boundaries.length; index += 1) {
      const prev = boundaries[index - 1]!
      const boundary = boundaries[index]!
      const prevStartRel = restBoundaryReliability(prev)
      const endRel = restBoundaryReliability(boundary)
      segments.push({
        startUtc: prev.nextWorkStartUtc,
        endUtc: boundary.workPeriodEndUtc,
        followingBoundary: boundary,
        startReliability: prevStartRel,
        endReliability: endRel,
        preliminaryNotes: [...new Set([...prev.preliminaryNotes, ...boundary.preliminaryNotes])],
      })
    }

    const last = boundaries[boundaries.length - 1]!
    segments.push({
      startUtc: last.nextWorkStartUtc,
      endUtc: envelope.endUtc,
      followingBoundary: null,
      startReliability: restBoundaryReliability(last),
      endReliability: 'open',
      preliminaryNotes: last.preliminaryNotes,
    })
  }

  const periods: WorkPeriodPresentationItem[] = segments
    .filter((segment) => segment.endUtc > segment.startUtc)
    .map((segment, index) => {
      const { summary, rows } = summarizeActivities(card.activities, segment.startUtc, segment.endUtc)
      const uniqueNotes = [...new Set(segment.preliminaryNotes)]
      return {
        id: `wp-${index + 1}`,
        index: index + 1,
        startUtc: segment.startUtc,
        endUtc: segment.endUtc,
        durationMs: segment.endUtc - segment.startUtc,
        startBoundaryReliability: segment.startReliability,
        endBoundaryReliability: segment.endReliability,
        separatingRest: segment.followingBoundary ? separatingRestSummary(segment.followingBoundary) : null,
        summary,
        activities: rows,
        overlappingCoverageGaps: coverageInRange(
          card.dailyRecordCoverageGaps,
          segment.startUtc,
          segment.endUtc,
        ),
        preliminaryBoundaryNotes: uniqueNotes,
      }
    })

  return {
    envelopeStartUtc: envelope.startUtc,
    envelopeEndUtc: envelope.endUtc,
    dataComplete: envelope.dataComplete,
    restBoundaryCount: boundaries.length,
    periods,
  }
}
