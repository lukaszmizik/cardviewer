import assert from 'node:assert/strict'
import test from 'node:test'
import type { DailyChainNode, DailyRestChain } from '../src/analysis/dailyRestChain.ts'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'
import { buildWeeklyRestAssignment } from '../src/analysis/weeklyRestAssignment.ts'
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
        windowMode: 'single_driver_24h',
        crewRecord: null,
        anchorEstablished: true,
        status: 'evaluated',
        interpretations: [
          {
            id: 'reduced-1',
            kind: 'continuous_reduced',
            qualifiesWindow: true,
            established: true,
            nextAnchorUtc: toUtc,
            nextAnchorEstablished: true,
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
        windowMode: 'single_driver_24h',
        crewRecord: null,
        anchorEstablished: true,
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

function reducedNode(anchorUtc: number, nextAnchorUtc: number, source: string, established = true): DailyChainNode {
  return {
    anchorUtc,
    windowStartUtc: anchorUtc,
    windowEndUtc: anchorUtc + 24 * HOUR,
    windowMode: 'single_driver_24h',
    crewRecord: null,
    anchorEstablished: true,
    status: 'evaluated',
    interpretations: [
      {
        id: source,
        kind: 'continuous_reduced',
        qualifiesWindow: true,
        established,
        nextAnchorUtc,
        nextAnchorEstablished: established,
        reducedDelta: 1,
        weeklyRolePossible: false,
        parts: [
          {
            startUtc: nextAnchorUtc - 9 * HOUR,
            endUtc: nextAnchorUtc,
            candidateMinutes: 9 * 60,
            restMinutesInsideWindow: 9 * 60,
            intersectionEndUtc: nextAnchorUtc,
            sourceActivityIds: [source],
          },
        ],
      },
    ],
  }
}

function endNode(anchorUtc: number): DailyChainNode {
  return {
    anchorUtc,
    windowStartUtc: anchorUtc,
    windowEndUtc: anchorUtc + 24 * HOUR,
    windowMode: 'single_driver_24h',
    crewRecord: null,
    anchorEstablished: true,
    status: 'window_unsatisfied',
    interpretations: [],
  }
}

test('jedno období uzavře počet a týdenní předěl nezapočítá', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const reducedEnd = Date.parse('2026-03-02T16:00:00.000Z')
  const toUtc = Date.parse('2026-03-04T21:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-03T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes: [
      reducedNode(fromUtc, reducedEnd, 'daily-9'),
      reducedNode(reducedEnd, toUtc, 'weekly'),
      endNode(toUtc),
    ],
    paths: [
      {
        steps: [
          { anchorUtc: fromUtc, interpretationId: 'daily-9' },
          { anchorUtc: reducedEnd, interpretationId: 'weekly' },
          { anchorUtc: toUtc, interpretationId: null },
        ],
        reducedCount: 2,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
  })
  assert.deepEqual(result.dailyReduced, { status: 'summed', fromUtc, toUtc, reducedCount: 1 })
  const interval = result.reducedDailyIntervals[0]
  assert.equal(interval?.status, 'summed')
  if (interval?.status !== 'summed') return
  assert.equal(interval.reducedCount, 1)
  assert.equal(interval.limitEvaluated, false)
  assert.deepEqual(interval.rests, [
    { startUtc: reducedEnd - 9 * HOUR, endUtc: reducedEnd, sourceActivityIds: ['daily-9'] },
  ])
  assert.equal(Object.hasOwn(interval, 'infringement'), false)
  assert.equal(Object.hasOwn(result, 'infringement'), false)
})

test('sousední období mají samostatné počty', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const middle = Date.parse('2026-03-08T18:00:00.000Z')
  const last = Date.parse('2026-03-16T12:00:00.000Z')
  const early = first + 10 * HOUR
  const laterA = middle + 10 * HOUR
  const laterB = middle + 20 * HOUR
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), middle, { sourceActivityIds: ['weekly-1'] }),
    candidate(Date.parse('2026-03-14T12:00:00.000Z'), last, { sourceActivityIds: ['weekly-2'] }),
  ])
  const chain: DailyRestChain = {
    startAnchorUtc: first,
    nodes: [
      reducedNode(first, early, 'reduced-1'),
      { ...reducedNode(early, middle, 'bridge-1'), interpretations: [{ ...reducedNode(early, middle, 'bridge-1').interpretations[0]!, reducedDelta: 0, kind: 'continuous_regular' }] },
      reducedNode(middle, laterA, 'reduced-2'),
      reducedNode(laterA, laterB, 'reduced-3'),
      { ...reducedNode(laterB, last, 'bridge-2'), interpretations: [{ ...reducedNode(laterB, last, 'bridge-2').interpretations[0]!, reducedDelta: 0, kind: 'continuous_regular' }] },
      endNode(last),
    ],
    paths: [
      {
        steps: [first, early, middle, laterA, laterB, last].map((anchorUtc, index, all) => ({
          anchorUtc,
          interpretationId: index === all.length - 1 ? null : ['reduced-1', 'bridge-1', 'reduced-2', 'reduced-3', 'bridge-2'][index]!,
        })),
        reducedCount: 3,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: first,
    selections: [select(weekly[0]!, 'w0'), select(weekly[1]!, 'w1')],
    clock: clock(4),
    dailyChain: chain,
  })
  assert.equal(result.dailyReduced.status, 'undecided')
  assert.deepEqual(
    result.reducedDailyIntervals.map((interval) => interval.status === 'summed' ? interval.reducedCount : interval.reason),
    [1, 2],
  )
  assert.equal(result.reducedDailyIntervals.every((interval) => interval.limitEvaluated === false), true)
})

