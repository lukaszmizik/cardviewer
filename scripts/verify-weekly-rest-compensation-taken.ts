import assert from 'node:assert/strict'
import test from 'node:test'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'
import type { CompensationAllocation, ObligationFulfillment } from '../src/analysis/weeklyRestCompensationTaken.ts'
import { assessWeeklyRestCompensationTaken } from '../src/analysis/weeklyRestCompensationTaken.ts'
import { classifyWeeklyRestCandidates } from '../src/analysis/weeklyRest.ts'

const HOUR = 60 * 60 * 1000
const RECORD_END = Date.parse('2026-06-01T00:00:00.000Z')

function candidate(startUtc: number, endUtc: number, sourceActivityIds: string[], overrides: Partial<RestCandidate> = {}): RestCandidate {
  const durationMs = endUtc - startUtc
  return {
    startUtc,
    endUtc,
    durationMs,
    durationMinutes: Math.round(durationMs / 60_000),
    slot: 1,
    sourceActivityIds,
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    overlappingNonRestKinds: [],
    kinds: [],
    ...overrides,
  }
}

function assess(rests: RestCandidate[], recordEndUtc: number | null = RECORD_END, unknownIntervals: { startUtc: number; endUtc: number }[] = []) {
  return assessWeeklyRestCompensationTaken({
    candidates: classifyWeeklyRestCandidates(rests),
    rests,
    recordEndUtc,
    unknownIntervals,
  })
}

function slicesOf(allocation: CompensationAllocation) {
  return allocation.slices
}

function noSharedMinute(allocation: CompensationAllocation) {
  const slices = slicesOf(allocation)
  for (let index = 0; index < slices.length; index += 1) {
    for (let other = index + 1; other < slices.length; other += 1) {
      const left = slices[index]!
      const right = slices[other]!
      assert.equal(left.startUtc < right.endUtc && right.startUtc < left.endUtc, false)
    }
  }
}

function fulfillmentFor(report: ReturnType<typeof assess>, activityId: string): ObligationFulfillment {
  const obligation = report.compensation.obligations.find((item) => item.sourceActivityIds[0] === activityId)
  assert.ok(obligation)
  const fulfillment = report.fulfillments.find((item) => item.obligationId === obligation.id)
  assert.ok(fulfillment)
  return fulfillment
}

test('dluh 21 hodin a odpočinek 66 hodin se dělí na 45 a 21 hodin', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const block = Date.parse('2026-03-08T00:00:00.000Z')
  const report = assess([
    candidate(reduced, reduced + 24 * HOUR, ['reduced']),
    candidate(block, block + 66 * HOUR, ['block']),
  ])
  const fulfillment = fulfillmentFor(report, 'reduced')
  assert.equal(fulfillment.status, 'taken')
  assert.equal(fulfillment.reason, 'completed_on_time')
  assert.equal(fulfillment.dailyWindowEffect, 'not_evaluated')
  assert.ok(fulfillment.readings.length >= 2)
  assert.equal(fulfillment.readings.every((item) => item.onTime && item.assignsObligation), true)
  for (const reading of fulfillment.readings) {
    const allocation = reading.allocations[0]!
    assert.equal(allocation.sourceActivityIds[0], 'block')
    assert.equal(allocation.excludesHostRestAndWeeklyRest, true)
    noSharedMinute(allocation)
    const weekly = allocation.slices.find((slice) => slice.role === 'weekly_rest')
    const compensation = allocation.slices.find((slice) => slice.role === 'compensation')
    assert.ok(weekly)
    assert.ok(compensation)
    assert.equal(weekly.durationMs, 45 * HOUR)
    assert.equal(compensation.durationMs, 21 * HOUR)
    assert.equal(compensation.endUtc <= Date.parse('2026-03-30T00:00:00.000Z'), true)
    assert.equal((weekly?.durationMs ?? 0) + (compensation?.durationMs ?? 0), 66 * HOUR)
  }
  assert.equal(report.compensation.obligations[0]?.taken.status, 'not_searched')
  assert.equal(report.internationalEntitlement, 'not_inferred')
  assert.equal(report.partialFulfillment, 'not_accepted')
  assert.equal(JSON.stringify(report).includes('přestupek'), false)
})

