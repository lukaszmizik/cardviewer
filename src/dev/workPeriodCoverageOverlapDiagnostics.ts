import type { DailyRecordCoverageGap } from '../types/coverage.ts'
import type { DriverCardData } from '../types/tacho.ts'
import type { CandidateCut } from '../analysis/workPeriods.ts'
import { assessWorkPeriodsFromCard } from '../analysis/workPeriods.ts'

export type CutCoverageOverlapState =
  | 'coverage_available_no_overlap'
  | 'coverage_available_with_overlap'
  | 'coverage_unavailable'

export type OverlappingCoverageGapSummary = {
  id: string
  startUtc: number
  endUtc: number
  calendarDaysBetween: number
  unknownGapSuppressedBySameAbsentActivity: boolean | null
  unknownGapEmittedByMapper: boolean | null
}

export type MapperCorridorHint =
  | 'unavailable'
  | 'none'
  | 'bridged_absent_rest'
  | 'mapper_unknown_emitted'
  | 'mixed_bridge_and_unknown'

export type CandidateCutCoverageOverlapRow = {
  cutId: string
  previousWorkEndUtc: number
  nextWorkStartUtc: number
  corridorDurationMs: number
  coverageOverlapState: CutCoverageOverlapState
  cardPresentSupport: CandidateCut['cardPresentSupport']
  support: CandidateCut['support']
  blockers: CandidateCut['blockers']
  uncertainties: CandidateCut['uncertainties']
  overlappingGapCount: number
  overlappingGaps: OverlappingCoverageGapSummary[]
  missingUtcDaysInOverlaps: number
  mapperCorridorHint: MapperCorridorHint
}

export type WorkPeriodCoverageOverlapDiagnostics = {
  coverageAvailable: boolean
  candidateCutCount: number
  summaryByState: Record<CutCoverageOverlapState, number>
  rows: CandidateCutCoverageOverlapRow[]
}

/** Přesný překryv [startUtc, endUtc) bez tolerance. */
export function halfOpenOverlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart
}

export function cutCorridorId(previousWorkEndUtc: number, nextWorkStartUtc: number): string {
  return `cut-${previousWorkEndUtc}|${nextWorkStartUtc}`
}

function overlappingGapsForCorridor(
  gaps: readonly DailyRecordCoverageGap[],
  corridorStart: number,
  corridorEnd: number,
): OverlappingCoverageGapSummary[] {
  const hits: OverlappingCoverageGapSummary[] = []
  for (const gap of gaps) {
    if (!halfOpenOverlaps(corridorStart, corridorEnd, gap.startUtc, gap.endUtc)) continue
    hits.push({
      id: gap.id,
      startUtc: gap.startUtc,
      endUtc: gap.endUtc,
      calendarDaysBetween: gap.calendarDaysBetween,
      unknownGapSuppressedBySameAbsentActivity: gap.unknownGapSuppressedBySameAbsentActivity,
      unknownGapEmittedByMapper: gap.unknownGapEmittedByMapper,
    })
  }
  return hits
}

function mapperHintFromGaps(gaps: readonly OverlappingCoverageGapSummary[]): MapperCorridorHint {
  if (gaps.length === 0) return 'none'
  const hasBridge = gaps.some((gap) => gap.unknownGapSuppressedBySameAbsentActivity === true)
  const hasUnknown = gaps.some((gap) => gap.unknownGapEmittedByMapper === true)
  if (hasBridge && hasUnknown) return 'mixed_bridge_and_unknown'
  if (hasBridge) return 'bridged_absent_rest'
  if (hasUnknown) return 'mapper_unknown_emitted'
  return 'none'
}

