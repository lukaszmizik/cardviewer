import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComplianceReview } from '../src/components/complianceReview.ts'
import type { Activity, ActivityKind } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-04-27T20:00:00.000Z')
const TODAY = Date.parse('2026-04-27T00:00:00.000Z')
const PERIOD_START = Date.parse('2026-03-02T00:00:00.000Z')

function activity(id: string, kind: ActivityKind, startUtc: number, endUtc: number, extra: Partial<Activity> = {}): Activity {
  return { id, kind, startUtc, endUtc, durationMinutes: Math.round((endUtc - startUtc) / 60_000), slot: 1, ...extra }
}

function review(activities: Activity[], nowUtc = NOW) {
  return buildComplianceReview({ activities, nowUtc, clockMode: 'utc' })
}

function coveredDays(): Activity[] {
  const rows: Activity[] = []
  for (let week = PERIOD_START; week < TODAY; week += 7 * DAY) {
    rows.push(activity(`rest-${week}`, 'rest', week, week + 45 * HOUR))
    let cursor = week + 45 * HOUR
    while (cursor + DAY <= week + 7 * DAY) {
      rows.push(activity(`drive-${cursor}`, 'driving', cursor, cursor + 2 * HOUR))
      rows.push(activity(`work-${cursor}`, 'work', cursor + 2 * HOUR, cursor + 10 * HOUR))
      rows.push(activity(`sleep-${cursor}`, 'rest', cursor + 10 * HOUR, cursor + DAY))
      cursor += DAY
    }
    if (cursor < week + 7 * DAY) rows.push(activity(`fill-${week}`, 'work', cursor, week + 7 * DAY))
  }
  rows.push(activity('today-drive', 'driving', TODAY, TODAY + 2 * HOUR))
  rows.push(activity('today-rest', 'rest', TODAY + 2 * HOUR, TODAY + 16 * HOUR))
  rows.push(activity('today-tail', 'availability', TODAY + 16 * HOUR, NOW))
  return rows
}

test('úplné období bez porušení je zelené a nehlásí bez přestupků při neuzavřené kontrole', () => {
  const view = review(coveredDays())
  assert.equal(view.days.length, 57)
  assert.equal(view.violationCount, 0)
  assert.equal(view.uncertaintyCount, 0)
  assert.equal(view.dataComplete, true)
  assert.equal(view.days.every((day) => day.severity === 'clear'), true)
  assert.equal(view.summaryText.includes('bez přestupků'), false)
  assert.equal(JSON.stringify(view).includes('bez přestupků'), false)
})

test('několik porušení v jednom dni má jeden červený den a víc karet', () => {
  const start = TODAY + 6 * HOUR
  const view = review([
    activity('before', 'rest', start - 12 * HOUR, start),
    activity('long', 'driving', start, start + 11 * HOUR),
    activity('after', 'rest', start + 11 * HOUR, start + 25 * HOUR),
    activity('tail', 'work', start + 25 * HOUR, NOW),
  ])
  const violations = view.findings.filter((finding) => finding.severity === 'violation')
  assert.equal(violations.length >= 2, true)
  const days = new Set(violations.map((finding) => finding.mapDayUtc))
  assert.equal(days.size, 1)
  assert.equal(view.days.find((day) => day.dayStartUtc === TODAY)?.severity, 'violation')
})

test('nejistý výsledek není prokázané porušení', () => {
  const start = TODAY + 8 * HOUR
  const view = review([
    activity('drive', 'driving', start, start + 4 * HOUR, { isCrew: true }),
    activity('crew', 'availability', start + 4 * HOUR, start + 4 * HOUR + 45 * 60 * 1000, { isCrew: true }),
    activity('more', 'driving', start + 4 * HOUR + 45 * 60 * 1000, start + 5 * HOUR + 45 * 60 * 1000, { isCrew: true }),
    activity('tail', 'rest', start + 6 * HOUR, NOW),
  ])
  const crew = view.findings.find((finding) => finding.id.startsWith('break:'))
  assert.equal(crew?.severity, 'uncertain')
  assert.equal(view.violationCount, 0)
  assert.equal(view.days.find((day) => day.dayStartUtc === TODAY)?.severity, 'uncertain')
})

test('neúplná data nejsou zelená', () => {
  const start = TODAY - 2 * DAY
  const view = review([
    activity('rest', 'rest', start, start + 12 * HOUR),
    activity('drive', 'driving', start + 12 * HOUR, start + 14 * HOUR),
    activity('tail', 'work', start + 14 * HOUR, NOW),
  ])
  assert.equal(view.dataComplete, false)
  assert.equal(view.completenessText.includes('nepokrývá'), true)
  assert.equal(view.days.some((day) => day.severity === 'incomplete'), true)
  assert.equal(view.days.every((day) => day.severity !== 'clear' || day.dayStartUtc >= start), true)
  assert.equal(view.summaryText.includes('bez přestupků'), false)
})

test('porušení přes půlnoc je jedna karta', () => {
  const start = TODAY - 2 * HOUR
  const view = review([
    activity('drive', 'driving', start, start + 5 * HOUR),
    activity('tail', 'rest', start + 5 * HOUR, NOW),
  ])
  const breaks = view.findings.filter((finding) => finding.id.startsWith('break:'))
  assert.equal(breaks.length, 1)
  assert.equal(breaks[0]?.severity, 'violation')
  assert.equal(view.days.filter((day) => day.findingIds.includes(breaks[0]!.id)).length, 1)
})

test('aktuální neuzavřený den není zelený ani porušení', () => {
  const view = review([
    activity('yesterday', 'rest', TODAY - 12 * HOUR, TODAY + 8 * HOUR),
    activity('drive', 'driving', TODAY + 8 * HOUR, TODAY + 10 * HOUR),
  ], TODAY + 10 * HOUR)
  const today = view.days.find((day) => day.dayStartUtc === TODAY)
  assert.equal(today?.severity, 'incomplete')
  assert.notEqual(today?.severity, 'violation')
  assert.notEqual(today?.severity, 'clear')
})

test('otevřená náhrada s budoucím termínem je v hlídání, ne v porušeních', () => {
  const rest = Date.parse('2026-04-20T00:00:00.000Z')
  const view = review([
    activity('reduced', 'rest', rest, rest + 24 * HOUR),
    activity('tail', 'driving', rest + 24 * HOUR, rest + 25 * HOUR),
  ])
  assert.equal(view.findings.some((finding) => finding.severity === 'violation' && finding.id.startsWith('compensation:')), false)
  assert.equal(view.watches.some((item) => item.title.includes('21 h') && item.deadlineText?.includes('UTC')), true)
  assert.equal(view.watches.some((item) => item.detail.includes('nepotvrzuje')), true)
})
