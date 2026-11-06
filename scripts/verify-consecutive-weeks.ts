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
  assert.match(covered[0]?.reason ?? '', /fyzick/)
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

test('listopadová dvojice nevynechá druhý odpočinek a nejednoznačnost je volba týdne', () => {
  const nov17 = Date.parse('2025-11-17T00:00:00.000Z')
  const nov24 = Date.parse('2025-11-24T00:00:00.000Z')
  const dec1 = Date.parse('2025-12-01T00:00:00.000Z')
  const period = pairAt(
    periodsOf([
      activity('lead', 'rest', Date.parse('2025-11-10T06:00:00.000Z'), Date.parse('2025-11-12T03:00:00.000Z')),
      activity('first', 'rest', Date.parse('2025-11-17T22:17:00.000Z'), Date.parse('2025-11-30T13:52:00.000Z')),
      activity('second', 'rest', Date.parse('2025-11-30T22:32:00.000Z'), Date.parse('2025-12-07T13:45:00.000Z')),
    ]),
    nov17,
  )
  assert.equal(period?.status, 'ambiguous')
  assert.equal(period?.needsController, true)
  assert.ok((period?.alternatives.length ?? 0) >= 2)
  for (const alternative of period?.alternatives ?? []) {
    const sources = alternative.rests.flatMap((rest) => rest.sourceActivityIds)
    assert.ok(sources.includes('first'))
    assert.ok(sources.includes('second'))
    assert.equal(new Set(alternative.rests.map((rest) => rest.nodeId)).size, alternative.rests.length)
  }
  const satisfied = period?.alternatives.filter((item) => item.meetsBasicRule) ?? []
  const failed = period?.alternatives.filter((item) => !item.meetsBasicRule) ?? []
  assert.equal(satisfied.length, 1)
  assert.ok(failed.length >= 1)
  assert.ok(
    satisfied[0]?.rests.some((rest) => rest.sourceActivityIds.includes('second') && rest.weekId === `monday:${nov24}`),
  )
  for (const alternative of failed) {
    const second = alternative.rests.find((rest) => rest.sourceActivityIds.includes('second'))
    assert.equal(second?.weekId, `monday:${dec1}`)
  }
})

