import assert from 'node:assert/strict'
import test from 'node:test'
import type { DailyRestChain } from '../src/analysis/dailyRestChain.ts'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'
import {
  assessWeeklyRests,
  classifyWeeklyRestCandidates,
  type WeekClock,
  type WeeklyRestCandidate,
} from '../src/analysis/weeklyRest.ts'

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR
const MONDAY = Date.parse('2026-03-02T00:00:00.000Z')

function candidate(startUtc: number, endUtc: number, overrides: Partial<RestCandidate> = {}): RestCandidate {
  const durationMs = endUtc - startUtc
  return {
    startUtc,
    endUtc,
    durationMs,
    durationMinutes: Math.round(durationMs / 60_000),
    slot: 1,
    sourceActivityIds: ['r'],
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    overlappingNonRestKinds: [],
    kinds: [],
    ...overrides,
  }
}

function clock(weekCount: number): WeekClock {
  return {
    weeks: Array.from({ length: weekCount }, (_, index) => ({
      id: `w${index}`,
      startUtc: MONDAY + index * WEEK,
      endUtc: MONDAY + (index + 1) * WEEK,
    })),
  }
}

function select(item: WeeklyRestCandidate, weekId: string) {
  return { candidate: item, weekId }
}

test('přesná hranice 24 a 45 hodin dává jednu délkovou třídu', () => {
  const origin = Date.parse('2026-03-06T18:00:00.000Z')
  const source = [
    candidate(origin, origin + 24 * HOUR - 60_000, { sourceActivityIds: ['short'] }),
    candidate(origin, origin + 24 * HOUR, { sourceActivityIds: ['h24'] }),
    candidate(origin, origin + 45 * HOUR - 60_000, { sourceActivityIds: ['h44'] }),
    candidate(origin, origin + 45 * HOUR, { sourceActivityIds: ['h45'] }),
    candidate(origin, origin + 60 * HOUR, { sourceActivityIds: ['h60'] }),
  ]
  const snapshot = structuredClone(source)
  const classified = classifyWeeklyRestCandidates(source)
  assert.deepEqual(
    classified.map((item) => [item.sourceActivityIds[0], item.lengthClass, item.durationMs]),
    [
      ['h24', 'reduced', 24 * HOUR],
      ['h44', 'reduced', 45 * HOUR - 60_000],
      ['h45', 'regular', 45 * HOUR],
      ['h60', 'regular', 60 * HOUR],
    ],
  )
  assert.equal(classified.filter((item) => item.sourceActivityIds[0] === 'h60').length, 1)
  assert.equal(classified.every((item) => Object.hasOwn(item, 'usedAsWeekly') === false), true)
  assert.deepEqual(source, snapshot)
})

test('ruční odpočinek zůstává vstupem a neznámý úsek ho nepřemostí', () => {
  const manual = candidate(Date.parse('2026-03-10T00:00:00.000Z'), Date.parse('2026-03-12T00:00:00.000Z'), {
    sourceActivityIds: ['manual-48'],
    manualEntry: true,
    uncertainties: ['manual_entry'],
  })
  const [classified] = classifyWeeklyRestCandidates([manual])
  assert.equal(classified?.lengthClass, 'regular')
  assert.equal(classified?.manualEntry, true)
  assert.deepEqual(classified?.uncertainties, ['manual_entry'])
  assert.equal(classified?.durationMs, 48 * HOUR)

  const previousWeeklyEndUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const assessed = assessWeeklyRests({
    previousWeeklyEndUtc,
    selections: [select(classified!, 'w1')],
    clock: clock(4),
    unknownIntervals: [
      { startUtc: previousWeeklyEndUtc, endUtc: classified!.startUtc },
    ],
  })
  assert.equal(assessed.selections[0]?.timing.status, 'undetermined')
  assert.equal(assessed.selections[0]?.usableAsBoundary, true)
  assert.deepEqual(assessed.boundaryEndsUtc, [classified!.endUtc])
  assert.equal(assessed.dailyReduced.status, 'undecided')
  assert.equal(assessed.consecutiveWeeks, 'not_evaluated')
  assert.equal(assessed.internationalRegime, 'not_evaluated')
  assert.equal(assessed.compensationTaken, 'not_evaluated')
  assert.equal(Object.hasOwn(assessed, 'infringement'), false)
})

