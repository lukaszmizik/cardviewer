import type { DriverCardData } from '../types/tacho.ts'
import type { CandidateCut, WorkEnvelope } from './workPeriods.ts'
import { assessWorkPeriodsFromCard } from './workPeriods.ts'

const MS_DAY = 24 * 60 * 60_000

export type WorkPeriodCutDiagnostic = {
  previousWorkEndUtc: string
  nextWorkStartUtc: string
  restSegments: Array<{ startUtc: string; endUtc: string; slot: string }>
  unknownInCorridor: Array<{ startUtc: string; endUtc: string }>
  cardPresentSupport: CandidateCut['cardPresentSupport']
  support: CandidateCut['support']
  blockers: CandidateCut['blockers']
  uncertainties: CandidateCut['uncertainties']
}

export type WorkPeriodWarningKind =
  | 'multi_day_envelope'
  | 'vehicle_only_cuts'
  | 'no_card_present_edges'
  | 'card_present_edges_without_cut_support'
  | 'incomplete_data'
  | 'time_overlap_blockers'
  | 'uncertain_cuts'

export type WorkPeriodDiagnostics = {
  activities: {
    count: number
    rangeStartUtc: string | null
    rangeEndUtc: string | null
  }
  cardPresentEdges: {
    total: number
    presentTrue: number
    presentFalse: number
  }
  vehicleUseCount: number
  workEnvelopeCount: number
  candidateCutCount: number
  dataComplete: boolean
  envelopeRangeStartUtc: string | null
  envelopeRangeEndUtc: string | null
  cuts: WorkPeriodCutDiagnostic[]
  warnings: WorkPeriodWarningKind[]
}

