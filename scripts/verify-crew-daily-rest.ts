import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import { assessCrewDailyWindow, CREW_WINDOW_MS, decideCrewDailyWindow, type CrewActivity } from '../src/analysis/crewDailyRest.ts'
import { DAILY_WINDOW_MS } from '../src/analysis/restWindowIntersection.ts'
import { buildDailyRestOverview } from '../src/components/dailyRestOverview.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const START = Date.parse('2026-04-01T06:00:00.000Z')

function activity(
  id: string,
  kind: CrewActivity['kind'],
  startUtc: number,
  endUtc: number,
  isCrew: boolean,
  slot: 1 | 2 = 1,
  isManualEntry = false,
): CrewActivity {
  return { id, kind, startUtc, endUtc, isCrew, slot, isManualEntry }
}

function expectCourse(label: string, actual: string, expected: string) {
  console.log(`${label}: očekáváno ${expected}, skutečnost ${actual}`)
  assert.equal(actual, expected)
}

function cardActivity(id: string, kind: Activity['kind'], startUtc: number, endUtc: number, overrides: Partial<Activity> = {}): Activity {
  return { id, kind, startUtc, endUtc, durationMinutes: Math.round((endUtc - startUtc) / 60_000), slot: 1, ...overrides }
}

test('devět hodin skončí před hranicí 30 hodin', () => {
  const restStart = START + 10 * HOUR
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('drive', 'driving', START, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
  })
  assert.equal(result.windowEndUtc, START + CREW_WINDOW_MS)
  assert.equal(result.nineHourCondition, 'met')
  assert.equal(result.qualifyingRest?.nineHoursAtUtc, restStart + 9 * HOUR)
  assert.equal(result.marginMs, START + CREW_WINDOW_MS - (restStart + 9 * HOUR))
  assert.ok((result.marginMs ?? 0) > 0)
  assert.equal(result.recording, 'recorded')
  assert.equal(result.legalApplicability, 'undecided')
  assert.ok(result.uncertainties.includes('legal_not_decided'))
})

test('devět hodin přesně na hranici 30 hodin je včas', () => {
  const restStart = START + CREW_WINDOW_MS - 9 * HOUR
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('drive', 'driving', START, restStart, true),
      activity('rest', 'rest', restStart, START + CREW_WINDOW_MS, true),
    ],
  })
  assert.equal(result.qualifyingRest?.nineHoursAtUtc, START + CREW_WINDOW_MS)
  assert.equal(result.nineHourCondition, 'met')
  assert.equal(result.marginMs, 0)
  assert.equal(result.legalApplicability, 'undecided')
})

test('devět hodin až po hranici časovou podmínku nesplní', () => {
  const restStart = START + CREW_WINDOW_MS - 9 * HOUR + MINUTE
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('drive', 'driving', START, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
  })
  assert.equal(result.nineHourCondition, 'not_met')
  assert.equal(result.qualifyingRest?.nineHoursAtUtc, START + CREW_WINDOW_MS + MINUTE)
  assert.equal(result.marginMs, -MINUTE)
  assert.ok(result.uncertainties.includes('nine_hours_late'))
  assert.equal(result.legalApplicability, 'undecided')
})

test('dlouhý odpočinek pokračuje za hranici a devět hodin stihne', () => {
  const restStart = START + CREW_WINDOW_MS - 9 * HOUR - 9 * MINUTE
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('drive', 'driving', START, restStart, true),
      activity('rest', 'rest', restStart, restStart + 40 * 24 * HOUR, true),
    ],
  })
  assert.equal(result.nineHourCondition, 'met')
  assert.equal(result.qualifyingRest?.nineHoursAtUtc, START + CREW_WINDOW_MS - 9 * MINUTE)
  assert.equal(result.qualifyingRest?.endUtc, restStart + 40 * 24 * HOUR)
  assert.equal(result.marginMs, 9 * MINUTE)
  assert.equal(result.legalApplicability, 'undecided')
})

