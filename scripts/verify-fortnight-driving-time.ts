import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessAdjacentFortnightDrivingTimes,
  assessFortnightDrivingTime,
  FORTNIGHT_DRIVING_LIMIT_MS,
} from '../src/analysis/fortnightDrivingTime.ts'
import { buildFortnightDrivingRow } from '../src/components/fortnightDrivingPanel.ts'
import type { Activity, ActivityKind } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR
const WEEK = Date.parse('2026-06-01T00:00:00.000Z')
const NEXT = WEEK + 7 * DAY
const THIRD = NEXT + 7 * DAY
const FOURTH = THIRD + 7 * DAY

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

function cover(endUtc: number, driving: Activity[]): Activity[] {
  return [activity('cover', 'rest', WEEK, endUtc), ...driving]
}

test('45 hodin a 45 hodin je přesně 90 hodin bez překročení', () => {
  assert.equal(new Date(WEEK).getUTCDay(), 1)
  const result = assessFortnightDrivingTime({
    activities: cover(THIRD, [
      activity('first', 'driving', WEEK + HOUR, WEEK + HOUR + 45 * HOUR),
      activity('second', 'driving', NEXT + HOUR, NEXT + HOUR + 45 * HOUR),
    ]),
    laterWeekStartUtc: NEXT,
  })
  assert.equal(result.earlier.drivingMs, 45 * HOUR)
  assert.equal(result.later.drivingMs, 45 * HOUR)
  assert.equal(result.drivingMs, FORTNIGHT_DRIVING_LIMIT_MS)
  assert.equal(result.status, 'within_90h')
  assert.equal(result.dataComplete, true)
  assert.equal(result.fortnightClosed, true)
  assert.equal(result.limitMs, 90 * HOUR)
  assert.equal(JSON.stringify(result).includes('přestupek'), false)
})

test('45 hodin a 45 hodin 1 minuta je prokázané překročení', () => {
  const result = assessFortnightDrivingTime({
    activities: cover(THIRD, [
      activity('first', 'driving', WEEK + HOUR, WEEK + HOUR + 45 * HOUR),
      activity('second', 'driving', NEXT + HOUR, NEXT + HOUR + 45 * HOUR + MINUTE),
    ]),
    laterWeekStartUtc: NEXT,
  })
  assert.equal(result.drivingMs, 90 * HOUR + MINUTE)
  assert.equal(result.status, 'over_90h')
  assert.equal(result.dataComplete, true)
})

test('50 hodin a 50 hodin s mezerou zůstane prokázaným překročením', () => {
  const result = assessFortnightDrivingTime({
    activities: [
      activity('before-a', 'rest', WEEK, WEEK + 10 * HOUR),
      activity('first', 'driving', WEEK + 10 * HOUR, WEEK + 60 * HOUR),
      activity('after-a', 'rest', WEEK + 70 * HOUR, NEXT),
      activity('before-b', 'rest', NEXT, NEXT + 10 * HOUR),
      activity('second', 'driving', NEXT + 10 * HOUR, NEXT + 60 * HOUR),
      activity('after-b', 'rest', NEXT + 70 * HOUR, THIRD),
    ],
    laterWeekStartUtc: NEXT,
  })
  assert.equal(result.drivingMs, 100 * HOUR)
  assert.equal(result.dataComplete, false)
  assert.equal(result.status, 'over_90h')
  assert.ok(result.uncertainties.includes('activity_gap'))
})

test('neznámý úsek při součtu pod 90 hodin nedovolí potvrdit dodržení', () => {
  const result = assessFortnightDrivingTime({
    activities: cover(THIRD, [
      activity('drive', 'driving', WEEK + HOUR, WEEK + 11 * HOUR),
      activity('gap', 'unknown', NEXT + HOUR, NEXT + 2 * HOUR),
    ]),
    laterWeekStartUtc: NEXT,
  })
  assert.equal(result.drivingMs, 10 * HOUR)
  assert.equal(result.status, 'insufficient_data')
  assert.equal(result.dataComplete, false)
  assert.ok(result.uncertainties.includes('unknown_interval'))
  assert.equal(result.status === 'within_90h', false)
})

