import {
  diagnoseHolderAbsentLongSpansFromParserJson,
  type HolderAbsentLongSpanDiagnostic,
} from '../utils/dddMapper.ts'

const DAY_MS = 24 * 60 * 60_000
const HIGHLIGHT_START = Date.parse('2024-10-28T16:47:00.000Z')
const HIGHLIGHT_END = Date.parse('2024-12-28T00:00:00.000Z')

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function formatBool(value: boolean | 'unavailable'): string {
  if (value === 'unavailable') return 'unavailable'
  return value ? 'true' : 'false'
}

function formatOptionalBool(value: boolean | null): string {
  if (value === null) return 'unavailable'
  return value ? 'true' : 'false'
}

function isHighlightMatch(row: HolderAbsentLongSpanDiagnostic): boolean {
  return row.startUtc === HIGHLIGHT_START && row.endUtc === HIGHLIGHT_END
}

function formatRow(row: HolderAbsentLongSpanDiagnostic, index: number): string[] {
  const lines = [
    `--- absent long span #${index + 1}${isHighlightMatch(row) ? ' [highlight 2024-10-28/12-28]' : ''} ---`,
    `sourceActivityId=${row.sourceActivityId}`,
    `startUtc=${iso(row.startUtc)} endUtc=${iso(row.endUtc)}`,
    `durationHours=${((row.endUtc - row.startUtc) / (60 * 60_000)).toFixed(2)}`,
    `current.dayStart=${iso(row.currentDayStart)}`,
    `nextLater.dayStart=${row.nextLaterDayStart != null ? iso(row.nextLaterDayStart) : 'unavailable'}`,
    `dayStartDiffCalendarDays=${row.dayStartDiffCalendarDays ?? 'unavailable'}`,
    `current.card_present=${formatOptionalBool(row.currentCardPresent)}`,
    `nextLater.card_present=${row.nextLaterCardPresent === null ? 'unavailable' : formatOptionalBool(row.nextLaterCardPresent)}`,
    `current.work_type=${row.currentWorkType ?? 'unavailable'}`,
    `nextLater.work_type=${row.nextLaterWorkType ?? 'unavailable'}`,
    `current.driver=${row.currentDriver === null ? 'unavailable' : String(row.currentDriver)}`,
    `nextLater.driver=${row.nextLaterDriver === null ? 'unavailable' : String(row.nextLaterDriver)}`,
    `spansUnrecordedDays=${formatBool(row.spansUnrecordedDays)}`,
    `sameAbsentActivity=${formatBool(row.sameAbsentActivity)}`,
    `wouldCreateUnknownWithoutSameAbsentException=${formatBool(row.wouldCreateUnknownWithoutSameAbsentException)}`,
    `dailyRecordsBetweenDayStartsInclusive=${row.dailyRecordsBetweenDayStartsInclusive}`,
    `dailyRecordsStrictlyBetweenDayStarts=${row.dailyRecordsStrictlyBetweenDayStarts}`,
  ]
  return lines
}

/** DEV výpis původu dlouhých absent-card úseků (bez PII). */
export function formatHolderAbsentLongSpanDiagnosticsReport(parserJson: unknown): string {
  const rows = diagnoseHolderAbsentLongSpansFromParserJson(parserJson)
  const ordered = [
    ...rows.filter((row) => isHighlightMatch(row)),
    ...rows.filter((row) => !isHighlightMatch(row)),
  ]

  const lines: string[] = [
    '=== Holder timeline — absent long spans (DEV, bez PII) ===',
    `Threshold: duration > ${DAY_MS / 60_000 / 60} h, start card_present=false`,
    `Highlight segment: ${iso(HIGHLIGHT_START)} .. ${iso(HIGHLIGHT_END)}`,
    `Matches: ${rows.filter((row) => isHighlightMatch(row)).length}`,
    `Total absent spans >24h: ${rows.length}`,
  ]

  if (ordered.length === 0) {
    lines.push('Žádné absent úseky delší než 24 h.')
    return lines.join('\n')
  }

  ordered.forEach((row, index) => {
    lines.push('')
    lines.push(...formatRow(row, index))
  })

  return lines.join('\n')
}