function isoUtc(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function calendarDaysSpanned(startUtc: number, endUtc: number): number {
  const startDay = Math.floor(startUtc / MS_DAY)
  const endDay = Math.floor((endUtc - 1) / MS_DAY)
  return endDay - startDay + 1
}

function buildWarnings(card: DriverCardData, envelope: WorkEnvelope): WorkPeriodWarningKind[] {
  const warnings: WorkPeriodWarningKind[] = []
  if (envelope.startUtc != null && envelope.endUtc != null) {
    if (calendarDaysSpanned(envelope.startUtc, envelope.endUtc) > 1) {
      warnings.push('multi_day_envelope')
    }
  }
  if (envelope.cuts.some((cut) => cut.support.length === 1 && cut.support[0] === 'vehicle_use_gap')) {
    warnings.push('vehicle_only_cuts')
  }
  const edgeCount = card.cardPresentEdges?.length ?? 0
  if (edgeCount === 0) {
    warnings.push('no_card_present_edges')
  } else if (!envelope.cuts.some((cut) => cut.support.includes('card_present_edge'))) {
    warnings.push('card_present_edges_without_cut_support')
  }
  if (!envelope.dataComplete) {
    warnings.push('incomplete_data')
  }
  if (envelope.blockers.some((item) => item.kind === 'time_overlap_event')) {
    warnings.push('time_overlap_blockers')
  }
  if (envelope.cuts.some((cut) => cut.uncertainties.length > 0 || cut.blockers.length > 0)) {
    warnings.push('uncertain_cuts')
  }
  const uses = card.vehicleUses ?? []
  for (const cut of envelope.cuts) {
    for (const segment of cut.restSegments) {
      if (
        uses.some(
          (use) =>
            use.fromUtc < segment.endUtc &&
            use.toUtc > segment.startUtc &&
            (use.toUtc !== segment.startUtc || use.fromUtc !== segment.endUtc),
        )
      ) {
        warnings.push('time_overlap_blockers')
        break
      }
    }
  }
  return [...new Set(warnings)]
}

export function diagnoseWorkPeriodsFromCard(card: DriverCardData): WorkPeriodDiagnostics {
  const envelope = assessWorkPeriodsFromCard(card)
  const activityTimes = card.activities
    .map((activity) => activity.startUtc)
    .concat(card.activities.map((activity) => activity.endUtc))
  const edges = card.cardPresentEdges ?? []

  return {
    activities: {
      count: card.activities.length,
      rangeStartUtc: isoUtc(activityTimes.length ? Math.min(...activityTimes) : null),
      rangeEndUtc: isoUtc(activityTimes.length ? Math.max(...activityTimes) : null),
    },
    cardPresentEdges: {
      total: edges.length,
      presentTrue: edges.filter((edge) => edge.present).length,
      presentFalse: edges.filter((edge) => !edge.present).length,
    },
    vehicleUseCount: card.vehicleUses?.length ?? 0,
    workEnvelopeCount: envelope.startUtc == null ? 0 : 1,
    candidateCutCount: envelope.cuts.length,
    dataComplete: envelope.dataComplete,
    envelopeRangeStartUtc: isoUtc(envelope.startUtc),
    envelopeRangeEndUtc: isoUtc(envelope.endUtc),
    cuts: envelope.cuts.map((cut) => ({
      previousWorkEndUtc: isoUtc(cut.previousWorkEndUtc)!,
      nextWorkStartUtc: isoUtc(cut.nextWorkStartUtc)!,
      restSegments: cut.restSegments.map((segment) => ({
        startUtc: isoUtc(segment.startUtc)!,
        endUtc: isoUtc(segment.endUtc)!,
        slot: segment.slot == null ? '—' : String(segment.slot),
      })),
      unknownInCorridor: cut.unknownInCorridor.map((span) => ({
        startUtc: isoUtc(span.startUtc)!,
        endUtc: isoUtc(span.endUtc)!,
      })),
      cardPresentSupport: cut.cardPresentSupport,
      support: [...cut.support],
      blockers: [...cut.blockers],
      uncertainties: [...cut.uncertainties],
    })),
    warnings: buildWarnings(card, envelope),
  }
}

const WARNING_LABELS: Record<WorkPeriodWarningKind, string> = {
  multi_day_envelope: 'Obálka práce přesahuje více kalendářních dní (fáze 1: jedna obálka).',
  vehicle_only_cuts: 'Alespoň jeden kandidátní předěl má podporu pouze vehicle_use_gap (bez card_present_edge).',
  no_card_present_edges: 'Chybí namapované přechody card_present.',
  card_present_edges_without_cut_support:
    'Přechody card_present jsou k dispozici, ale žádný kandidátní předěl je nevyužívá.',
  incomplete_data: 'dataComplete === false (unknown nebo jiná neúplnost v rozsahu obálky).',
  time_overlap_blockers: 'Časové kolize nebo vozidlo protínající odpočinek mimo hranu mezery.',
  uncertain_cuts: 'Alespoň jeden předěl má blokátory nebo nejistoty (není potvrzená hranice pracovní doby).',
}

export function formatWorkPeriodDiagnosticsReport(report: WorkPeriodDiagnostics): string {
  const lines: string[] = [
    '=== WorkPeriod diagnostika (lokální, bez PII) ===',
    `Aktivity: počet=${report.activities.count}, rozsah=${report.activities.rangeStartUtc ?? '—'} .. ${report.activities.rangeEndUtc ?? '—'}`,
    `cardPresentEdges: celkem=${report.cardPresentEdges.total}, present=true ${report.cardPresentEdges.presentTrue}, present=false ${report.cardPresentEdges.presentFalse}`,
    `VehicleUse: počet=${report.vehicleUseCount}`,
    `WorkEnvelope: počet=${report.workEnvelopeCount}, dataComplete=${report.dataComplete}`,
    `Obálka práce: ${report.envelopeRangeStartUtc ?? '—'} .. ${report.envelopeRangeEndUtc ?? '—'}`,
    `CandidateCut: počet=${report.candidateCutCount}`,
  ]

  if (report.cuts.length === 0) {
    lines.push('Kandidátní předěly: žádné')
  } else {
    lines.push('Kandidátní předěly:')
    report.cuts.forEach((cut, index) => {
      lines.push(
        `  [${index + 1}] konec předchozí práce ${cut.previousWorkEndUtc}, začátek následující ${cut.nextWorkStartUtc}`,
      )
      lines.push(`      card_present: ${cut.cardPresentSupport}`)
      lines.push(`      rest úseky (${cut.restSegments.length}):`)
      for (const segment of cut.restSegments) {
        lines.push(`        ${segment.startUtc} .. ${segment.endUtc} (slot ${segment.slot})`)
      }
      if (cut.unknownInCorridor.length > 0) {
        lines.push('      unknown v koridoru:')
        for (const span of cut.unknownInCorridor) {
          lines.push(`        ${span.startUtc} .. ${span.endUtc}`)
        }
      }
      lines.push(`      podpora: ${cut.support.join(', ') || '—'}`)
      lines.push(`      blokátory: ${cut.blockers.join(', ') || '—'}`)
      lines.push(`      nejistoty: ${cut.uncertainties.join(', ') || '—'}`)
    })
  }

  if (report.warnings.length > 0) {
    lines.push('Upozornění:')
    for (const kind of report.warnings) {
      lines.push(`  - ${WARNING_LABELS[kind]}`)
    }
  } else {
    lines.push('Upozornění: žádné')
  }

  return lines.join('\n')
}
