import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import type { DailyRestChain } from '../src/analysis/dailyRestChain.ts'
import { diagnoseProposedReducedCount } from '../src/analysis/weeklyRest.ts'
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

test('analysis_gap mezi týdenními předěly počet nesčítá', () => {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const weeklyEnd = Date.parse('2026-03-06T02:00:00.000Z')
  const activities = [
    activity('initial', 'rest', origin, anchor),
    activity('drive-1', 'driving', anchor, anchor + 4.5 * HOUR),
    activity('break-1', 'rest', anchor + 4.5 * HOUR, anchor + 5.25 * HOUR),
    activity('drive-2', 'driving', anchor + 5.25 * HOUR, anchor + 9.75 * HOUR),
    activity('short', 'rest', anchor + 9.75 * HOUR, anchor + 17.75 * HOUR),
    activity('work', 'work', anchor + 17.75 * HOUR, Date.parse('2026-03-03T18:00:00.000Z')),
    activity('resume', 'rest', Date.parse('2026-03-03T18:00:00.000Z'), Date.parse('2026-03-04T05:00:00.000Z')),
    activity('weekly', 'rest', Date.parse('2026-03-04T06:00:00.000Z'), weeklyEnd),
  ]
  const preview = analyzeDriverActivities({ card: card(activities) })
  const weekly = preview.candidates.weeklyRestCandidates.find((item) => item.sourceActivityIds.includes('weekly'))
  assert.ok(weekly)
  assert.equal(preview.assessed.daily.status, 'assessed')
  if (preview.assessed.daily.status !== 'assessed') return
  assert.equal(preview.assessed.daily.segments.some((segment) => segment.kind === 'analysis_gap'), true)
  const analysis = analyzeDriverActivities({
    card: card(activities),
    weekly: {
      previousWeeklyEndUtc: anchor,
      selections: [{ candidate: weekly, weekId: 'w0' }],
      clock: clock(),
    },
  })
  assert.equal(analysis.assessed.weekly.status, 'assessed')
  if (analysis.assessed.weekly.status !== 'assessed') return
  assert.equal(analysis.assessed.weekly.result.dailyReduced.status, 'undecided')
  const interval = analysis.assessed.weekly.result.reducedDailyIntervals[0]
  assert.equal(interval?.status, 'undecided')
  if (interval?.status !== 'undecided') return
  assert.equal(interval.reason, 'analysis_gap')
  assert.equal(interval.limitEvaluated, false)
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
  assert.deepEqual(analysis.assessed.daily.segments, [])
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
  assert.deepEqual(analysis.assessed.daily.segments, [])
})

test('tři pracovní cykly po 13 a 11 hodinách navazují od automatické kotvy', () => {
  const HOUR_MS = 60 * 60 * 1000
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const initialEnd = origin + 11 * HOUR_MS
  const activities: Activity[] = [
    activity('initial-rest', 'rest', origin, initialEnd),
  ]
  const expectedRests = [initialEnd]
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const workStart = initialEnd + (cycle - 1) * 24 * HOUR_MS
    const restStart = workStart + 13 * HOUR_MS
    const restEnd = restStart + 11 * HOUR_MS
    activities.push(activity(`work-${cycle}`, 'driving', workStart, restStart))
    activities.push(activity(`rest-${cycle}`, 'rest', restStart, restEnd))
    expectedRests.push(restEnd)
  }

  const analysis = analyzeDriverActivities({ card: card(activities) })
  const iso = (utc: number) => new Date(utc).toISOString()
  const daily = analysis.assessed.daily
  const chain = daily.status === 'assessed' ? daily.chain : null
  const report = {
    input: activities.map((item) => ({ id: item.id, kind: item.kind, start: iso(item.startUtc), end: iso(item.endUtc) })),
    expectedAnchor: iso(initialEnd),
    expectedWindows: expectedRests.slice(0, 3).map((start, index) => ({
      start: iso(start),
      end: iso(start + 24 * HOUR_MS),
      restId: `rest-${index + 1}`,
      nextAnchor: iso(expectedRests[index + 1]!),
    })),
    actual: daily.status !== 'assessed'
      ? daily
      : {
          anchorOrigin: daily.anchorOrigin,
          anchor: iso(daily.anchorUtc),
          paths: chain?.paths.length,
          nodes: chain?.nodes.map((node) => ({
            status: node.status,
            start: iso(node.windowStartUtc),
            end: iso(node.windowEndUtc),
            interpretations: node.interpretations.map((item) => ({
              kind: item.kind,
              qualifiesWindow: item.qualifiesWindow,
              nextAnchor: item.nextAnchorUtc == null ? null : iso(item.nextAnchorUtc),
              sources: item.parts.map((part) => part.sourceActivityIds),
            })),
          })),
          steps: chain?.paths.map((path) =>
            path.steps.map((step) => ({ anchor: iso(step.anchorUtc), interpretation: step.interpretationId })),
          ),
          restIntervals: analysis.candidates.restIntervals.map((interval) => interval.sourceActivityIds),
        },
  }
  console.log(JSON.stringify(report, null, 2))

  assert.equal(daily.status, 'assessed')
  if (daily.status !== 'assessed' || chain == null) return
  assert.equal(daily.anchorOrigin, 'proven_rest_end')
  assert.equal(daily.anchorUtc, initialEnd)
  assert.equal(chain.paths.length, 1)
  assert.equal(chain.nodes.filter((node) => node.status === 'insufficient_data').length, 0)
  assert.deepEqual(
    analysis.candidates.restIntervals.map((interval) => interval.sourceActivityIds),
    [['initial-rest'], ['rest-1'], ['rest-2'], ['rest-3']],
  )
  const completed = chain.nodes.slice(0, 3)
  assert.equal(completed.length, 3)
  completed.forEach((node, index) => {
    const start = expectedRests[index]!
    assert.equal(node.status, 'evaluated')
    assert.equal(node.windowStartUtc, start)
    assert.equal(node.windowEndUtc, start + 24 * HOUR_MS)
    assert.equal(node.interpretations.length, 1)
    assert.equal(node.interpretations[0]?.kind, 'continuous_regular')
    assert.equal(node.interpretations[0]?.qualifiesWindow, true)
    assert.equal(node.interpretations[0]?.nextAnchorUtc, expectedRests[index + 1])
    assert.deepEqual(node.interpretations[0]?.parts.map((part) => part.sourceActivityIds), [[`rest-${index + 1}`]])
  })
  assert.equal(
    chain.nodes.some((node) => node.interpretations.some((item) => item.parts.some((part) => part.sourceActivityIds.includes('initial-rest')))),
    false,
  )
  assert.equal(chain.nodes[3]?.status, 'history_incomplete')
  assert.equal(chain.nodes[3]?.windowStartUtc, expectedRests[3])
  assert.deepEqual(chain.nodes[3]?.interpretations, [])
  assert.equal(chain.paths[0]?.steps[3]?.interpretationId, null)
  assert.deepEqual(daily.segments, [])
})