test('řízení přes pondělí 00:00 UTC se započte v každém týdnu jen jednou', () => {
  const start = NEXT - 2 * HOUR
  const end = NEXT + 3 * HOUR
  const result = assessFortnightDrivingTime({
    activities: [activity('drive', 'driving', start, end)],
    laterWeekStartUtc: NEXT,
  })
  assert.equal(result.earlier.drivingMs, 2 * HOUR)
  assert.equal(result.later.drivingMs, 3 * HOUR)
  assert.equal(result.drivingMs, 5 * HOUR)
  assert.equal(result.earlier.intervals[0]?.endUtc, NEXT)
  assert.equal(result.later.intervals[0]?.startUtc, NEXT)
  assert.equal(result.earlier.intervals[0]?.endUtc === result.later.intervals[0]?.startUtc, true)
  assert.equal(result.drivingMs === 10 * HOUR, false)
})

test('tři týdny 50, 50 a 0 hodin překročí jen první sousední dvojici', () => {
  const pairs = assessAdjacentFortnightDrivingTimes({
    activities: cover(FOURTH, [
      activity('first', 'driving', WEEK + HOUR, WEEK + HOUR + 50 * HOUR),
      activity('second', 'driving', NEXT + HOUR, NEXT + HOUR + 50 * HOUR),
    ]),
  })
  assert.equal(pairs.length, 2)
  assert.equal(pairs[0]?.earlierWeekStartUtc, WEEK)
  assert.equal(pairs[0]?.laterWeekStartUtc, NEXT)
  assert.equal(pairs[0]?.drivingMs, 100 * HOUR)
  assert.equal(pairs[0]?.status, 'over_90h')
  assert.equal(pairs[1]?.earlierWeekStartUtc, NEXT)
  assert.equal(pairs[1]?.laterWeekStartUtc, THIRD)
  assert.equal(pairs[1]?.drivingMs, 50 * HOUR)
  assert.equal(pairs[1]?.status, 'within_90h')
})

test('neúplný aktuální týden není definitivně v limitu', () => {
  const result = assessFortnightDrivingTime({
    activities: cover(NEXT + 2 * DAY, [activity('drive', 'driving', NEXT + HOUR, NEXT + 6 * HOUR)]),
    laterWeekStartUtc: NEXT,
    untilUtc: NEXT + 2 * DAY,
  })
  assert.equal(result.drivingMs, 5 * HOUR)
  assert.equal(result.dataComplete, true)
  assert.equal(result.fortnightClosed, false)
  assert.equal(result.evaluatedUntilUtc, NEXT + 2 * DAY)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.status === 'within_90h', false)
})

test('řádek ukáže průběžný součet, uzavřený limit i překročení před koncem týdne', () => {
  const open = buildFortnightDrivingRow({
    activities: cover(NEXT + 2 * DAY, [activity('drive', 'driving', WEEK + HOUR, WEEK + 4 * HOUR)]),
    dayEndUtc: NEXT + 2 * DAY,
  })
  assert.equal(open.title, 'Doba řízení za dva po sobě jdoucí týdny')
  assert.equal(open.valueText, '3 h / 90 h')
  assert.equal(open.statusText, 'Průběžný součet.')
  assert.equal(open.tone, 'open')
  assert.equal(open.result.status, 'incomplete')
  assert.ok(open.rangeText.includes('UTC'))
  assert.ok(open.notes.some((note) => note.includes('není uzavřeno')))
  assert.equal(JSON.stringify(open).includes('přestupek'), false)

  const closed = buildFortnightDrivingRow({
    activities: cover(THIRD, [
      activity('first', 'driving', WEEK + HOUR, WEEK + HOUR + 45 * HOUR),
      activity('second', 'driving', NEXT + HOUR, NEXT + HOUR + 45 * HOUR),
    ]),
    dayEndUtc: THIRD,
  })
  assert.equal(closed.valueText, '90 h / 90 h')
  assert.equal(closed.statusText, 'V limitu 90 h.')
  assert.equal(closed.tone, 'clear')
  assert.equal(closed.result.fortnightClosed, true)
  assert.deepEqual(closed.notes, [])

  const over = buildFortnightDrivingRow({
    activities: cover(NEXT + 2 * DAY, [activity('drive', 'driving', WEEK, WEEK + 91 * HOUR)]),
    dayEndUtc: NEXT + 2 * DAY,
  })
  assert.equal(over.result.fortnightClosed, false)
  assert.equal(over.result.status, 'over_90h')
  assert.equal(over.statusText, 'Překročení limitu 90 h.')
  assert.equal(over.tone, 'over')
  assert.equal(over.valueText, '91 h / 90 h')
})
