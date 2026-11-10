import type { DailyRecordCoverageGap } from '../types/coverage.ts'
import type { DddParserCardJson } from '../utils/dddMapper.ts'
import {
  collectCoverageAnchorChanges,
  mapActivitiesFromDdd,
  mapperUnknownGapFlags,
  mergedActivityDayStarts,
  unwrapParserCardForCoverage,
} from '../utils/dddMapper.ts'

const DAY_MS = 24 * 60 * 60_000

function changeTime(dayStart: number, minutes: number): number {
  return dayStart + minutes * 60_000
}

function overlapActivityIds(
  activities: readonly { id: string; startUtc: number; endUtc: number }[],
  gapStart: number,
  gapEnd: number,
): string[] {
  const hits: string[] = []
  for (const activity of activities) {
    if (activity.startUtc < gapEnd && activity.endUtc > gapStart) hits.push(activity.id)
  }
  return hits
}

function pickStartAnchor<T extends { dayStart: number; minutes: number; index: number }>(
  changes: readonly T[],
  currentDayStart: number,
): T | null {
  const onDay = changes.filter((item) => item.dayStart === currentDayStart)
  if (onDay.length === 0) return null
  return onDay.reduce((best, item) =>
    changeTime(item.dayStart, item.minutes) > changeTime(best.dayStart, best.minutes) ? item : best,
  )
}

function pickEndAnchor<T extends { dayStart: number; minutes: number; index: number }>(
  changes: readonly T[],
  nextDayStart: number,
): T | null {
  const onDay = changes.filter((item) => item.dayStart === nextDayStart)
  if (onDay.length === 0) return null
  return onDay.reduce((best, item) =>
    changeTime(item.dayStart, item.minutes) < changeTime(best.dayStart, best.minutes) ? item : best,
  )
}

function laterChangeIndex<T extends { dayStart: number; minutes: number; index: number }>(
  collected: readonly T[],
  fromIndex: number,
): number | null {
  const startUtc = changeTime(collected[fromIndex]!.dayStart, collected[fromIndex]!.minutes)
  for (let cursor = fromIndex + 1; cursor < collected.length; cursor += 1) {
    const candidate = collected[cursor]!
    if (changeTime(candidate.dayStart, candidate.minutes) > startUtc) return candidate.index
  }
  return null
}

/**
 * Odvozuje kalendářní mezery mezi sousedními dny z mergeActivityDays (stejně jako mapper).
 * Nemění Activity[], Holder timeline ani pravidla mapování.
 */
export function deriveDailyRecordCoverageGaps(card: DddParserCardJson): DailyRecordCoverageGap[] {
  const dayStarts = mergedActivityDayStarts(card)
  if (dayStarts.length < 2) return []

  const collected = collectCoverageAnchorChanges(card)
  const activities = mapActivitiesFromDdd(card)
  const gaps: DailyRecordCoverageGap[] = []

  for (let pairIndex = 0; pairIndex < dayStarts.length - 1; pairIndex += 1) {
    const currentDayStart = dayStarts[pairIndex]!
    const nextLaterDayStart = dayStarts[pairIndex + 1]!
    const startUtc = currentDayStart + DAY_MS
    const endUtc = nextLaterDayStart
    if (endUtc <= startUtc) continue

    const calendarDaysBetween = Math.round((endUtc - startUtc) / DAY_MS)
    const startAnchor = pickStartAnchor(collected, currentDayStart)
    const endAnchor = pickEndAnchor(collected, nextLaterDayStart)

    let startAnchorSourceActivityId: string | null = null
    let endAnchorSourceActivityId: string | null = null
    let spansUnrecordedDays: boolean | null = null
    let sameAbsentActivityAtAnchors: boolean | null = null
    let unknownGapGeometryEligible: boolean | null = null
    let unknownGapSuppressedBySameAbsentActivity: boolean | null = null
    let unknownGapEmittedByMapper: boolean | null = null

    if (startAnchor != null) startAnchorSourceActivityId = `act-${startAnchor.index}`
    if (endAnchor != null) endAnchorSourceActivityId = `act-${endAnchor.index}`

    if (startAnchor != null && endAnchor != null) {
      const laterIndex = laterChangeIndex(collected, startAnchor.index)
      if (laterIndex === endAnchor.index) {
        const startItem = collected[startAnchor.index]!
        const endItem = collected[endAnchor.index]!
        const flags = mapperUnknownGapFlags(startItem, endItem)
        spansUnrecordedDays = flags.spansUnrecordedDays
        sameAbsentActivityAtAnchors = flags.sameAbsentActivityAtAnchors
        unknownGapGeometryEligible = flags.unknownGapGeometryEligible
        unknownGapSuppressedBySameAbsentActivity = flags.unknownGapSuppressedBySameAbsentActivity
        unknownGapEmittedByMapper = flags.unknownGapEmittedByMapper
      }
    }

    const overlapped = overlapActivityIds(activities, startUtc, endUtc)

    gaps.push({
      id: `cov-${pairIndex}`,
      startUtc,
      endUtc,
      currentDayStart,
      nextLaterDayStart,
      calendarDaysBetween,
      dailyRecordsStrictlyBetween: 0,
      startAnchorSourceActivityId,
      endAnchorSourceActivityId,
      overlappedActivityIds: overlapped.length > 0 ? overlapped : null,
      spansUnrecordedDays,
      sameAbsentActivityAtAnchors,
      unknownGapGeometryEligible,
      unknownGapSuppressedBySameAbsentActivity,
      unknownGapEmittedByMapper,
    })
  }

  return gaps
}

export function deriveDailyRecordCoverageGapsFromParserJson(parserJson: unknown): DailyRecordCoverageGap[] {
  const card = unwrapParserCardForCoverage(parserJson)
  if (!card) return []
  return deriveDailyRecordCoverageGaps(card)
}
