import assert from 'node:assert/strict'
import test from 'node:test'
import { findDailyRestOptions, type DailyRestOption } from '../src/analysis/dailyRestOptions.ts'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'

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

function kinds(options: DailyRestOption[]): string[] {
  return options.map((option) => option.kind)
}

test('11 hodin celé uvnitř okna je souvislá běžná varianta', () => {
  const options = findDailyRestOptions(
    [candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T19:00:00.000Z'))],
    WINDOW,
  )
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.parts[0]?.restMinutesInsideWindow, 11 * 60)
  assert.equal(options[0]?.parts[0]?.candidateMinutes, 11 * 60)
  assert.equal(options[0]?.established, true)
})

test('11 hodin celkem a jen 6 hodin v okně netvoří denní variantu', () => {
  const options = findDailyRestOptions(
    [candidate(Date.parse('2026-03-03T00:00:00.000Z'), Date.parse('2026-03-03T11:00:00.000Z'))],
    WINDOW,
  )
  assert.deepEqual(options, [])
})

test('přesně 9 hodin v okně je jen souvislá zkrácená varianta', () => {
  const options = findDailyRestOptions(
    [candidate(Date.parse('2026-03-02T06:00:00.000Z'), Date.parse('2026-03-02T15:00:00.000Z'))],
    WINDOW,
  )
  assert.deepEqual(kinds(options), ['continuous_reduced'])
  assert.equal(options[0]?.parts[0]?.restMinutesInsideWindow, 9 * 60)
  assert.equal(options[0]?.parts[0]?.candidateMinutes, 9 * 60)
})

test('přesně 11 hodin v okně je jen souvislá běžná varianta', () => {
  const options = findDailyRestOptions([candidate(WINDOW, WINDOW + 11 * HOUR)], WINDOW)
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.parts[0]?.restMinutesInsideWindow, 11 * 60)
})

test('3 + 9 hodin dává zkrácenou souvislou variantu a dělenou variantu', () => {
  const first = candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T11:00:00.000Z'), {
    sourceActivityIds: ['part-3'],
  })
  const second = candidate(Date.parse('2026-03-02T14:00:00.000Z'), Date.parse('2026-03-02T23:00:00.000Z'), {
    sourceActivityIds: ['part-9'],
  })
  const options = findDailyRestOptions([first, second], WINDOW)
  assert.deepEqual(kinds(options), ['continuous_reduced', 'split_regular'])
  const split = options[1]!
  assert.equal(split.established, true)
  assert.deepEqual(split.parts[0]?.sourceActivityIds, ['part-3'])
  assert.deepEqual(split.parts[1]?.sourceActivityIds, ['part-9'])
  assert.equal(split.parts[0]?.restMinutesInsideWindow, 3 * 60)
  assert.equal(split.parts[1]?.restMinutesInsideWindow, 9 * 60)
  assert.equal(split.parts[0]?.startUtc, first.startUtc)
  assert.equal(split.parts[1]?.endUtc, second.endUtc)
})

test('9 + 3 hodin netvoří dělenou variantu', () => {
  const options = findDailyRestOptions(
    [
      candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T17:00:00.000Z'), {
        sourceActivityIds: ['part-9'],
      }),
      candidate(Date.parse('2026-03-02T20:00:00.000Z'), Date.parse('2026-03-02T23:00:00.000Z'), {
        sourceActivityIds: ['part-3'],
      }),
    ],
    WINDOW,
  )
  assert.deepEqual(kinds(options), ['continuous_reduced'])
  assert.deepEqual(options[0]?.parts[0]?.sourceActivityIds, ['part-9'])
  assert.equal(options[0]?.parts[0]?.restMinutesInsideWindow, 9 * 60)
})

test('jeden 12hodinový odpočinek není dvě samostatné části', () => {
  const options = findDailyRestOptions(
    [candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T20:00:00.000Z'), { sourceActivityIds: ['whole'] })],
    WINDOW,
  )
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.parts.length, 1)
  assert.deepEqual(options[0]?.parts[0]?.sourceActivityIds, ['whole'])
})

