import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyRestChain, type DailyChainNode, type UnrecordedInterval } from '../src/analysis/dailyRestChain.ts'
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

function startNode(anchorUtc: number, candidates: RestCandidate[], unknown: UnrecordedInterval[] = []): DailyChainNode {
  return buildDailyRestChain(anchorUtc, candidates, unknown).nodes[0]!
}

test('11 hodin celé uvnitř navazuje na skutečný konec', () => {
  const endUtc = Date.parse('2026-03-02T19:00:00.000Z')
  const chain = buildDailyRestChain(WINDOW, [candidate(Date.parse('2026-03-02T08:00:00.000Z'), endUtc)])
  const node = chain.nodes[0]!
  assert.equal(node.status, 'evaluated')
  assert.deepEqual(
    node.interpretations.map((item) => item.kind),
    ['continuous_regular'],
  )
  assert.equal(node.interpretations[0]?.qualifiesWindow, true)
  assert.equal(node.interpretations[0]?.nextAnchorUtc, endUtc)
  assert.equal(node.interpretations[0]?.reducedDelta, 0)
  assert.equal(chain.paths[0]?.reducedCount, 0)
  assert.equal(chain.paths[0]?.weeklyBoundariesDetermined, false)
  assert.equal(chain.nodes.some((item) => item.anchorUtc === WINDOW + 24 * HOUR), false)
})

test('13 hodin s 10 hodinami v okně je zkrácená interpretace s kotvou na skutečném konci', () => {
  const startUtc = Date.parse('2026-03-02T20:00:00.000Z')
  const endUtc = Date.parse('2026-03-03T09:00:00.000Z')
  const windowEndUtc = WINDOW + 24 * HOUR
  const chain = buildDailyRestChain(WINDOW, [candidate(startUtc, endUtc, { sourceActivityIds: ['rest-13'] })])
  const node = chain.nodes[0]!
  const interpretation = node.interpretations[0]!
  assert.equal(node.status, 'evaluated')
  assert.deepEqual(
    node.interpretations.map((item) => item.kind),
    ['continuous_reduced'],
  )
  assert.equal(interpretation.qualifiesWindow, true)
  assert.equal(interpretation.reducedDelta, 1)
  assert.equal(interpretation.parts[0]?.candidateMinutes, 13 * 60)
  assert.equal(interpretation.parts[0]?.restMinutesInsideWindow, 10 * 60)
  assert.equal(interpretation.parts[0]?.endUtc, endUtc)
  assert.equal(interpretation.parts[0]?.intersectionEndUtc, windowEndUtc)
  assert.equal(interpretation.nextAnchorUtc, endUtc)
  assert.equal(chain.paths[0]?.reducedCount, 1)
  assert.equal(chain.paths[0]?.weeklyBoundariesDetermined, false)
  assert.equal(chain.nodes.some((item) => item.anchorUtc === windowEndUtc), false)
  assert.equal(Object.hasOwn(node, 'infringement'), false)
})

test('3 + 9 hodin drží dvě interpretace a sdílí konec druhé části', () => {
  const firstEnd = Date.parse('2026-03-02T11:00:00.000Z')
  const secondEnd = Date.parse('2026-03-02T23:00:00.000Z')
  const chain = buildDailyRestChain(WINDOW, [
    candidate(Date.parse('2026-03-02T08:00:00.000Z'), firstEnd, { sourceActivityIds: ['part-3'] }),
    candidate(Date.parse('2026-03-02T14:00:00.000Z'), secondEnd, { sourceActivityIds: ['part-9'] }),
  ])
  const node = chain.nodes[0]!
  assert.deepEqual(
    node.interpretations.map((item) => item.kind),
    ['continuous_reduced', 'split_regular'],
  )
  assert.equal(node.interpretations[0]?.nextAnchorUtc, secondEnd)
  assert.equal(node.interpretations[1]?.nextAnchorUtc, secondEnd)
  assert.deepEqual(node.interpretations[1]?.parts.map((part) => part.sourceActivityIds[0]), ['part-3', 'part-9'])
  assert.notEqual(node.interpretations[1]?.nextAnchorUtc, firstEnd)
  assert.equal(chain.nodes.filter((item) => item.anchorUtc === WINDOW).length, 1)
  assert.equal(chain.nodes.filter((item) => item.anchorUtc === secondEnd).length, 1)
  assert.deepEqual(chain.paths.map((path) => path.reducedCount).sort(), [0, 1])
  assert.equal(chain.paths.every((path) => path.weeklyBoundariesDetermined === false), true)
})

