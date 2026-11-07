import assert from 'node:assert/strict'
import test from 'node:test'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'
import { assessWeeklyRestCompensation } from '../src/analysis/weeklyRestCompensation.ts'
import { classifyWeeklyRestCandidates } from '../src/analysis/weeklyRest.ts'

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR
const RECORD_END = Date.parse('2026-06-01T00:00:00.000Z')

function candidate(startUtc: number, endUtc: number, sourceActivityIds: string[], overrides: Partial<RestCandidate> = {}): RestCandidate {
  const durationMs = endUtc - startUtc
  return {
    startUtc,
    endUtc,
    durationMs,
    durationMinutes: Math.round(durationMs / 60_000),
    slot: 1,
    sourceActivityIds,
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    overlappingNonRestKinds: [],
    kinds: [],
    ...overrides,
  }
}

function assess(rests: RestCandidate[], recordEndUtc: number | null = RECORD_END, unknownIntervals: { startUtc: number; endUtc: number }[] = []) {
  return assessWeeklyRestCompensation({
    candidates: classifyWeeklyRestCandidates(rests),
    recordEndUtc,
    unknownIntervals,
  })
}

test('jeden rozhodný odpočinek 24 hodin má náhradu 21 hodin', () => {
  const start = Date.parse('2026-03-03T00:00:00.000Z')
  const report = assess([candidate(start, start + 24 * HOUR, ['h24'])])
  assert.equal(report.obligations.length, 1)
  const obligation = report.obligations[0]!
  assert.equal(obligation.restMs, 24 * HOUR)
  assert.equal(obligation.compensationMs, 21 * HOUR)
  assert.equal(obligation.certainty, 'determined')
  assert.equal(obligation.deadlineRegime, 'end_of_third_following_week')
  assert.equal(obligation.deadlineUtc, Date.parse('2026-03-30T00:00:00.000Z'))
  assert.equal(obligation.weekId?.startsWith('monday:'), true)
  assert.equal(obligation.taken.status, 'not_searched')
  assert.equal(obligation.taken.excludesHostRestAndWeeklyRest, true)
  assert.equal(report.internationalConsecutive.length, 0)
  assert.equal(report.compensationTaken, 'not_evaluated')
  assert.equal(JSON.stringify(report).includes('přestupek'), false)
})

test('běžný týdenní odpočinek 45 hodin náhradu nezakládá', () => {
  const start = Date.parse('2026-03-03T00:00:00.000Z')
  const report = assess([candidate(start, start + 45 * HOUR, ['h45'])])
  assert.deepEqual(report.obligations, [])
  assert.equal(report.notRequired[0]?.reason, 'regular_length')
  assert.equal(report.notRequired[0]?.sourceActivityIds[0], 'h45')
})

test('více zkrácených odpočinků v jednom týdnu nezaloží dluh za každý', () => {
  const regularStart = Date.parse('2026-03-02T00:00:00.000Z')
  const early = Date.parse('2026-03-04T06:00:00.000Z')
  const late = Date.parse('2026-03-07T18:00:00.000Z')
  const report = assess([
    candidate(regularStart, regularStart + 45 * HOUR, ['regular']),
    candidate(early, early + 24 * HOUR, ['early']),
    candidate(late, late + 24 * HOUR, ['late']),
  ])
  assert.equal(report.obligations.length, 1)
  assert.equal(report.obligations[0]?.sourceActivityIds[0], 'late')
  assert.equal(report.obligations[0]?.compensationMs, 21 * HOUR)
  assert.equal(report.obligations[0]?.certainty, 'determined')
  assert.equal(report.notRequired.some((item) => item.sourceActivityIds[0] === 'early' && item.reason === 'additional_reduced'), true)
  assert.equal(report.obligations.some((item) => item.sourceActivityIds[0] === 'early'), false)
})