test('kratší odpočinky se nesčítají', () => {
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('a', 'rest', START + HOUR, START + 4 * HOUR, true),
      activity('b', 'driving', START + 4 * HOUR, START + 6 * HOUR, true),
      activity('c', 'rest', START + 6 * HOUR, START + 9 * HOUR, true),
      activity('d', 'driving', START + 9 * HOUR, START + 11 * HOUR, true),
      activity('e', 'rest', START + 11 * HOUR, START + 14 * HOUR, true),
    ],
  })
  assert.equal(result.qualifyingRest, null)
  assert.equal(result.nineHourCondition, 'not_met')
  assert.equal(result.marginMs, null)
  assert.ok(result.uncertainties.includes('nine_hours_missing'))
})

test('neznámý úsek přeruší souvislý odpočinek', () => {
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('before', 'rest', START + HOUR, START + 7 * HOUR, true),
      activity('after', 'rest', START + 8 * HOUR, START + 14 * HOUR, true),
    ],
    unknownIntervals: [{ startUtc: START + 7 * HOUR, endUtc: START + 8 * HOUR }],
  })
  assert.equal(result.qualifyingRest, null)
  assert.equal(result.nineHourCondition, 'not_met')
  assert.equal(result.recording, 'insufficient_data')
  assert.ok(result.uncertainties.includes('unknown_in_period'))
})

test('částečně zaznamenaná osádka zůstane právně nerozhodnutá', () => {
  const restStart = START + 8 * HOUR
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('crew', 'driving', START, START + 4 * HOUR, true),
      activity('plain', 'work', START + 4 * HOUR, restStart, false),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, false),
    ],
  })
  assert.equal(result.recording, 'partial')
  assert.equal(result.nineHourCondition, 'met')
  assert.equal(result.legalApplicability, 'undecided')
  assert.deepEqual(result.crewIntervals, [{
    startUtc: START,
    endUtc: START + 4 * HOUR,
    sourceActivityIds: ['crew'],
  }])
  assert.ok(result.uncertainties.includes('crew_partial'))
  assert.ok(result.uncertainties.includes('legal_not_decided'))
})

