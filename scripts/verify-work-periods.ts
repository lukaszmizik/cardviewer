import assert from 'node:assert/strict'
import test from 'node:test'
import { assessWorkPeriods } from '../src/analysis/workPeriods.ts'
import type { Activity, ActivityKind, VehicleUse } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.parse('2024-10-01T06:00:00.000Z')

function act(
  id: string,
  kind: ActivityKind,
  startUtc: number,
  endUtc: number,
  manual = false,
  slot: 1 | 2 = 1,
): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / MINUTE),
    slot,
    isManualEntry: manual || undefined,
  }
}

function cardEdge(atUtc: number, present: boolean, slot: 1 | 2 = 1) {
  return { atUtc, present, slot }
}

test('práce → 45 min odpočinek → práce bez dalšího důkazu: žádný předěl', () => {
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, T0 + 4 * HOUR),
      act('r1', 'rest', T0 + 4 * HOUR, T0 + 4 * HOUR + 45 * MINUTE),
      act('w2', 'driving', T0 + 4 * HOUR + 45 * MINUTE, T0 + 8 * HOUR),
    ],
  })
  assert.equal(envelope.cuts.length, 0)
  assert.ok(envelope.startUtc === T0)
})

test('práce → 8 h odpočinek → práce bez dalšího důkazu: žádný předěl', () => {
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, T0 + 2 * HOUR),
      act('r1', 'rest', T0 + 2 * HOUR, T0 + 10 * HOUR),
      act('w2', 'driving', T0 + 10 * HOUR, T0 + 12 * HOUR),
    ],
  })
  assert.equal(envelope.cuts.length, 0)
})

test('odpočinek s přechodem card_present: kandidátní předěl, ne potvrzená hranice', () => {
  const restStart = T0 + 2 * HOUR
  const restEnd = T0 + 10 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + 2 * HOUR),
    ],
    cardPresentEdges: [cardEdge(restStart, false)],
  })
  assert.equal(envelope.cuts.length, 1)
  assert.deepEqual(envelope.cuts[0]?.support, ['card_present_edge'])
  assert.equal(envelope.cuts[0]?.previousWorkEndUtc, restStart)
  assert.equal(envelope.cuts[0]?.nextWorkStartUtc, restEnd)
  assert.equal(envelope.cuts[0]?.cardPresentSupport, 'one_sided')
  assert.deepEqual(envelope.cuts[0]?.uncertainties, ['one_sided_card_present'])
})

test('odpočinek s mezerou VehicleUse: kandidátní předěl', () => {
  const restStart = T0 + 3 * HOUR
  const restEnd = T0 + 5 * HOUR
  const uses: VehicleUse[] = [
    { registration: '1AB2345', fromUtc: T0, toUtc: restStart, kilometers: 100 },
    { registration: '6CD7890', fromUtc: restEnd, toUtc: restEnd + 4 * HOUR, kilometers: 50 },
  ]
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + 4 * HOUR),
    ],
    vehicleUses: uses,
  })
  assert.equal(envelope.cuts.length, 1)
  assert.deepEqual(envelope.cuts[0]?.support, ['vehicle_use_gap'])
})

test('unknown protínající jen jeden z dvou kandidátních předělů', () => {
  const r1Start = T0 + 2 * HOUR
  const r1End = T0 + 3 * HOUR
  const r2Start = T0 + 5 * HOUR
  const r2End = T0 + 10 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, r1Start),
      act('r1', 'rest', r1Start, r1End),
      act('w2', 'driving', r1End, r2Start),
      act('r2', 'rest', r2Start, r2End),
      act('w3', 'driving', r2End, r2End + HOUR),
      act('gap', 'unknown', r2Start + HOUR, r2Start + 2 * HOUR),
    ],
    cardPresentEdges: [cardEdge(r1Start, false), cardEdge(r2Start, false)],
  })
  assert.equal(envelope.cuts.length, 2)
  const first = envelope.cuts.find((cut) => cut.restSegments[0]?.startUtc === r1Start)
  const second = envelope.cuts.find((cut) => cut.restSegments[0]?.startUtc === r2Start)
  assert.equal(first?.blockers.length, 0)
  assert.deepEqual(second?.blockers, ['unknown'])
})

