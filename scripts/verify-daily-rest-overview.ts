import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import { buildDailyRestOverview, type DailyRestOverviewRow } from '../src/components/dailyRestOverview.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000

function activity(id: string, kind: Activity['kind'], startUtc: number, endUtc: number, overrides: Partial<Activity> = {}): Activity {
  return { id, kind, startUtc, endUtc, durationMinutes: Math.round((endUtc - startUtc) / 60_000), slot: 1, ...overrides }
}

function card(activities: Activity[]): DriverCardData {
  return { cardNumber: 'TEST', firstName: 'Test', surname: 'Driver', lastWithdrawalUtc: null, activities, locations: [], violations: [] }
}

function rowsOf(activities: Activity[]): DailyRestOverviewRow[] {
  const overview = buildDailyRestOverview(analyzeDriverActivities({ card: card(activities) }))
  assert.equal(overview.status, 'rows')
  if (overview.status !== 'rows') return []
  return overview.rows
}

test('běžný denní odpočinek má skutečný interval a délku', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = Date.parse('2026-03-03T17:00:00.000Z')
  const rows = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ])
  const row = rows.find((item) => item.recognition === 'Běžný denní odpočinek')
  assert.ok(row)
  assert.equal(row.dateUtc, '03.03.2026 UTC')
  assert.equal(row.intervalUtc, '03.03.2026 06:00–17:00 UTC')
  assert.equal(row.duration, '11:00')
  assert.equal(rows.filter((item) => item.id.startsWith('window:')).length, new Set(rows.filter((item) => item.id.startsWith('window:')).map((item) => item.id)).size)
})

test('zkrácený denní odpočinek zůstane rozpoznanou délkou', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = restStart + 10 * HOUR
  const row = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.recognition === 'Zkrácený denní odpočinek')
  assert.ok(row)
  assert.equal(row.intervalUtc, '03.03.2026 06:00–16:00 UTC')
  assert.equal(row.duration, '10:00')
})

test('dělený odpočinek a druhá možnost zůstanou v jednom okně', () => {
  const anchor = Date.parse('2026-03-02T18:00:00.000Z')
  const rows = rowsOf([
    activity('lead', 'rest', Date.parse('2026-03-02T07:00:00.000Z'), anchor),
    activity('part-3', 'rest', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-02T23:00:00.000Z')),
    activity('work', 'work', Date.parse('2026-03-02T23:00:00.000Z'), Date.parse('2026-03-03T01:00:00.000Z')),
    activity('part-9', 'rest', Date.parse('2026-03-03T01:00:00.000Z'), Date.parse('2026-03-03T10:00:00.000Z')),
    activity('after', 'driving', Date.parse('2026-03-03T10:00:00.000Z'), Date.parse('2026-03-04T00:00:00.000Z')),
  ])
  const alternatives = rows.filter((item) => item.recognition === 'Více možností')
  assert.equal(alternatives.length, 1)
  const row = alternatives[0]
  assert.ok(row)
  assert.match(row.intervalUtc, /dělený/)
  assert.match(row.intervalUtc, /zkrácený/)
  assert.match(row.intervalUtc, /část 1:/)
  assert.match(row.intervalUtc, /část 2:/)
  assert.match(row.intervalUtc, /20:00–23:00 UTC/)
  assert.match(row.intervalUtc, /01:00–10:00 UTC/)
  assert.match(row.note, /nejvýše jedna/)
})

test('osmihodinový odpočinek v nesplněném okně zůstane vidět', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T02:45:00.000Z')
  const restEnd = restStart + 8 * HOUR
  const row = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('short', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, anchor + 25 * HOUR),
  ]).find((item) => item.recognition === 'Nedostatečný odpočinek')
  assert.ok(row)
  assert.equal(row.intervalUtc, '03.03.2026 02:45–10:45 UTC')
  assert.equal(row.duration, '8:00')
  assert.match(row.note, /nesplňuje/)
})

test('obnovený řetězec a nehodnocený úsek se nezdvojí', () => {
  const origin = Date.parse('2026-03-02T06:00:00.000Z')
  const anchor = origin + 11 * HOUR
  const shortStart = anchor + 9 * HOUR + 45 * 60 * 1000
  const shortEnd = shortStart + 8 * HOUR
  const laterStart = Date.parse('2026-03-03T18:00:00.000Z')
  const laterEnd = laterStart + 11 * HOUR
  const rows = rowsOf([
    activity('initial', 'rest', origin, anchor),
    activity('drive-1', 'driving', anchor, shortStart),
    activity('short', 'rest', shortStart, shortEnd),
    activity('work', 'work', shortEnd, laterStart),
    activity('later', 'rest', laterStart, laterEnd),
  ])
  const gap = rows.find((item) => item.recognition === 'Nehodnocený úsek')
  assert.ok(gap)
  assert.match(gap.note, /nehodnotí/)
  assert.equal(rows.filter((item) => item.duration === '8:00').length, 1)
  assert.equal(rows.filter((item) => item.intervalUtc.includes('18:00') && item.recognition === 'Běžný denní odpočinek').length, 1)
  assert.equal(rows.some((item) => item.recognition === 'Nelze rozhodnout'), true)
  const order = rows.map((item) => item.recognition)
  assert.ok(order.indexOf('Nedostatečný odpočinek') < order.indexOf('Nehodnocený úsek'))
  assert.ok(order.indexOf('Nehodnocený úsek') < order.lastIndexOf('Běžný denní odpočinek'))
})

test('neprokázaný a ruční odpočinek dostanou poznámku', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = restStart + 11 * HOUR
  const unproven = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd),
    activity('overlap', 'driving', restStart + HOUR, restStart + 2 * HOUR, { slot: 2 }),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.recognition === 'Běžný denní odpočinek')
  assert.match(unproven?.note ?? '', /nejistý/)

  const manual = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd, { isManualEntry: true }),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.recognition === 'Běžný denní odpočinek')
  assert.match(manual?.note ?? '', /Ruční záznam/)
})

test('bez kotvy se místo tabulky vysvětlí, proč přehled chybí', () => {
  const overview = buildDailyRestOverview(analyzeDriverActivities({
    card: card([
      activity('short', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-02T14:00:00.000Z')),
      activity('drive', 'driving', Date.parse('2026-03-02T14:00:00.000Z'), Date.parse('2026-03-03T14:00:00.000Z')),
    ]),
  }))
  assert.equal(overview.status, 'needs_anchor')
  if (overview.status !== 'needs_anchor') return
  assert.match(overview.message, /11 hodin/)
})
