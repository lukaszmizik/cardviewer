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
  assert.equal(rows.find((row) => row.label === 'Doba řízení v pracovním období')?.statusText, 'Nelze určit')
  assert.equal(rows.find((row) => row.label === 'Doba řízení v pracovním období')?.primary, '—')
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
  assert.equal(first.find((row) => row.rule === 'article_6' && row.presentation === 'status')?.statusText, 'Nelze určit')
  assert.equal(second.find((row) => row.rule === 'article_6' && row.presentation === 'status')?.statusText, 'Nelze určit')
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

test('příznak osádky na jízdě sám o sobě neskryje prokázané překročení', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 6 * HOUR, START + 11 * HOUR, true)],
  })
  assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'Limit 4 h 30 min překročen.')
  assert.equal(JSON.stringify(rows).includes('přestupek'), false)
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
  assert.equal(value(shown, 'Bezpečnostní přestávky'), '45 min (10:00–10:45), 45 min (21:23–22:08)')
  assert.equal(value(shown, 'Ukončení cyklu řízení'), undefined)
  assert.equal(JSON.stringify(shown).includes('824'), false)
  assert.equal(JSON.stringify(shown).includes('29.09.2024'), false)
  assert.equal(JSON.stringify(shown).includes('týdenní'), false)
  assert.equal(JSON.stringify(shown).includes('denní odpočinek'), false)

  const middle = buildDayDrivingRows({ activities, dayStartUtc: later, dayEndUtc: later + DAY })
  assert.equal(value(middle, 'Bezpečnostní přestávky'), '—')
  assert.equal(middle.some((row) => row.label === 'Ukončení cyklu řízení'), false)
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
    activities: [
      activity('drive-1', 'driving', START + 8 * HOUR, START + 12 * HOUR, true),
      activity('wait', 'availability', START + 12 * HOUR, START + 12 * HOUR + 45 * MINUTE, true),
      activity('drive-2', 'driving', START + 13 * HOUR, START + 14 * HOUR, true),
    ],
  })
  assert.equal(tone(unknown, 'Výsledek přestávek v řízení'), 'undecided')
  assert.equal(value(unknown, 'Výsledek přestávek v řízení'), 'Nelze spolehlivě vyhodnotit.')
  assert.equal(tone(crew, 'Výsledek přestávek v řízení'), 'caution')
  assert.equal(value(crew, 'Výsledek přestávek v řízení'), 'Podmíněně uznáno')
  assert.notEqual(tone(crew, 'Výsledek přestávek v řízení'), 'clear')
  assert.equal(JSON.stringify(crew).includes('přestupek'), false)
  assert.equal(JSON.stringify(crew).includes('V limitu'), false)
})

