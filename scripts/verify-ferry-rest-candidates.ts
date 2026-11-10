import assert from 'node:assert/strict'
import test from 'node:test'
import { findFerryRestCandidates } from '../src/analysis/ferryRestCandidates.ts'
import type { Activity, SpecificConditionEntry } from '../src/types/tacho.ts'

const MIN = 60_000
const H = 60 * MIN

function act(id: string, kind: Activity['kind'], startMin: number, endMin: number): Activity {
  return {
    id,
    kind,
    startUtc: startMin * MIN,
    endUtc: endMin * MIN,
    durationMinutes: endMin - startMin,
    slot: 1,
  }
}

function ferry(startMin: number, endMin: number | null): SpecificConditionEntry[] {
  const entries: SpecificConditionEntry[] = [{ atUtc: startMin * MIN, kind: 'ferry' }]
  if (endMin != null) entries.push({ atUtc: endMin * MIN, kind: 'ferry_end' })
  return entries
}

test('11 h čistého REST s jedním přerušením, lůžko neověřené', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 300),
      act('w', 'work', 300, 330),
      act('r2', 'rest', 330, 690),
    ],
    specificConditions: ferry(300, 330),
  })
  assert.ok(candidate != null)
  assert.equal(candidate.netRestMs, 11 * H)
  assert.equal(candidate.spanMs, 11 * H + 30 * MIN)
  assert.equal(candidate.interruptionCount, 1)
  assert.equal(candidate.interruptionMinutes, 30)
  assert.equal(candidate.qualification, 'regular_daily')
  assert.equal(candidate.timeConditionsMet, true)
  assert.equal(candidate.legalApplicability, 'conditional')
  assert.notEqual(candidate.legalApplicability, 'confirmed')
  assert.match(candidate.reasons.join(' '), /lůžk/i)
})

test('dvě přerušení po 30 min splňují počet i součet', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 360),
      act('w1', 'work', 360, 390),
      act('r2', 'rest', 390, 750),
      act('d', 'driving', 750, 780),
      act('r3', 'rest', 780, 1140),
    ],
    specificConditions: ferry(360, 780),
  })
  assert.equal(candidate?.interruptionCount, 2)
  assert.equal(candidate?.interruptionMinutes, 60)
  assert.equal(candidate?.timeConditionsMet, true)
  assert.equal(candidate?.legalApplicability, 'conditional')
})

test('tři přerušení po 10 min překračují počet', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 240),
      act('w1', 'work', 240, 250),
      act('r2', 'rest', 250, 490),
      act('w2', 'availability', 490, 500),
      act('r3', 'rest', 500, 740),
      act('w3', 'driving', 740, 750),
      act('r4', 'rest', 750, 990),
    ],
    specificConditions: ferry(240, 750),
  })
  assert.equal(candidate?.interruptionCount, 3)
  assert.equal(candidate?.interruptionMinutes, 30)
  assert.equal(candidate?.timeConditionsMet, false)
  assert.equal(candidate?.legalApplicability, 'not_applicable')
})

test('dvě přerušení celkem 61 min překračují limit', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 360),
      act('w1', 'work', 360, 391),
      act('r2', 'rest', 391, 751),
      act('w2', 'work', 751, 781),
      act('r3', 'rest', 781, 1141),
    ],
    specificConditions: ferry(360, 781),
  })
  assert.equal(candidate?.interruptionCount, 2)
  assert.equal(candidate?.interruptionMinutes, 61)
  assert.equal(candidate?.timeConditionsMet, false)
  assert.equal(candidate?.legalApplicability, 'not_applicable')
})

test('čistý REST 10 h 59 min není běžný denní odpočinek', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 300),
      act('w', 'work', 300, 330),
      act('r2', 'rest', 330, 689),
    ],
    specificConditions: ferry(300, 330),
  })
  assert.equal(candidate?.netRestMs, 10 * H + 59 * MIN)
  assert.equal(candidate?.qualification, 'reduced_daily_not_covered')
  assert.equal(candidate?.timeConditionsMet, false)
  assert.equal(candidate?.legalApplicability, 'not_applicable')
})

test('přerušovaných 9 h není zkrácený denní odpočinek podle čl. 9', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 240),
      act('w', 'work', 240, 260),
      act('r2', 'rest', 260, 560),
    ],
    specificConditions: ferry(240, 260),
  })
  assert.equal(candidate?.netRestMs, 9 * H)
  assert.equal(candidate?.qualification, 'reduced_daily_not_covered')
  assert.equal(candidate?.legalApplicability, 'not_applicable')
})

test('chybějící ferry_end nedovolí potvrzenou výjimku', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 300),
      act('w', 'work', 300, 330),
      act('r2', 'rest', 330, 690),
    ],
    specificConditions: ferry(300, null),
  })
  assert.equal(candidate?.ferryLinks[0]?.pairing, 'open_ended')
  assert.equal(candidate?.legalApplicability, 'conditional')
  assert.notEqual(candidate?.legalApplicability, 'confirmed')
  assert.match(candidate?.reasons.join(' ') ?? '', /ferry_end|není uzavřené/)
})

test('OUT bez trajektu kandidáta nevytvoří', () => {
  const candidates = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 300),
      act('w', 'work', 300, 330),
      act('r2', 'rest', 330, 690),
    ],
    specificConditions: [
      { atUtc: 300 * MIN, kind: 'out' },
      { atUtc: 330 * MIN, kind: 'out_end' },
    ],
  })
  assert.equal(candidates.length, 0)
})

test('neznámý úsek uvnitř odpočinku zůstane nejistý', () => {
  const [candidate] = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 300),
      act('u', 'unknown', 300, 310),
      act('r2', 'rest', 310, 980),
    ],
    specificConditions: ferry(300, 310),
  })
  assert.ok(candidate != null)
  assert.equal(candidate.interruptionCount, 0)
  assert.equal(candidate.netRestMs, 5 * H + 670 * MIN)
  assert.equal(candidate.timeConditionsMet, false)
  assert.equal(candidate.legalApplicability, 'conditional')
  assert.match(candidate.reasons.join(' '), /neznám/)
})

test('týdenní délky se rozliší a vnější podmínky zůstanou neověřené', () => {
  const reduced = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 24 * 60),
      act('w', 'work', 24 * 60, 24 * 60 + 30),
      act('r2', 'rest', 24 * 60 + 30, 48 * 60 + 30),
    ],
    specificConditions: ferry(24 * 60, 24 * 60 + 30),
  })[0]
  assert.equal(reduced?.netRestMs, 48 * H)
  assert.equal(reduced?.qualification, 'regular_weekly')

  const reducedOnly = findFerryRestCandidates({
    activities: [
      act('r1', 'rest', 0, 12 * 60),
      act('w', 'work', 12 * 60, 12 * 60 + 20),
      act('r2', 'rest', 12 * 60 + 20, 24 * 60 + 20),
    ],
    specificConditions: ferry(12 * 60, 12 * 60 + 20),
  })[0]
  assert.equal(reducedOnly?.netRestMs, 24 * H)
  assert.equal(reducedOnly?.qualification, 'reduced_weekly')
  assert.equal(reducedOnly?.legalApplicability, 'conditional')
  assert.match(reducedOnly?.reasons.join(' ') ?? '', /lůžk/i)
  assert.doesNotMatch(reducedOnly?.reasons.join(' ') ?? '', /8 hodin/)

  assert.match(reduced?.reasons.join(' ') ?? '', /8 hodin/)
  assert.match(reduced?.reasons.join(' ') ?? '', /spací kabina/)
  assert.equal(reduced?.legalApplicability, 'conditional')
})
