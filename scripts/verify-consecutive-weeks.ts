import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import type { ConsecutiveWeekPeriod } from '../src/analysis/consecutiveWeeks.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const W1 = Date.parse('2026-03-02T00:00:00.000Z')
const W2 = Date.parse('2026-03-09T00:00:00.000Z')

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

function leadIn(): Activity {
  return activity('lead', 'rest', Date.parse('2026-02-24T06:00:00.000Z'), Date.parse('2026-02-26T03:00:00.000Z'))
}

function periodsOf(activities: Activity[]): ConsecutiveWeekPeriod[] {
  return analyzeDriverActivities({ card: card(activities) }).consecutiveWeeks.periods
}

function pairAt(periods: readonly ConsecutiveWeekPeriod[], startUtc: number): ConsecutiveWeekPeriod | undefined {
  return periods.find((period) => period.earlierWeek.startUtc === startUtc)
}

test('dva běžné týdenní odpočinky splňují základní pravidlo ve všech přiřazeních', () => {
  const periods = periodsOf([
    leadIn(),
    activity('regular-a', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-04T15:00:00.000Z')),
    activity('regular-b', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-11T15:00:00.000Z')),
  ])
  const period = pairAt(periods, W1)
  assert.equal(period?.status, 'satisfied')
  assert.equal(period?.needsController, false)
  assert.equal(period?.isInfringement, false)
  assert.equal(period?.clockBasis, 'monday_00_00_utc')
  assert.equal(period?.lengthEligibilityIsLegalUse, false)
  assert.ok(period?.alternatives.every((item) => item.meetsBasicRule))
})

test('jeden běžný a jeden zkrácený odpočinek splňují základní pravidlo', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('regular', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-04T15:00:00.000Z')),
      activity('reduced', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-10T18:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'satisfied')
  assert.equal(period?.alternatives[0]?.rests.some((rest) => rest.lengthClass === 'reduced'), true)
})

test('dva zkrácené odpočinky základní pravidlo nesplní a nejsou přestupek', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('reduced-a', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-03T18:00:00.000Z')),
      activity('reduced-b', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-10T18:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'not_satisfied_basic_rule')
  assert.equal(period?.isInfringement, false)
  assert.equal(period?.internationalRegime, 'not_evaluated')
  assert.match(period?.reason ?? '', /není přestupek/)
})

test('odpočinek přes dva týdny se nezapočítá do obou', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('span', 'rest', Date.parse('2026-03-08T12:00:00.000Z'), Date.parse('2026-03-10T12:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'not_satisfied_basic_rule')
  assert.equal(period?.alternatives.length, 2)
  assert.ok(period?.alternatives.every((item) => item.rests.length === 1 && !item.meetsBasicRule))
})

test('dlouhý nepřerušený odpočinek se nerozděluje a období není falešně splněné ani nesplněné', () => {
  const periods = periodsOf([
    leadIn(),
    activity('long', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-02T06:00:00.000Z') + 20 * DAY, {
      isManualEntry: true,
    }),
  ])
  const covered = periods.filter((period) => period.earlierWeek.startUtc >= W1 && period.earlierWeek.startUtc < W1 + 21 * DAY)
  assert.ok(covered.length >= 2)
  assert.ok(covered.every((period) => period.status === 'not_evaluated'))
  assert.ok(covered.every((period) => period.status !== 'satisfied' && period.status !== 'not_satisfied_basic_rule'))
  assert.match(covered[0]?.reason ?? '', /jednoho fyzického/)
})

test('více přiřazení se stejným výsledkem nevyžaduje kontrolora', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('first', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-04T03:00:00.000Z')),
      activity('work', 'work', Date.parse('2026-03-04T03:00:00.000Z'), Date.parse('2026-03-04T12:00:00.000Z')),
      activity('second', 'rest', Date.parse('2026-03-04T12:00:00.000Z'), Date.parse('2026-03-06T09:00:00.000Z')),
      activity('later', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-11T15:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'satisfied')
  assert.equal(period?.needsController, false)
  const weekARests = new Set(
    period?.alternatives.flatMap((item) => item.rests.filter((rest) => rest.weekId.endsWith(String(W1))).map((rest) => rest.nodeId)),
  )
  assert.ok(weekARests.size >= 2)
})

test('více přiřazení s rozdílným výsledkem zůstane k rozhodnutí', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('regular', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-04T15:00:00.000Z')),
      activity('span', 'rest', Date.parse('2026-03-08T12:00:00.000Z'), Date.parse('2026-03-09T18:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'ambiguous')
  assert.equal(period?.needsController, true)
  assert.equal(period?.alternatives.some((item) => item.meetsBasicRule), true)
  assert.equal(period?.alternatives.some((item) => !item.meetsBasicRule), true)
  assert.ok(period?.usedRests.some((rest) => rest.sourceActivityIds.includes('span')))
})

test('chybějící předchozí historie brání uzavření dvojice', () => {
  const period = pairAt(
    periodsOf([
      activity('regular-a', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-04T15:00:00.000Z')),
      activity('regular-b', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-11T15:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'insufficient_data')
  assert.match(period?.reason ?? '', /historie|předchozího/)
  assert.ok(period?.missing.includes('konec předchozího týdenního odpočinku'))
})

test('neznámý úsek v období brání kontrole', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('gap', 'unknown', Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T12:00:00.000Z')),
      activity('regular-a', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-04T15:00:00.000Z')),
      activity('regular-b', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-11T15:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'insufficient_data')
  assert.match(period?.missing.join(' ') ?? '', /neznámý/)
})

test('přesně 24 hodin je zkrácený a přesně 45 hodin běžný kandidát', () => {
  const exact = pairAt(
    periodsOf([
      leadIn(),
      activity('regular', 'rest', W1 + 6 * HOUR, W1 + 6 * HOUR + 45 * HOUR),
      activity('reduced', 'rest', W2 + 6 * HOUR, W2 + 6 * HOUR + 24 * HOUR),
    ]),
    W1,
  )
  assert.equal(exact?.status, 'satisfied')
  assert.deepEqual(
    exact?.alternatives[0]?.rests.map((rest) => rest.lengthClass).sort(),
    ['reduced', 'regular'],
  )

  const tooShort = pairAt(
    periodsOf([
      leadIn(),
      activity('regular', 'rest', W1 + 6 * HOUR, W1 + 6 * HOUR + 45 * HOUR),
      activity('short', 'rest', W2 + 6 * HOUR, W2 + 6 * HOUR + 24 * HOUR - 60_000),
    ]),
    W1,
  )
  assert.equal(tooShort?.status, 'not_satisfied_basic_rule')
})