function dayWithRestInsideWindow(restMs: number): Activity[] {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const drive1End = anchor + 4.5 * HOUR
  const breakEnd = drive1End + 45 * 60 * 1000
  const drive2End = breakEnd + 4.5 * HOUR
  const restEnd = drive2End + restMs
  const windowEnd = anchor + 24 * HOUR
  return [
    activity('initial', 'rest', origin, anchor),
    activity('drive-1', 'driving', anchor, drive1End),
    activity('break', 'rest', drive1End, breakEnd),
    activity('drive-2', 'driving', breakEnd, drive2End),
    activity('daily', 'rest', drive2End, restEnd),
    activity('after', 'work', restEnd, windowEnd),
  ]
}

function assertRestInsideWindowDoesNotQualify(restMs: number): void {
  const analysis = analyzeDriverActivities({ card: card(dayWithRestInsideWindow(restMs)) })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  const chain = analysis.assessed.daily.chain
  const window = chain.nodes[0]
  const restEnd = Date.parse('2026-03-02T06:00:00.000Z') + 11 * HOUR + 4.5 * HOUR + 45 * 60 * 1000 + 4.5 * HOUR + restMs
  assert.equal(analysis.assessed.daily.anchorOrigin, 'proven_rest_end')
  assert.equal(window?.status, 'window_unsatisfied')
  assert.notEqual(window?.status, 'history_incomplete')
  assert.notEqual(window?.status, 'insufficient_data')
  assert.equal(window?.windowEndUtc, analysis.assessed.daily.anchorUtc + 24 * HOUR)
  assert.deepEqual(window?.interpretations ?? [], [])
  assert.equal(
    chain.nodes.some((node) => node.interpretations.some((item) => item.kind === 'continuous_reduced' || item.kind === 'continuous_regular' || item.kind === 'split_regular')),
    false,
  )
  assert.equal(
    chain.nodes.some((node) => node.interpretations.some((item) => item.nextAnchorUtc === restEnd)),
    false,
  )
  assert.equal(chain.paths.length, 1)
  assert.equal(chain.paths[0]?.steps[0]?.interpretationId, null)
  assert.deepEqual(
    analysis.candidates.restIntervals.map((interval) => interval.sourceActivityIds),
    [['initial'], ['break'], ['daily']],
  )
  assert.deepEqual(analysis.assessed.daily.segments, [])
}

test('8 hodin 59 minut uvnitř úplného okna není denní odpočinek', () => {
  assertRestInsideWindowDoesNotQualify(8 * HOUR + 59 * 60 * 1000)
})

test('8 hodin uvnitř úplného okna není denní odpočinek', () => {
  assertRestInsideWindowDoesNotQualify(8 * HOUR)
})

function resumedHistory(laterRest: boolean): Activity[] {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const drive1End = anchor + 4.5 * HOUR
  const break1End = drive1End + 45 * 60 * 1000
  const drive2End = break1End + 4.5 * HOUR
  const shortEnd = drive2End + 8 * HOUR
  const drive3End = shortEnd + 4.5 * HOUR
  const break2End = drive3End + 45 * 60 * 1000
  const workEnd = Date.parse('2026-03-03T18:00:00.000Z')
  const activities = [
    activity('initial', 'rest', origin, anchor),
    activity('drive-1', 'driving', anchor, drive1End),
    activity('break-1', 'rest', drive1End, break1End),
    activity('drive-2', 'driving', break1End, drive2End),
    activity('short-rest', 'rest', drive2End, shortEnd),
    activity('drive-3', 'driving', shortEnd, drive3End),
    activity('break-2', 'rest', drive3End, break2End),
    activity('work-1', 'work', break2End, workEnd),
  ]
  if (laterRest) activities.push(activity('later-rest', 'rest', workEnd, workEnd + 11 * HOUR))
  return activities
}