test('odpočinek přes dva týdny se nepřiřadí k oběma zároveň', () => {
  const start = Date.parse('2026-03-08T18:00:00.000Z')
  const report = assess([candidate(start, start + 30 * HOUR, ['span'])])
  assert.equal(report.obligations.length, 1)
  const obligation = report.obligations[0]!
  assert.equal(obligation.compensationMs, 15 * HOUR)
  assert.equal(obligation.weekId, null)
  assert.equal(obligation.deadlineUtc, null)
  assert.equal(obligation.certainty, 'ambiguous')
  assert.equal(obligation.alternatives.length, 2)
  assert.equal(new Set(obligation.alternatives.map((item) => item.weekId)).size, 2)
  assert.equal(obligation.alternatives[1]!.deadlineUtc - obligation.alternatives[0]!.deadlineUtc, WEEK)
})

test('nejednoznačné přiřazení ponechá alternativy a jeden dluh nevytvoří', () => {
  const start = Date.parse('2026-03-08T18:00:00.000Z')
  const report = assess([candidate(start, start + 30 * HOUR, ['span'])])
  assert.equal(report.obligations[0]?.certainty, 'ambiguous')
  assert.equal(report.obligations.filter((item) => item.certainty === 'determined').length, 0)
  assert.deepEqual(
    report.obligations[0]?.alternatives.map((item) => item.deadlineRegime),
    ['end_of_third_following_week', 'end_of_third_following_week'],
  )
})

test('dva po sobě jdoucí zkrácené odpočinky nepoužijí mezinárodní výjimku', () => {
  const first = Date.parse('2026-03-03T00:00:00.000Z')
  const second = Date.parse('2026-03-10T00:00:00.000Z')
  const report = assess([
    candidate(first, first + 24 * HOUR, ['first']),
    candidate(second, second + 24 * HOUR, ['second']),
  ])
  assert.equal(report.obligations.length, 2)
  assert.deepEqual(
    report.obligations.map((item) => item.compensationMs),
    [21 * HOUR, 21 * HOUR],
  )
  assert.equal(report.obligations.every((item) => item.deadlineRegime === 'end_of_third_following_week'), true)
  assert.equal(report.obligations.every((item) => item.certainty === 'determined'), true)
  assert.equal(report.internationalConsecutive.length, 1)
  assert.equal(report.internationalConsecutive[0]?.status, 'not_proven')
  assert.equal(report.internationalConsecutive[0]?.entitlement, 'not_inferred')
  assert.equal(report.internationalConsecutive[0]?.deadlineEffect, 'none')
  assert.deepEqual(
    report.internationalConsecutive[0]?.sourceNodeIds,
    report.obligations.map((item) => item.sourceNodeId),
  )
})

test('neúplná data nevytvoří prokázanou náhradu ani porušení', () => {
  const start = Date.parse('2026-03-03T00:00:00.000Z')
  const end = start + 24 * HOUR
  const unknown = assess(
    [candidate(start, end, ['hidden'])],
    RECORD_END,
    [{ startUtc: start + HOUR, endUtc: start + 2 * HOUR }],
  )
  assert.deepEqual(unknown.obligations, [])
  assert.equal(unknown.unresolved[0]?.reason, 'unknown_excluded')
  assert.equal(unknown.compensationTaken, 'not_evaluated')

  const openEnded = assess([candidate(start, end, ['open'])], end)
  assert.deepEqual(openEnded.obligations, [])
  assert.equal(openEnded.unresolved[0]?.reason, 'end_not_documented')

  const unclear = assess([
    candidate(start, end, ['unclear'], { ambiguous: true, established: false, uncertainties: ['overlaps_non_rest'] }),
  ])
  assert.deepEqual(unclear.obligations, [])
  assert.equal(unclear.unresolved[0]?.reason, 'ambiguous_rest')
  assert.equal(JSON.stringify({ unknown, openEnded, unclear }).includes('přestupek'), false)
  assert.equal(JSON.stringify({ unknown, openEnded, unclear }).includes('missed'), false)
})
