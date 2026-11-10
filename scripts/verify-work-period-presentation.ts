import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWorkPeriodOverview } from '../src/presentation/workPeriodOverview.ts'
import type { DriverCardData } from '../src/types/tacho.ts'
import type { DailyRecordCoverageGap } from '../src/types/coverage.ts'

const DAY = 24 * 60 * 60_000
const H = 60 * 60 * 1000
const H11 = 11 * H

function minimalCard(overrides: Partial<DriverCardData> = {}): DriverCardData {
  return {
    cardNumber: 'WP',
    firstName: 'A',
    surname: 'B',
    lastWithdrawalUtc: null,
    activities: [],
    locations: [],
    violations: [],
    ...overrides,
  }
}

test('bez práce — prázdný přehled', () => {
  const overview = buildWorkPeriodOverview(minimalCard())
  assert.equal(overview.periods.length, 0)
})

test('jedno období bez candidate cut', () => {
  const start = 1_000
  const end = 50_000
  const overview = buildWorkPeriodOverview(
    minimalCard({
      activities: [
        { id: 'd1', kind: 'driving', startUtc: start, endUtc: end, durationMinutes: 800, slot: 1 },
      ],
    }),
  )
  assert.equal(overview.periods.length, 1)
  assert.equal(overview.periods[0]!.startBoundaryReliability, 'open')
  assert.equal(overview.periods[0]!.endBoundaryReliability, 'open')
  const overlapMinutes = Math.round((end - start) / 60_000)
  assert.equal(overview.periods[0]!.summary.drivingMinutes, overlapMinutes)
})

test('dva segmenty oddělené 11 h odpočinkem', () => {
  const corridorStart = 10_000
  const corridorEnd = corridorStart + H11
  const card = minimalCard({
    activities: [
      { id: 'w1', kind: 'driving', startUtc: 0, endUtc: corridorStart, durationMinutes: 100, slot: 1 },
      { id: 'r0', kind: 'rest', startUtc: corridorStart, endUtc: corridorEnd, durationMinutes: 660, slot: 1 },
      { id: 'w2', kind: 'driving', startUtc: corridorEnd, endUtc: corridorEnd + 30_000, durationMinutes: 100, slot: 1 },
    ],
  })
  const overview = buildWorkPeriodOverview(card)
  assert.equal(overview.periods.length, 2)
  const first = overview.periods[0]!
  assert.equal(first.endUtc, corridorStart)
  assert.equal(first.endBoundaryReliability, 'confirmed')
  assert.ok(first.separatingRest != null)
})

test('coverage mezera v období', () => {
  const gap: DailyRecordCoverageGap = {
    id: 'cov-0',
    startUtc: 15_000,
    endUtc: 15_000 + 2 * DAY,
    currentDayStart: 14_000,
    nextLaterDayStart: 15_000 + 2 * DAY,
    calendarDaysBetween: 2,
    dailyRecordsStrictlyBetween: 0,
    startAnchorSourceActivityId: null,
    endAnchorSourceActivityId: null,
    overlappedActivityIds: null,
    spansUnrecordedDays: null,
    sameAbsentActivityAtAnchors: null,
    unknownGapGeometryEligible: null,
    unknownGapSuppressedBySameAbsentActivity: null,
    unknownGapEmittedByMapper: null,
  }
  const overview = buildWorkPeriodOverview(
    minimalCard({
      activities: [
        { id: 'w1', kind: 'driving', startUtc: 10_000, endUtc: 20_000, durationMinutes: 10, slot: 1 },
      ],
      dailyRecordCoverageGaps: [gap],
    }),
  )
  assert.equal(overview.periods.length, 1)
  assert.equal(overview.periods[0]!.overlappingCoverageGaps.length, 1)
})

test('aktivity v rozbalení odpovídají překryvu', () => {
  const overview = buildWorkPeriodOverview(
    minimalCard({
      activities: [
        { id: 'a', kind: 'work', startUtc: 0, endUtc: 5_000, durationMinutes: 80, slot: 1 },
        { id: 'b', kind: 'driving', startUtc: 3_000, endUtc: 8_000, durationMinutes: 80, slot: 1 },
      ],
    }),
  )
  const period = overview.periods[0]!
  assert.ok(period.activities.some((row) => row.id === 'a'))
  assert.ok(period.activities.some((row) => row.id === 'b'))
})
