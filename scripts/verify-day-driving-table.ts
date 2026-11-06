import assert from 'node:assert/strict'
import test from 'node:test'
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
      activity('rest', 'rest', START + 10 * HOUR, START + 10 * HOUR + 45 * MINUTE),
    ],
  })
  assert.match(value(rows, 'Celková zaznamenaná doba řízení') ?? '', /2 h/)
  assert.match(value(rows, 'Celková zaznamenaná doba řízení') ?? '', /není vyhodnocení podle čl\. 6/)
  assert.equal(value(rows, 'Bezpečnostní přestávky'), '45 min')
  assert.equal(value(rows, 'Kontrola čl. 7'), 'V limitu 4 h 30 min.')
  assert.equal(value(rows, 'Nejdelší úsek řízení mezi přestávkami'), '2 h')
})

test('překročení 4 h 30 min není označené jako přestupek', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR)],
  })
  assert.equal(value(rows, 'Kontrola čl. 7'), 'Limit 4 h 30 min překročen.')
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
  assert.equal(value(rows, 'Bezpečnostní přestávky'), '15 + 30 min')
  assert.equal(value(rows, 'Kontrola čl. 7'), 'V limitu 4 h 30 min.')
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
  assert.equal(value(first, 'Kontrola čl. 7'), 'Limit 4 h 30 min překročen.')
  assert.equal(value(second, 'Kontrola čl. 7'), 'Limit 4 h 30 min překročen.')
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
  assert.equal(value(rows, 'Kontrola čl. 7'), 'Nelze spolehlivě vyhodnotit.')
  assert.equal(value(rows, 'Nejdelší úsek řízení mezi přestávkami'), undefined)
  assert.equal(JSON.stringify(rows).includes('překročen'), false)
})

test('režim osádky zůstane nevyhodnocenou výjimkou', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR, true)],
  })
  assert.equal(value(rows, 'Kontrola čl. 7'), 'Nelze spolehlivě vyhodnotit.')
  assert.match(value(rows, 'Celková zaznamenaná doba řízení') ?? '', /5 h/)
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
  assert.equal(JSON.stringify(rows).includes('překročen'), false)
})
