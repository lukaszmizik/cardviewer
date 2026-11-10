import type { DriverCardData, HolderTimelineSegment } from '../types/tacho'
import { formatSegmentsInRange, segmentsInRange } from '../analysis/holderTimelineDiagnostics'

function utc(iso: string): number {
  return Date.parse(iso)
}

const WINDOW_1_START = utc('2025-02-22T02:30:00.000Z')
const WINDOW_1_END = utc('2025-02-22T05:00:00.000Z')

const WINDOW_2_START = utc('2024-10-25T17:00:00.000Z')
const WINDOW_2_END = utc('2024-10-26T09:00:00.000Z')

const WINDOW_3A_START = utc('2024-10-28T15:00:00.000Z')
const WINDOW_3A_END = utc('2024-10-30T00:00:00.000Z')
const WINDOW_3B_START = utc('2025-02-15T00:00:00.000Z')
const WINDOW_3B_END = utc('2025-02-16T14:00:00.000Z')
const WINDOW_3_BETWEEN_START = WINDOW_3A_END
const WINDOW_3_BETWEEN_END = WINDOW_3B_START

const WINDOW_4_START = utc('2025-11-16T21:00:00.000Z')
const WINDOW_4_END = utc('2025-11-17T15:00:00.000Z')

const DAY_MS = 24 * 60 * 60_000

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function formatAllSegmentsInRange(
  card: DriverCardData,
  rangeStartUtc: number,
  rangeEndUtc: number,
  label: string,
): string {
  const header = `--- ${label} ---`
  const body = formatSegmentsInRange(card, rangeStartUtc, rangeEndUtc)
  return `${header}\n${body}`
}

function countMidnightCrossings(segments: readonly HolderTimelineSegment[]): number {
  return segments.filter((segment) => {
    if (segment.endUtc <= segment.startUtc) return false
    const startDay = Math.floor(segment.startUtc / DAY_MS)
    const endDay = Math.floor((segment.endUtc - 1) / DAY_MS)
    return endDay > startDay
  }).length
}

function countPositionChanges(segments: readonly HolderTimelineSegment[]): number {
  const ordered = [...segments].sort(
    (a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc,
  )
  let changes = 0
  for (let index = 1; index < ordered.length; index += 1) {
    const prev = ordered[index - 1]!
    const next = ordered[index]!
    if (prev.position !== next.position) changes += 1
  }
  return changes
}

function formatBetweenWindowsAggregation(
  segments: readonly HolderTimelineSegment[],
  rangeStartUtc: number,
  rangeEndUtc: number,
): string {
  const picked = segmentsInRange(segments, rangeStartUtc, rangeEndUtc)
  const buckets = new Map<string, number>()
  for (const segment of picked) {
    const key = `kind=${segment.kind} position=${segment.position} startOrigin=${segment.startOrigin} continuity=${segment.continuity}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  const unknownSegments = picked.filter(
    (segment) => segment.kind === 'unknown' || segment.endCause === 'unknown_gap',
  ).length
  const positionChanges = countPositionChanges(picked)
  const midnightCrossings = countMidnightCrossings(picked)

  const lines: string[] = [
    `--- Okno 3: agregace mezi okny (${iso(rangeStartUtc)} .. ${iso(rangeEndUtc)}) ---`,
    `Segmentů celkem: ${picked.length}`,
    'Počty podle kind, position, startOrigin, continuity:',
  ]
  const sortedKeys = [...buckets.keys()].sort()
  for (const key of sortedKeys) {
    lines.push(`  ${key}: ${buckets.get(key)}`)
  }
  lines.push(`Počet unknown úseků: ${unknownSegments}`)
  lines.push(`Počet změn pozice: ${positionChanges}`)
  lines.push(`Počet přechodů přes půlnoc (UTC): ${midnightCrossings}`)
  return lines.join('\n')
}

/** Vývojový výpis čtyř cílených UTC oken (bez PII). */
export function formatHolderTimelineTargetWindowsReport(card: DriverCardData): string {
  const raw = card.holderTimelineSegments ?? []
  const assumption = card.holderTimelineMeta?.slotChronologyAssumption ?? 'unresolved'

  const lines: string[] = [
    '=== Holder timeline — cílená časová okna (DEV, bez PII) ===',
    `Předpoklad chronologie: ${assumption}`,
    `Celkem segmentů na kartě: ${raw.length}`,
    '',
    formatAllSegmentsInRange(card, WINDOW_1_START, WINDOW_1_END, 'Okno 1'),
    '',
    formatAllSegmentsInRange(card, WINDOW_2_START, WINDOW_2_END, 'Okno 2'),
    '',
    formatAllSegmentsInRange(card, WINDOW_3A_START, WINDOW_3A_END, 'Okno 3a'),
    '',
    formatAllSegmentsInRange(card, WINDOW_3B_START, WINDOW_3B_END, 'Okno 3b'),
    '',
    formatBetweenWindowsAggregation(raw, WINDOW_3_BETWEEN_START, WINDOW_3_BETWEEN_END),
    '',
    formatAllSegmentsInRange(card, WINDOW_4_START, WINDOW_4_END, 'Okno 4'),
  ]

  return lines.join('\n')
}
