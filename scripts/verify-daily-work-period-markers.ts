import assert from 'node:assert/strict'
import test from 'node:test'
import { assessDailyDrivingTime } from '../src/analysis/dailyDrivingTime.ts'
import { buildDailyRestChain } from '../src/analysis/dailyRestChain.ts'
import { assessDailyWorkPeriodMarkers } from '../src/analysis/dailyWorkPeriodMarkers.ts'
import { classifyRestCandidates } from '../src/analysis/restCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import type { DailyDrivingPeriod } from '../src/analysis/dailyDrivingTime.ts'
import type { Activity, ActivityKind, Location } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const START = Date.parse('2024-09-29T23:24:00.000Z')

function activity(id: string, kind: ActivityKind, startUtc: number, endUtc: number): Activity {
  return { id, kind, startUtc, endUtc, durationMinutes: Math.round((endUtc - startUtc) / MINUTE), slot: 1 }
}

function marker(id: string, recordType: Location['recordType'], recordedAtUtc: number): Location {
  return { id, recordedAtUtc, label: id, recordType }
}

function period(startUtc: number, endUtc: number | null, extra: Partial<DailyDrivingPeriod> = {}): DailyDrivingPeriod {
  return {
    startUtc,
    endUtc,
    drivingMs: 2 * HOUR,
    drivingSpanMs: null,
    openingRest: { startUtc: startUtc - 11 * HOUR, endUtc: startUtc, sourceActivityIds: ['open'] },
    closingRest: endUtc == null ? null : { startUtc: endUtc, endUtc: endUtc + 8 * HOUR, sourceActivityIds: ['close'] },
    result: 'up_to_9h',
    extensionNote: null,
    uncertainties: [],
    drivingSourceActivityIds: ['drive'],
    boundaryAlternatives: [],
    closed: endUtc != null,
    ...extra,
  }
}

function assess(input: {
  periods: DailyDrivingPeriod[]
  activities: Activity[]
  locations?: Location[]
  cardInsertions?: { fromUtc: number; toUtc: number }[]
  recordEndUtc?: number | null
}) {
  return assessDailyWorkPeriodMarkers({
    periods: input.periods,
    activities: input.activities,
    locations: input.locations ?? [],
    cardInsertions: input.cardInsertions,
    recordEndUtc: input.recordEndUtc,
  })
}

test('správný START a END nevytvoří nález', () => {
  const shiftStart = START
  const shiftEnd = START + 8 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('start', 'start_country', shiftStart),
      marker('end', 'end_country', shiftEnd),
    ],
  })
  assert.deepEqual(findings, [])
})

test('chybějící START', () => {
  const shiftStart = START
  const shiftEnd = START + 8 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [marker('end', 'end_country', shiftEnd)],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.issue, 'missing_start_country')
  assert.equal(findings[0]?.atUtc, shiftStart)
  assert.equal(findings[0]?.shiftStartUtc, shiftStart)
  assert.equal(findings[0]?.shiftEndUtc, shiftEnd)
  assert.deepEqual(findings[0]?.evidence.activityIds, ['drive'])
})

test('chybějící END', () => {
  const shiftStart = START
  const shiftEnd = START + 8 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [marker('start', 'start_country', shiftStart)],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.issue, 'missing_end_country')
  assert.equal(findings[0]?.atUtc, shiftEnd)
  assert.equal(findings[0]?.shiftEndUtc, shiftEnd)
})

test('více značek START v jedné směně nezaloží další směnu', () => {
  const shiftStart = START
  const shiftEnd = START + 8 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('start-1', 'start_country', shiftStart),
      marker('start-2', 'start_country', shiftStart + 2 * HOUR),
      marker('start-3', 'start_country', shiftStart + 4 * HOUR),
      marker('end', 'end_country', shiftEnd),
    ],
  })
  assert.deepEqual(findings, [])
})