test('neshoda alternativních cest počet neuzavře', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const reduced = reducedNode(fromUtc, fromUtc + 10 * HOUR, 'daily-9')
  const regular = {
    ...reduced,
    interpretations: [{ ...reduced.interpretations[0]!, id: 'regular', reducedDelta: 0, kind: 'continuous_regular' as const }],
  }
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes: [{ ...reduced, interpretations: [...reduced.interpretations, ...regular.interpretations] }, endNode(toUtc)],
    paths: [
      { steps: [{ anchorUtc: fromUtc, interpretationId: 'daily-9' }, { anchorUtc: toUtc, interpretationId: null }], reducedCount: 1, weeklyBoundariesDetermined: false },
      { steps: [{ anchorUtc: fromUtc, interpretationId: 'regular' }, { anchorUtc: toUtc, interpretationId: null }], reducedCount: 0, weeklyBoundariesDetermined: false },
    ],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
  })
  assert.equal(result.dailyReduced.status, 'undecided')
  assert.equal(result.reducedDailyIntervals[0]?.status, 'undecided')
  if (result.reducedDailyIntervals[0]?.status !== 'undecided') return
  assert.equal(result.reducedDailyIntervals[0].reason, 'paths_disagree')
})

test('neprokázaný odpočinek počet neuzavře', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const reducedEnd = Date.parse('2026-03-02T16:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes: [reducedNode(fromUtc, reducedEnd, 'daily-9', false), endNode(toUtc)],
    paths: [
      {
        steps: [
          { anchorUtc: fromUtc, interpretationId: 'daily-9' },
          { anchorUtc: toUtc, interpretationId: null },
        ],
        reducedCount: 1,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
  chain.nodes[0]!.interpretations[0]!.nextAnchorUtc = toUtc
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
  })
  assert.equal(result.reducedDailyIntervals[0]?.status, 'undecided')
  if (result.reducedDailyIntervals[0]?.status !== 'undecided') return
  assert.equal(result.reducedDailyIntervals[0].reason, 'unproven_rest')
})