test('předěl bez podpůrného důkazu nevznikne', () => {
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, T0 + 6 * HOUR),
      act('r1', 'rest', T0 + 6 * HOUR, T0 + 7 * HOUR),
      act('w2', 'work', T0 + 7 * HOUR, T0 + 9 * HOUR),
    ],
  })
  assert.equal(envelope.cuts.length, 0)
})

test('card_present uprostřed odpočinku nevytvoří předěl', () => {
  const restStart = T0 + 2 * HOUR
  const restEnd = T0 + 10 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + HOUR),
    ],
    cardPresentEdges: [cardEdge(restStart + 3 * HOUR, false)],
  })
  assert.equal(envelope.cuts.length, 0)
})

test('nesprávný směr present na začátku odpočinku nevytvoří podporu', () => {
  const restStart = T0 + 2 * HOUR
  const restEnd = T0 + 4 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + HOUR),
    ],
    cardPresentEdges: [cardEdge(restStart, true)],
  })
  assert.equal(envelope.cuts.length, 0)
})

test('vzdálené záznamy VehicleUse nevytvoří předěl', () => {
  const restStart = T0 + 10 * HOUR
  const restEnd = T0 + 12 * HOUR
  const uses: VehicleUse[] = [
    { registration: 'A', fromUtc: T0, toUtc: T0 + HOUR, kilometers: 10 },
    { registration: 'B', fromUtc: T0 + 3 * HOUR, toUtc: T0 + 4 * HOUR, kilometers: 10 },
    { registration: 'C', fromUtc: restEnd, toUtc: restEnd + HOUR, kilometers: 10 },
  ]
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0 + 8 * HOUR, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + 2 * HOUR),
    ],
    vehicleUses: uses,
  })
  assert.equal(envelope.cuts.length, 0)
})

test('změna vozidla bez odpočinku mezi prací nevytvoří předěl', () => {
  const uses: VehicleUse[] = [
    { registration: 'A', fromUtc: T0, toUtc: T0 + 5 * HOUR, kilometers: 10 },
    { registration: 'B', fromUtc: T0 + 5 * HOUR, toUtc: T0 + 9 * HOUR, kilometers: 10 },
  ]
  const envelope = assessWorkPeriods({
    activities: [act('w1', 'driving', T0, T0 + 9 * HOUR)],
    vehicleUses: uses,
  })
  assert.equal(envelope.cuts.length, 0)
})

test('ruční činnost na kraji předělu označí manual_only', () => {
  const restStart = T0 + 2 * HOUR
  const restEnd = T0 + 4 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart, true),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + HOUR),
    ],
    cardPresentEdges: [cardEdge(restStart, false)],
  })
  assert.equal(envelope.cuts.length, 1)
  assert.deepEqual(envelope.cuts[0]?.blockers, ['manual_only'])
})

test('unknown v obálce vypne dataComplete', () => {
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, T0 + HOUR),
      act('gap', 'unknown', T0 + HOUR, T0 + 2 * HOUR),
      act('w2', 'work', T0 + 2 * HOUR, T0 + 3 * HOUR),
    ],
  })
  assert.equal(envelope.dataComplete, false)
  assert.equal(envelope.blockers.length, 1)
  assert.equal(envelope.blockers[0]?.kind, 'unknown')
})

test('vícedenní vstup vrací jednu obálku', () => {
  const day = 24 * HOUR
  const start = T0
  const end = T0 + 27 * day
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', start, start + HOUR),
      act('r1', 'rest', start + HOUR, start + 2 * HOUR),
      act('w2', 'driving', end - HOUR, end),
    ],
  })
  assert.equal(envelope.startUtc, start)
  assert.equal(envelope.endUtc, end)
  assert.equal(envelope.cuts.length, 0)
})

