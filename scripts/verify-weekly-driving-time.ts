import assert from 'node:assert/strict'
import test from 'node:test'
import { assessWeeklyDrivingTime, WEEKLY_DRIVING_LIMIT_MS } from '../src/analysis/weeklyDrivingTime.ts'
import { buildWeeklyDrivingPanel } from '../src/components/weeklyDrivingPanel.ts'
import type { Activity, ActivityKind } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR
const WEEK = Date.parse('2026-06-01T00:00:00.000Z')
const NEXT = WEEK + 7 * DAY

function activity(id: string, kind: ActivityKind, startUtc: number, endUtc: number): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / MINUTE),
    slot: 1,
  }
}

function covered(driving: Activity[]): Activity[] {
  return [activity('cover', 'rest', WEEK, NEXT), ...driving]
}

test('pondělí 00:00 UTC je začátek týdne a přesně 56 hodin je v limitu', () => {
  assert.equal(new Date(WEEK).getUTCDay(), 1)
  const result = assessWeeklyDrivingTime({
    activities: covered([activity('drive', 'driving', WEEK, WEEK + WEEKLY_DRIVING_LIMIT_MS)]),
    weekStartUtc: WEEK,
  })
  assert.equal(result.weekStartUtc, WEEK)
  assert.equal(result.weekEndUtc, NEXT)
  assert.equal(result.drivingMs, 56 * HOUR)
  assert.equal(result.status, 'within_56h')
  assert.equal(result.dataComplete, true)
  assert.equal(result.limitMs, 56 * HOUR)
  assert.equal(result.intervals[0]?.sourceActivityIds.includes('drive'), true)
  assert.equal(JSON.stringify(result).includes('přestupek'), false)
})

test('56 hodin a 1 minuta je prokazatelné překročení', () => {
  const result = assessWeeklyDrivingTime({
    activities: covered([activity('drive', 'driving', WEEK, WEEK + WEEKLY_DRIVING_LIMIT_MS + MINUTE)]),
    weekStartUtc: WEEK,
  })
  assert.equal(result.drivingMs, 56 * HOUR + MINUTE)
  assert.equal(result.status, 'over_56h')
  assert.equal(result.dataComplete, true)
})

test('překročení zůstane viditelné i při neznámém úseku', () => {
  const result = assessWeeklyDrivingTime({
    activities: [
      activity('drive', 'driving', WEEK, WEEK + WEEKLY_DRIVING_LIMIT_MS + MINUTE),
      activity('gap', 'unknown', WEEK + 60 * HOUR, WEEK + 61 * HOUR),
      activity('cover', 'rest', WEEK, NEXT),
    ],
    weekStartUtc: WEEK,
  })
  assert.equal(result.status, 'over_56h')
  assert.equal(result.dataComplete, false)
  assert.ok(result.uncertainties.includes('unknown_interval'))
})

test('řízení přes nedělní půlnoc se rozdělí na hranici týdne', () => {
  const start = NEXT - 2 * HOUR
  const end = NEXT + 3 * HOUR
  const activities = [activity('drive', 'driving', start, end)]
  const before = assessWeeklyDrivingTime({ activities, weekStartUtc: WEEK })
  const after = assessWeeklyDrivingTime({ activities, weekStartUtc: NEXT })
  assert.equal(before.drivingMs, 2 * HOUR)
  assert.equal(after.drivingMs, 3 * HOUR)
  assert.equal(before.drivingMs + after.drivingMs, 5 * HOUR)
  assert.equal(before.intervals[0]?.endUtc, NEXT)
  assert.equal(after.intervals[0]?.startUtc, NEXT)
  assert.equal(before.status, 'incomplete')
  assert.equal(after.status, 'incomplete')
})

