import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComplianceDiagnostic, buildComplianceReview } from '../src/components/complianceReview.ts'
import { buildWorkPeriodOverview } from '../src/presentation/workPeriodOverview.ts'
import type { Activity, ActivityKind, CardPresentEdge, DriverCardData, Location, LocationRecordType } from '../src/types/tacho.ts'

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

test('uzavřené dny úplného období jsou zelené a neuzavřené kontroly ne', () => {
  const view = review(coveredDays())
  assert.equal(view.days.length, 57)
  assert.equal(view.violationCount, 0)
  assert.equal(view.uncertaintyCount, 0)
  assert.equal(view.dataComplete, true)
  assert.equal(view.days.find((day) => day.dayStartUtc === Date.parse('2026-04-01T00:00:00.000Z'))?.severity, 'clear')
  assert.equal(view.days.find((day) => day.dayStartUtc === Date.parse('2026-04-01T00:00:00.000Z'))?.note, null)
  const first = view.days.find((day) => day.dayStartUtc === PERIOD_START)
  assert.equal(first?.severity, 'incomplete')
  assert.equal(first?.note?.includes('nemá dost údajů'), true)
  assert.notEqual(view.days.find((day) => day.dayStartUtc === TODAY)?.severity, 'clear')
  assert.equal(view.summaryText.includes('bez přestupků'), false)
  assert.equal(JSON.stringify(view).includes('bez přestupků'), false)
  assert.equal(view.unevaluatedNotes.some((note) => note.includes('tří zkrácených')), false)
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
  const crew = view.findings.find((finding) => finding.id.startsWith('break-conditional:'))
  assert.equal(crew?.severity, 'uncertain')
  assert.equal(crew?.actualText, 'Podmíněně uznáno')
  assert.equal(crew?.explanation, 'Přestávka je uznatelná za předpokladu, že vozidlo řídil druhý řidič a odpočívající řidič mu během této doby nepomáhal při řízení.')
  assert.equal(view.violationCount, 0)
  assert.equal(view.findings.some((finding) => finding.severity === 'violation'), false)
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
  assert.equal(view.findings.some((finding) => finding.id.startsWith('extensions:')), false)
})

test('tři uzavřená prodloužení v jednom týdnu jsou porušení', () => {
  const week = Date.parse('2026-04-06T00:00:00.000Z')
  const rows: Activity[] = [activity('open', 'rest', week - 48 * HOUR, week)]
  let cursor = week
  for (let index = 0; index < 3; index += 1) {
    const pause = 45 * 60 * 1000
    rows.push(activity(`d1-${index}`, 'driving', cursor, cursor + 4 * HOUR))
    rows.push(activity(`b1-${index}`, 'rest', cursor + 4 * HOUR, cursor + 4 * HOUR + pause))
    rows.push(activity(`d2-${index}`, 'driving', cursor + 4 * HOUR + pause, cursor + 8 * HOUR + pause))
    rows.push(activity(`b2-${index}`, 'rest', cursor + 8 * HOUR + pause, cursor + 8 * HOUR + 2 * pause))
    rows.push(activity(`d3-${index}`, 'driving', cursor + 8 * HOUR + 2 * pause, cursor + 9.5 * HOUR + 2 * pause))
    rows.push(activity(`sleep-${index}`, 'rest', cursor + 9.5 * HOUR + 2 * pause, cursor + DAY))
    cursor += DAY
  }
  rows.push(activity('tail', 'rest', cursor, NOW))
  const view = review(rows)
  const extension = view.findings.find((finding) => finding.id.startsWith('extensions:'))
  assert.equal(extension?.severity, 'violation')
  assert.equal(extension?.actualText.includes('3'), true)
  assert.equal(view.days.filter((day) => day.findingIds.includes(extension?.id ?? '')).length, 1)
})

test('týdenní odpočinek po šesti 24hodinových obdobích je prokázané porušení', () => {
  const end = Date.parse('2026-04-02T06:00:00.000Z')
  const next = end + 6 * DAY + 60_000
  const view = review([
    activity('first', 'rest', end - 45 * HOUR, end),
    activity('gap', 'work', end, next),
    activity('second', 'rest', next, next + 24 * HOUR),
    activity('tail', 'work', next + 24 * HOUR, NOW),
  ])
  const finding = view.findings.find((item) => item.id.startsWith('weekly-start:'))
  assert.equal(finding?.severity, 'violation')
  assert.equal(finding?.reviewStatus, 'proven')
  assert.match(finding?.technicalText ?? '', /article_8_6/)
  assert.equal(finding?.sourceActivityIds?.includes('first'), true)
  assert.equal(finding?.sourceActivityIds?.includes('second'), true)
  assert.equal(finding?.id, `weekly-start:${end}`)
})