test('neznámý úsek mezi předěly počet neuzavře', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes: [reducedNode(fromUtc, fromUtc + 10 * HOUR, 'daily-9'), endNode(toUtc)],
    paths: [{ steps: [{ anchorUtc: fromUtc, interpretationId: 'daily-9' }, { anchorUtc: toUtc, interpretationId: null }], reducedCount: 1, weeklyBoundariesDetermined: false }],
  }
  chain.nodes[0]!.interpretations[0]!.nextAnchorUtc = toUtc
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
    unknownIntervals: [{ startUtc: fromUtc + HOUR, endUtc: fromUtc + 2 * HOUR }],
  })
  assert.equal(result.reducedDailyIntervals[0]?.status, 'undecided')
  if (result.reducedDailyIntervals[0]?.status !== 'undecided') return
  assert.equal(result.reducedDailyIntervals[0].reason, 'unknown_interval')
})

test('analysis_gap mezi předěly počet nesčítá', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes: [reducedNode(fromUtc, fromUtc + 10 * HOUR, 'daily-9'), endNode(toUtc)],
    paths: [{ steps: [{ anchorUtc: fromUtc, interpretationId: 'daily-9' }, { anchorUtc: toUtc, interpretationId: null }], reducedCount: 1, weeklyBoundariesDetermined: false }],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
    dailySegments: [
      { kind: 'analysis_gap', startUtc: fromUtc + 24 * HOUR, endUtc: fromUtc + 36 * HOUR },
      { kind: 'chain', anchorUtc: fromUtc + 36 * HOUR },
    ],
  })
  assert.equal(result.dailyReduced.status, 'undecided')
  assert.equal(result.reducedDailyIntervals[0]?.status, 'undecided')
  if (result.reducedDailyIntervals[0]?.status !== 'undecided') return
  assert.equal(result.reducedDailyIntervals[0].reason, 'analysis_gap')
})

test('denní kotva mimo týdenní předěl počet neuzavře', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const anchor = fromUtc + 5 * HOUR
  const chain: DailyRestChain = {
    startAnchorUtc: anchor,
    nodes: [reducedNode(anchor, anchor + 10 * HOUR, 'daily-9'), endNode(toUtc)],
    paths: [{ steps: [{ anchorUtc: anchor, interpretationId: 'daily-9' }, { anchorUtc: toUtc, interpretationId: null }], reducedCount: 1, weeklyBoundariesDetermined: false }],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
  })
  assert.equal(result.reducedDailyIntervals[0]?.status, 'undecided')
  if (result.reducedDailyIntervals[0]?.status !== 'undecided') return
  assert.equal(result.reducedDailyIntervals[0].reason, 'anchor_mismatch')
})

test('čtyři zkrácené odpočinky vrátí počet 4 bez závěru o porušení', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const ends = [1, 2, 3, 4].map((index) => fromUtc + index * 12 * HOUR)
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const anchors = [fromUtc, ...ends]
  const nodes = ends.map((end, index) => reducedNode(anchors[index]!, end, `reduced-${index + 1}`))
  nodes.push(endNode(toUtc))
  const chain: DailyRestChain = {
    startAnchorUtc: fromUtc,
    nodes,
    paths: [
      {
        steps: [
          ...ends.map((end, index) => ({ anchorUtc: anchors[index]!, interpretationId: `reduced-${index + 1}` })),
          { anchorUtc: toUtc, interpretationId: null },
        ],
        reducedCount: 4,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chain,
  })
  const interval = result.reducedDailyIntervals[0]
  assert.equal(interval?.status, 'summed')
  if (interval?.status !== 'summed') return
  assert.equal(interval.reducedCount, 4)
  assert.equal(interval.limitEvaluated, false)
  assert.deepEqual(interval.rests.map((rest) => rest.sourceActivityIds), [['reduced-1'], ['reduced-2'], ['reduced-3'], ['reduced-4']])
  assert.equal(Object.hasOwn(interval, 'infringement'), false)
  assert.equal(Object.hasOwn(result, 'infringement'), false)
})

