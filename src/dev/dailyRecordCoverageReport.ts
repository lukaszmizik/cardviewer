import type { DailyRecordCoverageGap } from '../types/coverage.ts'
import type { DriverCardData } from '../types/tacho.ts'
import { deriveDailyRecordCoverageGapsFromParserJson } from '../analysis/dailyRecordCoverage.ts'

const DAY_MS = 24 * 60 * 60_000
const HIGHLIGHT_CURRENT_DAY = Date.parse('2024-10-28T00:00:00.000Z')
const HIGHLIGHT_NEXT_DAY = Date.parse('2024-12-28T00:00:00.000Z')

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function formatBoolNull(value: boolean | null): string {
  if (value === null) return 'null'
  return value ? 'true' : 'false'
}

function isHighlight(gap: DailyRecordCoverageGap): boolean {
  return gap.currentDayStart === HIGHLIGHT_CURRENT_DAY && gap.nextLaterDayStart === HIGHLIGHT_NEXT_DAY
}

function hasNullAnchorMetadata(gap: DailyRecordCoverageGap): boolean {
  return (
    gap.startAnchorSourceActivityId === null ||
    gap.endAnchorSourceActivityId === null ||
    gap.spansUnrecordedDays === null ||
    gap.sameAbsentActivityAtAnchors === null ||
    gap.unknownGapGeometryEligible === null ||
    gap.unknownGapSuppressedBySameAbsentActivity === null ||
    gap.unknownGapEmittedByMapper === null
  )
}

function formatGapLines(gap: DailyRecordCoverageGap, label: string): string[] {
  return [
    `--- ${label} ---`,
    `id=${gap.id}`,
    `startUtc=${iso(gap.startUtc)} endUtc=${iso(gap.endUtc)}`,
    `currentDayStart=${iso(gap.currentDayStart)} nextLaterDayStart=${iso(gap.nextLaterDayStart)}`,
    `calendarDaysBetween=${gap.calendarDaysBetween}`,
    `dailyRecordsStrictlyBetween=${gap.dailyRecordsStrictlyBetween}`,
    `startAnchorSourceActivityId=${gap.startAnchorSourceActivityId ?? 'null'}`,
    `endAnchorSourceActivityId=${gap.endAnchorSourceActivityId ?? 'null'}`,
    `overlappedActivityIds=${gap.overlappedActivityIds?.join(',') ?? 'null'}`,
    `spansUnrecordedDays=${formatBoolNull(gap.spansUnrecordedDays)}`,
    `sameAbsentActivityAtAnchors=${formatBoolNull(gap.sameAbsentActivityAtAnchors)}`,
    `unknownGapGeometryEligible=${formatBoolNull(gap.unknownGapGeometryEligible)}`,
    `unknownGapSuppressedBySameAbsentActivity=${formatBoolNull(gap.unknownGapSuppressedBySameAbsentActivity)}`,
    `unknownGapEmittedByMapper=${formatBoolNull(gap.unknownGapEmittedByMapper)}`,
    'poznámka: unknownGapGeometryEligible používá changeTime(startAnchor), ne startUtc coverage mezery',
  ]
}

function summarizeFlag(gaps: readonly DailyRecordCoverageGap[], key: keyof DailyRecordCoverageGap): string {
  let trueCount = 0
  let falseCount = 0
  let nullCount = 0
  for (const gap of gaps) {
    const value = gap[key]
    if (value === true) trueCount += 1
    else if (value === false) falseCount += 1
    else nullCount += 1
  }
  return `true=${trueCount} false=${falseCount} null=${nullCount}`
}

function resolveCoverageGaps(card: DriverCardData, parserJson?: unknown): {
  gaps: DailyRecordCoverageGap[]
  source: string
} {
  if (card.dailyRecordCoverageGaps != null) {
    return { gaps: card.dailyRecordCoverageGaps, source: 'DriverCardData.dailyRecordCoverageGaps' }
  }
  if (parserJson != null) {
    return {
      gaps: deriveDailyRecordCoverageGapsFromParserJson(parserJson),
      source: 'parserJson (fallback, metadata na kartě chybí)',
    }
  }
  return { gaps: [], source: 'žádná data' }
}

/** DEV výpis DailyRecordCoverageGap (bez PII). */
export function formatDailyRecordCoverageReport(card: DriverCardData, parserJson?: unknown): string {
  const { gaps: all, source } = resolveCoverageGaps(card, parserJson)
  const multiDay = all.filter((gap) => gap.calendarDaysBetween > 1)
  const nullAnchor = all.filter((gap) => hasNullAnchorMetadata(gap))
  const highlights = all.filter((gap) => isHighlight(gap))

  const lines: string[] = [
    '=== Daily record coverage (DEV, bez PII) ===',
    `Zdroj gaps: ${source}`,
    `Celkem coverage gaps: ${all.length}`,
    `Mezery delší než 1 kalendářní den: ${multiDay.length}`,
    `Případy s null anchor / mapper metadata: ${nullAnchor.length}`,
    '',
    'Souhrn (všechny mezery):',
    `  unknownGapGeometryEligible: ${summarizeFlag(all, 'unknownGapGeometryEligible')}`,
    `  unknownGapSuppressedBySameAbsentActivity: ${summarizeFlag(all, 'unknownGapSuppressedBySameAbsentActivity')}`,
    `  unknownGapEmittedByMapper: ${summarizeFlag(all, 'unknownGapEmittedByMapper')}`,
    '',
    `Souhrn (jen calendarDaysBetween > 1, n=${multiDay.length}):`,
    `  unknownGapGeometryEligible: ${summarizeFlag(multiDay, 'unknownGapGeometryEligible')}`,
    `  unknownGapSuppressedBySameAbsentActivity: ${summarizeFlag(multiDay, 'unknownGapSuppressedBySameAbsentActivity')}`,
    `  unknownGapEmittedByMapper: ${summarizeFlag(multiDay, 'unknownGapEmittedByMapper')}`,
  ]

  if (highlights.length > 0) {
    lines.push('', '=== Zvýraznění: zdrojové dny 2024-10-28 .. 2024-12-28 ===')
    for (const gap of highlights) {
      lines.push('', ...formatGapLines(gap, 'highlight 2024-10-28/2024-12-28'))
    }
  } else {
    lines.push(
      '',
      '=== Zvýraznění: zdrojové dny 2024-10-28 .. 2024-12-28 ===',
      'Na kartě tato dvojice sousedních zdrojových dnů nebyla nalezena.',
    )
  }

  if (multiDay.length === 0) {
    lines.push('', 'Mezery delší než 1 den: žádné')
    return lines.join('\n')
  }

  lines.push('', '=== Mezery delší než 1 kalendářní den (plná pole) ===')
  multiDay.forEach((gap, index) => {
    lines.push('', ...formatGapLines(gap, `gap #${index + 1}`))
  })

  lines.push('', `Interval mezery: [startUtc, endUtc) s krokem ${DAY_MS / 60_000 / 60}h UTC`)

  return lines.join('\n')
}
