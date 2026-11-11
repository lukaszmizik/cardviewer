import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import { assessWeeklyStartDeadlines, buildWeeklyRestAssignment } from '../src/analysis/weeklyRestAssignment.ts'
import type { WeeklyRestCandidate } from '../src/analysis/weeklyRest.ts'
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
  assert.equal(onTime.nodes[0]?.nextAfterDeadline, null)

  const late = assignmentOf([
    first,
    activity('second', 'rest', end + 6 * DAY + 60_000, end + 6 * DAY + 60_000 + 24 * HOUR),
  ])
  assert.equal(late.nodes[0]?.nextOnTime.length, 0)
  assert.equal(late.nodes[0]?.nextAfterDeadline?.timing, 'after_deadline')
  assert.equal(late.nodes[0]?.nextAfterDeadline?.role, 'nearest_recorded_after_deadline')
  const onTimeReading = assessWeeklyStartDeadlines({ assignment: onTime, recordEndUtc: end + 6 * DAY + 24 * HOUR })
  assert.equal(onTimeReading.length, 0)
  const lateReading = assessWeeklyStartDeadlines({ assignment: late, recordEndUtc: end + 6 * DAY + 60_000 + 24 * HOUR })
  assert.equal(lateReading.length, 1)
  assert.equal(lateReading[0]?.status, 'violation')
  assert.equal(lateReading[0]?.nextStartUtc, end + 6 * DAY + 60_000)
  assert.equal(late.recommendation.status, 'suggested')
  assert.match(late.recommendation.status === 'suggested' ? late.recommendation.reason : '', /skutečném konci/)
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
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [])
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'alternative_on_time')
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
  assert.equal(result.nodes[0]?.nextAfterDeadline, null)
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
  assert.equal(result.nodes[0]?.weekChoice, 'continuous_cover')
  const slices = result.nodes[0]?.possibleWeeks ?? []
  assert.ok(slices.length > 2)
  assert.equal(
    slices.reduce((sum, slice) => sum + slice.overlapMs, 0),
    result.nodes[0]?.durationMs,
  )
  assert.deepEqual(result.nodes[0]?.sourceActivityIds, ['manual'])
  assert.equal(result.excludedByUnknown.length, 0)
  assert.equal(result.recommendation.status, 'suggested')
})

test('dlouhý odpočinek a odpočinek o několik týdnů později nejsou falešná nejednoznačnost', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = assignmentOf([
    activity('long', 'rest', start, start + 20 * DAY, { isManualEntry: true }),
    activity('work', 'work', start + 20 * DAY, start + 50 * DAY),
    activity('next', 'rest', start + 50 * DAY, start + 50 * DAY + 45 * HOUR),
    activity('later', 'rest', start + 80 * DAY, start + 80 * DAY + 45 * HOUR),
  ])
  assert.equal(result.nodes.length, 3)
  assert.equal(result.nodes[0]?.nextOnTime.length, 0)
  assert.equal(result.nodes[0]?.nextAfterDeadline?.toId, result.nodes[1]?.id)
  assert.equal(result.nodes[1]?.nextAfterDeadline?.toId, result.nodes[2]?.id)
  assert.equal(result.recommendation.status, 'suggested')
  assert.equal(result.recommendation.status === 'suggested' ? result.recommendation.nodeIds.length : 0, 3)
  assert.deepEqual(
    result.suggestedBoundaryEndsUtc,
    result.recommendation.status === 'suggested'
      ? result.recommendation.nodeIds.map((id) => result.nodes.find((node) => node.id === id)?.endUtc)
      : [],
  )
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.match(result.recommendation.status === 'suggested' ? result.recommendation.reason : '', /nepřerušeného odpočinku/)
})

function weeklyCandidate(
  id: string,
  startUtc: number,
  endUtc: number,
  overrides: Partial<WeeklyRestCandidate> = {},
): WeeklyRestCandidate {
  return {
    startUtc,
    endUtc,
    durationMs: endUtc - startUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
    sourceActivityIds: [id],
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    lengthClass: endUtc - startUtc >= 45 * HOUR ? 'regular' : 'reduced',
    ...overrides,
  }
}

test('dva prokázané odpočinky s jedinou včasnou návazností navrhnou dvojici uzlů', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const second = Date.parse('2026-03-05T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('first', first, first + 24 * HOUR),
      weeklyCandidate('second', second, second + 24 * HOUR),
    ],
    recordEndUtc: second + 30 * HOUR,
  })
  assert.equal(result.boundaryPair.status, 'pair')
  if (result.boundaryPair.status !== 'pair') return
  assert.equal(result.boundaryPair.technicalProposal, true)
  assert.equal(result.boundaryPair.legalDetermination, false)
  assert.deepEqual(result.boundaryPair.nodeIds, [result.nodes[0]?.id, result.nodes[1]?.id])
  assert.equal('endUtc' in result.boundaryPair, false)
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [first + 24 * HOUR, second + 24 * HOUR])
  assert.equal(result.recommendation.status, 'suggested')
})

