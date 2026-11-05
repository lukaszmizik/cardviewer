import assert from 'node:assert/strict'
import test from 'node:test'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'
import { intersectRestWithDailyWindow } from '../src/analysis/restWindowIntersection.ts'

const HOUR = 60 * 60 * 1000
const WINDOW = Date.parse('2026-03-02T06:00:00.000Z')

function candidate(startUtc: number, endUtc: number, overrides: Partial<RestCandidate> = {}): RestCandidate {
  const durationMs = endUtc - startUtc
  return {
    startUtc,
    endUtc,
    durationMs,
    durationMinutes: Math.round(durationMs / 60_000),
    slot: 1,
    sourceActivityIds: ['r'],
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    overlappingNonRestKinds: [],
    kinds: [],
    ...overrides,
  }
}

test('11 hodin celé uvnitř okna', () => {
  const result = intersectRestWithDailyWindow(
    candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T19:00:00.000Z')),
    WINDOW,
  )
  assert.equal(result.windowEndUtc, WINDOW + 24 * HOUR)
  assert.equal(result.intersectionStartUtc, Date.parse('2026-03-02T08:00:00.000Z'))
  assert.equal(result.intersectionEndUtc, Date.parse('2026-03-02T19:00:00.000Z'))
  assert.equal(result.restMinutesInsideWindow, 11 * 60)
  assert.equal(result.candidateMinutes, 11 * 60)
  assert.equal(result.reaches9h, true)
  assert.equal(result.reaches11h, true)
  assert.equal(result.ambiguous, false)
})

test('z 11 hodin je v okně jen 6 hodin', () => {
  const result = intersectRestWithDailyWindow(
    candidate(Date.parse('2026-03-03T00:00:00.000Z'), Date.parse('2026-03-03T11:00:00.000Z')),
    WINDOW,
  )
  assert.equal(result.intersectionStartUtc, Date.parse('2026-03-03T00:00:00.000Z'))
  assert.equal(result.intersectionEndUtc, Date.parse('2026-03-03T06:00:00.000Z'))
  assert.equal(result.restMinutesInsideWindow, 6 * 60)
  assert.equal(result.candidateMinutes, 11 * 60)
  assert.equal(result.reaches9h, false)
  assert.equal(result.reaches11h, false)
})

test('přesně 9 hodin uvnitř okna', () => {
  const result = intersectRestWithDailyWindow(
    candidate(Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-02T15:00:00.000Z')),
    WINDOW,
  )
  assert.equal(result.restMinutesInsideWindow, 9 * 60)
  assert.equal(result.reaches9h, true)
  assert.equal(result.reaches11h, false)
})

test('přesně 11 hodin uvnitř okna', () => {
  const result = intersectRestWithDailyWindow(
    candidate(WINDOW, WINDOW + 11 * HOUR),
    WINDOW,
  )
  assert.equal(result.restMinutesInsideWindow, 11 * 60)
  assert.equal(result.reaches9h, true)
  assert.equal(result.reaches11h, true)
})

test('odpočinek celý mimo okno', () => {
  const result = intersectRestWithDailyWindow(
    candidate(Date.parse('2026-03-01T00:00:00.000Z'), Date.parse('2026-03-01T12:00:00.000Z')),
    WINDOW,
  )
  assert.equal(result.intersectionStartUtc, null)
  assert.equal(result.intersectionEndUtc, null)
  assert.equal(result.restMinutesInsideWindow, 0)
  assert.equal(result.reaches9h, false)
  assert.equal(result.reaches11h, false)
})

test('odpočinek přesahuje obě hranice okna', () => {
  const result = intersectRestWithDailyWindow(
    candidate(Date.parse('2026-03-01T00:00:00.000Z'), Date.parse('2026-03-04T00:00:00.000Z')),
    WINDOW,
  )
  assert.equal(result.intersectionStartUtc, WINDOW)
  assert.equal(result.intersectionEndUtc, WINDOW + 24 * HOUR)
  assert.equal(result.restMinutesInsideWindow, 24 * 60)
  assert.equal(result.candidateMinutes, 3 * 24 * 60)
  assert.equal(result.reaches9h, true)
  assert.equal(result.reaches11h, true)
})

test('dlouhý ruční odpočinek přes několik měsíců', () => {
  const startUtc = Date.parse('2024-10-28T16:47:00.000Z')
  const endUtc = Date.parse('2025-02-16T12:32:00.000Z')
  const windowStartUtc = Date.parse('2024-11-01T00:00:00.000Z')
  const result = intersectRestWithDailyWindow(
    candidate(startUtc, endUtc, { manualEntry: true, sourceActivityIds: ['manual-long'] }),
    windowStartUtc,
  )
  assert.equal(result.intersectionStartUtc, windowStartUtc)
  assert.equal(result.intersectionEndUtc, windowStartUtc + 24 * HOUR)
  assert.equal(result.restMinutesInsideWindow, 24 * 60)
  assert.ok(result.candidateMinutes > 60 * 24 * 60)
  assert.equal(result.reaches9h, true)
  assert.equal(result.reaches11h, true)
  assert.equal(result.ambiguous, false)
})

test('nejednoznačný kandidát zůstane nejednoznačný', () => {
  const result = intersectRestWithDailyWindow(
    candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T19:00:00.000Z'), {
      ambiguous: true,
      established: false,
    }),
    WINDOW,
  )
  assert.equal(result.restMinutesInsideWindow, 11 * 60)
  assert.equal(result.reaches11h, true)
  assert.equal(result.ambiguous, true)
})

test('odpočinek začínající přesně na konci okna do něj nepatří', () => {
  const windowEnd = WINDOW + 24 * HOUR
  const source = candidate(windowEnd, windowEnd + 11 * HOUR)
  const snapshot = structuredClone(source)
  const result = intersectRestWithDailyWindow(source, WINDOW)
  assert.equal(result.intersectionStartUtc, null)
  assert.equal(result.restMinutesInsideWindow, 0)
  assert.equal(result.reaches9h, false)
  assert.equal(result.reaches11h, false)
  assert.deepEqual(source, snapshot)
})
