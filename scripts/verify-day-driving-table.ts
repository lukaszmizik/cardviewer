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
  assert.equal(rows.some((row) => row.label === 'Celková zaznamenaná doba řízení'), false)
  assert.equal(rows.find((row) => row.label === 'Denní doba řízení')?.value, 'Nelze spolehlivě vyhodnotit.')
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
  assert.equal(first.some((row) => row.label === 'Celková zaznamenaná doba řízení'), false)
  assert.equal(second.some((row) => row.label === 'Celková zaznamenaná doba řízení'), false)
  assert.equal(first.find((row) => row.rule === 'article_6' && row.presentation === 'status')?.primary, 'Nelze spolehlivě vyhodnotit.')
  assert.equal(second.find((row) => row.rule === 'article_6' && row.presentation === 'status')?.primary, 'Nelze spolehlivě vyhodnotit.')
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

function tone(rows: ReturnType<typeof buildDayDrivingRows>, label: string) {
  return rows.find((row) => row.label === label)?.tone
}

test('uzavřený cyklus v limitu má zelený stav', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [
      activity('drive', 'driving', START + 8 * HOUR, START + 10 * HOUR),
      activity('rest', 'rest', START + 10 * HOUR, START + 10 * HOUR + 50 * MINUTE),
    ],
  })
  const breaks = rows.find((row) => row.label === 'Bezpečnostní přestávky')
  assert.equal(tone(rows, 'Výsledek přestávek v řízení'), 'clear')
  assert.equal(breaks?.primary, '50 min')
  assert.equal(breaks?.detail, '10:00–10:50')
  assert.equal(rows.some((row) => row.label === 'Celková zaznamenaná doba řízení'), false)
})

test('nedokončený cyklus není zelený', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 8 * HOUR, START + 10 * HOUR)],
  })
  const result = rows.find((row) => row.label === 'Výsledek přestávek v řízení')
  assert.equal(result?.value, 'V limitu 4 h 30 min.')
  assert.equal(result?.tone, 'caution')
  assert.equal(result?.detail, 'Cyklus řízení není uzavřen.')
  assert.notEqual(result?.tone, 'clear')
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
})

test('doložené překročení má červený stav a není přestupek', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR)],
  })
  assert.equal(tone(rows, 'Výsledek přestávek v řízení'), 'exceeded')
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
})

test('nedostatek údajů a nevyhodnocená osádka mají šedý stav', () => {
  const unknown = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [
      activity('before', 'driving', START + 8 * HOUR, START + 12 * HOUR),
      activity('gap', 'unknown', START + 12 * HOUR, START + 13 * HOUR),
      activity('after', 'driving', START + 13 * HOUR, START + 14 * HOUR),
    ],
  })
  const crew = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR, true)],
  })
  assert.equal(tone(unknown, 'Výsledek přestávek v řízení'), 'undecided')
  assert.equal(tone(crew, 'Výsledek přestávek v řízení'), 'undecided')
  assert.notEqual(tone(crew, 'Výsledek přestávek v řízení'), 'exceeded')
  assert.equal(JSON.stringify(crew).includes('přestupek'), false)
  assert.equal(JSON.stringify(crew).includes('překročen'), false)
})

test('kalendářní součet řízení není součástí vyhodnocení', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 8 * HOUR, START + 10 * HOUR)],
  })
  assert.equal(rows.some((row) => row.label === 'Celková zaznamenaná doba řízení'), false)
  assert.equal(JSON.stringify(rows).includes('není vyhodnocení podle čl. 6'), false)
  assert.equal(rows.find((row) => row.label === 'Denní doba řízení')?.tone, 'undecided')
})

const WEEK = Date.parse('2026-06-01T00:00:00.000Z')

function weekRows(driveHours: number[], dayStart = WEEK) {
  return buildDayDrivingRows({
    activities: weekDrives(driveHours),
    dayStartUtc: dayStart,
    dayEndUtc: dayStart + DAY,
  })
}

function weekDrives(driveHours: number[]): DayDrivingActivity[] {
  const activities: DayDrivingActivity[] = []
  const openEnd = WEEK + 6 * HOUR
  activities.push(activity('open', 'rest', WEEK - 18 * HOUR, openEnd))
  let cursor = openEnd
  driveHours.forEach((hours, index) => {
    const driveEnd = cursor + Math.round(hours * HOUR)
    activities.push(activity(`drive-${index}`, 'driving', cursor, driveEnd))
    const restEnd = index === driveHours.length - 1 ? Math.max(driveEnd + 11 * HOUR, WEEK + 8 * DAY) : driveEnd + 11 * HOUR
    activities.push(activity(`rest-${index}`, 'rest', driveEnd, restEnd))
    cursor = restEnd
  })
  return activities
}

function extension(rows: ReturnType<typeof buildDayDrivingRows>) {
  return rows.find((row) => row.label === 'Prodloužení denní doby řízení')
}

test('týden bez prodloužení má zbývající dvě', () => {
  assert.equal(new Date(WEEK).getUTCDay(), 1)
  const rows = weekRows([8, 8, 8])
  const row = extension(rows)
  assert.equal(row?.value, 'Zbývají 2 ze 2')
  assert.equal(row?.tone, 'clear')
  assert.deepEqual(row?.extensionSlots, ['available', 'available'])
  assert.equal(rows.find((item) => item.label === 'Denní doba řízení')?.primary, '8 h')
  assert.equal(rows.find((item) => item.label === 'Denní doba řízení')?.statusText, 'Do 9 hodin.')
})

