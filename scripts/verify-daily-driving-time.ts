import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyRestChain } from '../src/analysis/dailyRestChain.ts'
import {
  assessDailyDrivingTime,
  WEEKLY_EXTENSION_CHECK_TEXT,
  type DailyDrivingPeriod,
} from '../src/analysis/dailyDrivingTime.ts'
import { classifyRestCandidates } from '../src/analysis/restCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import type { Activity, ActivityKind } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const START = Date.parse('2026-06-01T00:00:00.000Z')

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

function periodsOf(activities: Activity[]): DailyDrivingPeriod[] {
  const candidates = classifyRestCandidates(findRestIntervals(activities))
  const opening = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= 11 * HOUR)
    .sort((a, b) => a.endUtc - b.endUtc)[0]
  assert.ok(opening)
  const recordEndUtc = Math.max(...activities.map((item) => item.endUtc))
  const unknownIntervals = activities
    .filter((item) => item.kind === 'unknown')
    .map((item) => ({ startUtc: item.startUtc, endUtc: item.endUtc }))
  const chain = buildDailyRestChain(opening.endUtc, candidates, unknownIntervals, recordEndUtc)
  return assessDailyDrivingTime({ activities, candidates, chains: [chain] })
}

function betweenRests(driveMs: number, driveId = 'drive'): Activity[] {
  const restEnd = START + 11 * HOUR
  const driveEnd = restEnd + driveMs
  return [
    activity('open', 'rest', START, restEnd),
    activity(driveId, 'driving', restEnd, driveEnd),
    activity('close', 'rest', driveEnd, driveEnd + 11 * HOUR),
  ]
}

test('8 h 59 min řízení zůstane do 9 hodin', () => {
  const [period] = periodsOf(betweenRests(8 * HOUR + 59 * MINUTE))
  assert.equal(period?.drivingMs, 8 * HOUR + 59 * MINUTE)
  assert.equal(period?.result, 'up_to_9h')
  assert.equal(period?.extensionNote, null)
  assert.deepEqual(period?.drivingSourceActivityIds, ['drive'])
  assert.deepEqual(period?.openingRest?.sourceActivityIds, ['open'])
  assert.deepEqual(period?.closingRest?.sourceActivityIds, ['close'])
})

test('přesně 9 hodin je ještě do 9 hodin a další odpočinek začne nové období', () => {
  const restEnd = START + 11 * HOUR
  const firstEnd = restEnd + 9 * HOUR
  const secondOpen = firstEnd + 11 * HOUR
  const periods = periodsOf([
    activity('open', 'rest', START, restEnd),
    activity('drive-1', 'driving', restEnd, firstEnd),
    activity('middle', 'rest', firstEnd, secondOpen),
    activity('drive-2', 'driving', secondOpen, secondOpen + 2 * HOUR),
    activity('close', 'rest', secondOpen + 2 * HOUR, secondOpen + 13 * HOUR),
  ])
  assert.equal(periods.length, 2)
  assert.equal(periods[0]?.drivingMs, 9 * HOUR)
  assert.equal(periods[0]?.result, 'up_to_9h')
  assert.equal(periods[0]?.endUtc, firstEnd)
  assert.equal(periods[1]?.startUtc, secondOpen)
  assert.equal(periods[1]?.drivingMs, 2 * HOUR)
  assert.equal(periods[1]?.result, 'up_to_9h')
  assert.deepEqual(periods[1]?.openingRest?.sourceActivityIds, ['middle'])
})

test('9 h 30 min vyžaduje kontrolu týdenního počtu prodloužení', () => {
  const [period] = periodsOf(betweenRests(9 * HOUR + 30 * MINUTE))
  assert.equal(period?.drivingMs, 9 * HOUR + 30 * MINUTE)
  assert.equal(period?.result, 'over_9h_up_to_10h')
  assert.equal(period?.extensionNote, WEEKLY_EXTENSION_CHECK_TEXT)
  assert.equal(JSON.stringify(period).includes('přestupek'), false)
})