test('neznámý úsek před lhůtou šesti období není prokázané porušení', () => {
  const end = Date.parse('2026-04-02T06:00:00.000Z')
  const view = review([
    activity('first', 'rest', end - 45 * HOUR, end),
    activity('gap', 'unknown', end + HOUR, end + 2 * HOUR),
    activity('tail', 'work', end + 2 * HOUR, NOW),
  ])
  const finding = view.findings.find((item) => item.id.startsWith('weekly-start:'))
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.reviewStatus, 'needs_verification')
})

test('uzavřené dva zkrácené týdenní odpočinky nejsou prokázané porušení', () => {
  const first = Date.parse('2026-03-30T00:00:00.000Z')
  const second = Date.parse('2026-04-06T00:00:00.000Z')
  const third = Date.parse('2026-04-13T00:00:00.000Z')
  const view = review([
    activity('regular', 'rest', first, first + 45 * HOUR),
    activity('gap1', 'work', first + 45 * HOUR, second),
    activity('reduced-a', 'rest', second, second + 24 * HOUR),
    activity('gap2', 'work', second + 24 * HOUR, third),
    activity('reduced-b', 'rest', third, third + 24 * HOUR),
    activity('tail', 'work', third + 24 * HOUR, NOW),
  ])
  const weekly = view.findings.find((finding) => finding.id.startsWith('weekly-rest:'))
  assert.equal(weekly?.severity, 'uncertain')
  assert.equal(view.findings.some((finding) => finding.severity === 'violation' && finding.id.startsWith('weekly-rest:')), false)
  assert.equal(weekly?.explanation.includes('nedělá prokázané porušení'), true)
  assert.notEqual(view.days.find((day) => day.dayStartUtc === second)?.severity, 'clear')
})

test('diagnostika obsahuje období a stavy a ne osobní údaje', () => {
  const payload = buildComplianceDiagnostic({
    activities: [activity('rest', 'rest', TODAY, NOW, { registration: 'SPZ12345' })],
    nowUtc: NOW,
    clockMode: 'utc',
  })
  const text = JSON.stringify(payload)
  assert.equal(payload.period.legalWeekClock, 'monday_00_00_utc')
  assert.equal(payload.period.clockMode, 'utc')
  assert.equal(payload.period.startUtc, PERIOD_START)
  assert.equal(Array.isArray(payload.evaluation.unevaluatedNotes), true)
  assert.equal(payload.diagnostic.consecutiveWeeks.clockBasis, 'monday_00_00_utc')
  assert.equal(text.includes('SPZ12345'), false)
  assert.equal(text.includes('bez přestupků'), false)
  assert.equal(payload.period.mode, 'recent')
  assert.equal(payload.period.mapMode, 'days')
})

test('výchozí období má 57 dnů a denní mapu', () => {
  const view = review(coveredDays())
  assert.equal(view.periodMode, 'recent')
  assert.equal(view.days.length, 57)
  assert.equal(view.mapMode, 'days')
  assert.equal(view.buckets.length, 0)
  assert.equal(view.periodText, '02.03.2026 – 27.04.2026')
})

test('vlastní období zahrnuje oba krajní dny a přelom roku', () => {
  const view = buildComplianceReview({
    activities: coveredDays(),
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'custom', fromUtc: Date.parse('2025-12-30T00:00:00.000Z'), toUtc: Date.parse('2026-01-02T12:00:00.000Z') },
  })
  assert.deepEqual(view.days.map((day) => day.label), ['30.12.2025', '31.12.2025', '01.01.2026', '02.01.2026'])
  assert.equal(view.days.every((day) => day.severity !== 'clear'), true)
  assert.equal(view.completenessText.includes('nepokrývá'), true)
})

