import type { DriverCardData, HolderTimelineSegment } from '../types/tacho.ts'

export type HolderTimelineSegmentReport = {
  startUtc: string
  endUtc: string
  kind: HolderTimelineSegment['kind']
  position: 1 | 2
  startOrigin: HolderTimelineSegment['startOrigin']
  endCause: HolderTimelineSegment['endCause']
  continuity: HolderTimelineSegment['continuity']
  sourceChangeCount: number
  sourceActivityIds: string[]
}

export type HolderTimelineDiagnostics = {
  segmentCount: number
  slotChronologyAssumption: string
  slotChronologyUnresolvedNote: string
  segments: HolderTimelineSegmentReport[]
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function segmentsInRange(
  segments: readonly HolderTimelineSegment[],
  rangeStartUtc: number,
  rangeEndUtc: number,
): HolderTimelineSegment[] {
  return segments.filter(
    (segment) => segment.startUtc < rangeEndUtc && segment.endUtc > rangeStartUtc,
  )
}

function toReport(segment: HolderTimelineSegment): HolderTimelineSegmentReport {
  return {
    startUtc: iso(segment.startUtc),
    endUtc: iso(segment.endUtc),
    kind: segment.kind,
    position: segment.position,
    startOrigin: segment.startOrigin,
    endCause: segment.endCause,
    continuity: segment.continuity,
    sourceChangeCount: segment.sourceChangeCount,
    sourceActivityIds: [...segment.sourceActivityIds],
  }
}

export function diagnoseHolderTimelineFromCard(card: DriverCardData): HolderTimelineDiagnostics {
  const segments = card.holderTimelineSegments ?? []
  const assumption = card.holderTimelineMeta?.slotChronologyAssumption ?? 'unresolved'
  return {
    segmentCount: segments.length,
    slotChronologyAssumption: assumption,
    slotChronologyUnresolvedNote:
      assumption === 'single_card_merged_timeline'
        ? 'Změny slot 1 a 2 jsou v mapovači jedna chronologie (laterChange). Význam bitu driver v normě EU není zde ověřen.'
        : 'Chybí metadata z DDD mapování; segmenty jsou pouze odvozené z Activity[].',
    segments: segments.map(toReport),
  }
}

export function formatHolderTimelineSegmentReport(segment: HolderTimelineSegmentReport): string {
  const durationMin = Math.round(
    (Date.parse(segment.endUtc) - Date.parse(segment.startUtc)) / 60_000,
  )
  return [
    `${segment.startUtc} .. ${segment.endUtc} (${durationMin} min)`,
    `  kind=${segment.kind} position=${segment.position}`,
    `  startOrigin=${segment.startOrigin} endCause=${segment.endCause} continuity=${segment.continuity}`,
    `  sourceChangeCount=${segment.sourceChangeCount} ids=${segment.sourceActivityIds.join(',') || '—'}`,
  ].join('\n')
}

export function formatHolderTimelineDiagnosticsReport(report: HolderTimelineDiagnostics): string {
  const lines: string[] = [
    '=== Holder timeline diagnostika (lokální, bez PII) ===',
    `Segmentů: ${report.segmentCount}`,
    `Předpoklad chronologie: ${report.slotChronologyAssumption}`,
    `Poznámka: ${report.slotChronologyUnresolvedNote}`,
  ]
  if (report.segments.length === 0) {
    lines.push('Segmenty: žádné')
  } else {
    lines.push('Segmenty (výňatek — celý seznam může být dlouhý):')
    const preview = report.segments.length > 40 ? report.segments.slice(0, 40) : report.segments
    for (const segment of preview) {
      lines.push(formatHolderTimelineSegmentReport(segment))
    }
    if (report.segments.length > 40) {
      lines.push(`… a dalších ${report.segments.length - 40} segmentů`)
    }
  }
  return lines.join('\n')
}

/** Anonymní výňatek pro konkrétní UTC interval. */
export function formatSegmentsInRange(
  card: DriverCardData,
  rangeStartUtc: number,
  rangeEndUtc: number,
): string {
  const raw = card.holderTimelineSegments ?? []
  const picked = segmentsInRange(raw, rangeStartUtc, rangeEndUtc).map(toReport)
  if (picked.length === 0) return `Interval ${iso(rangeStartUtc)} .. ${iso(rangeEndUtc)}: žádné segmenty`
  const lines = [`Interval ${iso(rangeStartUtc)} .. ${iso(rangeEndUtc)}: ${picked.length} segment(ů)`]
  for (const segment of picked) {
    lines.push(formatHolderTimelineSegmentReport(segment))
  }
  const conflicts = picked.filter((segment) => segment.continuity === 'conflict')
  const gaps = picked.filter((segment) => segment.endCause === 'unknown_gap' || segment.kind === 'unknown')
  if (gaps.length > 0) lines.push(`Mezery/unknown v intervalu: ${gaps.length}`)
  if (conflicts.length > 0) lines.push(`Konflikty continuity: ${conflicts.length}`)
  return lines.join('\n')
}