test('referenční případ 21. až 22. února 2025 splní jen časovou podmínku', () => {
  const anchor = Date.parse('2025-02-21T07:39:00.000Z')
  const restStart = Date.parse('2025-02-21T08:15:00.000Z')
  const restEnd = Date.parse('2025-02-21T14:11:00.000Z')
  const manualStart = Date.parse('2025-02-22T04:30:00.000Z')
  const result = assessCrewDailyWindow({
    windowStartUtc: anchor,
    activities: [
      activity('avail-1', 'availability', anchor, restStart, true, 2),
      activity('rest-5h56', 'rest', restStart, restEnd, true, 2),
      activity('avail-2', 'availability', restEnd, Date.parse('2025-02-21T18:09:00.000Z'), true, 2),
      activity('drive', 'driving', Date.parse('2025-02-22T03:30:00.000Z'), manualStart, true, 1),
      activity('manual-long', 'rest', manualStart, Date.parse('2025-06-01T12:50:00.000Z'), false, 1),
    ],
  })
  assert.equal(result.windowStartUtc, anchor)
  assert.equal(result.windowEndUtc, Date.parse('2025-02-22T13:39:00.000Z'))
  assert.equal(result.qualifyingRest?.startUtc, manualStart)
  assert.equal(result.qualifyingRest?.nineHoursAtUtc, Date.parse('2025-02-22T13:30:00.000Z'))
  assert.equal(result.nineHourCondition, 'met')
  assert.equal(result.marginMs, 9 * MINUTE)
  assert.equal(result.recording, 'recorded')
  assert.equal(result.legalApplicability, 'undecided')
  assert.equal(result.crewRecord, 'crew_record_uncertain')
  assert.equal(result.crewIntervals.some((interval) => interval.sourceActivityIds.includes('drive')), true)
  assert.equal(result.crewIntervals.some((interval) => interval.sourceActivityIds.includes('manual-long')), false)

  const at = (value: string) => Date.parse(value)
  const recorded = assessCrewDailyWindow({
    windowStartUtc: anchor,
    activities: [
      activity('avail-1', 'availability', anchor, restStart, true, 2),
      activity('rest-5h56', 'rest', restStart, restEnd, true, 2),
      activity('avail-2', 'availability', restEnd, at('2025-02-21T18:09:00.000Z'), true, 2),
      activity('out-1', 'rest', at('2025-02-21T18:09:00.000Z'), at('2025-02-21T18:10:00.000Z'), false, 2, true),
      activity('work-1', 'work', at('2025-02-21T18:10:00.000Z'), at('2025-02-21T18:11:00.000Z'), true, 1),
      activity('rest-1', 'rest', at('2025-02-21T18:11:00.000Z'), at('2025-02-21T18:35:00.000Z'), true, 1),
      activity('drive-1', 'driving', at('2025-02-21T18:35:00.000Z'), at('2025-02-21T22:25:00.000Z'), true, 1),
      activity('out-2', 'work', at('2025-02-21T22:25:00.000Z'), at('2025-02-21T22:27:00.000Z'), false, 1, true),
      activity('avail-3', 'availability', at('2025-02-21T22:27:00.000Z'), at('2025-02-21T22:28:00.000Z'), true, 2),
      activity('rest-2', 'rest', at('2025-02-21T22:28:00.000Z'), at('2025-02-21T22:46:00.000Z'), true, 2),
      activity('avail-4', 'availability', at('2025-02-21T22:46:00.000Z'), at('2025-02-22T03:08:00.000Z'), true, 2),
      activity('out-3', 'rest', at('2025-02-22T03:08:00.000Z'), at('2025-02-22T03:09:00.000Z'), false, 2, true),
      activity('work-2', 'work', at('2025-02-22T03:09:00.000Z'), at('2025-02-22T03:15:00.000Z'), true, 1),
      activity('rest-3', 'rest', at('2025-02-22T03:15:00.000Z'), at('2025-02-22T03:30:00.000Z'), true, 1),
      activity('drive-2', 'driving', at('2025-02-22T03:30:00.000Z'), manualStart, true, 1),
      activity('manual-long', 'rest', manualStart, at('2025-06-01T12:50:00.000Z'), false, 1, true),
    ],
  })
  assert.equal(recorded.qualifyingRest?.nineHoursAtUtc, at('2025-02-22T13:30:00.000Z'))
  assert.equal(recorded.marginMs, 9 * MINUTE)
  assert.equal(recorded.nineHourCondition, 'met')
  assert.equal(recorded.crewRecord, 'crew_record_uncertain')
  assert.notEqual(recorded.crewRecord, 'crew_record_interrupted')
  assert.equal(recorded.legalApplicability, 'undecided')
})

test('souvislý příznak osádky', () => {
  const restStart = START + 10 * HOUR
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('drive', 'driving', START, restStart, true, 1),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true, 1),
    ],
  })
  expectCourse('prokazatelně nepřerušená osádka', result.crewRecord, 'crew_record_consistent')
  assert.equal(result.uncertainIntervals.length, 0)
  assert.equal(decideCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('drive', 'driving', START, restStart, true, 1),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true, 1),
    ],
  }).applies, true)
  assert.equal(result.nineHourCondition, 'met')
  assert.equal(result.windowEndUtc, START + CREW_WINDOW_MS)
  assert.equal(result.legalApplicability, 'undecided')
})

