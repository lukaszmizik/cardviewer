import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import { REST_OVERVIEW_COLOR, buildDailyRestOverview, restOverviewColor, type DailyRestOverviewRow } from '../src/components/dailyRestOverview.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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

function detailText(row: DailyRestOverviewRow): string {
  return row.details.map((detail) => `${detail.label}: ${detail.value}`).join('\n')
}

function mainText(row: DailyRestOverviewRow): string {
  return `${row.dateUtc} ${row.restSummary} ${row.result}`
}

test('běžný denní odpočinek má stručný řádek a interval v detailu', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = Date.parse('2026-03-03T17:00:00.000Z')
  const rows = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ])
  const row = rows.find((item) => item.result === 'Běžný denní odpočinek')
  assert.ok(row)
  assert.equal(row.dateUtc, '3. 3. 2026')
  assert.equal(row.atUtc, restStart)
  assert.equal(row.restSummary, '11 h')
  assert.equal(row.tone, 'daily')
  assert.equal(restOverviewColor(row.tone), REST_OVERVIEW_COLOR.daily)
  assert.match(detailText(row), /03\.03\.2026 06:00/)
  assert.match(detailText(row), /17:00 UTC/)
  assert.match(detailText(row), /daily/)
  assert.equal(rows.filter((item) => item.id.startsWith('window:')).length, new Set(rows.filter((item) => item.id.startsWith('window:')).map((item) => item.id)).size)
})

test('zkrácený denní odpočinek zůstane zelený a bez týdenní role', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = restStart + 10 * HOUR
  const row = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.result === 'Zkrácený denní odpočinek')
  assert.ok(row)
  assert.equal(row.restSummary, '10 h')
  assert.equal(row.tone, 'daily')
  assert.equal(restOverviewColor(row.tone), '#2d7d3e')
  assert.doesNotMatch(mainText(row), /týdenní odpočinek/i)
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
  const alternatives = rows.filter((item) => item.result === 'Více možných interpretací')
  assert.equal(alternatives.length, 1)
  const row = alternatives[0]
  assert.ok(row)
  assert.equal(row.restSummary, 'Více možností')
  assert.equal(row.tone, 'neutral')
  assert.equal(restOverviewColor(row.tone), null)
  const details = detailText(row)
  assert.match(details, /dělený denní odpočinek/)
  assert.match(details, /zkrácený denní odpočinek/)
  assert.match(details, /část 1:/)
  assert.match(details, /část 2:/)
  assert.match(details, /20:00/)
  assert.match(details, /10:00/)
  assert.match(details, /nejvýše jedna/)
  assert.doesNotMatch(mainText(row), /20:00/)
  assert.doesNotMatch(mainText(row) + details, /týdenní odpočinek/i)
})

test('nesplněné období nechá krátké odpočinky jen v detailu', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const firstStart = Date.parse('2026-03-02T20:00:00.000Z')
  const secondStart = Date.parse('2026-03-02T22:00:00.000Z')
  const row = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive-1', 'driving', anchor, firstStart),
    activity('short-a', 'rest', firstStart, firstStart + 45 * 60 * 1000),
    activity('drive-2', 'driving', firstStart + 45 * 60 * 1000, secondStart),
    activity('short-b', 'rest', secondStart, secondStart + 2 * HOUR),
    activity('after', 'driving', secondStart + 2 * HOUR, anchor + 25 * HOUR),
  ]).find((item) => item.result === 'Nesplněné 24hodinové období')
  assert.ok(row)
  assert.equal(row.restSummary, 'Více úseků')
  assert.equal(row.attention, true)
  assert.equal(row.tone, 'daily')
  assert.doesNotMatch(mainText(row), /20:00|22:00/)
  assert.doesNotMatch(mainText(row), /přestupek|porušení/i)
  const details = detailText(row)
  assert.match(details, /short-a/)
  assert.match(details, /short-b/)
  assert.match(details, /20:00/)
  assert.match(details, /22:00/)
  assert.match(details, /pravomocně zjištěný přestupek/)
})

test('osmihodinový odpočinek zůstane v nesplněném období svou barvou', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T02:45:00.000Z')
  const restEnd = restStart + 8 * HOUR
  const row = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('short', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, anchor + 25 * HOUR),
  ]).find((item) => item.result === 'Nesplněné 24hodinové období')
  assert.ok(row)
  assert.equal(row.restSummary, '8 h')
  assert.equal(row.tone, 'daily')
  assert.match(detailText(row), /02:45/)
  assert.match(detailText(row), /nesplňuje/)
})