test('automaticky navržený týdenní konec není předěl', () => {
  const firstEnd = Date.parse('2026-03-04T18:00:00.000Z')
  const secondEnd = Date.parse('2026-03-12T18:00:00.000Z')
  const classified = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-02T18:00:00.000Z'), firstEnd, { sourceActivityIds: ['first'] }),
    candidate(Date.parse('2026-03-10T18:00:00.000Z'), secondEnd, { sourceActivityIds: ['second'] }),
  ])
  const assignment = buildWeeklyRestAssignment({ candidates: classified })
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: Date.parse('2026-03-01T06:00:00.000Z'),
    selections: [select(classified[0]!, 'w0')],
    clock: clock(3),
  })
  assert.equal(assignment.recommendationIsLegalFinding, false)
  assert.deepEqual(result.boundaryEndsUtc, [firstEnd])
  assert.equal(result.reducedDailyIntervals.some((interval) => interval.toUtc === secondEnd || interval.fromUtc === secondEnd), false)
})

function chainWithReducedCount(count: number): DailyRestChain {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const ends = Array.from({ length: count }, (_, index) => fromUtc + (index + 1) * 12 * HOUR)
  const anchors = [fromUtc, ...ends.slice(0, -1)]
  const nodes = count === 0
    ? [endNode(toUtc)]
    : [...anchors.map((anchor, index) => reducedNode(anchor, ends[index]!, `reduced-${index + 1}`)), endNode(toUtc)]
  if (count === 0) {
    nodes.unshift({
      ...reducedNode(fromUtc, toUtc, 'regular'),
      interpretations: [{ ...reducedNode(fromUtc, toUtc, 'regular').interpretations[0]!, reducedDelta: 0, kind: 'continuous_regular' }],
    })
  }
  return {
    startAnchorUtc: fromUtc,
    nodes,
    paths: [
      {
        steps: count === 0
          ? [{ anchorUtc: fromUtc, interpretationId: 'regular' }, { anchorUtc: toUtc, interpretationId: null }]
          : [
              ...anchors.map((anchorUtc, index) => ({ anchorUtc, interpretationId: `reduced-${index + 1}` })),
              { anchorUtc: toUtc, interpretationId: null },
            ],
        reducedCount: count,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
}

function assessCount(count: number) {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  return assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chainWithReducedCount(count),
  })
}

test('počty 0 až 3 limit tří nepřekročí', () => {
  for (const count of [0, 1, 2, 3]) {
    const result = assessCount(count)
    const interval = result.reducedDailyIntervals[0]
    const check = result.reducedDailyLimitChecks[0]
    assert.equal(interval?.status, 'summed')
    if (interval?.status !== 'summed' || check == null) return
    assert.equal(interval.reducedCount, count)
    assert.equal(check.status, 'within_limit')
    assert.equal(check.exceeded, false)
    assert.equal(check.limit, 3)
    assert.equal(check.rule, 'ec_561_2006_article_8_4')
    assert.equal(Object.hasOwn(check, 'infringement'), false)
    if (count === 1) {
      assert.deepEqual(result.dailyReduced, { status: 'summed', fromUtc: interval.fromUtc, toUtc: interval.toUtc, reducedCount: 1 })
    }
  }
})

test('počty 4 a 5 překročí jen limit tří zkrácených denních odpočinků', () => {
  for (const count of [4, 5]) {
    const result = assessCount(count)
    const interval = result.reducedDailyIntervals[0]
    const check = result.reducedDailyLimitChecks[0]
    assert.equal(interval?.status, 'summed')
    if (interval?.status !== 'summed' || check?.status !== 'exceeded') return
    assert.equal(interval.reducedCount, count)
    assert.deepEqual(interval.rests.map((rest) => rest.sourceActivityIds), Array.from({ length: count }, (_, index) => [`reduced-${index + 1}`]))
    assert.equal(check.reducedCount, count)
    assert.equal(check.exceeded, true)
    assert.equal(check.limit, 3)
    assert.equal(check.rule, 'ec_561_2006_article_8_4')
    assert.equal(Object.hasOwn(check, 'severity'), false)
    assert.equal(Object.hasOwn(result, 'infringement'), false)
    assert.deepEqual(result.dailyReduced, { status: 'summed', fromUtc: interval.fromUtc, toUtc: interval.toUtc, reducedCount: count })
  }
})

test('sousední období mají nezávislé kontroly limitu', () => {
  const first = Date.parse('2026-03-02T06:00:00.000Z')
  const middle = Date.parse('2026-03-08T18:00:00.000Z')
  const last = Date.parse('2026-03-16T12:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), middle, { sourceActivityIds: ['weekly-1'] }),
    candidate(Date.parse('2026-03-14T12:00:00.000Z'), last, { sourceActivityIds: ['weekly-2'] }),
  ])
  const firstEnds = [1, 2, 3].map((index) => first + index * 10 * HOUR)
  const secondEnds = [1, 2, 3, 4].map((index) => middle + index * 10 * HOUR)
  const firstAnchors = [first, ...firstEnds.slice(0, -1)]
  const secondAnchors = [middle, ...secondEnds.slice(0, -1)]
  const chain: DailyRestChain = {
    startAnchorUtc: first,
    nodes: [
      ...firstAnchors.map((anchor, index) => reducedNode(anchor, firstEnds[index]!, `a-${index + 1}`)),
      ...secondAnchors.map((anchor, index) => reducedNode(anchor, secondEnds[index]!, `b-${index + 1}`)),
      endNode(last),
    ],
    paths: [
      {
        steps: [
          ...firstAnchors.map((anchorUtc, index) => ({ anchorUtc, interpretationId: `a-${index + 1}` })),
          ...secondAnchors.map((anchorUtc, index) => ({ anchorUtc, interpretationId: `b-${index + 1}` })),
          { anchorUtc: last, interpretationId: null },
        ],
        reducedCount: 7,
        weeklyBoundariesDetermined: false,
      },
    ],
  }
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: first,
    selections: [select(weekly[0]!, 'w0'), select(weekly[1]!, 'w1')],
    clock: clock(4),
    dailyChain: chain,
  })
  assert.equal(result.dailyReduced.status, 'undecided')
  assert.deepEqual(result.reducedDailyLimitChecks.map((check) => check.status), ['within_limit', 'exceeded'])
  assert.deepEqual(
    result.reducedDailyIntervals.map((interval) => interval.status === 'summed' ? interval.rests.map((rest) => rest.sourceActivityIds[0]) : []),
    [['a-1', 'a-2', 'a-3'], ['b-1', 'b-2', 'b-3', 'b-4']],
  )
})