test('po nesplněném okně vznikne samostatný řetězec od konce pozdějšího odpočinku', () => {
  const activities = resumedHistory(true)
  const analysis = analyzeDriverActivities({ card: card(activities) })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  const daily = analysis.assessed.daily
  const chain = daily.chain
  const laterEnd = Date.parse('2026-03-04T05:00:00.000Z')
  const windowEnd = Date.parse('2026-03-03T17:00:00.000Z')
  assert.equal(daily.anchorOrigin, 'proven_rest_end')
  assert.equal(daily.anchorUtc, Date.parse('2026-03-02T17:00:00.000Z'))
  assert.equal(chain.nodes.length, 1)
  assert.equal(chain.nodes[0]?.status, 'window_unsatisfied')
  assert.deepEqual(chain.nodes[0]?.interpretations, [])
  assert.equal(chain.paths.length, 1)
  assert.equal(chain.paths[0]?.steps.length, 1)
  assert.equal(chain.paths[0]?.steps[0]?.interpretationId, null)
  assert.equal(chain.paths[0]?.weeklyBoundariesDetermined, false)
  assert.equal(Object.hasOwn(daily, 'secondChain'), false)
  assert.deepEqual(daily.segments.map((segment) => segment.kind), ['analysis_gap', 'chain'])
  const gap = daily.segments[0]
  const resumed = daily.segments[1]
  if (gap?.kind !== 'analysis_gap' || resumed?.kind !== 'chain') return
  assert.equal(gap.startUtc, windowEnd)
  assert.equal(gap.endUtc, laterEnd)
  assert.equal(gap.stoppedAnchorUtc, daily.anchorUtc)
  assert.equal(gap.stoppedStatus, 'window_unsatisfied')
  assert.equal(resumed.anchorUtc, laterEnd)
  assert.equal(resumed.anchorOrigin, 'proven_rest_end_after_stopped_chain')
  assert.deepEqual(resumed.sourceActivityIds, ['later-rest'])
  assert.equal(resumed.chain.startAnchorUtc, laterEnd)
  assert.equal(resumed.chain.nodes[0]?.status, 'history_incomplete')
  assert.notEqual(resumed.chain, chain)
  assert.equal(resumed.chain.paths.some((path) => path.steps.some((step) => step.anchorUtc === chain.startAnchorUtc)), false)
  assert.equal(resumed.chain.nodes.some((node) => node.interpretations.some((item) => item.parts.some((part) => part.sourceActivityIds.includes('later-rest')))), false)
  assert.equal(chain.nodes.some((node) => node.interpretations.some((item) => item.parts.some((part) => part.sourceActivityIds.includes('later-rest')))), false)
  assert.deepEqual(analysis.recorded.activities.map((item) => item.id), activities.map((item) => item.id))
  assert.deepEqual(
    analysis.candidates.restIntervals.map((interval) => interval.sourceActivityIds),
    [['initial'], ['break-1'], ['short-rest'], ['break-2'], ['later-rest']],
  )
  assert.equal(resumed.chain.paths.every((path) => path.weeklyBoundariesDetermined === false), true)
})

test('bez pozdějšího jedenáctihodinového odpočinku druhý řetězec nevznikne', () => {
  const analysis = analyzeDriverActivities({ card: card(resumedHistory(false)) })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.chain.nodes[0]?.status, 'window_unsatisfied')
  assert.deepEqual(analysis.assessed.daily.segments, [])
})