function rowForCut(
  cut: CandidateCut,
  gaps: readonly DailyRecordCoverageGap[] | undefined,
): CandidateCutCoverageOverlapRow {
  const corridorStart = cut.previousWorkEndUtc
  const corridorEnd = cut.nextWorkStartUtc
  const corridorDurationMs = corridorEnd - corridorStart

  if (gaps === undefined) {
    return {
      cutId: cutCorridorId(corridorStart, corridorEnd),
      previousWorkEndUtc: corridorStart,
      nextWorkStartUtc: corridorEnd,
      corridorDurationMs,
      coverageOverlapState: 'coverage_unavailable',
      cardPresentSupport: cut.cardPresentSupport,
      support: [...cut.support],
      blockers: [...cut.blockers],
      uncertainties: [...cut.uncertainties],
      overlappingGapCount: 0,
      overlappingGaps: [],
      missingUtcDaysInOverlaps: 0,
      mapperCorridorHint: 'unavailable',
    }
  }

  const overlappingGaps = overlappingGapsForCorridor(gaps, corridorStart, corridorEnd)
  const coverageOverlapState: CutCoverageOverlapState =
    overlappingGaps.length > 0 ? 'coverage_available_with_overlap' : 'coverage_available_no_overlap'

  return {
    cutId: cutCorridorId(corridorStart, corridorEnd),
    previousWorkEndUtc: corridorStart,
    nextWorkStartUtc: corridorEnd,
    corridorDurationMs,
    coverageOverlapState,
    cardPresentSupport: cut.cardPresentSupport,
    support: [...cut.support],
    blockers: [...cut.blockers],
    uncertainties: [...cut.uncertainties],
    overlappingGapCount: overlappingGaps.length,
    overlappingGaps,
    missingUtcDaysInOverlaps: overlappingGaps.reduce(
      (sum, gap) => sum + gap.calendarDaysBetween,
      0,
    ),
    mapperCorridorHint: mapperHintFromGaps(overlappingGaps),
  }
}

/** Read-only diagnostika překryvu CandidateCut koridoru s DailyRecordCoverageGap. */
export function diagnoseWorkPeriodCoverageOverlap(
  card: DriverCardData,
): WorkPeriodCoverageOverlapDiagnostics {
  const envelope = assessWorkPeriodsFromCard(card)
  const gaps = card.dailyRecordCoverageGaps
  const rows = envelope.cuts.map((cut) => rowForCut(cut, gaps))

  const summaryByState: Record<CutCoverageOverlapState, number> = {
    coverage_available_no_overlap: 0,
    coverage_available_with_overlap: 0,
    coverage_unavailable: 0,
  }
  for (const row of rows) {
    summaryByState[row.coverageOverlapState] += 1
  }

  return {
    coverageAvailable: gaps !== undefined,
    candidateCutCount: rows.length,
    summaryByState,
    rows,
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function formatWorkPeriodCoverageOverlapReport(card: DriverCardData): string {
  const report = diagnoseWorkPeriodCoverageOverlap(card)
  const lines: string[] = [
    '=== WorkPeriod × Daily record coverage (DEV, bez PII) ===',
    `coverage metadata: ${report.coverageAvailable ? 'k dispozici' : 'nedostupná (undefined — neznamená 0 mezer)'}`,
    `CandidateCut: ${report.candidateCutCount}`,
    'Souhrn podle stavu:',
    `  coverage_available_no_overlap: ${report.summaryByState.coverage_available_no_overlap}`,
    `  coverage_available_with_overlap: ${report.summaryByState.coverage_available_with_overlap}`,
    `  coverage_unavailable: ${report.summaryByState.coverage_unavailable}`,
  ]

  if (report.rows.length === 0) {
    lines.push('Žádné CandidateCut.')
    return lines.join('\n')
  }

  lines.push('', '=== Kandidátní předěly ===')
  for (const row of report.rows) {
    lines.push(
      '',
      `--- ${row.cutId} ---`,
      `corridor [${iso(row.previousWorkEndUtc)}, ${iso(row.nextWorkStartUtc)}) durationMs=${row.corridorDurationMs}`,
      `coverageOverlapState=${row.coverageOverlapState}`,
      `cardPresentSupport=${row.cardPresentSupport}`,
      `support=${row.support.join(', ') || '—'}`,
      `blockers=${row.blockers.join(', ') || '—'}`,
      `uncertainties=${row.uncertainties.join(', ') || '—'}`,
      `overlappingGapCount=${row.overlappingGapCount}`,
      `missingUtcDaysInOverlaps=${row.missingUtcDaysInOverlaps}`,
      `mapperCorridorHint=${row.mapperCorridorHint}`,
    )
    if (row.overlappingGaps.length === 0) {
      lines.push('overlappingGaps: žádné')
    } else {
      lines.push('overlappingGaps:')
      for (const gap of row.overlappingGaps) {
        lines.push(
          `  ${gap.id} [${iso(gap.startUtc)}, ${iso(gap.endUtc)}) missingDays=${gap.calendarDaysBetween} suppressed=${gap.unknownGapSuppressedBySameAbsentActivity ?? 'null'} emitted=${gap.unknownGapEmittedByMapper ?? 'null'}`,
        )
      }
    }
  }

  return lines.join('\n')
}