test('dlouhý souvislý odpočinek nedostane denní ani týdenní roli', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = anchor + HOUR
  const restEnd = restStart + 110 * DAY
  const row = rowsOf([
    activity('initial', 'rest', anchor - 11 * HOUR, anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('long', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, restEnd + 2 * HOUR),
  ]).find((item) => item.restSummary === '110 dní')
  assert.ok(row)
  assert.equal(row.result, 'Dlouhý souvislý odpočinek')
  assert.equal(row.tone, 'longRegularLength')
  assert.equal(restOverviewColor(row.tone), '#2563eb')
  assert.doesNotMatch(`${row.result}\n${detailText(row)}`, /týdenní odpočinek|Běžný denní odpočinek/i)
  assert.match(detailText(row), /Alespoň 45 hodin/)
  assert.match(detailText(row), /není potvrzena/)
})

test('odpočinek dlouhý 30 hodin má světle modrou délkovou barvu', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = anchor + HOUR
  const restEnd = restStart + 30 * HOUR
  const row = rowsOf([
    activity('initial', 'rest', anchor - 11 * HOUR, anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('long', 'rest', restStart, restEnd),
    activity('after', 'driving', restEnd, restEnd + 2 * HOUR),
  ]).find((item) => item.result === 'Dlouhý souvislý odpočinek')
  assert.ok(row)
  assert.equal(row.restSummary, '1 den 6 h')
  assert.equal(row.tone, 'longReducedLength')
  assert.equal(restOverviewColor(row.tone), '#60a5fa')
  assert.match(detailText(row), /méně než 45 hodin/)
  assert.doesNotMatch(detailText(row), /týdenní odpočinek/i)
})

test('neznámý úsek není odpočinek', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const row = rowsOf([
    activity('initial', 'rest', anchor - 11 * HOUR, anchor),
    activity('before', 'driving', anchor, Date.parse('2026-03-02T20:00:00.000Z')),
    activity('gap', 'unknown', Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-03T08:00:00.000Z')),
    activity('after', 'driving', Date.parse('2026-03-03T08:00:00.000Z'), Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.result === 'Nedostatečná data')
  assert.ok(row)
  assert.equal(row.tone, 'neutral')
  assert.equal(row.restSummary, 'Bez zaznamenaného odpočinku')
  assert.match(detailText(row), /Neznámý úsek není odpočinek/)
  assert.doesNotMatch(mainText(row), /12 h/)
  assert.doesNotMatch(row.result, /odpočinek/i)
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
  const gap = rows.find((item) => item.result === 'Úsek nebyl vyhodnocen')
  assert.ok(gap)
  assert.match(detailText(gap), /nehodnotí/)
  assert.doesNotMatch(detailText(gap), /porušení/)
  assert.equal(rows.filter((item) => item.restSummary === '8 h').length, 1)
  assert.equal(rows.filter((item) => item.result === 'Běžný denní odpočinek' && detailText(item).includes('later')).length, 1)
  assert.equal(rows.some((item) => item.result === 'Neúplná historie'), true)
  const order = rows.map((item) => item.result)
  assert.ok(order.indexOf('Nesplněné 24hodinové období') < order.indexOf('Úsek nebyl vyhodnocen'))
  assert.ok(order.indexOf('Úsek nebyl vyhodnocen') < order.lastIndexOf('Běžný denní odpočinek'))
  assert.equal(new Set(rows.map((item) => item.id)).size, rows.length)
})

test('neprokázaný a ruční odpočinek dostanou poznámku v detailu', () => {
  const anchor = Date.parse('2026-03-02T17:00:00.000Z')
  const restStart = Date.parse('2026-03-03T06:00:00.000Z')
  const restEnd = restStart + 11 * HOUR
  const unproven = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd),
    activity('overlap', 'driving', restStart + HOUR, restStart + 2 * HOUR, { slot: 2 }),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.result === 'Běžný denní odpočinek')
  assert.match(detailText(unproven!), /nejistý/)

  const manual = rowsOf([
    activity('initial', 'rest', Date.parse('2026-03-02T06:00:00.000Z'), anchor),
    activity('drive', 'driving', anchor, restStart),
    activity('daily', 'rest', restStart, restEnd, { isManualEntry: true }),
    activity('after', 'driving', restEnd, Date.parse('2026-03-04T18:00:00.000Z')),
  ]).find((item) => item.result === 'Běžný denní odpočinek')
  assert.match(detailText(manual!), /Ruční záznam/)
  assert.doesNotMatch(mainText(manual!), /Ruční záznam/)
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