test('dluh 21 hodin a odpočinek 30 hodin se dělí na 9 a 21 hodin', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const host = Date.parse('2026-03-05T00:00:00.000Z')
  const regular = Date.parse('2026-03-09T00:00:00.000Z')
  const report = assess([
    candidate(reduced, reduced + 24 * HOUR, ['reduced']),
    candidate(host, host + 30 * HOUR, ['host30']),
    candidate(regular, regular + 45 * HOUR, ['regular']),
  ])
  const fulfillment = fulfillmentFor(report, 'reduced')
  assert.equal(report.compensation.obligations.length, 1)
  assert.equal(fulfillment.status, 'taken')
  for (const reading of fulfillment.readings) {
    const allocation = reading.allocations[0]!
    assert.equal(allocation.sourceActivityIds[0], 'host30')
    noSharedMinute(allocation)
    assert.equal(allocation.slices.find((slice) => slice.role === 'host')?.durationMs, 9 * HOUR)
    assert.equal(allocation.slices.find((slice) => slice.role === 'compensation')?.durationMs, 21 * HOUR)
    assert.equal(allocation.dailyWindowEffect, 'not_evaluated')
  }
})

test('dluh 21 hodin a odpočinek 29 hodin náhradu nesplní', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const short = Date.parse('2026-03-05T00:00:00.000Z')
  const regular = Date.parse('2026-03-09T00:00:00.000Z')
  const report = assess([
    candidate(reduced, reduced + 24 * HOUR, ['reduced']),
    candidate(short, short + 29 * HOUR, ['short']),
    candidate(regular, regular + 45 * HOUR, ['regular']),
  ])
  const fulfillment = fulfillmentFor(report, 'reduced')
  assert.equal(fulfillment.status, 'missed')
  assert.equal(fulfillment.reason, 'not_completed_before_deadline')
  assert.equal(fulfillment.readings.some((item) => item.onTime), false)
  assert.equal(fulfillment.readings.some((item) => item.allocations.some((allocation) => allocation.slices.some((slice) => slice.durationMs === 21 * HOUR))), false)
})

test('dvě náhrady 21 a 20 hodin mají nepřekrývající se čas a mezinárodní režim zůstane nedoložený', () => {
  const first = Date.parse('2026-03-03T00:00:00.000Z')
  const second = Date.parse('2026-03-09T06:00:00.000Z')
  const block = Date.parse('2026-03-12T00:00:00.000Z')
  const report = assess([
    candidate(first, first + 24 * HOUR, ['first']),
    candidate(second, second + 25 * HOUR, ['second']),
    candidate(block, block + 86 * HOUR, ['block']),
  ])
  assert.equal(report.compensation.obligations.length, 2)
  assert.deepEqual(
    report.compensation.obligations.map((item) => item.compensationMs).sort((a, b) => a - b),
    [20 * HOUR, 21 * HOUR],
  )
  for (const activityId of ['first', 'second']) {
    const fulfillment = fulfillmentFor(report, activityId)
    assert.equal(fulfillment.status, 'taken')
  }
  const reading = fulfillmentFor(report, 'first').readings.find((item) => item.satisfiedObligationIds.length === 2)
  assert.ok(reading)
  const allocation = reading.allocations[0]!
  noSharedMinute(allocation)
  const compensations = allocation.slices.filter((slice) => slice.role === 'compensation')
  assert.deepEqual(compensations.map((slice) => slice.durationMs).sort((a, b) => a - b), [20 * HOUR, 21 * HOUR])
  assert.equal(new Set(compensations.map((slice) => slice.obligationId)).size, 2)
  assert.equal(allocation.slices.find((slice) => slice.role === 'weekly_rest')?.durationMs, 45 * HOUR)
  assert.equal(report.compensation.internationalConsecutive[0]?.status, 'not_proven')
  assert.equal(report.compensation.internationalConsecutive[0]?.entitlement, 'not_inferred')
  assert.equal(report.compensation.internationalConsecutive[0]?.deadlineEffect, 'none')
  assert.equal(report.internationalEntitlement, 'not_inferred')
})