test('45 hodin zůstává jeden souvislý interval přesahující okno', () => {
  const startUtc = WINDOW
  const endUtc = WINDOW + 45 * HOUR
  const options = findDailyRestOptions([candidate(startUtc, endUtc, { sourceActivityIds: ['long-45'] })], WINDOW)
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.parts.length, 1)
  assert.equal(options[0]?.parts[0]?.startUtc, startUtc)
  assert.equal(options[0]?.parts[0]?.endUtc, endUtc)
  assert.equal(options[0]?.parts[0]?.candidateMinutes, 45 * 60)
  assert.equal(options[0]?.parts[0]?.restMinutesInsideWindow, 24 * 60)
})

test('dlouhý ruční odpočinek se nezkracuje a nevyřazuje', () => {
  const startUtc = Date.parse('2024-10-28T16:47:00.000Z')
  const endUtc = Date.parse('2025-02-16T12:32:00.000Z')
  const windowStartUtc = Date.parse('2024-11-01T00:00:00.000Z')
  const options = findDailyRestOptions(
    [candidate(startUtc, endUtc, { manualEntry: true, sourceActivityIds: ['manual-long'] })],
    windowStartUtc,
  )
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.parts[0]?.manualEntry, true)
  assert.equal(options[0]?.parts[0]?.startUtc, startUtc)
  assert.equal(options[0]?.parts[0]?.endUtc, endUtc)
  assert.equal(options[0]?.parts[0]?.restMinutesInsideWindow, 24 * 60)
  assert.ok((options[0]?.parts[0]?.candidateMinutes ?? 0) > 60 * 24 * 60)
})

test('nejednoznačný interval není prokázaná varianta', () => {
  const options = findDailyRestOptions(
    [
      candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T19:00:00.000Z'), {
        ambiguous: true,
        established: false,
        sourceActivityIds: ['unclear'],
      }),
    ],
    WINDOW,
  )
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.established, false)
  assert.equal(options[0]?.parts[0]?.ambiguous, true)
  assert.deepEqual(options[0]?.parts[0]?.sourceActivityIds, ['unclear'])
})

test('unknown mezi odpočinky je nespojuje', () => {
  const windowStartUtc = Date.parse('2026-03-01T06:00:00.000Z')
  const early = candidate(windowStartUtc, windowStartUtc + 12 * HOUR, { sourceActivityIds: ['before-gap'] })
  const later = candidate(Date.parse('2026-03-04T18:00:00.000Z'), Date.parse('2026-03-05T06:00:00.000Z'), {
    sourceActivityIds: ['after-gap'],
  })
  const snapshot = structuredClone([early, later])
  const options = findDailyRestOptions([early, later], windowStartUtc)
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.deepEqual(options[0]?.parts[0]?.sourceActivityIds, ['before-gap'])
  assert.equal(options[0]?.parts[0]?.endUtc, early.endUtc)
  assert.equal(options.some((option) => option.parts.some((part) => part.sourceActivityIds.includes('after-gap'))), false)
  assert.deepEqual([early, later], snapshot)
})

test('13 hodin s průnikem 10 hodin je zkrácená délková varianta, ne právní nález', () => {
  const startUtc = Date.parse('2026-03-02T20:00:00.000Z')
  const endUtc = Date.parse('2026-03-03T09:00:00.000Z')
  const options = findDailyRestOptions([candidate(startUtc, endUtc, { sourceActivityIds: ['rest-13'] })], WINDOW)
  assert.deepEqual(kinds(options), ['continuous_reduced'])
  const option = options[0]!
  const part = option.parts[0]!
  assert.equal(part.candidateMinutes, 13 * 60)
  assert.equal(part.restMinutesInsideWindow, 10 * 60)
  assert.equal(part.startUtc, startUtc)
  assert.equal(part.endUtc, endUtc)
  assert.equal(part.intersectionStartUtc, startUtc)
  assert.equal(part.intersectionEndUtc, WINDOW + 24 * HOUR)
  assert.equal(part.ambiguous, false)
  assert.equal(option.established, true)
  assert.equal(Object.hasOwn(option, 'legalValidity'), false)
  assert.equal(Object.hasOwn(part, 'legalValidity'), false)
})