test('šestkrát 24 hodin rozliší včasný a pozdní začátek', () => {
  const previousWeeklyEndUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const latest = previousWeeklyEndUtc + 6 * 24 * HOUR
  const onTime = classifyWeeklyRestCandidates([
    candidate(latest, latest + 45 * HOUR, { sourceActivityIds: ['on-time'] }),
  ])[0]!
  const lateStart = latest + 60_000
  const late = classifyWeeklyRestCandidates([
    candidate(lateStart, lateStart + 45 * HOUR, { sourceActivityIds: ['late'] }),
  ])[0]!
  const weeks = clock(4)
  const missingPrevious = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(onTime, 'w0')],
    clock: weeks,
  })
  const onTimeReport = assessWeeklyRests({
    previousWeeklyEndUtc,
    selections: [select(onTime, 'w0')],
    clock: weeks,
  })
  const lateReport = assessWeeklyRests({
    previousWeeklyEndUtc,
    selections: [select(late, 'w0')],
    clock: weeks,
  })
  assert.equal(missingPrevious.selections[0]?.timing.status, 'undetermined')
  assert.equal(missingPrevious.selections[0]?.timing.latestStartUtc, null)
  assert.equal(onTimeReport.selections[0]?.timing.status, 'on_time')
  assert.equal(onTimeReport.selections[0]?.timing.latestStartUtc, latest)
  assert.equal(lateReport.selections[0]?.timing.status, 'late')
  assert.equal(lateReport.selections[0]?.timing.latestStartUtc, latest)
  assert.equal(Object.hasOwn(onTimeReport, 'infringement'), false)
  assert.equal(Object.hasOwn(lateReport, 'infringement'), false)
})

test('odpočinek přes dva týdny patří jen jednomu z nich', () => {
  const startUtc = Date.parse('2026-03-08T20:00:00.000Z')
  const endUtc = Date.parse('2026-03-10T17:00:00.000Z')
  const item = classifyWeeklyRestCandidates([candidate(startUtc, endUtc, { sourceActivityIds: ['span'] })])[0]!
  const starting = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(item, 'w0')],
    clock: clock(4),
  })
  const ending = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(item, 'w1')],
    clock: clock(4),
  })
  const both = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(item, 'w0'), select(item, 'w1')],
    clock: clock(4),
  })
  assert.deepEqual(starting.selections[0]?.assignment, { status: 'assigned', weekId: 'w0', attachment: 'starting_week' })
  assert.deepEqual(ending.selections[0]?.assignment, { status: 'assigned', weekId: 'w1', attachment: 'ending_week' })
  assert.equal(both.selections.every((report) => report.assignment.status === 'rejected'), true)
  assert.deepEqual(both.boundaryEndsUtc, [])
})

