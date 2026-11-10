import assert from 'node:assert/strict'
import test from 'node:test'
import type { DailyRecordCoverageGap } from '../src/types/coverage.ts'
import type { DriverCardData } from '../src/types/tacho.ts'
import {
  cutCorridorId,
  diagnoseWorkPeriodCoverageOverlap,
  halfOpenOverlaps,
} from '../src/dev/workPeriodCoverageOverlapDiagnostics.ts'

const DAY = 24 * 60 * 60_000

function minimalCard(overrides: Partial<DriverCardData> = {}): DriverCardData {
  return {
    cardNumber: 'WPC',
    firstName: 'A',
    surname: 'B',
    lastWithdrawalUtc: null,
    activities: [],
    locations: [],
    violations: [],
    ...overrides,
  }
}

function gap(id: string, startUtc: number, endUtc: number, extra: Partial<DailyRecordCoverageGap> = {}): DailyRecordCoverageGap {
  return {
    id,
    startUtc,
    endUtc,
    currentDayStart: startUtc - DAY,
    nextLaterDayStart: endUtc,
    calendarDaysBetween: Math.round((endUtc - startUtc) / DAY),
    dailyRecordsStrictlyBetween: 0,
    startAnchorSourceActivityId: null,
    endAnchorSourceActivityId: null,
    overlappedActivityIds: null,
    spansUnrecordedDays: null,
    sameAbsentActivityAtAnchors: null,
    unknownGapGeometryEligible: null,
    unknownGapSuppressedBySameAbsentActivity: extra.unknownGapSuppressedBySameAbsentActivity ?? null,
    unknownGapEmittedByMapper: extra.unknownGapEmittedByMapper ?? null,
  }
}

test('halfOpenOverlaps — překryv uvnitř', () => {
  assert.equal(halfOpenOverlaps(0, 100, 50, 150), true)
})

test('halfOpenOverlaps — dotyk hranic bez překryvu', () => {
  assert.equal(halfOpenOverlaps(0, 100, 100, 200), false)
  assert.equal(halfOpenOverlaps(100, 200, 0, 100), false)
})

test('více coverage gaps v jednom koridoru', () => {
  const gaps = [
    gap('cov-0', 110, 120),
    gap('cov-1', 130, 140),
  ]
  const overlaps = gaps.filter((item) => halfOpenOverlaps(100, 150, item.startUtc, item.endUtc))
  assert.equal(overlaps.length, 2)
})

test('prázdné coverage pole ≠ undefined', () => {
  const card = minimalCard({ dailyRecordCoverageGaps: [] })
  const report = diagnoseWorkPeriodCoverageOverlap(card)
  assert.equal(report.coverageAvailable, true)
  assert.equal(report.summaryByState.coverage_unavailable, 0)
})

test('undefined coverage — stav coverage_unavailable', () => {
  const card = minimalCard({ dailyRecordCoverageGaps: undefined })
  const report = diagnoseWorkPeriodCoverageOverlap(card)
  assert.equal(report.coverageAvailable, false)
  assert.equal(report.candidateCutCount, 0)
})

test('cutId je deterministické', () => {
  assert.equal(cutCorridorId(100, 200), 'cut-100|200')
})

test('diagnostika s překryvem — mock přes přímé koridory v report builderu', () => {
  const corridorStart = 1_000
  const corridorEnd = 5_000
  const coverageGap = gap('cov-x', 2_000, 3_000, {
    unknownGapSuppressedBySameAbsentActivity: true,
    unknownGapEmittedByMapper: false,
  })
  assert.ok(halfOpenOverlaps(corridorStart, corridorEnd, coverageGap.startUtc, coverageGap.endUtc))
  const card = minimalCard({
    dailyRecordCoverageGaps: [coverageGap],
    activities: [
      {
        id: 'w1',
        kind: 'driving',
        startUtc: 0,
        endUtc: corridorStart,
        durationMinutes: 0,
        slot: 1,
      },
      {
        id: 'r0',
        kind: 'rest',
        startUtc: corridorStart,
        endUtc: corridorEnd,
        durationMinutes: 0,
        slot: 1,
      },
      {
        id: 'w2',
        kind: 'driving',
        startUtc: corridorEnd,
        endUtc: corridorEnd + 1_000,
        durationMinutes: 0,
        slot: 1,
      },
    ],
    cardPresentEdges: [
      { atUtc: corridorStart, present: false, slot: 1 },
      { atUtc: corridorEnd, present: true, slot: 1 },
    ],
  })

  const report = diagnoseWorkPeriodCoverageOverlap(card)
  assert.ok(report.candidateCutCount >= 1)
  const hit = report.rows.find((row) => row.coverageOverlapState === 'coverage_available_with_overlap')
  assert.ok(hit)
  assert.equal(hit.overlappingGapCount, 1)
  assert.equal(hit.mapperCorridorHint, 'bridged_absent_rest')
})

test('diagnostika bez překryvu', () => {
  const corridorStart = 10_000
  const corridorEnd = 20_000
  const card = minimalCard({
    dailyRecordCoverageGaps: [gap('cov-far', 30_000, 40_000)],
    activities: [
      {
        id: 'w1',
        kind: 'driving',
        startUtc: 0,
        endUtc: corridorStart,
        durationMinutes: 0,
        slot: 1,
      },
      {
        id: 'r0',
        kind: 'rest',
        startUtc: corridorStart,
        endUtc: corridorEnd,
        durationMinutes: 0,
        slot: 1,
      },
      {
        id: 'w2',
        kind: 'driving',
        startUtc: corridorEnd,
        endUtc: corridorEnd + 1_000,
        durationMinutes: 0,
        slot: 1,
      },
    ],
    cardPresentEdges: [
      { atUtc: corridorStart, present: false, slot: 1 },
      { atUtc: corridorEnd, present: true, slot: 1 },
    ],
  })
  const report = diagnoseWorkPeriodCoverageOverlap(card)
  const hit = report.rows.find((row) => row.previousWorkEndUtc === corridorStart)
  assert.ok(hit)
  assert.equal(hit.coverageOverlapState, 'coverage_available_no_overlap')
})