test('pokračující alternativní cesty automatické obnovení nespustí', () => {
  const anchorEnd = Date.parse('2026-03-02T18:00:00.000Z')
  const secondEnd = Date.parse('2026-03-03T10:00:00.000Z')
  const laterEnd = Date.parse('2026-03-04T05:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('lead', 'rest', Date.parse('2026-03-02T07:00:00.000Z'), anchorEnd),
      activity('part-3', 'rest', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-02T23:00:00.000Z')),
      activity('work', 'work', Date.parse('2026-03-02T23:00:00.000Z'), Date.parse('2026-03-03T01:00:00.000Z')),
      activity('part-9', 'rest', Date.parse('2026-03-03T01:00:00.000Z'), secondEnd),
      activity('drive', 'driving', secondEnd, Date.parse('2026-03-03T18:00:00.000Z')),
      activity('later-rest', 'rest', Date.parse('2026-03-03T18:00:00.000Z'), laterEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  const chain = analysis.assessed.daily.chain
  assert.equal(chain.paths.length, 2)
  assert.ok(chain.paths.every((path) => path.steps.some((step) => step.interpretationId != null)))
  assert.equal(chain.nodes.some((node) => node.anchorUtc === laterEnd), true)
  assert.deepEqual(analysis.assessed.daily.segments, [])
})

test('history_incomplete samo o sobě obnovení nespustí', () => {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const analysis = analyzeDriverActivities({
    card: card([
      activity('initial', 'rest', origin, anchor),
      activity('drive', 'driving', anchor, anchor + 4 * HOUR),
      activity('short', 'rest', anchor + 4 * HOUR, anchor + 12 * HOUR),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.chain.nodes[0]?.status, 'history_incomplete')
  assert.deepEqual(analysis.assessed.daily.segments, [])
})

test('nejasné okno zůstane nejasné a pozdější prokázaný odpočinek obnoví další řetězec', () => {
  const anchor = Date.parse('2026-03-02T18:00:00.000Z')
  const laterEnd = Date.parse('2026-03-04T05:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('lead', 'rest', Date.parse('2026-03-02T07:00:00.000Z'), anchor),
      activity('gap', 'unknown', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-03T08:00:00.000Z')),
      activity('work', 'work', Date.parse('2026-03-03T08:00:00.000Z'), Date.parse('2026-03-03T18:00:00.000Z')),
      activity('later-rest', 'rest', Date.parse('2026-03-03T18:00:00.000Z'), laterEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.chain.nodes[0]?.status, 'insufficient_data')
  assert.deepEqual(analysis.assessed.daily.chain.nodes[0]?.interpretations, [])
  assert.equal(analysis.assessed.daily.chain.nodes.some((node) => node.anchorUtc === laterEnd), false)
  assert.equal(analysis.candidates.restCandidates.some((item) => item.sourceActivityIds.includes('later-rest')), true)
  assert.deepEqual(analysis.assessed.daily.segments.map((segment) => segment.kind), ['analysis_gap', 'chain'])
  const gap = analysis.assessed.daily.segments[0]
  const resumed = analysis.assessed.daily.segments[1]
  assert.equal(gap?.kind === 'analysis_gap' && gap.stoppedStatus, 'insufficient_data')
  assert.equal(resumed?.kind === 'chain' && resumed.anchorUtc, laterEnd)
})

function activitySpan(steps: ReadonlyArray<readonly [string, Activity['kind'], number]>, origin: number): Activity[] {
  let cursor = origin
  return steps.map(([id, kind, duration]) => {
    const startUtc = cursor
    cursor += duration
    return activity(id, kind, startUtc, cursor)
  })
}

test('dvě nesplněná okna vytvoří tři řetězce a dvě mezery', () => {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const first = activitySpan([
    ['initial', 'rest', 11 * HOUR],
    ['drive-1', 'driving', 4.5 * HOUR],
    ['break-1', 'rest', 45 * 60 * 1000],
    ['drive-2', 'driving', 4.5 * HOUR],
    ['short-1', 'rest', 8 * HOUR],
    ['drive-3', 'driving', 4.5 * HOUR],
    ['break-2', 'rest', 45 * 60 * 1000],
  ], origin)
  const work1End = anchor + 25 * HOUR
  const resume1End = work1End + 11 * HOUR
  const second = activitySpan([
    ['drive-4', 'driving', 4.5 * HOUR],
    ['break-3', 'rest', 45 * 60 * 1000],
    ['drive-5', 'driving', 4.5 * HOUR],
    ['short-2', 'rest', 8 * HOUR],
    ['drive-6', 'driving', 4.5 * HOUR],
    ['break-4', 'rest', 45 * 60 * 1000],
  ], resume1End)
  const work2End = resume1End + 25 * HOUR
  const resume2End = work2End + 11 * HOUR
  const activities = [
    ...first,
    activity('work-1', 'work', first.at(-1)!.endUtc, work1End),
    activity('resume-1', 'rest', work1End, resume1End),
    ...second,
    activity('work-2', 'work', second.at(-1)!.endUtc, work2End),
    activity('resume-2', 'rest', work2End, resume2End),
    activity('drive-7', 'driving', resume2End, resume2End + 4.5 * HOUR),
    activity('break-5', 'rest', resume2End + 4.5 * HOUR, resume2End + 4.5 * HOUR + 45 * 60 * 1000),
    activity('drive-8', 'driving', resume2End + 5.25 * HOUR, resume2End + 9.75 * HOUR),
    activity('work-3', 'work', resume2End + 9.75 * HOUR, resume2End + 13 * HOUR),
    activity('daily-ok', 'rest', resume2End + 13 * HOUR, resume2End + 24 * HOUR),
  ]
  const analysis = analyzeDriverActivities({ card: card(activities) })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  const daily = analysis.assessed.daily
  assert.equal(daily.chain.nodes[0]?.status, 'window_unsatisfied')
  assert.deepEqual(daily.segments.map((segment) => segment.kind), ['analysis_gap', 'chain', 'analysis_gap', 'chain'])
  const chains = [daily.chain, ...daily.segments.filter((segment) => segment.kind === 'chain').map((segment) => segment.chain)]
  assert.equal(chains.length, 3)
  assert.equal(new Set(chains).size, 3)
  const anchors = chains.map((chain) => chain.startAnchorUtc)
  assert.deepEqual(anchors, [anchor, resume1End, resume2End])
  assert.equal(anchors[1]! > anchors[0]! && anchors[2]! > anchors[1]!, true)
  assert.equal(chains[1]?.nodes[0]?.status, 'window_unsatisfied')
  const finalNode = chains[2]?.nodes.find((node) => node.interpretations.some((item) => item.parts.some((part) => part.sourceActivityIds.includes('daily-ok'))))
  assert.equal(finalNode?.status, 'evaluated')
  assert.equal(finalNode?.interpretations[0]?.kind, 'continuous_regular')
  assert.equal(finalNode?.interpretations[0]?.qualifiesWindow, true)
  assert.equal(finalNode?.interpretations[0]?.nextAnchorUtc, resume2End + 24 * HOUR)
  for (const chain of chains) {
    const foreign = anchors.filter((item) => item !== chain.startAnchorUtc)
    assert.equal(chain.paths.some((path) => path.steps.some((step) => foreign.includes(step.anchorUtc))), false)
  }
  const gapAnchors = daily.segments.filter((segment) => segment.kind === 'analysis_gap').map((segment) => segment.kind === 'analysis_gap' ? segment.endUtc : 0)
  assert.deepEqual(gapAnchors, [resume1End, resume2End])
  assert.deepEqual(analysis.recorded.activities.map((item) => item.id), activities.map((item) => item.id))
  const restIds = analysis.candidates.restIntervals.map((interval) => interval.sourceActivityIds.join(','))
  assert.equal(new Set(restIds).size, restIds.length)
  const used = chains.flatMap((chain) => chain.nodes.flatMap((node) => node.interpretations.flatMap((item) => item.parts.flatMap((part) => part.sourceActivityIds))))
  assert.deepEqual(used.filter((id) => id === 'daily-ok'), ['daily-ok'])
  assert.equal(used.includes('short-1') || used.includes('short-2') || used.includes('resume-1') || used.includes('resume-2'), false)
})

test('bez dalšího prokázaného odpočinku se opakování zastaví', () => {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const opening = activitySpan([
    ['initial', 'rest', 11 * HOUR],
    ['drive-1', 'driving', 4.5 * HOUR],
    ['break-1', 'rest', 45 * 60 * 1000],
    ['drive-2', 'driving', 4.5 * HOUR],
    ['short-1', 'rest', 8 * HOUR],
    ['drive-3', 'driving', 4.5 * HOUR],
    ['break-2', 'rest', 45 * 60 * 1000],
  ], origin)
  const resumeEnd = anchor + 25 * HOUR + 11 * HOUR
  const second = activitySpan([
    ['drive-4', 'driving', 4.5 * HOUR],
    ['break-3', 'rest', 45 * 60 * 1000],
    ['drive-5', 'driving', 4.5 * HOUR],
    ['short-2', 'rest', 8 * HOUR],
    ['drive-6', 'driving', 4.5 * HOUR],
    ['break-4', 'rest', 45 * 60 * 1000],
  ], resumeEnd)
  const activities = [
    ...opening,
    activity('work-1', 'work', opening.at(-1)!.endUtc, anchor + 25 * HOUR),
    activity('resume-1', 'rest', anchor + 25 * HOUR, resumeEnd),
    ...second,
    activity('work-2', 'work', second.at(-1)!.endUtc, resumeEnd + 25 * HOUR),
  ]
  const analysis = analyzeDriverActivities({ card: card(activities) })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.deepEqual(analysis.assessed.daily.segments.map((segment) => segment.kind), ['analysis_gap', 'chain'])
  const resumed = analysis.assessed.daily.segments[1]
  assert.equal(resumed?.kind === 'chain' && resumed.chain.nodes[0]?.status, 'window_unsatisfied')
})

test('nejasné okno v obnoveném řetězci neukončí historii za dalším prokázaným odpočinkem', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const resumeEnd = Date.parse('2026-03-04T05:00:00.000Z')
  const temptingEnd = Date.parse('2026-03-05T17:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
      activity('drive', 'driving', anchor, Date.parse('2026-03-03T02:45:00.000Z')),
      activity('short', 'rest', Date.parse('2026-03-03T02:45:00.000Z'), Date.parse('2026-03-03T10:45:00.000Z')),
      activity('work', 'work', Date.parse('2026-03-03T10:45:00.000Z'), Date.parse('2026-03-03T18:00:00.000Z')),
      activity('resume-1', 'rest', Date.parse('2026-03-03T18:00:00.000Z'), resumeEnd),
      activity('gap', 'unknown', Date.parse('2026-03-04T06:00:00.000Z'), Date.parse('2026-03-04T08:00:00.000Z')),
      activity('after', 'work', Date.parse('2026-03-04T08:00:00.000Z'), Date.parse('2026-03-05T06:00:00.000Z')),
      activity('tempting', 'rest', Date.parse('2026-03-05T06:00:00.000Z'), temptingEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.equal(analysis.assessed.daily.segments.filter((segment) => segment.kind === 'chain').length, 2)
  const resumed = analysis.assessed.daily.segments[1]
  if (resumed?.kind !== 'chain') return
  assert.equal(resumed.chain.nodes[0]?.status, 'insufficient_data')
  assert.equal(resumed.chain.nodes[0]?.interpretations.length, 0)
  assert.equal(analysis.assessed.daily.segments.some((segment) => segment.kind === 'chain' && segment.anchorUtc === temptingEnd), true)
})

test('pokračující cesty obnoveného řetězce další obnovení zastaví', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const resumeEnd = Date.parse('2026-03-04T05:00:00.000Z')
  const part9End = resumeEnd + 16 * HOUR
  const analysis = analyzeDriverActivities({
    card: card([
      activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
      activity('drive', 'driving', anchor, Date.parse('2026-03-03T02:45:00.000Z')),
      activity('short', 'rest', Date.parse('2026-03-03T02:45:00.000Z'), Date.parse('2026-03-03T10:45:00.000Z')),
      activity('work-1', 'work', Date.parse('2026-03-03T10:45:00.000Z'), Date.parse('2026-03-03T18:00:00.000Z')),
      activity('resume-1', 'rest', Date.parse('2026-03-03T18:00:00.000Z'), resumeEnd),
      activity('part-3', 'rest', resumeEnd + 2 * HOUR, resumeEnd + 5 * HOUR),
      activity('between', 'work', resumeEnd + 5 * HOUR, resumeEnd + 7 * HOUR),
      activity('part-9', 'rest', resumeEnd + 7 * HOUR, resumeEnd + 16 * HOUR),
      activity('drive-2', 'driving', part9End, Date.parse('2026-03-05T06:00:00.000Z')),
      activity('later', 'rest', Date.parse('2026-03-05T06:00:00.000Z'), Date.parse('2026-03-05T17:00:00.000Z')),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed') return
  assert.deepEqual(analysis.assessed.daily.segments.map((segment) => segment.kind), ['analysis_gap', 'chain'])
  const resumed = analysis.assessed.daily.segments[1]
  if (resumed?.kind !== 'chain') return
  assert.equal(resumed.chain.paths.length, 2)
  assert.ok(resumed.chain.paths.every((path) => path.steps.some((step) => step.interpretationId != null)))
})

test('návrh dvojice vytvoří samostatný denní řetězec a původní analýza zůstane', () => {
  const seedEnd = Date.parse('2026-03-02T17:00:00.000Z')
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const secondEnd = Date.parse('2026-03-05T18:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('seed', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), seedEnd),
      activity('drive-1', 'driving', seedEnd, Date.parse('2026-03-03T06:00:00.000Z')),
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-2', 'driving', firstEnd, Date.parse('2026-03-04T18:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-04T18:00:00.000Z'), secondEnd),
      activity('after', 'driving', secondEnd, secondEnd + 2 * HOUR),
    ]),
  })
  assert.equal(analysis.weeklyAssignment.boundaryPair.status, 'pair')
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed' || analysis.boundaryPairDaily.status !== 'diagnostic') return
  assert.equal(analysis.boundaryPairDaily.basis, 'technical_boundary_proposal')
  assert.equal(analysis.boundaryPairDaily.legalDetermination, false)
  assert.equal(analysis.boundaryPairDaily.chain.startAnchorUtc, firstEnd)
  assert.equal(analysis.boundaryPairDaily.firstBoundaryEndUtc, firstEnd)
  assert.equal(analysis.boundaryPairDaily.reachesSecondBoundary, true)
  assert.equal(analysis.boundaryPairDaily.chain.nodes.at(-1)?.status, 'history_incomplete')
  assert.equal(analysis.boundaryPairDaily.chain.nodes.some((node) => node.anchorUtc === secondEnd), true)
  assert.equal(analysis.assessed.daily.chain.startAnchorUtc, seedEnd)
  assert.notEqual(analysis.assessed.daily.chain, analysis.boundaryPairDaily.chain)
  assert.deepEqual(analysis.assessed.daily.segments, [])
  assert.equal(analysis.assessed.weekly.status, 'requires_input')
})

test('alternativní denní cesty v diagnostickém řetězci zůstanou', () => {
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const splitEnd = Date.parse('2026-03-04T20:00:00.000Z')
  const secondEnd = Date.parse('2026-03-06T06:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, firstEnd + HOUR),
      activity('part-3', 'rest', firstEnd + HOUR, firstEnd + 4 * HOUR),
      activity('between', 'work', firstEnd + 4 * HOUR, firstEnd + 5 * HOUR),
      activity('part-9', 'rest', firstEnd + 5 * HOUR, splitEnd),
      activity('drive-2', 'driving', splitEnd, Date.parse('2026-03-05T06:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-05T06:00:00.000Z'), secondEnd),
      activity('after', 'driving', secondEnd, secondEnd + 2 * HOUR),
    ]),
  })
  assert.equal(analysis.boundaryPairDaily.status, 'diagnostic')
  if (analysis.boundaryPairDaily.status !== 'diagnostic') return
  const firstWindow = analysis.boundaryPairDaily.chain.nodes[0]
  assert.equal(firstWindow?.anchorUtc, firstEnd)
  assert.ok((firstWindow?.interpretations.length ?? 0) >= 2)
  assert.ok(analysis.boundaryPairDaily.chain.paths.length >= 2)
  assert.ok(analysis.boundaryPairDaily.chain.paths.every((path) => path.steps.length >= 1))
  assert.equal(analysis.boundaryPairDaily.reachesSecondBoundary, true)
})

test('diagnostický řetězec neobnovuje zastavená okna', () => {
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const secondEnd = Date.parse('2026-03-06T18:00:00.000Z')
  const unsatisfied = analyzeDriverActivities({
    card: card([
      activity('seed', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-02T17:00:00.000Z')),
      activity('drive-1', 'driving', Date.parse('2026-03-02T17:00:00.000Z'), Date.parse('2026-03-03T06:00:00.000Z')),
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-2', 'driving', firstEnd, firstEnd + 14 * HOUR),
      activity('short', 'rest', firstEnd + 14 * HOUR, firstEnd + 22 * HOUR),
      activity('work', 'work', firstEnd + 22 * HOUR, Date.parse('2026-03-05T18:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-05T18:00:00.000Z'), secondEnd),
      activity('after', 'driving', secondEnd, secondEnd + 2 * HOUR),
    ]),
  })
  assert.equal(unsatisfied.assessed.daily.status, 'assessed')
  assert.equal(unsatisfied.boundaryPairDaily.status, 'diagnostic')
  if (unsatisfied.assessed.daily.status !== 'assessed' || unsatisfied.boundaryPairDaily.status !== 'diagnostic') return
  assert.deepEqual(unsatisfied.assessed.daily.segments.map((segment) => segment.kind), ['analysis_gap', 'chain'])
  assert.equal(unsatisfied.assessed.daily.segments[1]?.kind === 'chain' ? unsatisfied.assessed.daily.segments[1].anchorUtc : null, secondEnd)
  assert.equal(unsatisfied.boundaryPairDaily.chain.nodes[0]?.status, 'window_unsatisfied')
  assert.deepEqual(unsatisfied.boundaryPairDaily.chain.nodes[0]?.interpretations, [])
  assert.equal(unsatisfied.boundaryPairDaily.chain.nodes.some((node) => node.anchorUtc === secondEnd), false)
  assert.equal(unsatisfied.boundaryPairDaily.reachesSecondBoundary, false)

  const secondEndOpen = Date.parse('2026-03-05T18:00:00.000Z')
  const incomplete = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive', 'driving', firstEnd, firstEnd + 12 * HOUR),
      activity('weekly-b', 'rest', firstEnd + 12 * HOUR, secondEndOpen),
      activity('tail', 'driving', secondEndOpen, secondEndOpen + 2 * HOUR),
    ]),
  })
  assert.equal(incomplete.boundaryPairDaily.status, 'diagnostic')
  if (incomplete.boundaryPairDaily.status !== 'diagnostic') return
  assert.equal(incomplete.boundaryPairDaily.chain.nodes.at(-1)?.status, 'history_incomplete')
  assert.equal(incomplete.boundaryPairDaily.chain.nodes.at(-1)?.interpretations.length, 0)
  assert.equal(incomplete.boundaryPairDaily.chain.nodes.length, 2)

  const unknownStart = Date.parse('2026-03-05T20:00:00.000Z')
  const blocked = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, Date.parse('2026-03-04T18:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-04T18:00:00.000Z'), secondEndOpen),
      activity('drive-2', 'driving', secondEndOpen, unknownStart),
      activity('gap', 'unknown', unknownStart, Date.parse('2026-03-06T08:00:00.000Z')),
      activity('drive-3', 'driving', Date.parse('2026-03-06T08:00:00.000Z'), Date.parse('2026-03-06T18:00:00.000Z')),
      activity('later', 'rest', Date.parse('2026-03-06T18:00:00.000Z'), Date.parse('2026-03-07T05:00:00.000Z')),
      activity('after', 'driving', Date.parse('2026-03-07T05:00:00.000Z'), Date.parse('2026-03-07T07:00:00.000Z')),
    ]),
  })
  assert.equal(blocked.boundaryPairDaily.status, 'diagnostic')
  if (blocked.boundaryPairDaily.status !== 'diagnostic') return
  assert.equal(blocked.boundaryPairDaily.chain.nodes.at(-1)?.status, 'insufficient_data')
  assert.equal(blocked.boundaryPairDaily.chain.nodes.some((node) => node.anchorUtc === Date.parse('2026-03-07T05:00:00.000Z')), false)
})