test('přesně 10 hodin zůstane v pásmu prodloužení', () => {
  const [period] = periodsOf(betweenRests(10 * HOUR))
  assert.equal(period?.drivingMs, 10 * HOUR)
  assert.equal(period?.result, 'over_9h_up_to_10h')
  assert.equal(period?.extensionNote, WEEKLY_EXTENSION_CHECK_TEXT)
})

test('10 h 01 min je nad 10 hodinami a není přestupek', () => {
  const [period] = periodsOf(betweenRests(10 * HOUR + MINUTE))
  assert.equal(period?.drivingMs, 10 * HOUR + MINUTE)
  assert.equal(period?.result, 'over_10h')
  assert.equal(period?.extensionNote, null)
  assert.equal(JSON.stringify(period).includes('přestupek'), false)
})

test('směna přes půlnoc zůstane jedno období', () => {
  const day = START
  const next = START + 24 * HOUR
  const periods = periodsOf([
    activity('open', 'rest', day + 7 * HOUR, day + 18 * HOUR),
    activity('drive', 'driving', day + 20 * HOUR, next + 5 * HOUR),
    activity('close', 'rest', next + 5 * HOUR, next + 16 * HOUR),
  ])
  assert.equal(periods.length, 1)
  assert.equal(periods[0]?.startUtc, day + 18 * HOUR)
  assert.equal(periods[0]?.endUtc, next + 5 * HOUR)
  assert.equal(periods[0]?.drivingMs, 9 * HOUR)
  assert.equal(periods[0]?.result, 'up_to_9h')
  assert.notEqual(periods[0]?.endUtc, next)
})

test('bezpečnostní přestávka denní dobu řízení neukončí', () => {
  const restEnd = START + 11 * HOUR
  const breakStart = restEnd + 4 * HOUR
  const breakEnd = breakStart + 45 * MINUTE
  const driveEnd = breakEnd + 5 * HOUR
  const [period] = periodsOf([
    activity('open', 'rest', START, restEnd),
    activity('drive-1', 'driving', restEnd, breakStart),
    activity('break', 'rest', breakStart, breakEnd),
    activity('drive-2', 'driving', breakEnd, driveEnd),
    activity('close', 'rest', driveEnd, driveEnd + 11 * HOUR),
  ])
  assert.equal(period?.drivingMs, 9 * HOUR)
  assert.equal(period?.result, 'up_to_9h')
  assert.equal(period?.startUtc, restEnd)
  assert.equal(period?.endUtc, driveEnd)
  assert.deepEqual(period?.drivingSourceActivityIds, ['drive-1', 'drive-2'])
  assert.deepEqual(period?.closingRest?.sourceActivityIds, ['close'])
})

test('neznámý úsek není doba bez řízení', () => {
  const restEnd = START + 11 * HOUR
  const unknownStart = restEnd + 4 * HOUR
  const driveEnd = unknownStart + 5 * HOUR
  const [period] = periodsOf([
    activity('open', 'rest', START, restEnd),
    activity('drive-1', 'driving', restEnd, unknownStart),
    activity('gap', 'unknown', unknownStart, unknownStart + HOUR),
    activity('drive-2', 'driving', unknownStart + HOUR, driveEnd),
    activity('close', 'rest', driveEnd, driveEnd + 11 * HOUR),
  ])
  assert.equal(period?.drivingMs, 8 * HOUR)
  assert.equal(period?.result, 'insufficient_data')
  assert.equal(period?.result === 'up_to_9h', false)
  assert.ok(period?.uncertainties.includes('unknown_interval'))
  assert.equal(period?.extensionNote, null)
})