test('45 h a 24 h v jednom týdnu nejsou samy o sobě chyba', () => {
  const period = pairAt(
    periodsOf([
      leadIn(),
      activity('long', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-04T03:00:00.000Z')),
      activity('work', 'work', Date.parse('2026-03-04T03:00:00.000Z'), Date.parse('2026-03-04T08:00:00.000Z')),
      activity('short', 'rest', Date.parse('2026-03-04T08:00:00.000Z'), Date.parse('2026-03-05T08:00:00.000Z')),
      activity('next', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-11T15:00:00.000Z')),
    ]),
    W1,
  )
  assert.equal(period?.status, 'satisfied')
  assert.equal(period?.needsController, false)
  assert.ok(period?.alternatives.every((item) => item.meetsBasicRule))
})

test('splněné sousední dvojice nepřiřadí jeden odpočinek ke dvěma týdnům', () => {
  const periods = periodsOf([
    leadIn(),
    activity('regular-a', 'rest', Date.parse('2026-03-02T18:00:00.000Z'), Date.parse('2026-03-04T15:00:00.000Z')),
    activity('regular-b', 'rest', Date.parse('2026-03-09T18:00:00.000Z'), Date.parse('2026-03-11T15:00:00.000Z')),
    activity('regular-c', 'rest', Date.parse('2026-03-16T18:00:00.000Z'), Date.parse('2026-03-18T15:00:00.000Z')),
  ])
  const fixed = new Map<string, string>()
  for (const period of periods) {
    for (const alternative of period.alternatives) {
      const seen = new Set<string>()
      for (const rest of alternative.rests) {
        assert.equal(seen.has(rest.nodeId), false)
        seen.add(rest.nodeId)
      }
    }
    if (period.status !== 'satisfied') continue
    const weeksByRest = new Map<string, Set<string>>()
    for (const alternative of period.alternatives) {
      for (const rest of alternative.rests) {
        const set = weeksByRest.get(rest.nodeId) ?? new Set<string>()
        set.add(rest.weekId)
        weeksByRest.set(rest.nodeId, set)
      }
    }
    for (const [nodeId, weeks] of weeksByRest) {
      if (weeks.size !== 1) continue
      const weekId = [...weeks][0]!
      const previous = fixed.get(nodeId)
      if (previous != null) assert.equal(previous, weekId)
      fixed.set(nodeId, weekId)
    }
  }
})

test('odpočinek přes tři týdny doloží jen dvojici s tříhodinovou rezervou', () => {
  const start = Date.parse('2026-03-04T12:00:00.000Z')
  const end = start + 21 * DAY
  const periods = periodsOf([leadIn(), activity('three', 'rest', start, end, { isManualEntry: true })])
  const interior = pairAt(periods, Date.parse('2026-03-09T00:00:00.000Z'))
  assert.equal(interior?.status, 'resting_throughout')
  if (interior?.status !== 'resting_throughout') return
  assert.equal(interior.compositionEvaluated, false)
  assert.equal(interior.infringementAssessment, 'not_evaluated')
  assert.equal(interior.cover.startUtc, start)
  assert.equal(interior.cover.endUtc, end)
  assert.deepEqual(interior.cover.sourceActivityIds, ['three'])
  assert.equal(interior.cover.weekOverlaps.length, 4)
  assert.ok(interior.cover.marginBeforeMs >= interior.cover.technicalMarginMs)
  assert.ok(interior.cover.marginAfterMs >= interior.cover.technicalMarginMs)
  assert.equal(interior.usedRests.length, 0)
  assert.equal(interior.alternatives.length, 0)
  for (const edge of [W1, Date.parse('2026-03-16T00:00:00.000Z')]) {
    const period = pairAt(periods, edge)
    assert.equal(period?.status, 'not_evaluated')
    assert.match(period?.reason ?? '', /začíná nebo končí/)
    assert.notEqual(period?.status, 'satisfied')
    assert.notEqual(period?.status, 'not_satisfied_basic_rule')
  }
})

test('odpočinek přes osm týdnů nechá vnitřní dvojice jako volno a okraje otevřené', () => {
  const start = Date.parse('2026-03-01T21:00:00.000Z')
  const end = Date.parse('2026-04-27T03:00:00.000Z')
  const periods = periodsOf([leadIn(), activity('eight', 'rest', start, end, { isManualEntry: true })])
  const resting = periods.filter((period) => period.status === 'resting_throughout')
  assert.equal(resting.length, 7)
  assert.ok(resting.every((period) => period.compositionEvaluated === false && period.infringementAssessment === 'not_evaluated'))
  assert.ok(resting.every((period) => period.cover.sourceActivityIds.length === 1 && period.cover.weekOverlaps.length > 2))
  const edges = [
    pairAt(periods, Date.parse('2026-02-23T00:00:00.000Z')),
    pairAt(periods, Date.parse('2026-04-20T00:00:00.000Z')),
  ]
  assert.ok(edges.every((period) => period?.status === 'not_evaluated'))
  assert.ok(periods.every((period) => period.status !== 'satisfied' && period.status !== 'not_satisfied_basic_rule'))
})

test('několikaměsíční odpočinek zůstává jeden interval', () => {
  const start = Date.parse('2026-03-01T21:00:00.000Z')
  const end = Date.parse('2026-06-01T03:00:00.000Z')
  const periods = periodsOf([leadIn(), activity('months', 'rest', start, end, { isManualEntry: true })])
  const resting = periods.filter((period) => period.status === 'resting_throughout')
  assert.ok(resting.length >= 8)
  const ids = new Set(resting.map((period) => period.cover.nodeId))
  assert.equal(ids.size, 1)
  assert.ok(resting.every((period) => period.cover.sourceActivityIds.join('+') === 'months'))
  assert.ok(resting.every((period) => period.cover.weekOverlaps.length > 8))
  assert.ok(resting.every((period) => period.compositionEvaluated === false))
  assert.equal(periods.some((period) => period.status === 'satisfied' || period.status === 'not_satisfied_basic_rule'), false)
})

test('přesně tříhodinová rezerva projde a o minutu kratší zůstane nevyhodnocená', () => {
  const exactStart = Date.parse('2026-03-08T21:00:00.000Z')
  const exactEnd = Date.parse('2026-03-23T03:00:00.000Z')
  const exact = pairAt(
    periodsOf([leadIn(), activity('exact', 'rest', exactStart, exactEnd, { isManualEntry: true })]),
    Date.parse('2026-03-09T00:00:00.000Z'),
  )
  assert.equal(exact?.status, 'resting_throughout')
  if (exact?.status === 'resting_throughout') {
    assert.equal(exact.cover.marginBeforeMs, 3 * HOUR)
    assert.equal(exact.cover.marginAfterMs, 3 * HOUR)
    assert.equal(exact.cover.technicalMarginMs, 3 * HOUR)
  }
  const short = pairAt(
    periodsOf([
      leadIn(),
      activity('short-margin', 'rest', exactStart + 60_000, exactEnd, { isManualEntry: true }),
    ]),
    Date.parse('2026-03-09T00:00:00.000Z'),
  )
  assert.equal(short?.status, 'not_evaluated')
  assert.match(short?.reason ?? '', /technická podmínka/)
  assert.equal(short?.status === 'resting_throughout', false)
})

test('návrat k řízení po dlouhém odpočinku nezaloží splnění ani porušení na okraji', () => {
  const periods = periodsOf([
    leadIn(),
    activity('away', 'rest', Date.parse('2026-03-04T12:00:00.000Z'), Date.parse('2026-03-25T12:00:00.000Z'), { isManualEntry: true }),
    activity('drive', 'driving', Date.parse('2026-03-25T12:00:00.000Z'), Date.parse('2026-03-25T18:00:00.000Z')),
    activity('back', 'rest', Date.parse('2026-03-30T18:00:00.000Z'), Date.parse('2026-04-01T15:00:00.000Z')),
    activity('next', 'rest', Date.parse('2026-04-06T18:00:00.000Z'), Date.parse('2026-04-08T15:00:00.000Z')),
  ])
  const interior = pairAt(periods, Date.parse('2026-03-09T00:00:00.000Z'))
  assert.equal(interior?.status, 'resting_throughout')
  const edge = pairAt(periods, Date.parse('2026-03-16T00:00:00.000Z'))
  assert.equal(edge?.status, 'not_evaluated')
  assert.match(edge?.reason ?? '', /začíná nebo končí/)
  const worked = pairAt(periods, Date.parse('2026-03-30T00:00:00.000Z'))
  assert.equal(worked?.status, 'satisfied')
  assert.ok(worked?.alternatives.every((item) => item.rests.every((rest) => !rest.sourceActivityIds.includes('away'))))
})

test('neznámý úsek uprostřed volna přeruší jeden odpočinek', () => {
  const unknownStart = Date.parse('2026-04-01T12:00:00.000Z')
  const periods = periodsOf([
    leadIn(),
    activity('before', 'rest', Date.parse('2026-03-01T21:00:00.000Z'), unknownStart, { isManualEntry: true }),
    activity('gap', 'unknown', unknownStart, unknownStart + HOUR),
    activity('after', 'rest', unknownStart + HOUR, Date.parse('2026-05-04T03:00:00.000Z'), { isManualEntry: true }),
  ])
  const across = pairAt(periods, Date.parse('2026-03-30T00:00:00.000Z'))
  assert.equal(across?.status, 'insufficient_data')
  const resting = periods.filter((period) => period.status === 'resting_throughout')
  assert.ok(resting.length >= 2)
  assert.ok(
    resting.every(
      (period) => period.cover.endUtc <= unknownStart || period.cover.startUtc >= unknownStart + HOUR,
    ),
  )
  assert.equal(new Set(resting.map((period) => period.cover.nodeId)).size, 2)
})
