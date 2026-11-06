import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'
import type { WeekClock, WeeklyRestCandidate } from '../src/analysis/weeklyRest.ts'

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR
const MONDAY = Date.parse('2026-03-02T00:00:00.000Z')
const ANCHOR = Date.parse('2026-03-02T06:00:00.000Z')

function activity(id: string, kind: Activity['kind'], startUtc: number, endUtc: number, overrides: Partial<Activity> = {}): Activity {
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
    cardNumber: 'TEST',
    firstName: 'Test',
    surname: 'Driver',
    lastWithdrawalUtc: null,
    activities,
    locations: [],
    violations: [],
  }
}

function clock(): WeekClock {
  return {
    weeks: [{ id: 'w0', startUtc: MONDAY, endUtc: MONDAY + WEEK }],
  }
}

function sampleActivities(): Activity[] {
  return [
    activity('rest-11', 'rest', Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T19:00:00.000Z')),
    activity('drive-1', 'driving', Date.parse('2026-03-02T19:00:00.000Z'), Date.parse('2026-03-02T20:00:00.000Z')),
    activity('manual-48', 'rest', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-04T20:00:00.000Z'), {
      isManualEntry: true,
    }),
    activity('gap-1', 'unknown', Date.parse('2026-03-05T00:00:00.000Z'), Date.parse('2026-03-06T00:00:00.000Z')),
  ]
}

test('průchod původních aktivit zachová zdroje a neznámý úsek nepovažuje za odpočinek', () => {
  const activities = sampleActivities()
  const snapshot = structuredClone(activities)
  const weekly = analyzeDriverActivities({ card: card(activities), dailyAnchorUtc: ANCHOR }).candidates.weeklyRestCandidates
  const manual = weekly.find((item) => item.sourceActivityIds.includes('manual-48'))
  assert.ok(manual)
  const analysis = analyzeDriverActivities({
    card: card(activities),
    dailyAnchorUtc: ANCHOR,
    weekly: {
      previousWeeklyEndUtc: ANCHOR,
      selections: [{ candidate: manual as WeeklyRestCandidate, weekId: 'w0' }],
      clock: clock(),
    },
  })

  assert.deepEqual(activities, snapshot)
  assert.deepEqual(
    analysis.recorded.activities.map((item) => item.id),
    ['rest-11', 'drive-1', 'manual-48', 'gap-1'],
  )
  assert.equal(analysis.recorded.activities[2]?.isManualEntry, true)
  assert.deepEqual(analysis.recorded.unknownIntervals, [
    {
      startUtc: Date.parse('2026-03-05T00:00:00.000Z'),
      endUtc: Date.parse('2026-03-06T00:00:00.000Z'),
      sourceActivityIds: ['gap-1'],
    },
  ])
  assert.equal(analysis.candidates.restIntervals.some((interval) => interval.sourceActivityIds.includes('gap-1')), false)
  assert.equal(analysis.candidates.restIntervals.some((interval) => interval.sourceActivityIds.includes('rest-11')), true)
  assert.equal(manual?.manualEntry, true)
  assert.equal(manual?.lengthClass, 'regular')
  assert.equal(Object.hasOwn(manual as WeeklyRestCandidate, 'error'), false)
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status === 'assessed') {
    assert.equal(analysis.assessed.daily.anchorUtc, ANCHOR)
    assert.equal(analysis.assessed.daily.anchorOrigin, 'explicit')
    assert.equal(analysis.assessed.daily.chain.nodes[0]?.interpretations[0]?.kind, 'continuous_regular')
    assert.deepEqual(analysis.assessed.daily.chain.nodes[0]?.interpretations[0]?.parts[0]?.sourceActivityIds, ['rest-11'])
  }
  assert.equal(analysis.assessed.weekly.status, 'assessed')
  if (analysis.assessed.weekly.status === 'assessed') {
    assert.equal(analysis.assessed.weekly.result.selections[0]?.timing.status, 'on_time')
    assert.equal(analysis.assessed.weekly.result.selections[0]?.manualEntry, true)
    assert.deepEqual(analysis.assessed.weekly.result.boundaryEndsUtc, [manual?.endUtc])
  }
  assert.equal(analysis.notEvaluated.every((item) => item.status === 'not_evaluated'), true)
  assert.equal(Object.hasOwn(analysis, 'infringement'), false)
})

