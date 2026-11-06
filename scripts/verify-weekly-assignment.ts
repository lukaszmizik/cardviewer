import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function activity(
  id: string,
  kind: Activity['kind'],
  startUtc: number,
  endUtc: number,
  overrides: Partial<Activity> = {},
): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
    slot: 1,
    ...overrides,
  }
}

function card(activities: Activity[]): DriverCardData {
  return {
    cardNumber: 'X',
    firstName: 'A',
    surname: 'B',
    lastWithdrawalUtc: null,
    activities,
    locations: [],
    violations: [],
  }
}

function assignmentOf(activities: Activity[]) {
  return analyzeDriverActivities({ card: card(activities) }).weeklyAssignment
}

test('přesně 24 hodin je zkrácený délkový kandidát a jeden uzel', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([activity('rest-24', 'rest', start, start + 24 * HOUR)])
  assert.equal(result.nodes.length, 1)
  assert.equal(result.nodes[0]?.lengthClass, 'reduced')
  assert.equal(result.nodes[0]?.durationMs, 24 * HOUR)
  assert.equal(result.recommendationIsLegalFinding, false)
})

test('přesně 45 hodin je běžný délkový kandidát', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([activity('rest-45', 'rest', start, start + 45 * HOUR)])
  assert.equal(result.nodes[0]?.lengthClass, 'regular')
  assert.equal(result.nodes[0]?.weekChoice, 'single')
})

test('hranice šesti 24hodinových období je včasná a minuta po ní je pozdní', () => {
  const end = Date.parse('2026-03-02T06:00:00.000Z')
  const first = activity('first', 'rest', end - 45 * HOUR, end)
  const onTime = assignmentOf([first, activity('second', 'rest', end + 6 * DAY, end + 6 * DAY + 24 * HOUR)])
  assert.equal(onTime.nodes[0]?.nextOnTime.length, 1)
  assert.equal(onTime.nodes[0]?.nextOnTime[0]?.timing, 'on_time')
  assert.equal(onTime.nodes[0]?.nextLate.length, 0)

  const late = assignmentOf([
    first,
    activity('second', 'rest', end + 6 * DAY + 60_000, end + 6 * DAY + 60_000 + 24 * HOUR),
  ])
  assert.equal(late.nodes[0]?.nextOnTime.length, 0)
  assert.equal(late.nodes[0]?.nextLate.length, 1)
  assert.equal(late.nodes[0]?.nextLate[0]?.timing, 'late')
  assert.equal(late.recommendation.status, 'suggested')
  assert.equal(late.recommendation.status === 'suggested' ? late.recommendation.nodeIds.length : 0, 1)
})

test('odpočinek přes dva kalendářní týdny zůstává jeden a týden se nevolí', () => {
  const start = Date.parse('2026-03-08T12:00:00.000Z')
  const result = assignmentOf([activity('span', 'rest', start, Date.parse('2026-03-10T12:00:00.000Z'))])
  const node = result.nodes[0]
  assert.equal(result.nodes.length, 1)
  assert.equal(node?.weekChoice, 'needs_controller')
  assert.equal(node?.possibleWeeks.length, 2)
  assert.deepEqual(
    node?.possibleWeeks.map((week) => week.attachment),
    ['starting_week', 'ending_week'],
  )
})

test('více včasných pokračování se nevybírá a žádné se nezahodí', () => {
  const end = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([
    activity('first', 'rest', end - 24 * HOUR, end),
    activity('early', 'rest', end + DAY, end + 2 * DAY),
    activity('work', 'work', end + 2 * DAY, end + 2 * DAY + 6 * HOUR),
    activity('also', 'rest', end + 2 * DAY + 6 * HOUR, end + 3 * DAY + 6 * HOUR),
  ])
  assert.equal(result.nodes[0]?.nextOnTime.length, 2)
  assert.equal(result.recommendation.status, 'undecided')
  assert.equal(result.searchLimited, false)
  assert.equal(result.nodes.length, 3)
})

test('neznámý úsek návaznost nespojuje a není odpočinek', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([
    activity('before', 'rest', start, start + 24 * HOUR),
    activity('gap', 'unknown', start + 25 * HOUR, start + 48 * HOUR),
    activity('after', 'rest', start + 49 * HOUR, start + 73 * HOUR),
  ])
  assert.equal(result.nodes.length, 2)
  assert.equal(result.nodes[0]?.nextOnTime.length, 0)
  assert.equal(result.nodes[0]?.nextLate.length, 0)
  assert.deepEqual(result.rootIds.length, 2)
})

test('bez předchozího týdenního konce je historie na začátku nedostatečná', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([activity('only', 'rest', start, start + 45 * HOUR)])
  assert.deepEqual(result.rootIds, result.nodes.map((node) => node.id))
  assert.match(result.recommendation.status === 'suggested' ? result.recommendation.reason : '', /historie/)
  assert.equal(result.suggestedBoundaryEndsUtc.length, 1)
})

test('dlouhý ruční odpočinek zůstává jeden uzel a není odmítnutý', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([
    activity('manual', 'rest', start, start + 20 * DAY, { isManualEntry: true }),
  ])
  assert.equal(result.nodes.length, 1)
  assert.equal(result.nodes[0]?.manualEntry, true)
  assert.equal(result.nodes[0]?.lengthClass, 'regular')
  assert.equal(result.nodes[0]?.weekChoice, 'spans_more_than_two_weeks')
  assert.equal(result.excludedByUnknown.length, 0)
})