test('45 hodin zůstává jeden odpočinek s otevřenou týdenní rolí', () => {
  const endUtc = WINDOW + 45 * HOUR
  const windowEndUtc = WINDOW + 24 * HOUR
  const chain = buildDailyRestChain(WINDOW, [
    candidate(WINDOW, endUtc, {
      sourceActivityIds: ['block-45'],
      kinds: ['daily_regular', 'weekly_reduced', 'weekly_regular'],
    }),
  ])
  const node = chain.nodes[0]!
  assert.equal(node.interpretations.length, 1)
  assert.equal(node.interpretations[0]?.kind, 'continuous_regular')
  assert.equal(node.interpretations[0]?.parts.length, 1)
  assert.equal(node.interpretations[0]?.parts[0]?.candidateMinutes, 45 * 60)
  assert.equal(node.interpretations[0]?.parts[0]?.restMinutesInsideWindow, 24 * 60)
  assert.equal(node.interpretations[0]?.weeklyRolePossible, true)
  assert.equal(node.interpretations[0]?.nextAnchorUtc, endUtc)
  assert.equal(chain.nodes.some((item) => item.anchorUtc === windowEndUtc), false)
  assert.equal(chain.paths[0]?.weeklyBoundariesDetermined, false)
})

test('neznámý úsek brání návaznosti a nevytvoří odpočinek', () => {
  const anchorUtc = Date.parse('2026-03-01T06:00:00.000Z')
  const laterStart = Date.parse('2026-03-03T10:00:00.000Z')
  const laterEnd = Date.parse('2026-03-03T22:00:00.000Z')
  const chain = buildDailyRestChain(
    anchorUtc,
    [candidate(laterStart, laterEnd, { sourceActivityIds: ['after-gap'] })],
    [{ startUtc: Date.parse('2026-03-01T08:00:00.000Z'), endUtc: Date.parse('2026-03-03T08:00:00.000Z') }],
  )
  const node = chain.nodes[0]!
  assert.equal(node.status, 'insufficient_data')
  assert.deepEqual(node.interpretations, [])
  assert.equal(chain.nodes.length, 1)
  assert.equal(chain.nodes.some((item) => item.anchorUtc === laterEnd), false)
  assert.equal(chain.paths[0]?.steps[0]?.interpretationId, null)
})

test('méně než 9 hodin v okně zůstává window_unsatisfied a kotva je skutečný konec', () => {
  const startUtc = Date.parse('2026-03-03T00:00:00.000Z')
  const endUtc = Date.parse('2026-03-03T12:00:00.000Z')
  const windowEndUtc = WINDOW + 24 * HOUR
  const source = [candidate(startUtc, endUtc, { sourceActivityIds: ['crosses'] })]
  const snapshot = structuredClone(source)
  const chain = buildDailyRestChain(WINDOW, source)
  const node = startNode(WINDOW, source)
  const interpretation = node.interpretations[0]!
  assert.equal(node.status, 'window_unsatisfied')
  assert.equal(interpretation.kind, 'window_unsatisfied')
  assert.equal(interpretation.qualifiesWindow, false)
  assert.equal(interpretation.reducedDelta, 0)
  assert.equal(interpretation.parts[0]?.restMinutesInsideWindow, 6 * 60)
  assert.equal(interpretation.parts[0]?.candidateMinutes, 12 * 60)
  assert.equal(interpretation.parts[0]?.endUtc, endUtc)
  assert.equal(interpretation.nextAnchorUtc, endUtc)
  assert.notEqual(interpretation.nextAnchorUtc, windowEndUtc)
  assert.equal(chain.nodes.some((item) => item.anchorUtc === windowEndUtc), false)
  assert.equal(Object.hasOwn(node, 'infringement'), false)
  assert.equal(Object.hasOwn(node, 'compliant'), false)
  assert.equal(Object.hasOwn(interpretation, 'noBreach'), false)
  assert.deepEqual(source, snapshot)
})