test('celá historie začíná prvním záznamem a neobsahuje budoucí den', () => {
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  const view = buildComplianceReview({
    activities: [
      activity('rest', 'rest', start, start + 12 * HOUR),
      activity('tail', 'work', start + 12 * HOUR, NOW),
    ],
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  assert.equal(view.days[0]?.label, '01.01.2026')
  assert.equal(view.days[view.days.length - 1]?.dayStartUtc, TODAY)
  assert.equal(view.days.some((day) => day.dayStartUtc > TODAY), false)
  assert.equal(view.mapMode, 'weeks')
  const listed = view.buckets.flatMap((bucket) => bucket.dayStarts)
  assert.equal(listed.length, view.days.length)
  assert.equal(new Set(listed).size, view.days.length)
})

test('událost přes hranici období je jedno zjištění na jednom dni', () => {
  const start = TODAY - 2 * HOUR
  const activities = [
    activity('drive', 'driving', start, start + 5 * HOUR),
    activity('tail', 'rest', start + 5 * HOUR, NOW),
  ]
  const yesterday = buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'custom', fromUtc: TODAY - DAY, toUtc: TODAY - DAY },
  })
  const today = buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'custom', fromUtc: TODAY, toUtc: TODAY },
  })
  const both = review(activities)
  for (const view of [yesterday, today, both]) {
    assert.equal(view.findings.filter((finding) => finding.id.startsWith('break:')).length, 1)
  }
  assert.equal(yesterday.findings.find((finding) => finding.id.startsWith('break:'))?.mapDayUtc, TODAY - DAY)
  assert.equal(today.findings.find((finding) => finding.id.startsWith('break:'))?.mapDayUtc, TODAY)
  assert.equal(both.findings.filter((finding) => finding.id.startsWith('break:')).length, 1)
})

test('změna období na stejných datech nepřidá porušení ani zelený den mimo záznam', () => {
  const activities = coveredDays()
  const recent = review(activities)
  const slice = buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'custom', fromUtc: Date.parse('2026-04-01T00:00:00.000Z'), toUtc: Date.parse('2026-04-01T00:00:00.000Z') },
  })
  const outside = buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'custom', fromUtc: Date.parse('2026-01-01T00:00:00.000Z'), toUtc: Date.parse('2026-01-03T00:00:00.000Z') },
  })
  assert.equal(recent.violationCount, 0)
  assert.equal(slice.violationCount, 0)
  assert.equal(slice.days[0]?.severity, 'clear')
  assert.equal(outside.violationCount, 0)
  assert.equal(outside.days.every((day) => day.severity === 'incomplete'), true)
})

test('budoucí konec období se ořízne na dnešek a nevytvoří zelený den', () => {
  const view = buildComplianceReview({
    activities: coveredDays(),
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'custom', fromUtc: TODAY, toUtc: TODAY + 10 * DAY },
  })
  assert.equal(view.days.length, 1)
  assert.equal(view.days[0]?.dayStartUtc, TODAY)
  assert.equal(view.rangeNote?.includes('po dnešku'), true)
  assert.notEqual(view.days[0]?.severity, 'clear')
})