test('chybějící kotva není prázdné denní vyhodnocení', () => {
  const analysis = analyzeDriverActivities({ card: card(sampleActivities()) })
  assert.ok(analysis.candidates.restIntervals.length > 0)
  assert.ok(analysis.candidates.weeklyRestCandidates.length > 0)
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status === 'assessed') {
    assert.equal(analysis.assessed.daily.anchorOrigin, 'proven_rest_end')
    assert.equal(analysis.assessed.daily.anchorUtc, Date.parse('2026-03-02T19:00:00.000Z'))
  }
  assert.deepEqual(analysis.assessed.weekly, { status: 'requires_input', missing: ['weekly_selection'] })
})

test('bez odpočinku dlouhého 11 hodin zůstane denní řetězec bez kotvy', () => {
  const analysis = analyzeDriverActivities({
    card: card([activity('short', 'rest', ANCHOR, ANCHOR + 10 * HOUR)]),
  })
  assert.deepEqual(analysis.assessed.daily, { status: 'requires_input', missing: ['daily_anchor'] })
})

test('chybějící výběr týdenních odpočinků ponechá jen délkové kandidáty', () => {
  const analysis = analyzeDriverActivities({ card: card(sampleActivities()), dailyAnchorUtc: ANCHOR })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  assert.equal(analysis.candidates.weeklyRestCandidates.length, 1)
  assert.deepEqual(analysis.assessed.weekly, { status: 'requires_input', missing: ['weekly_selection'] })
  const withoutClock = analyzeDriverActivities({
    card: card(sampleActivities()),
    dailyAnchorUtc: ANCHOR,
    weekly: {
      previousWeeklyEndUtc: ANCHOR,
      selections: [
        {
          candidate: analysis.candidates.weeklyRestCandidates[0]!,
          weekId: 'w0',
        },
      ],
      clock: { weeks: [] },
    },
  })
  assert.deepEqual(withoutClock.assessed.weekly, { status: 'requires_input', missing: ['week_clock'] })
})

test('stejná kotva propojí denní návaznost se součtem zkrácených odpočinků', () => {
  const weeklyEnd = Date.parse('2026-03-04T21:00:00.000Z')
  const activities = [
    activity('daily-9', 'rest', ANCHOR, ANCHOR + 9 * HOUR),
    activity('weekly-45', 'rest', Date.parse('2026-03-03T00:00:00.000Z'), weeklyEnd),
  ]
  const preview = analyzeDriverActivities({ card: card(activities), dailyAnchorUtc: ANCHOR })
  const weeklyCandidate = preview.candidates.weeklyRestCandidates[0]
  assert.ok(weeklyCandidate)
  const analysis = analyzeDriverActivities({
    card: card(activities),
    dailyAnchorUtc: ANCHOR,
    weekly: {
      previousWeeklyEndUtc: ANCHOR,
      selections: [{ candidate: weeklyCandidate, weekId: 'w0' }],
      clock: clock(),
    },
  })
  assert.equal(analysis.assessed.weekly.status, 'assessed')
  if (analysis.assessed.weekly.status === 'assessed') {
    assert.deepEqual(analysis.assessed.weekly.result.dailyReduced, {
      status: 'summed',
      fromUtc: ANCHOR,
      toUtc: weeklyEnd,
      reducedCount: 1,
    })
  }
})