test('nerozhodnutý návrh dvojice denní řetězec nespustí', () => {
  const analysis = analyzeDriverActivities({
    card: card([
      activity('only', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-03T06:00:00.000Z')),
      activity('after', 'driving', Date.parse('2026-03-03T06:00:00.000Z'), Date.parse('2026-03-03T08:00:00.000Z')),
    ]),
  })
  assert.equal(analysis.weeklyAssignment.boundaryPair.status, 'undecided')
  assert.deepEqual(analysis.boundaryPairDaily, { status: 'not_run', reason: 'boundary_pair_undecided' })
})

test('diagnostický řetězec nemění kontrolu tří zkrácených denních odpočinků', () => {
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
  assert.equal(analysis.boundaryPairDaily.status, 'not_run')
  assert.equal(analysis.assessed.weekly.status, 'assessed')
  if (analysis.assessed.weekly.status !== 'assessed') return
  assert.deepEqual(analysis.assessed.weekly.result.dailyReduced, {
    status: 'summed',
    fromUtc: ANCHOR,
    toUtc: weeklyEnd,
    reducedCount: 1,
  })
  assert.equal(analysis.assessed.weekly.result.reducedDailyLimitChecks[0]?.status, 'within_limit')
  assert.equal(analysis.assessed.weekly.result.reducedDailyIntervals[0]?.status, 'summed')
  assert.equal(analysis.boundaryPairReducedCount.status, 'not_run')
})

function opened(endUtc: number): Activity {
  return activity('after', 'driving', endUtc, endUtc + 26 * HOUR)
}

test('jedna úplná diagnostická cesta uzavře počet zkrácených odpočinků', () => {
  const seedEnd = Date.parse('2026-03-02T17:00:00.000Z')
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const reducedEnd = Date.parse('2026-03-04T18:00:00.000Z')
  const secondEnd = Date.parse('2026-03-06T06:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('seed', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), seedEnd),
      activity('drive-seed', 'driving', seedEnd, Date.parse('2026-03-03T06:00:00.000Z')),
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, firstEnd + 2 * HOUR),
      activity('reduced', 'rest', firstEnd + 2 * HOUR, reducedEnd),
      activity('drive-2', 'driving', reducedEnd, Date.parse('2026-03-05T06:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-05T06:00:00.000Z'), secondEnd),
      opened(secondEnd),
    ]),
  })
  assert.equal(analysis.assessed.daily.status, 'assessed')
  if (analysis.assessed.daily.status !== 'assessed' || analysis.boundaryPairReducedCount.status !== 'diagnostic') return
  assert.equal(analysis.boundaryPairReducedCount.basis, 'technical_boundary_proposal')
  assert.equal(analysis.boundaryPairReducedCount.legalDetermination, false)
  assert.equal(analysis.boundaryPairReducedCount.count.status, 'summed')
  if (analysis.boundaryPairReducedCount.count.status !== 'summed') return
  assert.equal(analysis.boundaryPairReducedCount.count.reducedCount, 1)
  assert.equal(analysis.boundaryPairReducedCount.count.limitEvaluated, false)
  assert.deepEqual(analysis.boundaryPairReducedCount.count.rests, [
    { startUtc: firstEnd + 2 * HOUR, endUtc: reducedEnd, sourceActivityIds: ['reduced'] },
  ])
  assert.equal(analysis.assessed.daily.chain.startAnchorUtc, seedEnd)
  assert.notEqual(analysis.assessed.daily.chain, analysis.boundaryPairDaily.status === 'diagnostic' ? analysis.boundaryPairDaily.chain : null)
  assert.deepEqual(analysis.assessed.daily.segments, [])
  assert.equal(analysis.assessed.weekly.status, 'requires_input')
})