test('historie delší než rok se skládá po měsících', () => {
  const start = Date.parse('2024-06-01T00:00:00.000Z')
  const view = buildComplianceReview({
    activities: [activity('span', 'rest', start, NOW)],
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  assert.equal(view.mapMode, 'months')
  assert.equal(view.buckets.some((bucket) => bucket.label === '12.2025'), true)
  assert.equal(view.buckets.some((bucket) => bucket.label === '01.2026'), true)
  assert.equal(view.days.at(-1)?.dayStartUtc, TODAY)
})

const LONG_PERIOD = (iso: string) => Date.parse(iso)

function clockActivity(id: string, kind: ActivityKind, start: string, end: string, extra: Partial<Activity> = {}): Activity {
  const startUtc = LONG_PERIOD(start)
  const endUtc = LONG_PERIOD(end)
  return { id, kind, startUtc, endUtc, durationMinutes: Math.round((endUtc - startUtc) / 60_000), slot: 1, ...extra }
}

function period114Timeline(extra: Activity[] = []): Activity[] {
  return [
    clockActivity('opening-rest', 'rest', '2026-07-31T00:00:00Z', '2026-08-01T12:00:00Z'),
    clockActivity('early-d0', 'driving', '2026-08-01T12:00:00Z', '2026-08-01T13:00:00Z'),
    clockActivity('early-r3', 'rest', '2026-08-01T13:00:00Z', '2026-08-01T16:00:00Z'),
    clockActivity('early-d1', 'driving', '2026-08-01T16:00:00Z', '2026-08-02T08:00:00Z'),
    clockActivity('early-r9', 'rest', '2026-08-02T08:00:00Z', '2026-08-02T18:00:00Z'),
    clockActivity('early-d2', 'driving', '2026-08-02T18:00:00Z', '2026-08-13T00:00:00Z'),
    clockActivity('anchor-rest', 'rest', '2026-08-13T00:00:00Z', '2026-08-14T11:01:00Z'),
    clockActivity('shift-d1', 'driving', '2026-08-14T11:01:00Z', '2026-08-15T22:35:00Z'),
    clockActivity('short-rest', 'rest', '2026-08-15T22:35:00Z', '2026-08-16T05:48:00Z'),
    clockActivity('shift-d2', 'driving', '2026-08-16T05:48:00Z', '2026-08-16T13:02:00Z'),
    clockActivity('long-rest', 'rest', '2026-08-16T13:02:00Z', '2026-08-18T11:34:00Z'),
    clockActivity('after', 'driving', '2026-08-18T11:34:00Z', '2026-08-18T14:00:00Z'),
    ...extra,
  ]
}

test('50h období bez odpočinku 9 h má dvě prokázaná denní okna a zachová přestávku 4:30', () => {
  const activities = period114Timeline()
  const view = buildComplianceReview({
    activities,
    nowUtc: LONG_PERIOD('2026-08-20T12:00:00Z'),
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  const provenDaily = view.findings.filter((finding) => finding.id.startsWith('gn7-daily:') && finding.severity === 'violation')
  assert.deepEqual(provenDaily.map((finding) => finding.startUtc).sort((a, b) => a - b), [
    LONG_PERIOD('2026-08-14T11:01:00Z'),
    LONG_PERIOD('2026-08-15T11:01:00Z'),
  ])
  assert.equal(provenDaily.every((finding) => finding.reviewStatus === 'proven'), true)
  assert.equal(view.findings.some((finding) => finding.title === 'Přestávka v řízení' && finding.severity === 'violation'), true)
  const card = {
    cardNumber: '',
    firstName: '',
    surname: '',
    lastWithdrawalUtc: null,
    activities,
    locations: [],
    violations: [],
  } as DriverCardData
  const period = buildWorkPeriodOverview(card).periods.find((item) => item.startUtc === LONG_PERIOD('2026-08-14T11:01:00Z'))
  assert.equal(period?.endUtc, LONG_PERIOD('2026-08-16T13:02:00Z'))
  assert.equal(period?.durationMs, 50 * HOUR + 60_000)
})

test('neznámý úsek v 50h období nedělá z denního odpočinku prokázané porušení', () => {
  const view = buildComplianceReview({
    activities: period114Timeline([
      clockActivity('gap', 'unknown', '2026-08-14T12:00:00Z', '2026-08-14T13:00:00Z'),
    ]),
    nowUtc: LONG_PERIOD('2026-08-20T12:00:00Z'),
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  const provenInside = view.findings.filter((finding) =>
    finding.id.startsWith('gn7-daily:')
    && finding.severity === 'violation'
    && finding.startUtc >= LONG_PERIOD('2026-08-14T11:01:00Z')
    && finding.startUtc < LONG_PERIOD('2026-08-16T13:02:00Z'),
  )
  assert.equal(provenInside.length, 0)
})

test('72h bez kvalifikovaného odpočinku vytvoří tři denní nálezy', () => {
  const start = LONG_PERIOD('2026-05-01T00:00:00Z')
  const view = buildComplianceReview({
    activities: [
      clockActivity('before', 'rest', '2026-04-30T00:00:00Z', '2026-05-01T00:00:00Z'),
      clockActivity('drive', 'driving', '2026-05-01T00:00:00Z', '2026-05-04T00:00:00Z'),
      clockActivity('rest', 'rest', '2026-05-04T00:00:00Z', '2026-05-04T12:00:00Z'),
      clockActivity('tail', 'driving', '2026-05-04T12:00:00Z', '2026-05-04T16:00:00Z'),
    ],
    nowUtc: LONG_PERIOD('2026-05-06T00:00:00Z'),
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  const proven = view.findings
    .filter((finding) => finding.id.startsWith('gn7-daily:') && finding.severity === 'violation')
    .map((finding) => finding.startUtc - start)
    .sort((a, b) => a - b)
  assert.deepEqual(proven, [0, DAY, 2 * DAY])
  assert.equal(view.findings.some((finding) => finding.title === 'Přestávka v řízení' && finding.severity === 'violation'), true)
})

const MINUTE = 60 * 1000
const SHIFT = Date.parse('2026-04-10T07:00:00.000Z')
const SHIFT_END = SHIFT + 8 * HOUR

function place(id: string, recordType: LocationRecordType, entryType: number | undefined, at: number): Location {
  return {
    id,
    recordedAtUtc: at,
    label: 'CZ',
    recordType,
    countryCode: 'CZ',
    entryType,
    isManualEntry: entryType === 2 || entryType === 3,
  }
}

function closedShift(workStart = SHIFT): Activity[] {
  return [
    activity('open-rest', 'rest', SHIFT - 11 * HOUR, SHIFT),
    activity('drive', 'driving', workStart, workStart + 2 * HOUR),
    activity('work', 'work', workStart + 2 * HOUR, SHIFT_END),
    activity('close-rest', 'rest', SHIFT_END, SHIFT_END + 11 * HOUR),
  ]
}

function countryView(activities: Activity[], locations: Location[], edges: CardPresentEdge[] = []) {
  return buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    period: { mode: 'history' },
    locations,
    cardPresentEdges: edges,
  })
}

function countryFindings(activities: Activity[], locations: Location[], edges: CardPresentEdge[] = []) {
  return countryView(activities, locations, edges).findings.filter((finding) => finding.id.startsWith('country:'))
}

function findingSignature(findings: { id: string; severity: string; reviewStatus?: string }[]) {
  return findings.filter((finding) => !finding.id.startsWith('country:')).map((finding) => `${finding.id}|${finding.severity}|${finding.reviewStatus ?? ''}`)
}

test('START a END na hranici denní pracovní doby nevytvoří nález', () => {
  const activities = closedShift()
  const plain = buildComplianceReview({ activities, nowUtc: NOW, clockMode: 'utc', period: { mode: 'history' } })
  const marked = countryView(activities, [
    place('start', 'start_country', 0, SHIFT),
    place('end', 'end_country', 1, SHIFT_END),
  ])
  assert.deepEqual(countryFindings(activities, [
    place('start', 'start_country', 0, SHIFT),
    place('end', 'end_country', 1, SHIFT_END),
  ]), [])
  assert.deepEqual(findingSignature(marked.findings), findingSignature(plain.findings))
})

test('dvě značky CZ START v jedné směně a platný END nejsou přestupek', () => {
  const edges: CardPresentEdge[] = [
    { atUtc: SHIFT, present: true, slot: 1 },
    { atUtc: SHIFT + 2 * MINUTE, present: false, slot: 1 },
    { atUtc: SHIFT + 2 * MINUTE, present: true, slot: 1 },
    { atUtc: SHIFT_END, present: false, slot: 1 },
  ]
  const findings = countryFindings(closedShift(), [
    place('start-0700', 'start_country', 0, SHIFT),
    place('start-0702', 'start_country', 0, SHIFT + 2 * MINUTE),
    place('end', 'end_country', 1, SHIFT_END),
  ], edges)
  assert.deepEqual(findings, [])
})

test('START a START bez END je jeden prokázaný nález, jen když konec směny existuje', () => {
  const closed = countryFindings(closedShift(), [
    place('start-0700', 'start_country', 0, SHIFT),
    place('start-0702', 'start_country', 0, SHIFT + 2 * MINUTE),
  ])
  assert.deepEqual(closed.map((finding) => finding.id), [`country:missing_end_country:${SHIFT}`])
  assert.equal(closed[0]?.reviewStatus, 'proven')
  assert.equal(closed[0]?.severity, 'violation')

  const open = countryFindings([
    activity('open-rest', 'rest', SHIFT - 11 * HOUR, SHIFT),
    activity('drive', 'driving', SHIFT, SHIFT + 4 * HOUR),
  ], [
    place('start-0700', 'start_country', 0, SHIFT),
    place('start-0702', 'start_country', 0, SHIFT + 2 * MINUTE),
  ])
  assert.equal(open.some((finding) => finding.reviewStatus === 'proven'), false)
  assert.equal(open.some((finding) => finding.id.startsWith('country:uncertain_end_country:')), true)
})

test('chybějící START je prokázaný a chybějící END je prokázaný', () => {
  const missingStart = countryFindings(closedShift(), [place('end', 'end_country', 1, SHIFT_END)])
  assert.deepEqual(missingStart.map((finding) => [finding.id, finding.reviewStatus]), [
    [`country:missing_start_country:${SHIFT}`, 'proven'],
  ])
  const missingEnd = countryFindings(closedShift(), [place('start', 'start_country', 0, SHIFT)])
  assert.deepEqual(missingEnd.map((finding) => [finding.id, finding.reviewStatus]), [
    [`country:missing_end_country:${SHIFT}`, 'proven'],
  ])
})

test('automatický záznam typu 4 a 5 povinnost splní a GNSS ani hranice ji nenahradí', () => {
  assert.deepEqual(countryFindings(closedShift(), [
    place('auto-start', 'start_country', 4, SHIFT),
    place('auto-end', 'end_country', 5, SHIFT_END),
  ]), [])
  const replaced = countryFindings(closedShift(), [
    place('gps', 'gps', undefined, SHIFT),
    place('border', 'border_crossing', undefined, SHIFT),
    place('end', 'end_country', 1, SHIFT_END),
  ])
  assert.deepEqual(replaced.map((finding) => finding.id), [`country:missing_start_country:${SHIFT}`])
  assert.equal(replaced[0]?.reviewStatus, 'proven')
})

test('ruční zadání mimo hranici směny vyžaduje ověření', () => {
  const findings = countryFindings(closedShift(), [
    place('manual', 'start_country', 2, SHIFT + 4 * HOUR),
    place('end', 'end_country', 1, SHIFT_END),
  ])
  assert.deepEqual(findings.map((finding) => finding.id), [`country:start_country_timing_uncertain:${SHIFT}`])
  assert.equal(findings[0]?.reviewStatus, 'needs_verification')
  assert.equal(findings[0]?.severity, 'uncertain')
})

test('značka bez typu zadání není prokázané porušení', () => {
  const findings = countryFindings(closedShift(), [
    place('start', 'start_country', undefined, SHIFT),
    place('end', 'end_country', undefined, SHIFT_END),
  ])
  assert.equal(findings.some((finding) => finding.reviewStatus === 'proven'), false)
  assert.deepEqual(findings.map((finding) => finding.id), [
    `country:unknown_entry_type:start:${SHIFT}`,
    `country:unknown_entry_type:end:${SHIFT}`,
  ])
})

test('kontrola zemí nemění přestávku 4:30, denní řízení, GN7 ani týdenní odpočinek', () => {
  const activities = coveredDays()
  const plain = review(activities)
  const withPlaces = buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    locations: [],
  })
  assert.deepEqual(findingSignature(withPlaces.findings), findingSignature(plain.findings))
  const start = TODAY - 2 * HOUR
  const drive = [
    activity('drive', 'driving', start, start + 5 * HOUR),
    activity('tail', 'rest', start + 5 * HOUR, NOW),
  ]
  const breaks = (findings: { id: string; severity: string }[]) =>
    findings.filter((finding) => finding.id.startsWith('break:')).map((finding) => `${finding.id}|${finding.severity}`)
  assert.deepEqual(breaks(countryView(drive, [
    place('start', 'start_country', 0, start),
    place('end', 'end_country', 1, start + 5 * HOUR),
  ]).findings), breaks(review(drive).findings))
  assert.equal(breaks(review(drive).findings).length, 1)
})

test('plný soubor míst nedělá ze starší směny prokázané chybění', () => {
  const later = SHIFT_END + 24 * HOUR
  const archived = Array.from({ length: 112 }, (_, index) => ({
    ...place(`archived-${index}`, index % 2 === 0 ? 'start_country' : 'end_country', index % 2, later + index * MINUTE),
    placeFile: 'card_place_1' as const,
  }))
  const findings = countryFindings(closedShift(), archived)
  assert.equal(findings.some((finding) => finding.reviewStatus === 'proven'), false)
  assert.equal(findings.filter((finding) => finding.reviewStatus === 'needs_verification').length, 2)
  assert.equal(new Set(findings.map((finding) => finding.id)).size, findings.length)
})
