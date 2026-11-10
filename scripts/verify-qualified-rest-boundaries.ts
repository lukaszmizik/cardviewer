import assert from 'node:assert/strict'
import test from 'node:test'
import { findQualifiedRestBoundaries } from '../src/presentation/qualifiedRestBoundaries.ts'
import { buildWorkPeriodOverview } from '../src/presentation/workPeriodOverview.ts'
import type { DriverCardData } from '../src/types/tacho.ts'
import type { DailyRecordCoverageGap } from '../src/types/coverage.ts'

const H = 60 * 60 * 1000
const H8 = 8 * H
const H9 = 9 * H
const H11 = 11 * H
const DAY = 24 * H

function card(activities: DriverCardData['activities'], extra: Partial<DriverCardData> = {}): DriverCardData {
  return {
    cardNumber: 'T',
    firstName: 'A',
    surname: 'B',
    lastWithdrawalUtc: null,
    activities,
    locations: [],
    violations: [],
    ...extra,
  }
}

function boundaries(activities: DriverCardData['activities'], extra: Partial<DriverCardData> = {}) {
  return findQualifiedRestBoundaries({
    activities,
    dailyRecordCoverageGaps: extra.dailyRecordCoverageGaps,
    cardPresentEdges: extra.cardPresentEdges,
  })
}

test('11 h REST — karta vložená (card_present doplněk)', () => {
  const w0 = 0
  const r0 = 10_000
  const r1 = r0 + H11
  const w1 = r1
  const w2 = w1 + 20_000
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: w0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 660, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: w1, endUtc: w2, durationMinutes: 1, slot: 1 },
  ], {
    cardPresentEdges: [
      { atUtc: r0, present: false, slot: 1 },
      { atUtc: r1, present: true, slot: 1 },
    ],
  })
  assert.equal(list.length, 1)
  assert.equal(list[0]!.durationMs, H11)
  assert.equal(list[0]!.cardPresentSupport, 'two_sided')
  const overview = buildWorkPeriodOverview(
    card([
      { id: 'd1', kind: 'driving', startUtc: w0, endUtc: r0, durationMinutes: 1, slot: 1 },
      { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 660, slot: 1 },
      { id: 'd2', kind: 'driving', startUtc: w1, endUtc: w2, durationMinutes: 1, slot: 1 },
    ], {
      cardPresentEdges: [
        { atUtc: r0, present: false, slot: 1 },
        { atUtc: r1, present: true, slot: 1 },
      ],
    }),
  )
  assert.equal(overview.periods.length, 2)
  assert.equal(overview.periods[0]!.endBoundaryReliability, 'confirmed')
})

test('11 h REST — karta vyjmutá, záznam REST zůstal', () => {
  const r0 = 50_000
  const r1 = r0 + H11
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 660, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 5_000, durationMinutes: 1, slot: 1 },
  ], {
    cardPresentEdges: [{ atUtc: r0, present: false, slot: 1 }],
  })
  assert.equal(list.length, 1)
  assert.equal(list[0]!.evidenceBasis, 'activity_recorded')
})

test('9 h REST — kvalifikovaná hranice', () => {
  const r0 = 1_000
  const r1 = r0 + H9
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 540, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
  ])
  assert.equal(list.length, 1)
  assert.ok(list[0]!.kinds.includes('daily_reduced'))
})

test('8 h REST — automaticky nekvalifikovaný', () => {
  const r0 = 1_000
  const r1 = r0 + H8
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 480, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
  ])
  assert.equal(list.length, 0)
})

test('navazující REST přes půlnoc — sloučení stejného slotu', () => {
  const r0 = DAY - 2 * H
  const r1 = DAY + H11 - (DAY - r0)
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r1', kind: 'rest', startUtc: r0, endUtc: DAY, durationMinutes: 120, slot: 1 },
    { id: 'r2', kind: 'rest', startUtc: DAY, endUtc: r1, durationMinutes: 540, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
  ])
  assert.equal(list.length, 1)
  assert.equal(list[0]!.durationMs, H11)
})

