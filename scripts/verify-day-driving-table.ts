import assert from 'node:assert/strict'
import test from 'node:test'
import { assessDrivingBreaks } from '../src/analysis/drivingBreaks.ts'
import { buildDayDrivingRows, type DayDrivingActivity } from '../src/components/dayDrivingTable.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR
const START = Date.parse('2026-06-01T00:00:00.000Z')

function activity(id: string, kind: DayDrivingActivity['kind'], startUtc: number, endUtc: number, isCrew = false): DayDrivingActivity {
  return { id, kind, startUtc, endUtc, isCrew }
}

function value(rows: ReturnType<typeof buildDayDrivingRows>, label: string): string | undefined {
  return rows.find((row) => row.label === label)?.value
}

test('den s řízením a platnou přestávkou', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [
      activity('drive', 'driving', START + 8 * HOUR, START + 10 * HOUR),
      activity('rest', 'rest', START + 10 * HOUR, START + 10 * HOUR + 50 * MINUTE),
    ],
  })
  assert.match(value(rows, 'Celková zaznamenaná doba řízení') ?? '', /2 h/)
  assert.match(value(rows, 'Celková zaznamenaná doba řízení') ?? '', /není vyhodnocení podle čl\. 6/)
  assert.equal(value(rows, 'Bezpečnostní přestávky'), '50 min (10:00–10:50)')
  assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'V limitu 4 h 30 min.')
  assert.equal(value(rows, 'Nejdelší úsek řízení mezi přestávkami'), '2 h')
})

test('překročení 4 h 30 min není označené jako přestupek', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR)],
  })
  assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'Limit 4 h 30 min překročen.')
  assert.equal(value(rows, 'Nejdelší úsek řízení mezi přestávkami'), '5 h')
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
})

test('dělená přestávka 15 + 30 minut', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [
      activity('drive-1', 'driving', START + 8 * HOUR, START + 10 * HOUR),
      activity('first', 'rest', START + 10 * HOUR, START + 10 * HOUR + 15 * MINUTE),
      activity('drive-2', 'driving', START + 10 * HOUR + 15 * MINUTE, START + 11 * HOUR),
      activity('second', 'rest', START + 11 * HOUR, START + 11 * HOUR + 30 * MINUTE),
    ],
  })
  assert.equal(value(rows, 'Bezpečnostní přestávky'), '15 min (10:00–10:15), 30 min (11:00–11:30)')
  assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'V limitu 4 h 30 min.')
})

test('cyklus řízení pokračuje přes půlnoc', () => {
  const activities = [
    activity('before', 'driving', START + 22 * HOUR, START + DAY),
    activity('after', 'driving', START + DAY, START + DAY + 3 * HOUR),
  ]
  const first = buildDayDrivingRows({ activities, dayStartUtc: START, dayEndUtc: START + DAY })
  const second = buildDayDrivingRows({ activities, dayStartUtc: START + DAY, dayEndUtc: START + 2 * DAY })
  assert.match(value(first, 'Celková zaznamenaná doba řízení') ?? '', /^2 h\./)
  assert.match(value(second, 'Celková zaznamenaná doba řízení') ?? '', /^3 h\./)
  assert.equal(value(first, 'Výsledek přestávek v řízení'), 'Limit 4 h 30 min překročen.')
  assert.equal(value(second, 'Výsledek přestávek v řízení'), 'Limit 4 h 30 min překročen.')
  assert.equal(value(first, 'Nejdelší úsek řízení mezi přestávkami'), '5 h')
  assert.equal(value(second, 'Nejdelší úsek řízení mezi přestávkami'), '5 h')
})

test('neznámý úsek nedovolí prokázané překročení', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [
      activity('before', 'driving', START + 8 * HOUR, START + 12 * HOUR),
      activity('gap', 'unknown', START + 12 * HOUR, START + 13 * HOUR),
      activity('after', 'driving', START + 13 * HOUR, START + 14 * HOUR),
    ],
  })
  assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'Nelze spolehlivě vyhodnotit.')
  assert.equal(value(rows, 'Nejdelší úsek řízení mezi přestávkami'), undefined)
  assert.equal(JSON.stringify(rows).includes('překročen'), false)
})

test('režim osádky zůstane nevyhodnocenou výjimkou', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR, true)],
  })
  assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'Nelze spolehlivě vyhodnotit.')
  assert.match(value(rows, 'Celková zaznamenaná doba řízení') ?? '', /5 h/)
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
  assert.equal(JSON.stringify(rows).includes('překročen'), false)
})

test('odpočinek 824 h 51 min resetuje řízení a není přestávka', () => {
  const restStart = Date.parse('2024-08-25T21:23:00.000Z')
  const restEnd = Date.parse('2024-09-29T06:14:00.000Z')
  assert.equal(restEnd - restStart, 824 * HOUR + 51 * MINUTE)
  const day = Date.parse('2024-08-25T00:00:00.000Z')
  const later = Date.parse('2024-09-10T00:00:00.000Z')
  const after = Date.parse('2024-09-29T00:00:00.000Z')
  const activities = [
    activity('drive-1', 'driving', day + 8 * HOUR, day + 10 * HOUR),
    activity('short', 'rest', day + 10 * HOUR, day + 10 * HOUR + 45 * MINUTE),
    activity('drive-2', 'driving', day + 11 * HOUR, day + 13 * HOUR),
    activity('long', 'rest', restStart, restEnd),
    activity('drive-3', 'driving', restEnd, restEnd + 2 * HOUR),
  ]
  const periods = assessDrivingBreaks(activities)
  assert.equal(periods[1]?.drivingMs, 2 * HOUR)
  assert.equal(periods[1]?.qualifyingBreak?.kind, 'continuous_45')
  assert.equal(periods[2]?.drivingMs, 2 * HOUR)
  assert.equal(periods[2]?.startUtc, restEnd)

  const shown = buildDayDrivingRows({ activities, dayStartUtc: day, dayEndUtc: day + DAY })
  assert.equal(value(shown, 'Bezpečnostní přestávky'), '45 min (10:00–10:45)')
  assert.equal(value(shown, 'Ukončení cyklu řízení'), 'Cyklus řízení ukončen odpočinkem.')
  assert.equal(JSON.stringify(shown).includes('824'), false)
  assert.equal(JSON.stringify(shown).includes('29.09.2024'), false)
  assert.equal(JSON.stringify(shown).includes('týdenní'), false)
  assert.equal(JSON.stringify(shown).includes('denní odpočinek'), false)

  const middle = buildDayDrivingRows({ activities, dayStartUtc: later, dayEndUtc: later + DAY })
  assert.equal(value(middle, 'Bezpečnostní přestávky'), '—')
  assert.equal(value(middle, 'Ukončení cyklu řízení'), undefined)
  assert.equal(JSON.stringify(middle).includes('824'), false)
  assert.equal(JSON.stringify(middle).includes('10:00'), false)

  const resumed = buildDayDrivingRows({ activities, dayStartUtc: after, dayEndUtc: after + DAY })
  assert.equal(value(resumed, 'Nejdelší úsek řízení mezi přestávkami'), '2 h')
  assert.equal(JSON.stringify(resumed).includes('824'), false)
  assert.equal(JSON.stringify(resumed).includes('10:00–10:45'), false)
})