test('nejednoznačné hranice odpočinků nemají jeden závěr', () => {
  const anchor = START + 11 * HOUR
  const firstRest = anchor + HOUR
  const secondDrive = firstRest + 9 * HOUR
  const secondRest = secondDrive + HOUR
  const periods = periodsOf([
    activity('open', 'rest', START, anchor),
    activity('drive-1', 'driving', anchor, firstRest),
    activity('short', 'rest', firstRest, firstRest + 9 * HOUR),
    activity('drive-2', 'driving', secondDrive, secondRest),
    activity('long', 'rest', secondRest, secondRest + 11 * HOUR),
  ])
  assert.equal(periods.length >= 1, true)
  const period = periods[0]
  assert.equal(period?.result, 'ambiguous_boundaries')
  assert.equal(period?.drivingMs, null)
  assert.equal(period?.closed, false)
  assert.equal(period?.closingRest, null)
  assert.equal(period?.extensionNote, null)
  assert.ok(period?.uncertainties.includes('multiple_rest_boundaries'))
  assert.deepEqual(
    period?.boundaryAlternatives.map((item) => item.drivingMs),
    [HOUR, 2 * HOUR],
  )
  assert.equal(JSON.stringify(period).includes('přestupek'), false)
})

test('dvě hranice se stejným řízením dají průběžný součet a dřívější nejednoznačnost ho nesmaže', () => {
  const earlyAnchor = Date.parse('2024-10-25T09:36:00.000Z')
  const forkRest = earlyAnchor + HOUR
  const secondDrive = forkRest + 9 * HOUR
  const secondRest = secondDrive + HOUR
  const laterAnchor = Date.parse('2025-09-26T09:14:00.000Z')
  const splitStart = laterAnchor + 101 * MINUTE
  const splitEnd = splitStart + 4 * HOUR
  const longStart = splitEnd + HOUR
  const periods = periodsOf([
    activity('early-open', 'rest', earlyAnchor - 12 * HOUR, earlyAnchor),
    activity('early-drive', 'driving', earlyAnchor, forkRest),
    activity('early-short', 'rest', forkRest, secondDrive),
    activity('early-drive-2', 'driving', secondDrive, secondRest),
    activity('bridge', 'rest', secondRest, laterAnchor),
    activity('later-drive', 'driving', laterAnchor, splitStart),
    activity('later-split', 'rest', splitStart, splitEnd),
    activity('later-gap', 'work', splitEnd, longStart),
    activity('later-long', 'rest', longStart, longStart + 20 * HOUR),
  ])
  const early = periods.find((item) => item.startUtc === earlyAnchor)
  assert.equal(early?.result, 'ambiguous_boundaries')
  assert.equal(early?.drivingMs, null)
  assert.equal(early?.endUtc != null && early.endUtc < laterAnchor, true)
  const later = periods.find((item) => item.startUtc === laterAnchor)
  assert.equal(later?.closed, false)
  assert.equal(later?.drivingMs, 101 * MINUTE)
  assert.equal(later?.result, 'up_to_9h')
  assert.equal(later?.closingRest, null)
})

test('uzavřený odpočinek ukončí období', () => {
  const anchor = START + 11 * HOUR
  const driveEnd = anchor + 8 * HOUR
  const [period] = periodsOf([
    activity('open', 'rest', START, anchor),
    activity('drive', 'driving', anchor, driveEnd),
    activity('close', 'rest', driveEnd, driveEnd + 11 * HOUR),
  ])
  assert.equal(period?.closed, true)
  assert.equal(period?.result, 'up_to_9h')
  assert.equal(period?.drivingMs, 8 * HOUR)
})

test('chybějící následující odpočinek ponechá dosud zaznamenané řízení', () => {
  const anchor = START + 11 * HOUR
  const [period] = periodsOf([
    activity('open', 'rest', START, anchor),
    activity('drive', 'driving', anchor, anchor + 2 * HOUR),
  ])
  assert.equal(period?.closed, false)
  assert.equal(period?.drivingMs, 2 * HOUR)
  assert.ok(period?.uncertainties.includes('closing_rest_missing'))
  assert.equal(period?.result, 'up_to_9h')
})