test('REST s přechodem slotu 2 → 1 — předběžná hranice', () => {
  const r0 = 100_000
  const bridge = r0 + 2 * H
  const r1 = bridge + H11
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r2', kind: 'rest', startUtc: r0, endUtc: bridge, durationMinutes: 120, slot: 2 },
    { id: 'r1', kind: 'rest', startUtc: bridge, endUtc: r1, durationMinutes: 660, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
  ])
  assert.equal(list.length, 1)
  assert.ok(list[0]!.preliminaryNotes.some((n) => n.includes('jiném slotu')))
  const overview = buildWorkPeriodOverview(
    card([
      { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
      { id: 'r2', kind: 'rest', startUtc: r0, endUtc: bridge, durationMinutes: 120, slot: 2 },
      { id: 'r1', kind: 'rest', startUtc: bridge, endUtc: r1, durationMinutes: 660, slot: 1 },
      { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
    ]),
  )
  assert.equal(overview.periods[0]!.endBoundaryReliability, 'preliminary')
})

test('REST přes DailyRecordCoverageGap — nepoužije confirmed', () => {
  const r0 = 200_000
  const r1 = r0 + H11
  const gap: DailyRecordCoverageGap = {
    id: 'g1',
    startUtc: r0 + 2 * H,
    endUtc: r0 + 5 * H,
    currentDayStart: r0,
    nextLaterDayStart: r0 + 5 * H,
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
    card(
      [
        { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
        { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 660, slot: 1 },
        { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
      ],
      { dailyRecordCoverageGaps: [gap] },
    ),
  )
  assert.equal(overview.periods[0]!.endBoundaryReliability, 'preliminary')
  const b = boundaries(
    [
      { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
      { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 660, slot: 1 },
      { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
    ],
    { dailyRecordCoverageGaps: [gap] },
  )
  assert.equal(b[0]!.evidenceBasis, 'coverage_gap')
})

test('dělený 3+9 s řízením mezi částmi', () => {
  const t6 = 6 * H
  const t9 = 9 * H
  const t15 = 15 * H
  const t24 = 24 * H
  const acts = [
    { id: 'd0', kind: 'driving' as const, startUtc: 0, endUtc: t6, durationMinutes: 360, slot: 1 as const },
    { id: 'r3', kind: 'rest' as const, startUtc: t6, endUtc: t9, durationMinutes: 180, slot: 1 as const },
    { id: 'd1', kind: 'driving' as const, startUtc: t9, endUtc: t15, durationMinutes: 360, slot: 1 as const },
    { id: 'r9', kind: 'rest' as const, startUtc: t15, endUtc: t24, durationMinutes: 540, slot: 1 as const },
    { id: 'd2', kind: 'driving' as const, startUtc: t24, endUtc: t24 + H, durationMinutes: 60, slot: 1 as const },
  ]
  const list = boundaries(acts)
  const boundary = list.find((item) => item.workPeriodEndUtc === t15)
  assert.ok(boundary != null)
  assert.equal(boundary.variant, 'continuous_reduced')
  assert.equal(boundary.restStartUtc, t15)
  assert.equal(boundary.restEndUtc, t24)
  const split = boundary.interpretations.find((item) => item.variant === 'split_regular')
  assert.ok(split != null)
  assert.equal(split.parts.length, 2)
  assert.equal(split.parts[0]!.startUtc, t6)
  assert.equal(split.parts[1]!.startUtc, t15)
  assert.notEqual(split.durationMs, t24 - t6)
  const overview = buildWorkPeriodOverview(card(acts))
  assert.equal(overview.periods.length, 2)
  assert.equal(overview.periods[0]!.endUtc, t15)
  assert.equal(overview.periods[0]!.separatingRest?.variant, 'continuous_reduced')
  assert.equal(overview.periods[0]!.separatingRest?.startUtc, t15)
  assert.ok(overview.periods[0]!.separatingRest?.alternatives.some((item) => item.variant === 'split_regular'))
})

test('dělený 3+9 s prací mezi částmi', () => {
  const t6 = 6 * H
  const t9 = 9 * H
  const t15 = 15 * H
  const t24 = 24 * H
  const list = boundaries([
    { id: 'w0', kind: 'work', startUtc: 0, endUtc: t6, durationMinutes: 360, slot: 1 },
    { id: 'r3', kind: 'rest', startUtc: t6, endUtc: t9, durationMinutes: 180, slot: 1 },
    { id: 'w1', kind: 'work', startUtc: t9, endUtc: t15, durationMinutes: 360, slot: 1 },
    { id: 'r9', kind: 'rest', startUtc: t15, endUtc: t24, durationMinutes: 540, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: t24, endUtc: t24 + H, durationMinutes: 60, slot: 1 },
  ])
  const boundary = list.find((item) => item.workPeriodEndUtc === t15)
  assert.equal(boundary?.variant, 'continuous_reduced')
  assert.ok(boundary?.interpretations.some((item) => item.variant === 'split_regular'))
})

test('dělený 3+9 s pohotovostí mezi částmi', () => {
  const t6 = 6 * H
  const t9 = 9 * H
  const t15 = 15 * H
  const t24 = 24 * H
  const list = boundaries([
    { id: 'd0', kind: 'driving', startUtc: 0, endUtc: t6, durationMinutes: 360, slot: 1 },
    { id: 'r3', kind: 'rest', startUtc: t6, endUtc: t9, durationMinutes: 180, slot: 1 },
    { id: 'a1', kind: 'availability', startUtc: t9, endUtc: t15, durationMinutes: 360, slot: 1 },
    { id: 'r9', kind: 'rest', startUtc: t15, endUtc: t24, durationMinutes: 540, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: t24, endUtc: t24 + H, durationMinutes: 60, slot: 1 },
  ])
  const boundary = list.find((item) => item.workPeriodEndUtc === t15)
  assert.equal(boundary?.variant, 'continuous_reduced')
  assert.ok(boundary?.interpretations.some((item) => item.variant === 'split_regular'))
})

test('neplatné pořadí 9+3 — bez split_regular', () => {
  const list = boundaries([
    { id: 'd0', kind: 'driving', startUtc: 0, endUtc: 8 * H, durationMinutes: 480, slot: 1 },
    { id: 'r9', kind: 'rest', startUtc: 8 * H, endUtc: 17 * H, durationMinutes: 540, slot: 1 },
    { id: 'd1', kind: 'driving', startUtc: 17 * H, endUtc: 20 * H, durationMinutes: 180, slot: 1 },
    { id: 'r3', kind: 'rest', startUtc: 20 * H, endUtc: 23 * H, durationMinutes: 180, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: 23 * H, endUtc: 30 * H, durationMinutes: 420, slot: 1 },
  ])
  assert.equal(list.some((item) => item.variant === 'split_regular'), false)
})

test('2:59 + 9 — bez split_regular', () => {
  const list = boundaries([
    { id: 'd0', kind: 'driving', startUtc: 0, endUtc: 6 * H, durationMinutes: 360, slot: 1 },
    { id: 'r', kind: 'rest', startUtc: 6 * H, endUtc: 6 * H + 179 * 60_000, durationMinutes: 179, slot: 1 },
    { id: 'd1', kind: 'driving', startUtc: 6 * H + 179 * 60_000, endUtc: 14 * H, durationMinutes: 300, slot: 1 },
    { id: 'r9', kind: 'rest', startUtc: 14 * H, endUtc: 23 * H, durationMinutes: 540, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: 23 * H, endUtc: 30 * H, durationMinutes: 420, slot: 1 },
  ])
  assert.equal(list.some((item) => item.variant === 'split_regular'), false)
})

test('3 + 8:59 — bez split_regular', () => {
  const list = boundaries([
    { id: 'd0', kind: 'driving', startUtc: 0, endUtc: 6 * H, durationMinutes: 360, slot: 1 },
    { id: 'r3', kind: 'rest', startUtc: 6 * H, endUtc: 9 * H, durationMinutes: 180, slot: 1 },
    { id: 'd1', kind: 'driving', startUtc: 9 * H, endUtc: 14 * H, durationMinutes: 300, slot: 1 },
    { id: 'r', kind: 'rest', startUtc: 14 * H, endUtc: 14 * H + 8 * H + 59 * 60_000, durationMinutes: 539, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: 14 * H + 8 * H + 59 * 60_000, endUtc: 30 * H, durationMinutes: 420, slot: 1 },
  ])
  assert.equal(list.some((item) => item.variant === 'split_regular'), false)
})

test('souvislý 13:38 má přednost, split_regular je alternativa', () => {
  const restStart = Date.parse('2024-10-25T18:02:00Z')
  const restEnd = Date.parse('2024-10-26T07:40:00Z')
  const firstStart = Date.parse('2024-10-25T10:28:00Z')
  const firstEnd = Date.parse('2024-10-25T13:28:00Z')
  const after = restEnd + H
  const acts = [
    { id: 'd0', kind: 'driving' as const, startUtc: firstStart - 2 * H, endUtc: firstStart, durationMinutes: 120, slot: 2 as const },
    { id: 'r3', kind: 'rest' as const, startUtc: firstStart, endUtc: firstEnd, durationMinutes: 180, slot: 2 as const },
    { id: 'a1', kind: 'availability' as const, startUtc: firstEnd, endUtc: restStart, durationMinutes: 274, slot: 2 as const },
    { id: 'r9', kind: 'rest' as const, startUtc: restStart, endUtc: restEnd, durationMinutes: 818, slot: 2 as const },
    { id: 'd2', kind: 'driving' as const, startUtc: restEnd, endUtc: after, durationMinutes: 60, slot: 2 as const },
  ]
  const list = boundaries(acts)
  const boundary = list.find((item) => item.workPeriodEndUtc === restStart)
  assert.ok(boundary != null)
  assert.equal(boundary.variant, 'continuous_regular')
  assert.equal(boundary.restStartUtc, restStart)
  assert.equal(boundary.restEndUtc, restEnd)
  assert.equal(boundary.durationMs, 13 * H + 38 * 60_000)
  assert.equal(boundary.parts.length, 1)
  const split = boundary.interpretations.find((item) => item.variant === 'split_regular')
  assert.ok(split != null)
  assert.deepEqual(split.parts.map((part) => [part.startUtc, part.endUtc]), [
    [firstStart, firstEnd],
    [restStart, restEnd],
  ])
  assert.notEqual(split.durationMs, restEnd - firstStart)
  const overview = buildWorkPeriodOverview(card(acts))
  const separating = overview.periods[0]!.separatingRest
  assert.equal(separating?.variant, 'continuous_regular')
  assert.equal(separating?.startUtc, restStart)
  assert.equal(separating?.endUtc, restEnd)
  assert.equal(separating?.parts.length, 1)
  const alternative = separating?.alternatives.find((item) => item.variant === 'split_regular')
  assert.equal(alternative?.parts.length, 2)
  assert.equal(overview.periods[0]!.endBoundaryReliability, 'confirmed')
})

test('jen split_regular, bez souvislé alternativy', () => {
  const t6 = 6 * H
  const t9 = 9 * H
  const t15 = 15 * H
  const t24 = 24 * H
  const list = boundaries([
    { id: 'd0', kind: 'driving', startUtc: 0, endUtc: t6, durationMinutes: 360, slot: 1 },
    { id: 'r3', kind: 'rest', startUtc: t6, endUtc: t9, durationMinutes: 180, slot: 1 },
    { id: 'd1', kind: 'driving', startUtc: t9, endUtc: t15, durationMinutes: 360, slot: 1 },
    { id: 'r9', kind: 'rest', startUtc: t15, endUtc: t24, durationMinutes: 540, slot: 1 },
    { id: 'overlap', kind: 'rest', startUtc: t15 + H, endUtc: t15 + 2 * H, durationMinutes: 60, slot: 2 },
    { id: 'd2', kind: 'driving', startUtc: t24, endUtc: t24 + H, durationMinutes: 60, slot: 1 },
  ])
  const boundary = list.find((item) => item.workPeriodEndUtc === t15)
  assert.ok(boundary != null)
  assert.equal(boundary.variant, 'split_regular')
  assert.equal(boundary.interpretations.some((item) => item.variant === 'continuous_regular' || item.variant === 'continuous_reduced'), false)
  assert.equal(boundary.parts.length, 2)
  assert.equal(boundary.restStartUtc, t15)
  assert.equal(boundary.restEndUtc, t24)
  assert.equal(boundary.durationMs, 3 * H + 9 * H)
  const overview = buildWorkPeriodOverview(card([
    { id: 'd0', kind: 'driving', startUtc: 0, endUtc: t6, durationMinutes: 360, slot: 1 },
    { id: 'r3', kind: 'rest', startUtc: t6, endUtc: t9, durationMinutes: 180, slot: 1 },
    { id: 'd1', kind: 'driving', startUtc: t9, endUtc: t15, durationMinutes: 360, slot: 1 },
    { id: 'r9', kind: 'rest', startUtc: t15, endUtc: t24, durationMinutes: 540, slot: 1 },
    { id: 'overlap', kind: 'rest', startUtc: t15 + H, endUtc: t15 + 2 * H, durationMinutes: 60, slot: 2 },
    { id: 'd2', kind: 'driving', startUtc: t24, endUtc: t24 + H, durationMinutes: 60, slot: 1 },
  ]))
  const separating = overview.periods[0]!.separatingRest
  assert.equal(separating?.variant, 'split_regular')
  assert.equal(separating?.parts.length, 2)
  assert.equal(separating?.alternatives.length, 0)
  assert.equal(separating?.parts[0]!.endUtc, t9)
  assert.equal(separating?.parts[1]!.startUtc, t15)
})

test('REST přerušený řízením — žádná hranice', () => {
  const r0 = 300_000
  const r1 = r0 + H11
  const list = boundaries([
    { id: 'd1', kind: 'driving', startUtc: 0, endUtc: r0, durationMinutes: 1, slot: 1 },
    { id: 'r1', kind: 'rest', startUtc: r0, endUtc: r1, durationMinutes: 660, slot: 1 },
    { id: 'x', kind: 'driving', startUtc: r0 + 4 * H, endUtc: r0 + 4 * H + 3_600_000, durationMinutes: 60, slot: 1 },
    { id: 'd2', kind: 'driving', startUtc: r1, endUtc: r1 + 1_000, durationMinutes: 1, slot: 1 },
  ])
  assert.equal(list.length, 0)
})