test('11 hodin přesně na konci okna nemá minutovou odchylku', () => {
  const windowEnd = WINDOW + 24 * HOUR
  const exact = findDailyRestOptions([candidate(windowEnd - 11 * HOUR, windowEnd)], WINDOW)
  assert.deepEqual(kinds(exact), ['continuous_regular'])
  assert.equal(exact[0]?.parts[0]?.restMinutesInsideWindow, 11 * 60)
  assert.equal(exact[0]?.parts[0]?.candidateMinutes, 11 * 60)
  assert.equal(exact[0]?.parts[0]?.intersectionEndUtc, windowEnd)

  const oneMinuteShort = findDailyRestOptions(
    [candidate(windowEnd - 11 * HOUR + 60_000, windowEnd)],
    WINDOW,
  )
  assert.deepEqual(kinds(oneMinuteShort), ['continuous_reduced'])
  assert.equal(oneMinuteShort[0]?.parts[0]?.restMinutesInsideWindow, 11 * 60 - 1)

  const startsAtWindowEnd = findDailyRestOptions([candidate(windowEnd, windowEnd + 11 * HOUR)], WINDOW)
  assert.deepEqual(startsAtWindowEnd, [])
})

test('dělená varianta vyžaduje 9 hodin druhé části uvnitř okna', () => {
  const first = candidate(Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T11:00:00.000Z'), {
    sourceActivityIds: ['part-3'],
  })
  const secondShortInside = candidate(
    Date.parse('2026-03-02T22:00:00.000Z'),
    Date.parse('2026-03-03T07:00:00.000Z'),
    { sourceActivityIds: ['part-9-outside'] },
  )
  const missing = findDailyRestOptions([first, secondShortInside], WINDOW)
  assert.deepEqual(kinds(missing), [])

  const secondEnoughInside = candidate(
    Date.parse('2026-03-02T21:00:00.000Z'),
    Date.parse('2026-03-03T07:00:00.000Z'),
    { sourceActivityIds: ['part-9-inside'] },
  )
  const present = findDailyRestOptions([first, secondEnoughInside], WINDOW)
  assert.deepEqual(kinds(present), ['continuous_reduced', 'split_regular'])
  const split = present[1]!
  assert.equal(split.parts[1]?.candidateMinutes, 10 * 60)
  assert.equal(split.parts[1]?.restMinutesInsideWindow, 9 * 60)
  assert.equal(split.parts[1]?.endUtc, secondEnoughInside.endUtc)
  assert.equal(split.parts[1]?.intersectionEndUtc, WINDOW + 24 * HOUR)
})

test('45 hodin se nikdy nerozdělí na dvě části', () => {
  const startUtc = Date.parse('2026-03-02T00:00:00.000Z')
  const endUtc = startUtc + 45 * HOUR
  const options = findDailyRestOptions([candidate(startUtc, endUtc, { sourceActivityIds: ['block-45'] })], WINDOW)
  assert.equal(options.some((option) => option.kind === 'split_regular'), false)
  assert.deepEqual(kinds(options), ['continuous_regular'])
  assert.equal(options[0]?.parts.length, 1)
  assert.equal(options[0]?.parts[0]?.candidateMinutes, 45 * 60)
})

test('established sleduje jen konflikt časové osy', () => {
  const startUtc = Date.parse('2026-03-02T08:00:00.000Z')
  const endUtc = Date.parse('2026-03-02T19:00:00.000Z')
  const clear = findDailyRestOptions(
    [candidate(startUtc, endUtc, { ambiguous: false, established: true, sourceActivityIds: ['clear'] })],
    WINDOW,
  )[0]!
  const conflict = findDailyRestOptions(
    [candidate(startUtc, endUtc, { ambiguous: true, established: false, sourceActivityIds: ['conflict'] })],
    WINDOW,
  )[0]!
  assert.equal(clear.kind, conflict.kind)
  assert.equal(clear.parts[0]?.restMinutesInsideWindow, conflict.parts[0]?.restMinutesInsideWindow)
  assert.equal(clear.established, true)
  assert.equal(clear.parts[0]?.ambiguous, false)
  assert.equal(conflict.established, false)
  assert.equal(conflict.parts[0]?.ambiguous, true)
  assert.equal(Object.hasOwn(clear, 'legalValidity'), false)
  assert.equal(Object.hasOwn(conflict, 'legalValidity'), false)
})