test('více úplných cest se stejným počtem uzavře diagnostický počet', () => {
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const reducedEnd = Date.parse('2026-03-04T17:00:00.000Z')
  const secondEnd = Date.parse('2026-03-06T12:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, firstEnd + HOUR),
      activity('reduced', 'rest', firstEnd + HOUR, reducedEnd),
      activity('drive-2', 'driving', reducedEnd, reducedEnd + HOUR),
      activity('part-3', 'rest', reducedEnd + HOUR, reducedEnd + 4 * HOUR),
      activity('between', 'work', reducedEnd + 4 * HOUR, reducedEnd + 5 * HOUR),
      activity('part-11', 'rest', reducedEnd + 5 * HOUR, reducedEnd + 16 * HOUR),
      activity('drive-3', 'driving', reducedEnd + 16 * HOUR, Date.parse('2026-03-05T12:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-05T12:00:00.000Z'), secondEnd),
      opened(secondEnd),
    ]),
  })
  assert.equal(analysis.boundaryPairDaily.status, 'diagnostic')
  if (analysis.boundaryPairDaily.status !== 'diagnostic' || analysis.boundaryPairReducedCount.status !== 'diagnostic') return
  assert.ok(analysis.boundaryPairDaily.chain.paths.length >= 2)
  assert.equal(analysis.boundaryPairReducedCount.count.status, 'summed')
  if (analysis.boundaryPairReducedCount.count.status !== 'summed') return
  assert.equal(analysis.boundaryPairReducedCount.count.reducedCount, 1)
  assert.deepEqual(analysis.boundaryPairReducedCount.count.rests[0]?.sourceActivityIds, ['reduced'])
})