test('přerušení příznaku po první hodině při vložené kartě', () => {
  const restStart = START + 12 * HOUR
  const interrupted = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('before', 'driving', START, START + 3 * HOUR, true),
      activity('break', 'work', START + 3 * HOUR, START + 3 * HOUR + 30 * MINUTE, false),
      activity('after', 'driving', START + 3 * HOUR + 30 * MINUTE, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
  })
  expectCourse('prokazatelné nesplnění podmínek osádky', interrupted.crewRecord, 'crew_record_interrupted')
  assert.equal(decideCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('before', 'driving', START, START + 3 * HOUR, true),
      activity('break', 'work', START + 3 * HOUR, START + 3 * HOUR + 30 * MINUTE, false),
      activity('after', 'driving', START + 3 * HOUR + 30 * MINUTE, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
  }).applies, false)
  assert.equal(interrupted.nineHourCondition, 'met')
  assert.equal(interrupted.legalApplicability, 'undecided')

  const firstHourOnly = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('grace', 'driving', START, START + HOUR, false),
      activity('later', 'driving', START + HOUR, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
  })
  assert.equal(firstHourOnly.crewRecord, 'crew_record_consistent')
  assert.equal(firstHourOnly.legalApplicability, 'undecided')
})

test('změna slotu bez přerušení osádky', () => {
  const restStart = START + 10 * HOUR
  const result = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('slot-1', 'driving', START, START + 5 * HOUR, true, 1),
      activity('slot-2', 'driving', START + 5 * HOUR, restStart, true, 2),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true, 1),
    ],
  })
  assert.equal(result.crewRecord, 'crew_record_consistent')
  assert.equal(result.legalApplicability, 'undecided')
  assert.equal(result.nineHourCondition, 'met')
})

test('neznámý úsek nebo vyjmutá karta průběh neuzavře', () => {
  const restStart = START + 10 * HOUR
  const unknown = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('before', 'driving', START, START + 4 * HOUR, true),
      activity('after', 'driving', START + 5 * HOUR, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
    unknownIntervals: [{ startUtc: START + 4 * HOUR, endUtc: START + 5 * HOUR }],
  })
  assert.equal(unknown.crewRecord, 'crew_record_uncertain')
  assert.notEqual(unknown.crewRecord, 'crew_record_interrupted')
  assert.equal(unknown.nineHourCondition, 'met')
  assert.equal(unknown.legalApplicability, 'undecided')

  const cardOut = assessCrewDailyWindow({
    windowStartUtc: START,
    activities: [
      activity('before', 'driving', START, START + 4 * HOUR, true),
      activity('out', 'work', START + 4 * HOUR, START + 5 * HOUR, false, 1, true),
      activity('after', 'driving', START + 5 * HOUR, restStart, true),
      activity('rest', 'rest', restStart, restStart + 9 * HOUR, true),
    ],
  })
  assert.equal(cardOut.crewRecord, 'crew_record_uncertain')
  assert.equal(cardOut.legalApplicability, 'undecided')
  assert.equal(cardOut.windowEndUtc, START + CREW_WINDOW_MS)
})

test('výměna karet 22. až 23. září 2025 není přerušení a neotevře 30hodinové okno', () => {
  const anchor = Date.parse('2025-09-22T17:31:00.000Z')
  const manualStart = Date.parse('2025-09-22T21:38:00.000Z')
  const swap = Date.parse('2025-09-23T09:49:00.000Z')
  const restStart = Date.parse('2025-09-23T13:48:00.000Z')
  const activities = [
    activity('crew-before', 'driving', anchor, manualStart, true, 1),
    activity('manual-gap', 'rest', manualStart, manualStart + MINUTE, false, 1, true),
    activity('crew-slot-2', 'availability', manualStart + MINUTE, swap, true, 2),
    activity('leave-slot', 'availability', swap, swap + MINUTE, false, 2),
    activity('card-mark', 'availability', swap + MINUTE, swap + MINUTE, false, 2, true),
    activity('enter-slot', 'work', swap + MINUTE, swap + 2 * MINUTE, false, 1),
    activity('crew-after', 'driving', swap + 2 * MINUTE, restStart, true, 1),
    activity('daily-rest', 'rest', restStart, restStart + 12 * HOUR, false, 2, true),
    activity('after-rest', 'driving', restStart + HOUR, restStart + 3 * HOUR, false, 1),
  ]
  const snapshot = structuredClone(activities)
  const result = assessCrewDailyWindow({ windowStartUtc: anchor, activities })
  const decision = decideCrewDailyWindow({ windowStartUtc: anchor, activities })
  expectCourse('22.–23. 9. 2025', result.crewRecord, 'crew_record_uncertain')
  assert.notEqual(result.crewRecord, 'crew_record_interrupted')
  assert.notEqual(result.crewRecord, 'crew_record_consistent')
  assert.deepEqual(result.uncertainIntervals, [
    { startUtc: manualStart, endUtc: manualStart + MINUTE },
    { startUtc: swap, endUtc: swap + 2 * MINUTE },
  ])
  assert.equal(result.qualifyingRest?.startUtc, restStart)
  assert.equal(decision.applies, false)
  assert.equal(decision.crewRecord, 'crew_record_uncertain')
  assert.equal(activities.find((item) => item.id === 'manual-gap')?.isCrew, false)
  assert.equal(activities.find((item) => item.id === 'leave-slot')?.isCrew, false)
  assert.deepEqual(activities, snapshot)
})

