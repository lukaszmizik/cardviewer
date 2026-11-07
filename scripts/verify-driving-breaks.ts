import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessDrivingBreaks,
  BREAK_FULL_MS,
  DRIVING_LIMIT_MS,
  type BreakActivity,
} from '../src/analysis/drivingBreaks.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const START = Date.parse('2026-06-01T06:00:00.000Z')

function activity(id: string, kind: BreakActivity['kind'], startUtc: number, endUtc: number, isCrew = false): BreakActivity {
  return { id, kind, startUtc, endUtc, isCrew }
}

test('přesně 4 hodiny 30 minut je ještě v limitu', () => {
  const [period] = assessDrivingBreaks([
    activity('drive', 'driving', START, START + DRIVING_LIMIT_MS),
  ])
  assert.equal(period?.status, 'within_limit')
  assert.equal(period?.drivingMs, DRIVING_LIMIT_MS)
  assert.equal(period?.limitReachedUtc, null)
  assert.equal(period?.qualifyingBreak, null)
  assert.deepEqual(period?.drivingSourceActivityIds, ['drive'])
})

test('minuta přes limit je doložené překročení', () => {
  const [period] = assessDrivingBreaks([
    activity('drive', 'driving', START, START + DRIVING_LIMIT_MS + MINUTE),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.limitReachedUtc, START + DRIVING_LIMIT_MS)
  assert.equal(period?.drivingMs, DRIVING_LIMIT_MS + MINUTE)
  assert.equal(period?.qualifyingBreak, null)
  assert.equal(JSON.stringify(period).includes('přestupek'), false)
})

test('souvislých 45 minut odpočinku vynuluje součet', () => {
  const periods = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 4 * HOUR),
    activity('rest', 'rest', START + 4 * HOUR, START + 4 * HOUR + BREAK_FULL_MS),
    activity('drive-2', 'driving', START + 4 * HOUR + BREAK_FULL_MS, START + 8 * HOUR + BREAK_FULL_MS),
  ])
  assert.equal(periods.length, 2)
  assert.equal(periods[0]?.status, 'within_limit')
  assert.equal(periods[0]?.drivingMs, 4 * HOUR)
  assert.equal(periods[0]?.qualifyingBreak?.kind, 'continuous_45')
  assert.equal(periods[0]?.qualifyingBreak?.completedAtUtc, START + 4 * HOUR + BREAK_FULL_MS)
  assert.deepEqual(periods[0]?.qualifyingBreak?.sourceActivityIds, ['rest'])
  assert.equal(periods[1]?.status, 'within_limit')
  assert.equal(periods[1]?.drivingMs, 4 * HOUR)
  assert.deepEqual(periods[1]?.drivingSourceActivityIds, ['drive-2'])
})

test('po překročení další úsek začíná až za přestávkou', () => {
  const periods = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 5 * HOUR),
    activity('rest', 'rest', START + 5 * HOUR, START + 5 * HOUR + BREAK_FULL_MS),
    activity('drive-2', 'driving', START + 5 * HOUR + BREAK_FULL_MS, START + 6 * HOUR + BREAK_FULL_MS),
  ])
  assert.equal(periods[0]?.status, 'exceeded')
  assert.equal(periods[0]?.limitReachedUtc, START + DRIVING_LIMIT_MS)
  assert.equal(periods[0]?.qualifyingBreak?.kind, 'continuous_45')
  assert.equal(periods[1]?.status, 'within_limit')
  assert.equal(periods[1]?.drivingMs, HOUR)
})

test('15 minut a potom 30 minut vynuluje součet', () => {
  const second = START + 3 * HOUR
  const periods = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 2 * HOUR),
    activity('first', 'rest', START + 2 * HOUR, START + 2 * HOUR + 15 * MINUTE),
    activity('drive-2', 'driving', START + 2 * HOUR + 15 * MINUTE, second),
    activity('second', 'rest', second, second + 30 * MINUTE),
    activity('drive-3', 'driving', second + 30 * MINUTE, second + 30 * MINUTE + 2 * HOUR),
  ])
  assert.equal(periods[0]?.status, 'within_limit')
  assert.equal(periods[0]?.drivingMs, 2 * HOUR + 45 * MINUTE)
  assert.equal(periods[0]?.qualifyingBreak?.kind, 'split_15_30')
  assert.equal(periods[0]?.qualifyingBreak?.startUtc, START + 2 * HOUR)
  assert.equal(periods[0]?.qualifyingBreak?.completedAtUtc, second + 30 * MINUTE)
  assert.deepEqual(periods[0]?.qualifyingBreak?.sourceActivityIds, ['first', 'second'])
  assert.equal(periods[1]?.drivingMs, 2 * HOUR)
})