test('rozdílné počty alternativních cest zůstanou nerozhodnuté', () => {
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const secondEnd = Date.parse('2026-03-06T08:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, firstEnd + 2 * HOUR),
      activity('reduced', 'rest', firstEnd + 2 * HOUR, firstEnd + 12 * HOUR),
      activity('drive-2', 'driving', firstEnd + 12 * HOUR, firstEnd + 13 * HOUR),
      activity('regular', 'rest', firstEnd + 13 * HOUR, firstEnd + 24 * HOUR),
      activity('drive-3', 'driving', firstEnd + 24 * HOUR, firstEnd + 26 * HOUR),
      activity('weekly-b', 'rest', firstEnd + 26 * HOUR, secondEnd),
      opened(secondEnd),
    ]),
  })
  assert.equal(analysis.boundaryPairReducedCount.status, 'diagnostic')
  if (analysis.boundaryPairReducedCount.status !== 'diagnostic') return
  assert.equal(analysis.boundaryPairReducedCount.count.status, 'undecided')
  if (analysis.boundaryPairReducedCount.count.status !== 'undecided') return
  assert.equal(analysis.boundaryPairReducedCount.count.reason, 'paths_disagree')
})

test('odpočinek koncového předělu se do diagnostického počtu nezahrne', () => {
  const firstEnd = Date.parse('2026-03-03T06:00:00.000Z')
  const secondEnd = Date.parse('2026-03-04T20:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), firstEnd),
      activity('drive', 'driving', firstEnd, Date.parse('2026-03-03T20:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-03T20:00:00.000Z'), secondEnd),
      opened(secondEnd),
    ]),
  })
  assert.equal(analysis.boundaryPairReducedCount.status, 'diagnostic')
  if (analysis.boundaryPairReducedCount.status !== 'diagnostic' || analysis.boundaryPairDaily.status !== 'diagnostic') return
  const boundaryInterpretation = analysis.boundaryPairDaily.chain.nodes
    .flatMap((node) => node.interpretations)
    .find((item) => item.parts.some((part) => part.sourceActivityIds.includes('weekly-b')))
  assert.equal(boundaryInterpretation?.reducedDelta, 1)
  assert.equal(analysis.boundaryPairReducedCount.count.status, 'summed')
  if (analysis.boundaryPairReducedCount.count.status !== 'summed') return
  assert.equal(analysis.boundaryPairReducedCount.count.reducedCount, 0)
  assert.deepEqual(analysis.boundaryPairReducedCount.count.rests, [])
})