test('týden bez řízení s úplnými daty je v limitu', () => {
  const result = assessWeeklyDrivingTime({
    activities: [
      activity('rest', 'rest', WEEK, NEXT),
      activity('work', 'work', WEEK + 8 * HOUR, WEEK + 10 * HOUR),
      activity('availability', 'availability', WEEK + 10 * HOUR, WEEK + 12 * HOUR),
    ],
    weekStartUtc: WEEK,
  })
  assert.equal(result.drivingMs, 0)
  assert.equal(result.status, 'within_56h')
  assert.equal(result.dataComplete, true)
  assert.deepEqual(result.intervals, [])
})

test('neúplný týden neoznačí dosud zjištěné řízení jako uzavřený limit', () => {
  const result = assessWeeklyDrivingTime({
    activities: [activity('drive', 'driving', WEEK + 2 * 24 * HOUR, WEEK + 2 * 24 * HOUR + 8 * HOUR)],
    weekStartUtc: WEEK,
  })
  assert.equal(result.drivingMs, 8 * HOUR)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.dataComplete, false)
  assert.equal(result.status === 'within_56h', false)
  assert.ok(result.uncertainties.includes('record_incomplete'))
})

test('neznámý úsek nedovolí uzavřít součet do 56 hodin', () => {
  const result = assessWeeklyDrivingTime({
    activities: [
      activity('cover', 'rest', WEEK, NEXT),
      activity('drive', 'driving', WEEK + HOUR, WEEK + 6 * HOUR),
      activity('gap', 'unknown', WEEK + 6 * HOUR, WEEK + 7 * HOUR),
    ],
    weekStartUtc: WEEK,
  })
  assert.equal(result.drivingMs, 5 * HOUR)
  assert.equal(result.status, 'insufficient_data')
  assert.equal(result.dataComplete, false)
  assert.ok(result.uncertainties.includes('unknown_interval'))
  assert.equal(result.status === 'within_56h', false)
})

test('překryv a duplicita se do týdenního součtu nezapočítají dvakrát', () => {
  const result = assessWeeklyDrivingTime({
    activities: covered([
      activity('first', 'driving', WEEK + HOUR, WEEK + 5 * HOUR),
      activity('duplicate', 'driving', WEEK + HOUR, WEEK + 5 * HOUR),
      activity('overlap', 'driving', WEEK + 4 * HOUR, WEEK + 7 * HOUR),
    ]),
    weekStartUtc: WEEK,
  })
  assert.equal(result.drivingMs, 6 * HOUR)
  assert.equal(result.status, 'within_56h')
  assert.ok(result.uncertainties.includes('overlapping_records'))
  assert.deepEqual(result.intervals[0]?.sourceActivityIds, ['first', 'duplicate', 'overlap'])
})

test('součet narůstá od pondělí do neděle a další týden začíná znovu', () => {
  const drives = [0, 1, 2, 3, 4, 5, 6].map((day) =>
    activity(`day-${day}`, 'driving', WEEK + day * DAY + 8 * HOUR, WEEK + day * DAY + 9 * HOUR),
  )
  const activities = covered(drives)
  const monday = assessWeeklyDrivingTime({ activities, weekStartUtc: WEEK, untilUtc: WEEK + DAY })
  const wednesday = assessWeeklyDrivingTime({ activities, weekStartUtc: WEEK, untilUtc: WEEK + 3 * DAY })
  const sunday = assessWeeklyDrivingTime({ activities, weekStartUtc: WEEK, untilUtc: NEXT })
  assert.equal(monday.drivingMs, HOUR)
  assert.equal(wednesday.drivingMs, 3 * HOUR)
  assert.equal(sunday.drivingMs, 7 * HOUR)
  assert.equal(monday.status, 'within_56h')
  assert.equal(sunday.status, 'within_56h')
  assert.equal(sunday.evaluatedUntilUtc, NEXT)
  const next = assessWeeklyDrivingTime({
    activities: covered([activity('next', 'driving', NEXT + 8 * HOUR, NEXT + 10 * HOUR)]).map((item) =>
      item.id === 'cover' ? activity('cover', 'rest', WEEK, NEXT + 7 * DAY) : item,
    ),
    weekStartUtc: NEXT,
    untilUtc: NEXT + DAY,
  })
  assert.equal(next.weekStartUtc, NEXT)
  assert.equal(next.drivingMs, 2 * HOUR)
  assert.equal(next.drivingMs === sunday.drivingMs, false)
})