test('30 minut a teprve potom 15 minut součet nevynuluje', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 2 * HOUR),
    activity('longer', 'rest', START + 2 * HOUR, START + 2 * HOUR + 30 * MINUTE),
    activity('drive-2', 'driving', START + 2 * HOUR + 30 * MINUTE, START + 4 * HOUR + 30 * MINUTE),
    activity('shorter', 'rest', START + 4 * HOUR + 30 * MINUTE, START + 4 * HOUR + 45 * MINUTE),
    activity('drive-3', 'driving', START + 4 * HOUR + 45 * MINUTE, START + 6 * HOUR),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.qualifyingBreak, null)
  assert.ok((period?.drivingMs ?? 0) > DRIVING_LIMIT_MS)
})

test('dvakrát 15 minut dělenou přestávku nesloží', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 2 * HOUR),
    activity('a', 'rest', START + 2 * HOUR, START + 2 * HOUR + 15 * MINUTE),
    activity('drive-2', 'driving', START + 2 * HOUR + 15 * MINUTE, START + 4 * HOUR),
    activity('b', 'rest', START + 4 * HOUR, START + 4 * HOUR + 15 * MINUTE),
    activity('drive-3', 'driving', START + 4 * HOUR + 15 * MINUTE, START + 6 * HOUR),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.qualifyingBreak, null)
})

test('pohotovost ani jiná práce součet nepřeruší', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 3 * HOUR),
    activity('avail', 'availability', START + 3 * HOUR, START + 4 * HOUR),
    activity('work', 'work', START + 4 * HOUR, START + 5 * HOUR),
    activity('drive-2', 'driving', START + 5 * HOUR, START + 7 * HOUR),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.drivingMs, 5 * HOUR)
  assert.deepEqual(period?.drivingSourceActivityIds, ['drive-1', 'drive-2'])
  assert.equal(period?.qualifyingBreak, null)
})

test('práce mezi 15 a 30 minutami dělení neruší', () => {
  const second = START + 3 * HOUR
  const [period] = assessDrivingBreaks([
    activity('drive', 'driving', START, START + 2 * HOUR),
    activity('first', 'rest', START + 2 * HOUR, START + 2 * HOUR + 15 * MINUTE),
    activity('work', 'work', START + 2 * HOUR + 15 * MINUTE, second),
    activity('second', 'rest', second, second + 30 * MINUTE),
  ])
  assert.equal(period?.status, 'within_limit')
  assert.equal(period?.drivingMs, 2 * HOUR)
  assert.equal(period?.qualifyingBreak?.kind, 'split_15_30')
})

test('odpočinek kratší než 15 minut součet nevynuluje', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 3 * HOUR),
    activity('short', 'rest', START + 3 * HOUR, START + 3 * HOUR + 14 * MINUTE),
    activity('drive-2', 'driving', START + 3 * HOUR + 14 * MINUTE, START + 3 * HOUR + 14 * MINUTE + 2 * HOUR),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.qualifyingBreak, null)
})

test('navazující odpočinky se spojí na 45 minut a minuta práce mezi nimi ne', () => {
  const joined = assessDrivingBreaks([
    activity('drive', 'driving', START, START + 4 * HOUR),
    activity('a', 'rest', START + 4 * HOUR, START + 4 * HOUR + 20 * MINUTE),
    activity('b', 'rest', START + 4 * HOUR + 20 * MINUTE, START + 4 * HOUR + 45 * MINUTE),
  ])
  assert.equal(joined[0]?.qualifyingBreak?.kind, 'continuous_45')
  assert.deepEqual(joined[0]?.qualifyingBreak?.sourceActivityIds, ['a', 'b'])

  const splitByWork = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 2 * HOUR),
    activity('a', 'rest', START + 2 * HOUR, START + 2 * HOUR + 20 * MINUTE),
    activity('work', 'work', START + 2 * HOUR + 20 * MINUTE, START + 2 * HOUR + 21 * MINUTE),
    activity('b', 'rest', START + 2 * HOUR + 21 * MINUTE, START + 2 * HOUR + 46 * MINUTE),
    activity('drive-2', 'driving', START + 2 * HOUR + 46 * MINUTE, START + 6 * HOUR),
  ])
  assert.equal(splitByWork[0]?.status, 'exceeded')
  assert.equal(splitByWork[0]?.qualifyingBreak, null)
})

