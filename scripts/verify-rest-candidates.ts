import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyRestCandidates, type RestCandidateKind } from '../src/analysis/restCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import type { Activity, ActivityKind } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

function activity(input: {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
  slot?: 1 | 2
  isManualEntry?: boolean
}): Activity {
  return {
    id: input.id,
    kind: input.kind,
    startUtc: input.startUtc,
    endUtc: input.endUtc,
    durationMinutes: Math.round((input.endUtc - input.startUtc) / MINUTE),
    slot: input.slot ?? 1,
    isManualEntry: input.isManualEntry,
  }
}

function kindsOf(durationMs: number, manual = false): RestCandidateKind[] {
  const intervals = findRestIntervals([
    activity({
      id: 'r',
      kind: 'rest',
      startUtc: 0,
      endUtc: durationMs,
      isManualEntry: manual,
    }),
  ])
  const candidates = classifyRestCandidates(intervals)
  assert.equal(candidates.length, 1)
  return candidates[0]!.kinds
}

test('8:59 je jen možná první část děleného odpočinku', () => {
  assert.deepEqual(kindsOf(8 * HOUR + 59 * MINUTE), ['daily_split_first'])
})

test('9:00 splňuje zkrácený denní odpočinek a obě délky dělené části', () => {
  assert.deepEqual(kindsOf(9 * HOUR), ['daily_reduced', 'daily_split_first', 'daily_split_second'])
})

test('10:59 ještě není běžný denní odpočinek', () => {
  assert.deepEqual(kindsOf(10 * HOUR + 59 * MINUTE), ['daily_reduced', 'daily_split_first', 'daily_split_second'])
})

test('11:00 splňuje běžný i zkrácený denní odpočinek', () => {
  assert.deepEqual(kindsOf(11 * HOUR), [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
  ])
})

test('23:59 ještě není týdenní odpočinek', () => {
  assert.deepEqual(kindsOf(23 * HOUR + 59 * MINUTE), [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
  ])
})

test('24:00 přidává zkrácený týdenní odpočinek', () => {
  assert.deepEqual(kindsOf(24 * HOUR), [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
    'weekly_reduced',
  ])
})

test('29:00 se nedělí na kompenzaci a denní odpočinek', () => {
  const intervals = findRestIntervals([
    activity({ id: 'long', kind: 'rest', startUtc: 0, endUtc: 29 * HOUR }),
  ])
  const candidates = classifyRestCandidates(intervals)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.durationMs, 29 * HOUR)
  assert.deepEqual(candidates[0]?.kinds, [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
    'weekly_reduced',
  ])
  assert.equal(candidates[0]?.kinds.includes('weekly_regular'), false)
  assert.equal(candidates[0]?.established, true)
  assert.equal('parts' in (candidates[0] ?? {}), false)
})

test('44:59 ještě není běžný týdenní odpočinek', () => {
  assert.deepEqual(kindsOf(44 * HOUR + 59 * MINUTE), [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
    'weekly_reduced',
  ])
})

test('45:00 splňuje i běžný týdenní odpočinek', () => {
  assert.deepEqual(kindsOf(45 * HOUR), [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
    'weekly_reduced',
    'weekly_regular',
  ])
})

test('60 dní ručního odpočinku je jeden kandidát', () => {
  const candidates = classifyRestCandidates(
    findRestIntervals([
      activity({
        id: 'manual-long',
        kind: 'rest',
        startUtc: 0,
        endUtc: 60 * 24 * HOUR,
        isManualEntry: true,
      }),
    ]),
  )
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.manualEntry, true)
  assert.equal(candidates[0]?.established, true)
  assert.equal(candidates[0]?.ambiguous, false)
  assert.deepEqual(candidates[0]?.sourceActivityIds, ['manual-long'])
  assert.deepEqual(candidates[0]?.kinds, [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
    'weekly_reduced',
    'weekly_regular',
  ])
})

test('nejednoznačný interval není prokázaný odpočinek', () => {
  const intervals = findRestIntervals([
    activity({ id: 'r', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR }),
    activity({ id: 'd', kind: 'driving', startUtc: HOUR, endUtc: 2 * HOUR }),
  ])
  const candidates = classifyRestCandidates(intervals)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.ambiguous, true)
  assert.equal(candidates[0]?.established, false)
  assert.deepEqual(candidates[0]?.uncertainties.includes('overlaps_non_rest'), true)
  assert.deepEqual(candidates[0]?.kinds, [
    'daily_reduced',
    'daily_regular',
    'daily_split_first',
    'daily_split_second',
  ])
})

test('vstupní intervaly se nemění', () => {
  const intervals = findRestIntervals([
    activity({ id: 'a', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR }),
    activity({ id: 'b', kind: 'rest', startUtc: 11 * HOUR, endUtc: 20 * HOUR }),
  ])
  const snapshot = structuredClone(intervals)
  const first = intervals[0]
  classifyRestCandidates(intervals)
  assert.deepEqual(intervals, snapshot)
  assert.equal(intervals[0], first)
})