test('neprokázaný odpočinek dvojici nenavrhne', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const second = Date.parse('2026-03-05T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('first', first, first + 24 * HOUR, { established: false, ambiguous: true }),
      weeklyCandidate('second', second, second + 24 * HOUR),
    ],
    recordEndUtc: second + 30 * HOUR,
  })
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'unproven_rest')
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [first + 24 * HOUR, second + 24 * HOUR])
})

test('dva kandidáti v jednom týdnu s alternativní návazností zůstanou nerozhodnutí', () => {
  const end = Date.parse('2026-03-03T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('first', end - 24 * HOUR, end),
      weeklyCandidate('early', end + DAY, end + 2 * DAY),
      weeklyCandidate('also', end + 2 * DAY, end + 3 * DAY),
    ],
    recordEndUtc: end + 4 * DAY,
  })
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'alternative_on_time')
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [])
})

test('odpočinek přes hranici dvou týdnů dvojici nenavrhne', () => {
  const spanning = Date.parse('2026-03-08T12:00:00.000Z')
  const next = Date.parse('2026-03-11T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('span', spanning, Date.parse('2026-03-10T12:00:00.000Z')),
      weeklyCandidate('next', next, next + 24 * HOUR),
    ],
    recordEndUtc: next + 30 * HOUR,
  })
  assert.equal(result.nodes[0]?.weekChoice, 'needs_controller')
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'spans_two_weeks')
})

test('odpočinek přes tři týdny dvojici nenavrhne', () => {
  const spanning = Date.parse('2026-03-02T12:00:00.000Z')
  const next = Date.parse('2026-03-20T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('long', spanning, Date.parse('2026-03-18T12:00:00.000Z'), { lengthClass: 'regular' }),
      weeklyCandidate('next', next, next + 24 * HOUR),
    ],
    recordEndUtc: next + 30 * HOUR,
  })
  assert.equal(result.nodes[0]?.weekChoice, 'continuous_cover')
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'spans_more_than_two_weeks')
})

test('neznámý úsek mezi odpočinky dvojici nenavrhne', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const second = Date.parse('2026-03-05T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('before', first, first + 24 * HOUR),
      weeklyCandidate('after', second, second + 24 * HOUR),
    ],
    unknownIntervals: [{ startUtc: first + 30 * HOUR, endUtc: first + 40 * HOUR }],
    recordEndUtc: second + 30 * HOUR,
  })
  assert.equal(result.nodes.length, 2)
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'unknown_between')
})

test('odpočinek s nedoloženým koncem dvojici nenavrhne', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const second = Date.parse('2026-03-05T06:00:00.000Z')
  const secondEnd = second + 24 * HOUR
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('first', first, first + 24 * HOUR),
      weeklyCandidate('second', second, secondEnd),
    ],
    recordEndUtc: secondEnd,
  })
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'end_not_documented')
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [first + 24 * HOUR, secondEnd])
})

test('pouze jeden kandidát dvojici nenavrhne', () => {
  const start = Date.parse('2026-03-02T06:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [weeklyCandidate('only', start, start + 45 * HOUR, { lengthClass: 'regular' })],
    recordEndUtc: start + 50 * HOUR,
  })
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'not_exactly_two')
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [start + 45 * HOUR])
})

test('tři kandidáti v jedné větvi dvojici nenavrhnou a seznam konců zůstane', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const second = Date.parse('2026-03-07T06:00:00.000Z')
  const third = Date.parse('2026-03-09T12:00:00.000Z')
  const result = buildWeeklyRestAssignment({
    candidates: [
      weeklyCandidate('first', first, first + 24 * HOUR),
      weeklyCandidate('second', second, second + 24 * HOUR),
      weeklyCandidate('third', third, third + 24 * HOUR),
    ],
    recordEndUtc: third + 30 * HOUR,
  })
  assert.equal(result.boundaryPair.status, 'undecided')
  assert.equal(result.boundaryPair.status === 'undecided' ? result.boundaryPair.reason : '', 'not_exactly_two')
  assert.equal(result.recommendation.status, 'suggested')
  assert.deepEqual(result.suggestedBoundaryEndsUtc, [first + 24 * HOUR, second + 24 * HOUR, third + 24 * HOUR])
})

test('návrh dvojice nepřejde do kontroly zkrácených denních odpočinků', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const second = Date.parse('2026-03-05T06:00:00.000Z')
  const analyzed = analyzeDriverActivities({
    card: card([
      activity('first', 'rest', first, first + 24 * HOUR),
      activity('gap', 'work', first + 24 * HOUR, second),
      activity('second', 'rest', second, second + 24 * HOUR),
      activity('after', 'driving', second + 24 * HOUR, second + 26 * HOUR),
    ]),
  })
  assert.equal(analyzed.weeklyAssignment.boundaryPair.status, 'pair')
  assert.equal(analyzed.assessed.weekly.status, 'requires_input')
})