test('zkrácený odpočinek eviduje deficit a třetí následující týden', () => {
  const startUtc = Date.parse('2026-03-06T18:00:00.000Z')
  const reduced = classifyWeeklyRestCandidates([
    candidate(startUtc, startUtc + 30 * HOUR, { sourceActivityIds: ['h30'] }),
  ])[0]!
  const exact24 = classifyWeeklyRestCandidates([
    candidate(startUtc, startUtc + 24 * HOUR, { sourceActivityIds: ['h24'] }),
  ])[0]!
  const regular = classifyWeeklyRestCandidates([
    candidate(startUtc, startUtc + 45 * HOUR, { sourceActivityIds: ['h45'] }),
  ])[0]!
  const weeks = clock(4)
  const reducedReport = assessWeeklyRests({
    previousWeeklyEndUtc: Date.parse('2026-03-02T06:00:00.000Z'),
    selections: [select(reduced, 'w0')],
    clock: weeks,
  }).selections[0]!
  const dayReport = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(exact24, 'w0')],
    clock: weeks,
  }).selections[0]!
  const regularReport = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(regular, 'w0')],
    clock: weeks,
  }).selections[0]!
  assert.deepEqual(reducedReport.compensation, {
    status: 'recorded_unassigned',
    deficitMs: 15 * HOUR,
    deadlineUtc: Date.parse('2026-03-30T00:00:00.000Z'),
  })
  assert.equal(dayReport.compensation.status, 'recorded_unassigned')
  if (dayReport.compensation.status === 'recorded_unassigned') {
    assert.equal(dayReport.compensation.deficitMs, 21 * HOUR)
  }
  assert.deepEqual(regularReport.compensation, { status: 'not_recorded', reason: 'regular_length' })
  assert.equal(reducedReport.usableAsBoundary, true)
  assert.deepEqual(
    assessWeeklyRests({
      previousWeeklyEndUtc: null,
      selections: [select(reduced, 'w0')],
      clock: weeks,
    }).boundaryEndsUtc,
    [reduced.endUtc],
  )
})

test('dva úplné předěly sečtou zkrácené denní odpočinky, neúplné nechají nerozhodné', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes: [
      {
        anchorUtc: fromUtc,
        windowStartUtc: fromUtc,
        windowEndUtc: fromUtc + 24 * HOUR,
        status: 'evaluated',
        interpretations: [
          {
            id: 'reduced-1',
            kind: 'continuous_reduced',
            qualifiesWindow: true,
            established: true,
            nextAnchorUtc: toUtc,
            reducedDelta: 1,
            weeklyRolePossible: false,
            parts: [],
          },
        ],
      },
      {
        anchorUtc: toUtc,
        windowStartUtc: toUtc,
        windowEndUtc: toUtc + 24 * HOUR,
        status: 'window_unsatisfied',
        interpretations: [],
      },
    ],
    paths: [
      {
        steps: [
          { anchorUtc: fromUtc, interpretationId: 'reduced-1' },
          { anchorUtc: toUtc, interpretationId: null },
        ],
        reducedCount: 1,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
  const summed = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(4),
    dailyChain: chain,
  })
  assert.deepEqual(summed.boundaryEndsUtc, [toUtc])
  assert.deepEqual(summed.dailyReduced, { status: 'summed', fromUtc, toUtc, reducedCount: 1 })
  assert.equal(chain.paths[0]?.weeklyBoundariesDetermined, false)

  const broken: DailyRestChain = {
    ...chain,
    nodes: chain.nodes.map((node) => (node.anchorUtc === fromUtc ? { ...node, status: 'insufficient_data' } : node)),
  }
  const undecided = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(4),
    dailyChain: broken,
  })
  assert.equal(undecided.dailyReduced.status, 'undecided')
})

test('dlouhý odpočinek zůstává použitelný a stejný čas se nezapočítá dvakrát', () => {
  const start = MONDAY + 6 * HOUR
  const end = start + 20 * 24 * HOUR
  const [item] = classifyWeeklyRestCandidates([candidate(start, end, { sourceActivityIds: ['manual'], manualEntry: true })])
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: null,
    selections: [select(item!, 'w0')],
    clock: clock(5),
  })
  const report = result.selections[0]
  assert.equal(report?.assignment.status, 'continuous_cover')
  assert.equal(report?.usableAsBoundary, true)
  assert.deepEqual(result.boundaryEndsUtc, [end])
  if (report?.assignment.status !== 'continuous_cover') return
  assert.ok(report.assignment.weeks.length > 2)
  assert.equal(
    report.assignment.weeks.reduce((sum, week) => sum + week.overlapMs, 0),
    end - start,
  )
  for (let index = 1; index < report.assignment.weeks.length; index += 1) {
    assert.ok(report.assignment.weeks[index - 1]!.overlapEndUtc <= report.assignment.weeks[index]!.overlapStartUtc)
  }
})