test('výměna karet 30. září až 1. října 2025 není přerušení a neotevře 30hodinové okno', () => {
  const anchor = Date.parse('2025-09-30T07:14:00.000Z')
  const manualStart = Date.parse('2025-09-30T11:33:00.000Z')
  const swap = Date.parse('2025-09-30T23:41:00.000Z')
  const restStart = Date.parse('2025-10-01T03:11:00.000Z')
  const activities = [
    activity('crew-before', 'driving', anchor, manualStart, true, 1),
    activity('manual-gap', 'rest', manualStart, manualStart + 5 * MINUTE, false, 1, true),
    activity('crew-slot-2', 'availability', manualStart + 5 * MINUTE, swap, true, 2),
    activity('leave-slot', 'availability', swap, swap + MINUTE, false, 2),
    activity('card-mark', 'availability', swap + MINUTE, swap + MINUTE, false, 2, true),
    activity('enter-slot', 'work', swap + MINUTE, swap + 2 * MINUTE, false, 1),
    activity('crew-after', 'driving', swap + 2 * MINUTE, restStart, true, 1),
    activity('daily-rest', 'rest', restStart, restStart + 12 * HOUR, false, 1, true),
    activity('after-rest', 'driving', restStart + HOUR, restStart + 3 * HOUR, false, 1),
  ]
  const result = assessCrewDailyWindow({ windowStartUtc: anchor, activities })
  const decision = decideCrewDailyWindow({ windowStartUtc: anchor, activities })
  expectCourse('30. 9.–1. 10. 2025', result.crewRecord, 'crew_record_uncertain')
  assert.notEqual(result.crewRecord, 'crew_record_interrupted')
  assert.notEqual(result.crewRecord, 'crew_record_consistent')
  assert.deepEqual(result.uncertainIntervals, [
    { startUtc: manualStart, endUtc: manualStart + 5 * MINUTE },
    { startUtc: swap, endUtc: swap + 2 * MINUTE },
  ])
  assert.equal(result.qualifyingRest?.startUtc, restStart)
  assert.equal(decision.applies, false)
  assert.equal(decision.crewRecord, 'crew_record_uncertain')
})

test('skutečné přerušení osádky zůstane přerušením', () => {
  const restStart = START + 12 * HOUR
  const activities = [
    activity('crew', 'driving', START, START + 4 * HOUR, true, 1),
    activity('solo', 'driving', START + 4 * HOUR, START + 6 * HOUR, false, 1),
    activity('other-slot', 'rest', START + 4 * HOUR, START + 6 * HOUR, false, 2),
    activity('later', 'driving', START + 6 * HOUR, restStart, true, 2),
    activity('rest', 'rest', restStart, restStart + 9 * HOUR, true, 2),
  ]
  const result = assessCrewDailyWindow({ windowStartUtc: START, activities })
  const decision = decideCrewDailyWindow({ windowStartUtc: START, activities })
  assert.equal(result.crewRecord, 'crew_record_interrupted')
  assert.equal(decision.applies, false)
  assert.equal(decision.crewRecord, 'crew_record_interrupted')
  assert.equal(result.qualifyingRest?.startUtc, restStart)
})