test('opakované vložení karty během směny nezaloží další směnu', () => {
  const shiftStart = START
  const shiftEnd = START + 8 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart + HOUR, shiftEnd)],
    locations: [
      marker('start', 'start_country', shiftStart),
      marker('end', 'end_country', shiftEnd),
    ],
    cardInsertions: [
      { fromUtc: shiftStart, toUtc: shiftStart + 3 * HOUR },
      { fromUtc: shiftStart + 4 * HOUR, toUtc: shiftEnd },
    ],
  })
  assert.deepEqual(findings, [])
})

test('směna před kratším denním odpočinkem se stále kontroluje', () => {
  const shiftStart = START
  const shiftEnd = START + 6 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [],
  })
  assert.deepEqual(
    findings.map((item) => item.issue),
    ['missing_start_country', 'missing_end_country'],
  )
  assert.equal(findings[0]?.shiftEndUtc, shiftEnd)
  assert.equal(findings[1]?.atUtc, shiftEnd)
})

test('neúplná historie a otevřená směna vrací nejistotu', () => {
  const shiftStart = START
  const open = assess({
    periods: [
      period(shiftStart, null, {
        closed: false,
        endUtc: null,
        uncertainties: ['closing_rest_missing'],
        closingRest: null,
      }),
    ],
    activities: [activity('drive', 'driving', shiftStart, shiftStart + 2 * HOUR)],
    locations: [marker('start', 'start_country', shiftStart)],
    recordEndUtc: shiftStart + 2 * HOUR,
  })
  assert.deepEqual(open.map((item) => item.issue), ['uncertain_end_country'])
  assert.equal(open[0]?.shiftEndUtc, null)

  const incomplete = assess({
    periods: [
      period(shiftStart, shiftStart + 10 * HOUR, {
        closed: false,
        result: 'insufficient_data',
        uncertainties: ['unknown_interval'],
      }),
    ],
    activities: [
      activity('drive', 'driving', shiftStart, shiftStart + 2 * HOUR),
      activity('gap', 'unknown', shiftStart + 2 * HOUR, shiftStart + 4 * HOUR),
    ],
    locations: [marker('late', 'start_country', shiftStart + 4 * HOUR)],
    recordEndUtc: shiftStart + 4 * HOUR,
  })
  assert.deepEqual(incomplete.map((item) => item.issue), ['uncertain_start_country', 'uncertain_end_country'])
  assert.equal(incomplete.some((item) => item.issue.startsWith('missing_') || item.issue.endsWith('timing_uncertain')), false)
})

test('GNSS ani přechod hranice nenahradí START a END', () => {
  const shiftStart = START
  const shiftEnd = START + 8 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('gnss', 'gps', shiftStart),
      marker('border', 'border_crossing', shiftEnd),
    ],
  })
  assert.deepEqual(
    findings.map((item) => item.issue),
    ['missing_start_country', 'missing_end_country'],
  )
  assert.deepEqual(findings[0]?.evidence.disregardedLocationIds, ['gnss', 'border'])
  assert.deepEqual(findings[1]?.evidence.disregardedLocationIds, ['gnss', 'border'])
  assert.deepEqual(findings[0]?.evidence.locationIds, [])
})

test('časová razítka zůstávají v UTC', () => {
  const shiftStart = Date.parse('2024-09-29T23:24:00.000Z')
  const shiftEnd = Date.parse('2024-09-30T07:24:00.000Z')
  assert.equal(shiftStart, 1727652240000)
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [],
  })
  assert.equal(findings[0]?.atUtc, 1727652240000)
  assert.equal(findings[0]?.shiftStartUtc, 1727652240000)
  assert.equal(findings[1]?.atUtc, shiftEnd)
  assert.equal(new Date(findings[0]!.atUtc).toISOString(), '2024-09-29T23:24:00.000Z')
})