test('jedno a dvě prodloužení ubírají zbývající počet', () => {
  const one = extension(weekRows([9.5, 8, 8]))
  assert.equal(one?.value, 'Zbývá 1 ze 2')
  assert.equal(one?.tone, 'clear')
  assert.deepEqual(one?.extensionSlots, ['used', 'available'])
  const two = extension(weekRows([9.5, 9.5, 8]))
  assert.equal(two?.value, 'Zbývá 0 ze 2')
  assert.equal(two?.tone, 'neutral')
  assert.deepEqual(two?.extensionSlots, ['used', 'used'])
})

test('tři prodloužení jsou doložené překročení počtu', () => {
  const row = extension(weekRows([9.5, 9.5, 9.5]))
  assert.equal(row?.value, 'Využito 3 ze 2')
  assert.equal(row?.tone, 'exceeded')
  assert.equal(JSON.stringify(row).includes('přestupek'), false)
})

test('směna přes půlnoc zůstane jedna denní doba řízení', () => {
  const tuesday = WEEK + DAY
  const activities = [
    activity('open', 'rest', WEEK - 12 * HOUR, tuesday + 20 * HOUR),
    activity('drive', 'driving', tuesday + 22 * HOUR, tuesday + DAY + 8 * HOUR),
    activity('close', 'rest', tuesday + DAY + 8 * HOUR, WEEK + 8 * DAY),
  ]
  const first = buildDayDrivingRows({ activities, dayStartUtc: tuesday, dayEndUtc: tuesday + DAY })
  const second = buildDayDrivingRows({ activities, dayStartUtc: tuesday + DAY, dayEndUtc: tuesday + 2 * DAY })
  assert.equal(first.find((row) => row.label === 'Denní doba řízení')?.primary, '10 h')
  assert.equal(second.find((row) => row.label === 'Denní doba řízení')?.primary, '10 h')
  assert.equal(first.filter((row) => row.label.startsWith('Denní doba řízení')).length, 1)
  assert.equal(extension(first)?.value, 'Zbývá 1 ze 2')
  assert.equal(second.find((row) => row.label === 'Denní doba řízení')?.primary === '2 h', false)
})

test('období přes pondělní půlnoc patří jen týdnu svého začátku', () => {
  const sunday = WEEK - DAY
  const activities = [
    activity('open', 'rest', WEEK - 8 * DAY, sunday + 20 * HOUR),
    activity('drive', 'driving', sunday + 20 * HOUR, WEEK + 6 * HOUR),
    activity('close', 'rest', WEEK + 6 * HOUR, WEEK + 8 * DAY),
  ]
  const before = buildDayDrivingRows({ activities, dayStartUtc: sunday, dayEndUtc: WEEK })
  const after = buildDayDrivingRows({ activities, dayStartUtc: WEEK, dayEndUtc: WEEK + DAY })
  assert.equal(before.find((row) => row.label === 'Denní doba řízení')?.primary, '10 h')
  assert.equal(after.find((row) => row.label === 'Denní doba řízení')?.primary, '10 h')
  assert.equal(extension(before)?.value, 'Zbývá 1 ze 2')
  assert.equal(extension(after)?.value, 'Zbývají 2 ze 2')
})

test('neúplný týden není nulový počet prodloužení', () => {
  const wednesday = WEEK + 2 * DAY
  const rows = buildDayDrivingRows({
    activities: [
      activity('open', 'rest', wednesday, wednesday + 11 * HOUR),
      activity('drive', 'driving', wednesday + 11 * HOUR, wednesday + 19 * HOUR),
      activity('close', 'rest', wednesday + 19 * HOUR, WEEK + 8 * DAY),
    ],
    dayStartUtc: wednesday,
    dayEndUtc: wednesday + DAY,
  })
  assert.equal(extension(rows)?.value, 'Nelze určit')
  assert.equal(extension(rows)?.tone, 'undecided')
  assert.deepEqual(extension(rows)?.extensionSlots, ['unknown', 'unknown'])
})

test('dvě denní doby řízení v jednom dni se zobrazí odděleně', () => {
  const activities = [
    activity('open', 'rest', WEEK - 12 * HOUR, WEEK + HOUR),
    activity('drive-1', 'driving', WEEK + HOUR, WEEK + 3 * HOUR),
    activity('middle', 'rest', WEEK + 3 * HOUR, WEEK + 14 * HOUR),
    activity('drive-2', 'driving', WEEK + 16 * HOUR, WEEK + 18 * HOUR),
    activity('close', 'rest', WEEK + 18 * HOUR, WEEK + 29 * HOUR),
  ]
  const daily = buildDayDrivingRows({ activities, dayStartUtc: WEEK, dayEndUtc: WEEK + DAY }).filter((row) =>
    row.label.startsWith('Denní doba řízení'),
  )
  assert.deepEqual(
    daily.map((row) => row.primary),
    ['2 h', '2 h'],
  )
})

test('překročení 10 hodin zůstane samostatné a prodloužení se započte', () => {
  const rows = weekRows([10 + 1 / 60, 8, 8])
  const daily = rows.find((row) => row.label === 'Denní doba řízení')
  assert.equal(daily?.statusText, 'Nad 10 hodin.')
  assert.equal(daily?.tone, 'exceeded')
  assert.equal(extension(rows)?.value, 'Zbývá 1 ze 2')
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
})