test('navazující výměna slotu není přerušení a odpočinek už se nekontroluje', () => {
  const restStart = START + 10 * HOUR
  const swap = START + 5 * HOUR
  const exchanged = [
    activity('before', 'driving', START, swap, true, 1),
    activity('leave-slot', 'availability', swap, swap + MINUTE, false, 1),
    activity('card-mark', 'availability', swap + MINUTE, swap + MINUTE, false, 1, true),
    activity('enter-slot', 'work', swap + MINUTE, swap + 2 * MINUTE, false, 2),
    activity('after', 'driving', swap + 2 * MINUTE, restStart, true, 2),
    activity('daily-rest', 'rest', restStart, restStart + 12 * HOUR, false, 1, true),
    activity('ignored', 'driving', restStart + HOUR, restStart + 4 * HOUR, false, 1),
  ]
  const result = assessCrewDailyWindow({ windowStartUtc: START, activities: exchanged })
  expectCourse('výměna slotu bez samostatného řízení', result.crewRecord, 'crew_record_uncertain')
  assert.notEqual(result.crewRecord, 'crew_record_interrupted')
  assert.deepEqual(result.uncertainIntervals, [{ startUtc: swap, endUtc: swap + 2 * MINUTE }])
  assert.equal(result.qualifyingRest?.startUtc, restStart)
  assert.equal(decideCrewDailyWindow({ windowStartUtc: START, activities: exchanged }).applies, false)
  assert.equal(exchanged.find((item) => item.id === 'ignored')?.isCrew, false)
  assert.equal(exchanged.find((item) => item.id === 'leave-slot')?.isCrew, false)
})

test('pozdní nástup druhého řidiče po první hodině 30hodinové okno neotevře', () => {
  const restStart = START + 20 * HOUR
  const activities = [
    activity('solo', 'driving', START, START + 8 * HOUR, false, 1),
    activity('late', 'driving', START + 8 * HOUR, restStart, true, 1),
    activity('rest', 'rest', restStart, restStart + 10 * HOUR, true, 1),
  ]
  const result = assessCrewDailyWindow({ windowStartUtc: START, activities })
  const decision = decideCrewDailyWindow({ windowStartUtc: START, activities })
  expectCourse('pozdní nástup druhého řidiče', result.crewRecord, 'crew_record_interrupted')
  assert.equal(decision.applies, false)
  assert.equal(result.qualifyingRest?.startUtc, restStart)
  assert.equal(result.uncertainIntervals.length, 0)
})

test('24hodinové okno zůstane beze změny', () => {
  assert.equal(DAILY_WINDOW_MS, 24 * HOUR)
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = restStart + 11 * HOUR
  const overview = buildDailyRestOverview(analyzeDriverActivities({
    card: {
      cardNumber: 'TEST',
      firstName: 'Test',
      surname: 'Driver',
      lastWithdrawalUtc: null,
      activities: [
        cardActivity('initial', 'rest', anchor - 11 * HOUR, anchor),
        cardActivity('drive', 'driving', anchor, restStart),
        cardActivity('daily', 'rest', restStart, restEnd),
        cardActivity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
      ],
      locations: [],
      violations: [],
    } satisfies DriverCardData,
  }))
  assert.equal(overview.status, 'rows')
  if (overview.status !== 'rows') return
  const row = overview.rows.find((item) => item.result === 'Běžný denní odpočinek')
  expectCourse('platný denní odpočinek v 24hodinovém okně', row?.result ?? 'chybí', 'Běžný denní odpočinek')
  assert.ok(row)
  assert.equal(row.details.some((detail) => detail.label === 'Kandidátní posouzení režimu osádky'), false)
})