test('historie končící na začátku dalšího okna není nesplněný odpočinek', () => {
  const chain = buildDailyRestChain(WINDOW, [], [], WINDOW)
  assert.equal(chain.nodes[0]?.status, 'history_incomplete')
  assert.deepEqual(chain.nodes[0]?.interpretations, [])
  assert.equal(chain.paths.length, 1)
  assert.equal(chain.paths[0]?.steps[0]?.interpretationId, null)
})

test('historie končící uprostřed okna není nesplněný odpočinek', () => {
  const recordEnd = WINDOW + 6 * HOUR
  const chain = buildDailyRestChain(
    WINDOW,
    [candidate(WINDOW + HOUR, WINDOW + 3 * HOUR, { sourceActivityIds: ['short'] })],
    [],
    recordEnd,
  )
  assert.equal(chain.nodes[0]?.status, 'history_incomplete')
  assert.equal(chain.nodes[0]?.windowEndUtc, WINDOW + 24 * HOUR)
  assert.deepEqual(chain.nodes[0]?.interpretations, [])
  assert.equal(chain.paths.length, 1)
})

test('úplné okno bez kvalifikovaného odpočinku zůstává window_unsatisfied', () => {
  const recordEnd = WINDOW + 24 * HOUR
  const chain = buildDailyRestChain(
    WINDOW,
    [candidate(WINDOW + HOUR, WINDOW + 9 * HOUR, { sourceActivityIds: ['eight'] })],
    [],
    recordEnd,
  )
  assert.equal(chain.nodes[0]?.status, 'window_unsatisfied')
  assert.deepEqual(chain.nodes[0]?.interpretations, [])
  assert.notEqual(chain.nodes[0]?.status, 'history_incomplete')
  assert.equal(chain.paths.length, 1)
})

test('neznámý úsek má přednost před neúplnou historií', () => {
  const unknown = [{ startUtc: WINDOW + 2 * HOUR, endUtc: WINDOW + 4 * HOUR }]
  const covered = buildDailyRestChain(WINDOW, [], unknown, WINDOW + 24 * HOUR)
  const short = buildDailyRestChain(WINDOW, [], unknown, WINDOW + 6 * HOUR)
  assert.equal(covered.nodes[0]?.status, 'insufficient_data')
  assert.equal(short.nodes[0]?.status, 'insufficient_data')
  assert.deepEqual(covered.nodes[0]?.interpretations, [])
  assert.equal(covered.paths.length, 1)
  assert.equal(short.paths.length, 1)
})

test('odpočinek dokončený před koncem okna zůstává vyhodnocený i při kratší historii', () => {
  const restEnd = WINDOW + 12 * HOUR
  const chain = buildDailyRestChain(
    WINDOW,
    [candidate(WINDOW + HOUR, restEnd, { sourceActivityIds: ['done'] })],
    [],
    restEnd,
  )
  const first = chain.nodes[0]!
  assert.equal(first.status, 'evaluated')
  assert.equal(first.interpretations.length, 1)
  assert.equal(first.interpretations[0]?.kind, 'continuous_regular')
  assert.equal(first.interpretations[0]?.nextAnchorUtc, restEnd)
  assert.equal(chain.nodes[1]?.status, 'history_incomplete')
  assert.equal(chain.paths.length, 1)
  assert.equal(chain.paths[0]?.steps[0]?.interpretationId, first.interpretations[0]?.id)
  assert.equal(chain.paths[0]?.steps[1]?.anchorUtc, restEnd)
})

test('odpočinek pokračující za konec okna zůstává window_unsatisfied s variantou', () => {
  const restEnd = WINDOW + 30 * HOUR
  const chain = buildDailyRestChain(
    WINDOW,
    [candidate(WINDOW + 18 * HOUR, restEnd, { sourceActivityIds: ['crosses'] })],
    [],
    restEnd,
  )
  const first = chain.nodes[0]!
  assert.equal(first.status, 'window_unsatisfied')
  assert.equal(first.interpretations.length, 1)
  assert.equal(first.interpretations[0]?.kind, 'window_unsatisfied')
  assert.equal(first.interpretations[0]?.qualifiesWindow, false)
  assert.equal(first.interpretations[0]?.nextAnchorUtc, restEnd)
  assert.equal(chain.nodes[1]?.status, 'history_incomplete')
  assert.equal(chain.paths.length, 1)
  assert.equal(chain.paths[0]?.steps.map((step) => step.anchorUtc).join(','), [WINDOW, restEnd].join(','))
})