test('řetězec s zkráceným odpočinkem 9 h předá směnu ke kontrole značek', () => {
  const restEnd = START + 11 * HOUR
  const firstEnd = restEnd + 4 * HOUR
  const secondOpen = firstEnd + 9 * HOUR
  const secondDriveEnd = secondOpen + 4 * HOUR
  const secondRest = restEnd + 25 * HOUR
  const activities = [
    activity('open', 'rest', START, restEnd),
    activity('drive-1', 'driving', restEnd, firstEnd),
    activity('short', 'rest', firstEnd, secondOpen),
    activity('drive-2', 'driving', secondOpen, secondDriveEnd),
    activity('close', 'rest', secondRest, secondRest + 11 * HOUR),
  ]
  const candidates = classifyRestCandidates(findRestIntervals(activities))
  const recordEndUtc = secondRest + 11 * HOUR
  const chain = buildDailyRestChain(restEnd, candidates, [], recordEndUtc)
  const periods = assessDailyDrivingTime({ activities, candidates, chains: [chain] })
  const findings = assessDailyWorkPeriodMarkers({ periods, activities, locations: [], recordEndUtc })
  assert.equal(periods.length, 2)
  assert.equal(findings.filter((item) => item.shiftStartUtc === restEnd).length, 2)
  assert.equal(findings.filter((item) => item.shiftStartUtc === secondOpen).length, 2)
  assert.equal(findings.every((item) => item.issue === 'missing_start_country' || item.issue === 'missing_end_country'), true)
})

const DAY = Date.parse('2024-09-29T00:00:00.000Z')

test('START přesně na začátku práce a END přesně na konci práce', () => {
  const shiftStart = DAY + 6 * HOUR
  const shiftEnd = DAY + 18 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('start', 'start_country', shiftStart),
      marker('end', 'end_country', shiftEnd),
    ],
  })
  assert.deepEqual(findings, [])
})

test('START čtyři hodiny po začátku práce není prokázané porušení', () => {
  const shiftStart = DAY + 6 * HOUR
  const shiftEnd = DAY + 18 * HOUR
  const markedAt = DAY + 10 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('late-start', 'start_country', markedAt),
      marker('end', 'end_country', shiftEnd),
    ],
  })
  assert.deepEqual(findings.map((item) => item.issue), ['start_country_timing_uncertain'])
  assert.equal(findings[0]?.atUtc, markedAt)
  assert.equal(findings[0]?.shiftStartUtc, shiftStart)
  assert.equal(findings[0]?.shiftEndUtc, shiftEnd)
  assert.equal(findings[0]?.issue === 'missing_start_country', false)
})

test('END šest hodin před koncem práce není prokázané porušení', () => {
  const shiftStart = DAY + 6 * HOUR
  const shiftEnd = DAY + 18 * HOUR
  const markedAt = DAY + 12 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('start', 'start_country', shiftStart),
      marker('early-end', 'end_country', markedAt),
    ],
  })
  assert.deepEqual(findings.map((item) => item.issue), ['end_country_timing_uncertain'])
  assert.equal(findings[0]?.atUtc, markedAt)
  assert.equal(findings[0]?.shiftEndUtc, shiftEnd)
  assert.equal(findings[0]?.issue === 'missing_end_country', false)
})

test('správný START a další START během směny nevytvoří druhý nález', () => {
  const shiftStart = DAY + 6 * HOUR
  const shiftEnd = DAY + 18 * HOUR
  const findings = assess({
    periods: [period(shiftStart, shiftEnd)],
    activities: [activity('drive', 'driving', shiftStart, shiftEnd)],
    locations: [
      marker('start', 'start_country', shiftStart),
      marker('again', 'start_country', shiftStart + 4 * HOUR),
      marker('end', 'end_country', shiftEnd),
    ],
  })
  assert.deepEqual(findings, [])
})

test('8 h odpočinku uvnitř jednoho DailyDrivingPeriod směnu nerozdělí', () => {
  const firstStart = DAY + 6 * HOUR
  const firstEnd = DAY + 16 * HOUR
  const secondStart = firstEnd + 8 * HOUR
  const secondEnd = secondStart + 8 * HOUR
  const findings = assess({
    periods: [period(firstStart, secondEnd)],
    activities: [
      activity('drive-1', 'driving', firstStart, firstEnd),
      activity('short-rest', 'rest', firstEnd, secondStart),
      activity('drive-2', 'driving', secondStart, secondEnd),
    ],
    locations: [
      marker('start-1', 'start_country', firstStart),
      marker('start-2', 'start_country', secondStart),
      marker('end-2', 'end_country', secondEnd),
    ],
  })
  assert.equal(findings.length, 0)
})
