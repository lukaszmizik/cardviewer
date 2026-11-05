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
  assert.deepEqual(analysis.assessed.daily, { status: 'requires_input', missing: ['daily_anchor'] })
  assert.deepEqual(analysis.assessed.weekly, { status: 'requires_input', missing: ['weekly_selection'] })
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