test('neprokázaný zkrácený odpočinek diagnostický počet neuzavře', () => {
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const reducedStart = firstEnd + 2 * HOUR
  const reducedEnd = firstEnd + 12 * HOUR
  const secondEnd = Date.parse('2026-03-06T06:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, reducedStart),
      activity('reduced', 'rest', reducedStart, reducedEnd),
      activity('overlap', 'driving', reducedStart + HOUR, reducedStart + 2 * HOUR, { slot: 2 }),
      activity('drive-2', 'driving', reducedEnd, Date.parse('2026-03-05T06:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-05T06:00:00.000Z'), secondEnd),
      opened(secondEnd),
    ]),
  })
  assert.equal(analysis.boundaryPairReducedCount.status, 'diagnostic')
  if (analysis.boundaryPairReducedCount.status !== 'diagnostic') return
  assert.equal(analysis.boundaryPairReducedCount.count.status, 'undecided')
  if (analysis.boundaryPairReducedCount.count.status !== 'undecided') return
  assert.equal(analysis.boundaryPairReducedCount.count.reason, 'unproven_rest')
})

test('nesplněné okno mezi předěly diagnostický počet neuzavře', () => {
  const firstEnd = Date.parse('2026-03-04T06:00:00.000Z')
  const secondEnd = Date.parse('2026-03-06T18:00:00.000Z')
  const analysis = analyzeDriverActivities({
    card: card([
      activity('weekly-a', 'rest', Date.parse('2026-03-03T06:00:00.000Z'), firstEnd),
      activity('drive-1', 'driving', firstEnd, firstEnd + 14 * HOUR),
      activity('short', 'rest', firstEnd + 14 * HOUR, firstEnd + 22 * HOUR),
      activity('work', 'work', firstEnd + 22 * HOUR, Date.parse('2026-03-05T18:00:00.000Z')),
      activity('weekly-b', 'rest', Date.parse('2026-03-05T18:00:00.000Z'), secondEnd),
      opened(secondEnd),
    ]),
  })
  assert.equal(analysis.boundaryPairReducedCount.status, 'diagnostic')
  if (analysis.boundaryPairReducedCount.status !== 'diagnostic') return
  assert.equal(analysis.boundaryPairReducedCount.count.status, 'undecided')
  if (analysis.boundaryPairReducedCount.count.status !== 'undecided') return
  assert.equal(analysis.boundaryPairReducedCount.count.reason, 'window_unsatisfied')
})

test('neúplná cesta a blokující stavy diagnostický počet neuzavřou', () => {
  const fromUtc = Date.parse('2026-03-04T06:00:00.000Z')
  const midUtc = Date.parse('2026-03-04T18:00:00.000Z')
  const toUtc = Date.parse('2026-03-06T06:00:00.000Z')
  const regular = {
    id: 'regular',
    kind: 'continuous_regular' as const,
    qualifiesWindow: true,
    established: true,
    nextAnchorUtc: toUtc,
    nextAnchorEstablished: true,
    reducedDelta: 0,
    weeklyRolePossible: false,
    parts: [],
  }
  const reduced = { ...regular, id: 'reduced', kind: 'continuous_reduced' as const, nextAnchorUtc: midUtc, reducedDelta: 1 }
  const open: DailyRestChain = {
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
        interpretations: [reduced, regular],
      },
      {
        anchorUtc: midUtc,
        windowStartUtc: midUtc,
        windowEndUtc: midUtc + 24 * HOUR,
        windowMode: 'single_driver_24h',
        crewRecord: null,
        anchorEstablished: true,
        status: 'evaluated',
        interpretations: [],
      },
      {
        anchorUtc: toUtc,
        windowStartUtc: toUtc,
        windowEndUtc: toUtc + 24 * HOUR,
        windowMode: 'single_driver_24h',
        crewRecord: null,
        anchorEstablished: true,
        status: 'evaluated',
        interpretations: [],
      },
    ],
    paths: [
      { steps: [{ anchorUtc: fromUtc, interpretationId: 'reduced' }, { anchorUtc: midUtc, interpretationId: null }], reducedCount: 1, weeklyBoundariesDetermined: false },
      { steps: [{ anchorUtc: fromUtc, interpretationId: 'regular' }, { anchorUtc: toUtc, interpretationId: null }], reducedCount: 0, weeklyBoundariesDetermined: false },
    ],
  }
  const partial = diagnoseProposedReducedCount(fromUtc, toUtc, open, [], ['weekly-b'])
  assert.equal(partial.status, 'undecided')
  if (partial.status !== 'undecided') return
  assert.equal(partial.reason, 'uncovered')

  for (const status of ['history_incomplete', 'insufficient_data'] as const) {
    const blocked: DailyRestChain = {
      startAnchorUtc: fromUtc,
      nodes: [
        {
          anchorUtc: fromUtc,
          windowStartUtc: fromUtc,
          windowEndUtc: fromUtc + 24 * HOUR,
          windowMode: 'single_driver_24h',
          crewRecord: null,
          anchorEstablished: true,
          status,
          interpretations: [],
        },
      ],
      paths: [
        { steps: [{ anchorUtc: fromUtc, interpretationId: null }], reducedCount: 0, weeklyBoundariesDetermined: false },
      ],
    }
    const result = diagnoseProposedReducedCount(fromUtc, toUtc, blocked, [], [])
    assert.equal(result.status, 'undecided')
    if (result.status !== 'undecided') return
    assert.equal(result.reason, status)
  }
})

test('nerozhodnutý návrh dvojice diagnostický počet nespustí', () => {
  const analysis = analyzeDriverActivities({
    card: card([
      activity('only', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-03T06:00:00.000Z')),
      opened(Date.parse('2026-03-03T06:00:00.000Z')),
    ]),
  })
  assert.equal(analysis.weeklyAssignment.boundaryPair.status, 'undecided')
  assert.deepEqual(analysis.boundaryPairReducedCount, { status: 'not_run', reason: 'boundary_pair_undecided' })
})
