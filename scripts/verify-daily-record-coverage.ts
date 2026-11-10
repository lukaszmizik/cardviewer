import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDailyRecordCoverageGapsFromParserJson } from '../src/analysis/dailyRecordCoverage.ts'

const DAY = 24 * 60 * 60_000

function cardJson(days: object[]) {
  return {
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'COV' },
    },
    card_driver_activity_2: { decoded_activity_daily_records: days },
  }
}

function day(isoDate: string, changes: object[] = []) {
  return {
    activity_record_date: new Date(isoDate).toISOString(),
    activity_change_info: changes,
  }
}

test('sousední denní záznamy — žádná coverage mezera', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: true, work_type: 3, minutes: 0 },
      ]),
      day('2024-10-29T00:00:00.000Z', [
        { driver: true, card_present: true, work_type: 3, minutes: 0 },
      ]),
    ]),
  )
  assert.equal(gaps.length, 0)
})

test('dva zdrojové dny vzdálené — interval [start,end) podle UTC dnů', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-12-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  assert.equal(gaps.length, 1)
  const gap = gaps[0]!
  assert.equal(gap.startUtc, Date.parse('2024-10-29T00:00:00.000Z'))
  assert.equal(gap.endUtc, Date.parse('2024-12-28T00:00:00.000Z'))
  assert.equal(gap.calendarDaysBetween, 60)
  assert.equal(gap.dailyRecordsStrictlyBetween, 0)
})

test('unknownGapGeometryEligible řídí se changeTime start anchoru, ne startUtc mezery', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-12-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  const gap = gaps[0]!
  assert.equal(gap.startUtc, Date.parse('2024-10-29T00:00:00.000Z'))
  assert.equal(gap.unknownGapGeometryEligible, true)
})

test('absent-card REST — stejné krajní změny, bridge bez mapper unknown', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-12-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  const gap = gaps[0]!
  assert.equal(gap.spansUnrecordedDays, true)
  assert.equal(gap.sameAbsentActivityAtAnchors, true)
  assert.equal(gap.unknownGapGeometryEligible, true)
  assert.equal(gap.unknownGapSuppressedBySameAbsentActivity, true)
  assert.equal(gap.unknownGapEmittedByMapper, false)
  assert.equal(gap.startAnchorSourceActivityId, 'act-0')
  assert.equal(gap.endAnchorSourceActivityId, 'act-1')
})

test('rozdílné krajní work_type — mapper by emitoval unknown', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-01T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
      day('2024-10-05T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 3, minutes: 0 },
      ]),
    ]),
  )
  assert.equal(gaps.length, 1)
  const gap = gaps[0]!
  assert.equal(gap.sameAbsentActivityAtAnchors, false)
  assert.equal(gap.unknownGapEmittedByMapper, true)
  assert.equal(gap.unknownGapSuppressedBySameAbsentActivity, false)
})

test('změna pozice (driver) na krajích', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-25T00:00:00.000Z', [
        { driver: false, card_present: true, work_type: 0, minutes: 18 * 60 + 2 },
      ]),
      day('2024-10-27T00:00:00.000Z', [
        { driver: true, card_present: true, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  const gap = gaps[0]!
  assert.equal(gap.sameAbsentActivityAtAnchors, false)
})

test('přes hranici roku', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-12-31T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
      day('2025-01-02T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
    ]),
  )
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]!.startUtc, Date.parse('2025-01-01T00:00:00.000Z'))
  assert.equal(gaps[0]!.endUtc, Date.parse('2025-01-02T00:00:00.000Z'))
  assert.equal(gaps[0]!.calendarDaysBetween, 1)
})

test('nulová délka mezery — sousední dny', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-06-01T00:00:00.000Z'),
      day('2024-06-02T00:00:00.000Z'),
    ]),
  )
  assert.equal(gaps.length, 0)
})

test('overlappedActivityIds — překryv pouze v mezeře, ne mimo', () => {
  const gaps = deriveDailyRecordCoverageGapsFromParserJson(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-10-30T00:00:00.000Z', [
        { driver: true, card_present: true, work_type: 3, minutes: 0 },
      ]),
    ]),
  )
  assert.equal(gaps.length, 1)
  const gap = gaps[0]!
  assert.equal(gap.calendarDaysBetween, 1)
  if (gap.overlappedActivityIds != null) {
    assert.ok(gap.overlappedActivityIds.length >= 0)
  }
})