test('vnitřní mezera není nulové řízení a týden neuzavře', () => {
  const result = assessWeeklyDrivingTime({
    activities: [
      activity('before', 'rest', WEEK, WEEK + 10 * HOUR),
      activity('drive', 'driving', WEEK + 10 * HOUR, WEEK + 12 * HOUR),
      activity('after', 'rest', WEEK + 14 * HOUR, NEXT),
    ],
    weekStartUtc: WEEK,
  })
  assert.equal(result.drivingMs, 2 * HOUR)
  assert.equal(result.dataComplete, false)
  assert.equal(result.status, 'incomplete')
  assert.ok(result.uncertainties.includes('activity_gap'))
  assert.equal(result.status === 'within_56h', false)
})

test('panel ukáže průběžný součet, překročení a neúplný údaj', () => {
  const drives = [0, 1, 2].map((day) => activity(`day-${day}`, 'driving', WEEK + day * DAY, WEEK + day * DAY + 2 * HOUR))
  const monday = buildWeeklyDrivingPanel({ activities: covered(drives), dayEndUtc: WEEK + DAY })
  const wednesday = buildWeeklyDrivingPanel({ activities: covered(drives), dayEndUtc: WEEK + 3 * DAY })
  assert.equal(monday.title, 'Týdenní doba řízení')
  assert.equal(monday.valueText, '2 h / 56 h')
  assert.equal(wednesday.valueText, '6 h / 56 h')
  assert.equal(monday.tone, 'fill')
  assert.equal(monday.notes.includes('Součet nemusí být konečný.'), false)
  assert.ok(monday.notes.some((note) => note.includes('podíl')))
  assert.equal(JSON.stringify(monday).includes('přestupek'), false)

  const exact = buildWeeklyDrivingPanel({
    activities: covered([activity('drive', 'driving', WEEK, WEEK + WEEKLY_DRIVING_LIMIT_MS)]),
    dayEndUtc: NEXT,
  })
  assert.equal(exact.valueText, '56 h / 56 h')
  assert.equal(exact.tone, 'fill')
  assert.equal(exact.fill, 1)

  const over = buildWeeklyDrivingPanel({
    activities: covered([activity('drive', 'driving', WEEK, WEEK + WEEKLY_DRIVING_LIMIT_MS + MINUTE)]),
    dayEndUtc: NEXT,
  })
  assert.equal(over.valueText, '56 h 1 min / 56 h')
  assert.equal(over.tone, 'over')
  assert.ok(over.notes.includes('Překročení limitu 56 h.'))

  const gap = buildWeeklyDrivingPanel({
    activities: [
      activity('before', 'rest', WEEK, WEEK + 10 * HOUR),
      activity('after', 'rest', WEEK + 12 * HOUR, NEXT),
    ],
    dayEndUtc: NEXT,
  })
  assert.equal(gap.valueText, '0 min / 56 h')
  assert.equal(gap.tone, 'fill')
  assert.ok(gap.notes.includes('Součet nemusí být konečný.'))

  const unknown = buildWeeklyDrivingPanel({
    activities: covered([activity('gap', 'unknown', WEEK + HOUR, WEEK + 2 * HOUR)]),
    dayEndUtc: WEEK + DAY,
  })
  assert.equal(unknown.result.status, 'insufficient_data')
  assert.ok(unknown.notes.includes('Součet nemusí být konečný.'))
  assert.equal(unknown.tone === 'over', false)
})