test('neznámý úsek před rozhodnutím není překročení', () => {
  const hidden = assessDrivingBreaks([
    activity('before', 'driving', START, START + 4 * HOUR),
    activity('gap', 'unknown', START + 4 * HOUR, START + 5 * HOUR),
    activity('after', 'driving', START + 5 * HOUR, START + 6 * HOUR),
  ])
  assert.equal(hidden[0]?.status, 'insufficient_data')
  assert.equal(hidden[0]?.limitReachedUtc, null)
  assert.notEqual(hidden[0]?.status, 'exceeded')

  const proven = assessDrivingBreaks([
    activity('drive', 'driving', START, START + 5 * HOUR),
    activity('gap', 'unknown', START + 5 * HOUR, START + 6 * HOUR),
  ])
  assert.equal(proven[0]?.status, 'exceeded')
  assert.equal(proven[0]?.limitReachedUtc, START + DRIVING_LIMIT_MS)
})

test('překryv řízení ve dvou slotech se nepočítá dvakrát', () => {
  const [period] = assessDrivingBreaks([
    activity('slot-1', 'driving', START, START + DRIVING_LIMIT_MS),
    activity('slot-2', 'driving', START, START + DRIVING_LIMIT_MS),
  ])
  assert.equal(period?.status, 'within_limit')
  assert.equal(period?.drivingMs, DRIVING_LIMIT_MS)
  assert.deepEqual(period?.drivingSourceActivityIds, ['slot-1', 'slot-2'])
})

test('pohotovost v osádce není prokázaná přestávka, ale změní výsledek na neuzavřený', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 4 * HOUR, true),
    activity('wait', 'availability', START + 4 * HOUR, START + 4 * HOUR + 45 * MINUTE, true),
    activity('drive-2', 'driving', START + 5 * HOUR, START + 6 * HOUR, true),
  ])
  assert.equal(period?.status, 'crew_break_unconfirmed')
  assert.equal(period?.qualifyingBreak, null)
  assert.equal(period?.limitReachedUtc, null)
  assert.equal(period?.drivingMs, 5 * HOUR)
  assert.notEqual(period?.status, 'within_limit')
  assert.notEqual(period?.status, 'exceeded')
})

test('15 a 30 minut pohotovosti v osádce cyklus prokazatelně neobnoví', () => {
  const periods = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + 2 * HOUR, true),
    activity('first', 'availability', START + 2 * HOUR, START + 2 * HOUR + 15 * MINUTE, true),
    activity('drive-2', 'driving', START + 3 * HOUR, START + 5 * HOUR, true),
    activity('second', 'availability', START + 5 * HOUR, START + 5 * HOUR + 30 * MINUTE, true),
    activity('drive-3', 'driving', START + 6 * HOUR, START + 7 * HOUR, true),
  ])
  assert.equal(periods.length, 1)
  assert.equal(periods[0]?.status, 'crew_break_unconfirmed')
  assert.equal(periods[0]?.qualifyingBreak, null)
  assert.equal(periods[0]?.drivingMs, 5 * HOUR)
})

test('pohotovost bez doložené osádky po 4 h 30 min přestávku nepotvrdí', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + DRIVING_LIMIT_MS),
    activity('wait', 'availability', START + DRIVING_LIMIT_MS, START + DRIVING_LIMIT_MS + 45 * MINUTE),
    activity('drive-2', 'driving', START + DRIVING_LIMIT_MS + 45 * MINUTE, START + DRIVING_LIMIT_MS + 75 * MINUTE),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.qualifyingBreak, null)
  assert.notEqual(period?.status, 'within_limit')
})

test('práce uprostřed pohotovosti v osádce nepřerušenou přestávku nesplní', () => {
  const [period] = assessDrivingBreaks([
    activity('drive-1', 'driving', START, START + DRIVING_LIMIT_MS, true),
    activity('wait-1', 'availability', START + DRIVING_LIMIT_MS, START + DRIVING_LIMIT_MS + 22 * MINUTE, true),
    activity('help', 'work', START + DRIVING_LIMIT_MS + 22 * MINUTE, START + DRIVING_LIMIT_MS + 28 * MINUTE, true),
    activity('wait-2', 'availability', START + DRIVING_LIMIT_MS + 28 * MINUTE, START + DRIVING_LIMIT_MS + 51 * MINUTE, true),
    activity('drive-2', 'driving', START + DRIVING_LIMIT_MS + HOUR, START + DRIVING_LIMIT_MS + 90 * MINUTE, true),
  ])
  assert.equal(period?.status, 'exceeded')
  assert.equal(period?.qualifyingBreak, null)
  assert.equal(period?.drivingSourceActivityIds.includes('help'), false)
})