test('dvě náhrady soutěžící o stejný čas se nezapočítají dvakrát', () => {
  const first = Date.parse('2026-03-03T00:00:00.000Z')
  const second = Date.parse('2026-03-09T06:00:00.000Z')
  const block = Date.parse('2026-03-12T00:00:00.000Z')
  const report = assess([
    candidate(first, first + 24 * HOUR, ['first']),
    candidate(second, second + 25 * HOUR, ['second']),
    candidate(block, block + 66 * HOUR, ['block']),
  ])
  for (const activityId of ['first', 'second']) {
    const fulfillment = fulfillmentFor(report, activityId)
    assert.equal(fulfillment.status, 'undecided')
    assert.equal(fulfillment.reason, 'alternative_outcomes')
  }
  const readings = fulfillmentFor(report, 'first').readings
  assert.equal(readings.some((item) => item.assignsObligation), true)
  assert.equal(readings.some((item) => !item.assignsObligation), true)
  for (const reading of readings) {
    assert.equal(reading.satisfiedObligationIds.length <= 1, true)
    for (const allocation of reading.allocations) {
      noSharedMinute(allocation)
      const compensations = allocation.slices.filter((slice) => slice.role === 'compensation')
      assert.equal(compensations.length <= 1, true)
    }
  }
})

test('náhrada dokončená po termínu není splněná', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const block = Date.parse('2026-03-30T12:00:00.000Z')
  const deadline = Date.parse('2026-03-30T00:00:00.000Z')
  const report = assess([
    candidate(reduced, reduced + 24 * HOUR, ['reduced']),
    candidate(block, block + 66 * HOUR, ['block']),
  ])
  const fulfillment = fulfillmentFor(report, 'reduced')
  assert.equal(fulfillment.status, 'missed')
  assert.equal(fulfillment.reason, 'not_completed_before_deadline')
  assert.equal(fulfillment.readings.length > 0, true)
  assert.equal(fulfillment.readings.every((item) => item.onTime === false), true)
  for (const reading of fulfillment.readings) {
    const compensation = reading.allocations[0]?.slices.find((slice) => slice.role === 'compensation')
    assert.equal(compensation != null && compensation.endUtc > deadline, true)
  }
})

test('chybějící data před termínem nejsou zmeškaná náhrada', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const report = assess(
    [candidate(reduced, reduced + 24 * HOUR, ['reduced'])],
    RECORD_END,
    [{ startUtc: Date.parse('2026-03-15T00:00:00.000Z'), endUtc: Date.parse('2026-03-16T00:00:00.000Z') }],
  )
  const fulfillment = fulfillmentFor(report, 'reduced')
  assert.equal(fulfillment.status, 'undecided')
  assert.equal(fulfillment.reason, 'record_incomplete')
  assert.notEqual(fulfillment.status, 'missed')
  assert.notEqual(fulfillment.status, 'taken')
})

test('více rozdělení téhož odpočinku s rozdílným výsledkem zůstane nerozhodnuté', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const block = Date.parse('2026-03-29T00:00:00.000Z')
  const deadline = Date.parse('2026-03-30T00:00:00.000Z')
  const report = assess([
    candidate(reduced, reduced + 24 * HOUR, ['reduced']),
    candidate(block, block + 66 * HOUR, ['block']),
  ])
  const fulfillment = fulfillmentFor(report, 'reduced')
  assert.equal(fulfillment.status, 'undecided')
  assert.equal(fulfillment.reason, 'alternative_outcomes')
  assert.equal(fulfillment.readings.some((item) => item.assignsObligation && item.onTime), true)
  assert.equal(fulfillment.readings.some((item) => item.assignsObligation && !item.onTime), true)
  const onTime = fulfillment.readings.find((item) => item.onTime)!
  const late = fulfillment.readings.find((item) => !item.onTime)!
  const onTimeEnd = onTime.allocations[0]?.slices.find((slice) => slice.role === 'compensation')?.endUtc
  const lateEnd = late.allocations[0]?.slices.find((slice) => slice.role === 'compensation')?.endUtc
  assert.equal(onTimeEnd != null && onTimeEnd <= deadline, true)
  assert.equal(lateEnd != null && lateEnd > deadline, true)
  assert.equal(onTime.allocations[0]?.dailyWindowEffect, 'not_evaluated')
})