test('kalendářní součet řízení není součástí vyhodnocení', () => {
  const rows = buildDayDrivingRows({
    dayStartUtc: START,
    dayEndUtc: START + DAY,
    activities: [activity('drive', 'driving', START + 8 * HOUR, START + 10 * HOUR)],
  })
  assert.equal(rows.some((row) => row.label === 'Celková zaznamenaná doba řízení'), false)
  assert.equal(JSON.stringify(rows).includes('není vyhodnocení podle čl. 6'), false)
  assert.equal(rows.find((row) => row.label === 'Doba řízení v pracovním období')?.statusText, 'Nelze určit')
  assert.equal(rows.find((row) => row.label === 'Doba řízení v pracovním období')?.tone, 'undecided')
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

function daily(rows: ReturnType<typeof buildDayDrivingRows>) {
  return rows.find((row) => row.label.startsWith('Doba řízení v pracovním období'))
}

test('uzavřená doba řízení rozliší běžnou, prodlouženou a nad 10 hodin', () => {
  const within = daily(weekRows([8, 8, 8]))
  assert.equal(within?.primary, '8 h')
  assert.equal(within?.statusText, 'Běžná')
  assert.equal(within?.mark, 'check')
  assert.equal(within?.tone, 'clear')
  const extended = daily(weekRows([9.5, 8, 8]))
  assert.equal(extended?.statusText, 'Prodloužená')
  assert.equal(extended?.mark, 'alarm')
  assert.equal(extended?.tone, 'caution')
  const exactTen = daily(weekRows([10, 8, 8]))
  assert.equal(exactTen?.statusText, 'Prodloužená')
  const over = daily(weekRows([10 + 1 / 60, 8, 8]))
  assert.equal(over?.statusText, 'Překročení')
  assert.equal(over?.mark, 'alert')
  assert.equal(over?.tone, 'exceeded')
  assert.equal(weekRows([8]).some((row) => row.label === 'Prodloužení denní doby řízení'), false)
  assert.equal(JSON.stringify(over).includes('přestupek'), false)
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
  assert.equal(first.find((row) => row.label === 'Doba řízení v pracovním období')?.primary, '10 h')
  assert.equal(second.find((row) => row.label === 'Doba řízení v pracovním období')?.primary, '10 h')
  assert.equal(first.filter((row) => row.label.startsWith('Doba řízení v pracovním období')).length, 1)
  assert.equal(second.find((row) => row.label === 'Doba řízení v pracovním období')?.primary === '2 h', false)
})

test('období přes pondělní půlnoc zůstane jedna denní doba řízení', () => {
  const sunday = WEEK - DAY
  const activities = [
    activity('open', 'rest', WEEK - 8 * DAY, sunday + 20 * HOUR),
    activity('drive', 'driving', sunday + 20 * HOUR, WEEK + 6 * HOUR),
    activity('close', 'rest', WEEK + 6 * HOUR, WEEK + 8 * DAY),
  ]
  const before = buildDayDrivingRows({ activities, dayStartUtc: sunday, dayEndUtc: WEEK })
  const after = buildDayDrivingRows({ activities, dayStartUtc: WEEK, dayEndUtc: WEEK + DAY })
  assert.equal(before.find((row) => row.label === 'Doba řízení v pracovním období')?.primary, '10 h')
  assert.equal(after.find((row) => row.label === 'Doba řízení v pracovním období')?.primary, '10 h')
})

test('dvě denní doby řízení v jednom dni se zobrazí odděleně', () => {
  const activities = [
    activity('open', 'rest', WEEK - 12 * HOUR, WEEK + HOUR),
    activity('drive-1', 'driving', WEEK + HOUR, WEEK + 3 * HOUR),
    activity('middle', 'rest', WEEK + 3 * HOUR, WEEK + 14 * HOUR),
    activity('drive-2', 'driving', WEEK + 16 * HOUR, WEEK + 18 * HOUR),
    activity('close', 'rest', WEEK + 18 * HOUR, WEEK + 29 * HOUR),
  ]
  const rows = buildDayDrivingRows({ activities, dayStartUtc: WEEK, dayEndUtc: WEEK + DAY }).filter((row) =>
    row.label.startsWith('Doba řízení v pracovním období'),
  )
  assert.deepEqual(
    rows.map((row) => row.label),
    ['Doba řízení v pracovním období 1', 'Doba řízení v pracovním období 2'],
  )
  assert.deepEqual(
    rows.map((row) => row.primary),
    ['2 h', '2 h'],
  )
  assert.equal(rows.every((row) => row.statusText === 'Běžná' && row.detail != null), true)
})

test('neuzavřené období do 9 hodin je běžné bez fajfky uzavřeného výsledku', () => {
  const anchor = WEEK + 6 * HOUR
  const rows = buildDayDrivingRows({
    activities: [
      activity('open', 'rest', WEEK - 12 * HOUR, anchor),
      activity('drive', 'driving', anchor, anchor + 2 * HOUR),
    ],
    dayStartUtc: WEEK,
    dayEndUtc: WEEK + DAY,
  })
  const row = daily(rows)
  assert.equal(row?.primary, '2 h')
  assert.equal(row?.statusText, 'Běžná')
  assert.equal(row?.mark, 'open')
  assert.equal(row?.mark === 'check', false)
  assert.equal(row?.tone, 'clear')
  assert.equal(row?.detail?.includes('Dosavadní stav. Období není uzavřeno.'), true)
  assert.equal(JSON.stringify(row).includes('Průběžně'), false)
})

test('neuzavřený součet nad 10 hodin je překročení a není zelený', () => {
  const anchor = WEEK + 6 * HOUR
  const row = daily(buildDayDrivingRows({
    activities: [
      activity('open', 'rest', WEEK - 12 * HOUR, anchor),
      activity('drive', 'driving', anchor, anchor + 10 * HOUR + MINUTE),
    ],
    dayStartUtc: WEEK,
    dayEndUtc: WEEK + DAY,
  }))
  assert.equal(row?.statusText, 'Překročení')
  assert.equal(row?.tone, 'exceeded')
  assert.equal(row?.mark, 'alert')
  assert.equal(row?.tone === 'clear', false)
  assert.equal(row?.detail?.includes('Období není uzavřeno.'), true)
  assert.equal(JSON.stringify(row).includes('Průběžně'), false)
})

test('uzavřené období do 9 hodin není označené jako průběžné', () => {
  const row = daily(weekRows([8]))
  assert.equal(row?.statusText, 'Běžná')
  assert.equal(row?.mark, 'check')
  assert.equal(JSON.stringify(row).includes('Průběžně'), false)
})

test('dřívější nejednoznačná hranice nezakryje pozdější den se stejným řízením', () => {
  const earlyAnchor = Date.parse('2024-10-25T09:36:00.000Z')
  const forkRest = earlyAnchor + HOUR
  const secondDrive = forkRest + 9 * HOUR
  const secondRest = secondDrive + HOUR
  const laterAnchor = Date.parse('2025-09-26T09:14:00.000Z')
  const splitStart = laterAnchor + 101 * MINUTE
  const splitEnd = splitStart + 4 * HOUR
  const longStart = splitEnd + HOUR
  const day = Date.parse('2025-09-26T00:00:00.000Z')
  const rows = buildDayDrivingRows({
    activities: [
      activity('early-open', 'rest', earlyAnchor - 12 * HOUR, earlyAnchor),
      activity('early-drive', 'driving', earlyAnchor, forkRest),
      activity('early-short', 'rest', forkRest, secondDrive),
      activity('early-drive-2', 'driving', secondDrive, secondRest),
      activity('bridge', 'rest', secondRest, laterAnchor),
      activity('later-drive', 'driving', laterAnchor, splitStart),
      activity('later-split', 'rest', splitStart, splitEnd),
      activity('later-gap', 'work', splitEnd, longStart),
      activity('later-long', 'rest', longStart, longStart + 20 * HOUR),
    ],
    dayStartUtc: day,
    dayEndUtc: day + DAY,
  })
  const row = daily(rows)
  assert.equal(row?.primary, '1 h 41 min')
  assert.equal(row?.statusText, 'Běžná')
  assert.equal(row?.mark, 'check')
  assert.equal(row?.tone, 'clear')
  assert.equal(row?.detail, '09:14–15:55')
  assert.equal(row?.detail?.includes('10:55'), false)
})

test('26. 9. 2025 má jednu běžnou denní dobu řízení do 18:21 místního času', () => {
  const anchor = Date.parse('2025-09-26T09:14:00.000Z')
  const firstPart = Date.parse('2025-09-26T11:18:00.000Z')
  const drivingEnd = Date.parse('2025-09-26T16:21:00.000Z')
  const day = Date.parse('2025-09-26T00:00:00.000Z')
  const row = daily(buildDayDrivingRows({
    activities: [
      activity('open', 'rest', anchor - 20 * HOUR, anchor),
      activity('drive', 'driving', anchor, anchor + 101 * MINUTE),
      activity('before-split', 'work', anchor + 101 * MINUTE, firstPart),
      activity('split', 'rest', firstPart, firstPart + 222 * MINUTE),
      activity('between', 'availability', firstPart + 222 * MINUTE, drivingEnd),
      activity('long', 'rest', drivingEnd, drivingEnd + 30 * HOUR),
    ],
    dayStartUtc: day,
    dayEndUtc: day + DAY,
  }))
  assert.equal(row?.primary, '1 h 41 min')
  assert.equal(row?.statusText, 'Běžná')
  assert.equal(row?.mark, 'check')
  assert.equal(row?.detail, '09:14–16:21')
  assert.equal(row?.detail?.includes('11:18'), false)
})

test('18. 10. 2025 započte 40 minut za první částí odpočinku', () => {
  const anchor = Date.parse('2025-10-18T13:10:00.000Z')
  const firstPart = Date.parse('2025-10-18T14:28:00.000Z')
  const between = Date.parse('2025-10-18T17:47:00.000Z')
  const drivingEnd = Date.parse('2025-10-18T18:47:00.000Z')
  const day = Date.parse('2025-10-18T00:00:00.000Z')
  const row = daily(buildDayDrivingRows({
    activities: [
      activity('open', 'rest', anchor - 20 * HOUR, anchor),
      activity('drive-early', 'driving', anchor, anchor + 37 * MINUTE),
      activity('before-rest', 'work', anchor + 37 * MINUTE, firstPart),
      activity('split', 'rest', firstPart, between),
      activity('drive-late', 'driving', between, between + 40 * MINUTE),
      activity('before-long', 'work', between + 40 * MINUTE, drivingEnd),
      activity('long', 'rest', drivingEnd, drivingEnd + 20 * HOUR),
    ],
    dayStartUtc: day,
    dayEndUtc: day + DAY,
  }))
  assert.equal(row?.primary, '1 h 17 min')
  assert.equal(row?.statusText, 'Běžná')
  assert.equal(row?.mark, 'check')
  assert.equal(row?.detail, '13:10–18:47')
  assert.equal(row?.primary === '37 min', false)
  assert.equal(row?.detail?.includes('14:28'), false)
})

test('neznámý úsek mezi variantami se nezobrazí jako přesný rozsah', () => {
  const anchor = WEEK + 6 * HOUR
  const firstRest = anchor + HOUR
  const row = daily(buildDayDrivingRows({
    activities: [
      activity('open', 'rest', WEEK - 12 * HOUR, anchor),
      activity('drive-1', 'driving', anchor, firstRest),
      activity('short', 'rest', firstRest, firstRest + 9 * HOUR),
      activity('gap', 'unknown', firstRest + 9 * HOUR, firstRest + 10 * HOUR),
      activity('drive-2', 'driving', firstRest + 10 * HOUR, firstRest + 11 * HOUR),
      activity('long', 'rest', firstRest + 11 * HOUR, firstRest + 22 * HOUR),
    ],
    dayStartUtc: WEEK,
    dayEndUtc: WEEK + DAY,
  }))
  assert.equal(row?.primary, '—')
  assert.equal(row?.statusText, 'Nelze určit')
  assert.equal(row?.detail, 'Přesný rozsah součtů nelze určit, protože některá varianta obsahuje neznámý úsek.')
  assert.equal(row?.primary.includes('–'), false)
})

test('neznámý úsek po známém začátku zůstane nerozhodnutý', () => {
  const anchor = WEEK + 6 * HOUR
  const rows = buildDayDrivingRows({
    activities: [
      activity('open', 'rest', WEEK - 12 * HOUR, anchor),
      activity('drive', 'driving', anchor, anchor + HOUR),
      activity('gap', 'unknown', anchor + HOUR, anchor + 2 * HOUR),
      activity('drive-2', 'driving', anchor + 2 * HOUR, anchor + 3 * HOUR),
    ],
    dayStartUtc: WEEK,
    dayEndUtc: WEEK + DAY,
  })
  const row = daily(rows)
  assert.equal(row?.statusText, 'Nelze určit')
  assert.equal(row?.mark, 'unknown')
  assert.equal(JSON.stringify(row).includes('Průběžně'), false)
})

test('7. a 8. 3. 2026 ukáže 45 minut po jízdě v osádce a limit 4 h 30 min', () => {
  const driveStart = Date.parse('2026-03-07T20:01:00.000Z')
  const driveEnd = Date.parse('2026-03-07T23:36:00.000Z')
  const restStart = Date.parse('2026-03-08T02:09:00.000Z')
  const activities = [
    activity('drive', 'driving', driveStart, driveEnd, true),
    activity('long', 'rest', restStart, restStart + 30 * HOUR),
  ]
  const [period] = assessDrivingBreaks(activities)
  assert.equal(period?.status, 'within_limit')
  assert.equal(period?.drivingMs, 3 * HOUR + 35 * MINUTE)
  assert.equal(period?.qualifyingBreak?.kind, 'continuous_45')
  assert.equal(period?.qualifyingBreak?.startUtc, restStart)
  assert.equal(period?.qualifyingBreak?.completedAtUtc, restStart + 45 * MINUTE)

  const march7 = Date.parse('2026-03-06T23:00:00.000Z')
  const march8 = Date.parse('2026-03-07T23:00:00.000Z')
  const first = buildDayDrivingRows({ activities, dayStartUtc: march7, dayEndUtc: march8, clockMode: 'local' })
  const second = buildDayDrivingRows({ activities, dayStartUtc: march8, dayEndUtc: march8 + DAY, clockMode: 'local' })
  for (const rows of [first, second]) {
    assert.equal(value(rows, 'Bezpečnostní přestávky'), '45 min (03:09–03:54)')
    assert.equal(value(rows, 'Výsledek přestávek v řízení'), 'V limitu 4 h 30 min.')
    assert.equal(tone(rows, 'Výsledek přestávek v řízení'), 'clear')
    assert.equal(value(rows, 'Nejdelší úsek řízení mezi přestávkami'), '3 h 35 min')
    assert.equal(JSON.stringify(rows).includes('Nelze spolehlivě vyhodnotit.'), false)
    assert.equal(JSON.stringify(rows).includes('09:09'), false)
  }
})