test('nerozhodnutý počet nemá závěr o limitu', () => {
  const fromUtc = Date.parse('2026-03-02T06:00:00.000Z')
  const toUtc = Date.parse('2026-03-08T18:00:00.000Z')
  const weekly = classifyWeeklyRestCandidates([
    candidate(Date.parse('2026-03-07T00:00:00.000Z'), toUtc, { sourceActivityIds: ['weekly'] }),
  ])[0]!
  const result = assessWeeklyRests({
    previousWeeklyEndUtc: fromUtc,
    selections: [select(weekly, 'w0')],
    clock: clock(3),
    dailyChain: chainWithReducedCount(2),
    unknownIntervals: [{ startUtc: fromUtc + HOUR, endUtc: fromUtc + 2 * HOUR }],
  })
  assert.equal(result.dailyReduced.status, 'undecided')
  assert.equal(result.reducedDailyIntervals[0]?.status, 'undecided')
  const check = result.reducedDailyLimitChecks[0]
  assert.equal(check?.status, 'not_concluded')
  if (check?.status !== 'not_concluded' || result.reducedDailyIntervals[0]?.status !== 'undecided') return
  assert.equal(check.reason, result.reducedDailyIntervals[0].reason)
  assert.equal(check.reason, 'unknown_interval')
  assert.equal(Object.hasOwn(check, 'exceeded'), false)
})