test('automatická kotva je konec prvního odpočinku dlouhého 11 hodin', () => {
  const firstEnd = Date.parse('2026-03-02T18:00:00.000Z')
  const secondEnd = Date.parse('2026-03-03T08:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('drive', 'driving', Date.parse('2026-03-02T05:00:00.000Z'), Date.parse('2026-03-02T07:00:00.000Z')),
      activity('first', 'rest', Date.parse('2026-03-02T07:00:00.000Z'), firstEnd),
      activity('second', 'rest', Date.parse('2026-03-02T20:00:00.000Z'), secondEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.anchorOrigin, 'proven_rest_end')
  assert.equal(analysis.assessed.daily.anchorUtc, firstEnd)
  assert.notEqual(analysis.assessed.daily.anchorUtc, Date.parse('2026-03-02T05:00:00.000Z'))
  assert.equal(analysis.assessed.daily.chain.startAnchorUtc, firstEnd)
  assert.equal(analysis.assessed.daily.chain.nodes.some((node) => node.anchorUtc === secondEnd), true)
  assert.equal(Object.hasOwn(analysis.assessed.daily, 'uncoveredTail'), false)
})

test('ruční kotva má přednost před automatickým koncem odpočinku', () => {
  const restEnd = Date.parse('2026-03-02T19:00:00.000Z')
  const activities = [activity('rest-11', 'rest', Date.parse('2026-03-02T08:00:00.000Z'), restEnd)]
  const manual = analyzeDriverActivities({ card: card(activities), dailyAnchorUtc: ANCHOR })
  const automatic = analyzeDriverActivities({ card: card(activities) })
  assert.equal(manual.assessed.daily.status, 'assessed')
  assert.equal(automatic.assessed.daily.status, 'assessed')
  if (manual.assessed.daily.status !== 'assessed' || automatic.assessed.daily.status !== 'assessed') return
  assert.equal(manual.assessed.daily.anchorOrigin, 'explicit')
  assert.equal(manual.assessed.daily.anchorUtc, ANCHOR)
  assert.equal(automatic.assessed.daily.anchorOrigin, 'proven_rest_end')
  assert.equal(automatic.assessed.daily.anchorUtc, restEnd)
})

test('přesně 11 hodin je kotva a o minutu kratší odpočinek kotvu nedá', () => {
  const exactEnd = ANCHOR + 11 * HOUR
  const exact = analyzeDriverActivities({
    card: card([activity('exact', 'rest', ANCHOR, exactEnd)]),
  })
  const short = analyzeDriverActivities({
    card: card([activity('short', 'rest', ANCHOR, exactEnd - 60_000)]),
  })
  assert.equal(exact.assessed.daily.status, 'assessed')
  if (exact.assessed.daily.status === 'assessed') {
    assert.equal(exact.assessed.daily.anchorUtc, exactEnd)
    assert.equal(exact.assessed.daily.anchorOrigin, 'proven_rest_end')
  }
  assert.deepEqual(short.assessed.daily, { status: 'requires_input', missing: ['daily_anchor'] })
})

test('konec neznámého úseku není kotva a odpočinek přes neznámý úsek se přeskočí', () => {
  const unknownEnd = Date.parse('2026-03-02T10:00:00.000Z')
  const cleanEnd = Date.parse('2026-03-03T09:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('gap', 'unknown', Date.parse('2026-03-02T00:00:00.000Z'), unknownEnd),
      activity('crossed', 'rest', Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T20:00:00.000Z')),
      activity('clean', 'rest', Date.parse('2026-03-02T22:00:00.000Z'), cleanEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.anchorUtc, cleanEnd)
  assert.notEqual(analysis.assessed.daily.anchorUtc, unknownEnd)
  assert.notEqual(analysis.assessed.daily.anchorUtc, Date.parse('2026-03-02T00:00:00.000Z'))
})

test('více denních variant zůstane v cestách jednoho řetězce', () => {
  const anchorEnd = Date.parse('2026-03-02T18:00:00.000Z')
  const secondEnd = Date.parse('2026-03-03T10:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('lead', 'rest', Date.parse('2026-03-02T07:00:00.000Z'), anchorEnd),
      activity('part-3', 'rest', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-02T23:00:00.000Z')),
      activity('work', 'work', Date.parse('2026-03-02T23:00:00.000Z'), Date.parse('2026-03-03T01:00:00.000Z')),
      activity('part-9', 'rest', Date.parse('2026-03-03T01:00:00.000Z'), secondEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  const chain = analysis.assessed.daily.chain
  assert.equal(chain.startAnchorUtc, anchorEnd)
  assert.equal(chain.paths.length, 2)
  assert.deepEqual(chain.paths.map((path) => path.reducedCount).sort(), [0, 1])
  assert.deepEqual(
    chain.nodes[0]?.interpretations.map((item) => item.kind).sort(),
    ['continuous_reduced', 'split_regular'],
  )
  assert.ok(chain.paths.every((path) => path.steps.some((step) => step.anchorUtc === secondEnd)))
})

test('zastavený řetězec si ponechá důvod ukončení', () => {
  const restEnd = Date.parse('2026-03-02T18:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('lead', 'rest', Date.parse('2026-03-02T07:00:00.000Z'), restEnd),
      activity('gap', 'unknown', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-03T08:00:00.000Z')),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.anchorUtc, restEnd)
  assert.equal(analysis.assessed.daily.chain.nodes[0]?.status, 'insufficient_data')
  assert.deepEqual(analysis.assessed.daily.chain.nodes[0]?.interpretations, [])
  assert.equal(analysis.assessed.daily.chain.paths[0]?.steps[0]?.interpretationId, null)
})