test('dva rest úseky mezi stejnou dvojicí prací → jeden kandidát', () => {
  const wEnd = T0 + 2 * HOUR
  const wStart = T0 + 4 * HOUR
  const r1Start = wEnd
  const r1End = wEnd + MINUTE
  const r2Start = wEnd + 2 * MINUTE
  const r2End = wEnd + 3 * MINUTE
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, wEnd),
      act('r1', 'rest', r1Start, r1End),
      act('r2', 'rest', r2Start, r2End),
      act('w2', 'driving', wStart, wStart + HOUR),
    ],
    cardPresentEdges: [cardEdge(wEnd, false), cardEdge(wStart, true)],
  })
  assert.equal(envelope.cuts.length, 1)
  assert.equal(envelope.cuts[0]?.restSegments.length, 2)
  assert.equal(envelope.cuts[0]?.cardPresentSupport, 'two_sided')
})

test('jednominutový rest s jednou hranou card_present', () => {
  const restStart = T0 + HOUR
  const restEnd = restStart + MINUTE
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + HOUR),
    ],
    cardPresentEdges: [cardEdge(restStart, false)],
  })
  assert.equal(envelope.cuts.length, 1)
  assert.equal(envelope.cuts[0]?.cardPresentSupport, 'one_sided')
  assert.ok(envelope.cuts[0]?.uncertainties.includes('one_sided_card_present'))
})

test('oboustranná podpora stejného slotu', () => {
  const restStart = T0 + 2 * HOUR
  const restEnd = T0 + 4 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart),
      act('r1', 'rest', restStart, restEnd),
      act('w2', 'driving', restEnd, restEnd + HOUR),
    ],
    cardPresentEdges: [cardEdge(restStart, false), cardEdge(restEnd, true)],
  })
  assert.equal(envelope.cuts[0]?.cardPresentSupport, 'two_sided')
  assert.equal(envelope.cuts[0]?.uncertainties.length, 0)
})

test('hrana jiného slotu se nezapočítá', () => {
  const restStart = T0 + 2 * HOUR
  const restEnd = T0 + 4 * HOUR
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, restStart, false, 1),
      act('r1', 'rest', restStart, restEnd, false, 1),
      act('w2', 'driving', restEnd, restEnd + HOUR, false, 1),
    ],
    cardPresentEdges: [cardEdge(restStart, false, 2), cardEdge(restEnd, true, 2)],
  })
  assert.equal(envelope.cuts.length, 0)
})

test('unknown mezi rest a následující prací označí nejistotu', () => {
  const wEnd = T0 + 2 * HOUR
  const rStart = wEnd
  const rEnd = wEnd + HOUR
  const gapStart = rEnd
  const gapEnd = rEnd + 30 * DAY
  const w2Start = gapEnd
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, wEnd),
      act('r1', 'rest', rStart, rEnd),
      act('gap', 'unknown', gapStart, gapEnd),
      act('w2', 'driving', w2Start, w2Start + HOUR),
    ],
    cardPresentEdges: [cardEdge(wEnd, false), cardEdge(w2Start, true)],
  })
  assert.equal(envelope.cuts.length, 1)
  assert.ok(envelope.cuts[0]?.unknownInCorridor.length > 0)
  assert.ok(envelope.cuts[0]?.uncertainties.includes('unknown_in_corridor'))
  assert.ok(envelope.cuts[0]?.blockers.includes('unknown'))
})

test('dlouhá mezera v historii: koridor s unknown bez slučování restů', () => {
  const wEnd = T0 + HOUR
  const rEnd = wEnd + MINUTE
  const w2 = T0 + 60 * DAY
  const envelope = assessWorkPeriods({
    activities: [
      act('w1', 'driving', T0, wEnd),
      act('r1', 'rest', wEnd, rEnd),
      act('gap', 'unknown', rEnd, w2),
      act('w2', 'driving', w2, w2 + HOUR),
    ],
    cardPresentEdges: [cardEdge(wEnd, false), cardEdge(w2, true)],
  })
  assert.equal(envelope.cuts.length, 1)
  assert.equal(envelope.cuts[0]?.restSegments.length, 1)
  assert.equal(envelope.cuts[0]?.restSegments[0]?.startUtc, wEnd)
})
