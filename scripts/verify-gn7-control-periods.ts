import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGn7ControlPeriods } from '../src/analysis/gn7ControlPeriods.ts'
import type { Activity } from '../src/types/tacho.ts'

const H = 60 * 60 * 1000

function act(
  id: string,
  kind: Activity['kind'],
  startHour: number,
  endHour: number,
  extra: Partial<Activity> = {},
): Activity {
  return {
    id,
    kind,
    startUtc: startHour * H,
    endUtc: endHour * H,
    durationMinutes: (endHour - startHour) * 60,
    slot: 1,
    ...extra,
  }
}

test('souvislý kvalifikovaný odpočinek posune kotvu na svůj konec', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 8),
      act('r', 'rest', 8, 19),
      act('d2', 'driving', 19, 30),
    ],
  })
  assert.equal(periods[0]!.status, 'qualifying_rest')
  assert.equal(periods[0]!.boundarySource, 'gn7')
  assert.equal(periods[0]!.windowMinutes, 24 * 60)
  assert.equal(periods[0]!.endUtc, 24 * H)
  assert.equal(periods[0]!.nextAnchorUtc, 19 * H)
  assert.equal(periods[0]!.qualifying[0]!.variant, 'continuous_regular')
  assert.equal(periods[1]!.startUtc, 19 * H)
})

test('odpočinek 8 h a následující činnost drží další období na 24:00', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('r', 'rest', 1, 9),
      act('d', 'driving', 9, 48),
    ],
  })
  assert.equal(periods[0]!.status, 'consecutive_reference')
  assert.equal(periods[0]!.nextAnchorUtc, 24 * H)
  assert.equal(periods[0]!.rests[0]!.durationMinutes, 8 * 60)
  assert.equal(periods[0]!.rests[0]!.reachesNamedMinimum, false)
  assert.equal(periods[1]!.startUtc, 24 * H)
  assert.equal(periods[1]!.windowMinutes, 24 * 60)
})

test('několik po sobě jdoucích nedostatečných odpočinků', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('r1', 'rest', 2, 10),
      act('d1', 'driving', 10, 26),
      act('r2', 'rest', 26, 34),
      act('d2', 'driving', 34, 50),
    ],
  })
  assert.deepEqual(periods.slice(0, 2).map((period) => [period.startUtc, period.nextAnchorUtc, period.status]), [
    [0, 24 * H, 'consecutive_reference'],
    [24 * H, 48 * H, 'consecutive_reference'],
  ])
  assert.equal(periods[0]!.rests.some((rest) => rest.durationMinutes === 8 * 60), true)
  assert.equal(periods[1]!.rests.some((rest) => rest.startUtc === 26 * H), true)
})

test('přesah 24 h, který zůstane nedostatečný, navazuje na 24:00', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 20),
      act('r', 'rest', 20, 26),
      act('d2', 'driving', 26, 50),
    ],
  })
  assert.equal(periods[0]!.status, 'crossing_rest_remains_insufficient')
  assert.equal(periods[0]!.endUtc, 24 * H)
  assert.equal(periods[0]!.nextAnchorUtc, 24 * H)
  assert.equal(periods[1]!.startUtc, 24 * H)
})

test('kvalifikovaný odpočinek smí skončit až po hranici okna', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 10),
      act('r', 'rest', 10, 30),
      act('d2', 'driving', 30, 36),
    ],
  })
  assert.equal(periods[0]!.status, 'qualifying_rest')
  assert.equal(periods[0]!.nextAnchorUtc, 30 * H)
  assert.notEqual(periods[0]!.nextAnchorUtc, periods[0]!.endUtc)
})

test('přesah, který dosáhne 9 h, navazuje na konec odpočinku ve 3:00', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 18),
      act('r', 'rest', 18, 27),
      act('d2', 'driving', 27, 40),
    ],
  })
  assert.equal(periods[0]!.status, 'crossing_rest_becomes_qualifying')
  assert.equal(periods[0]!.endUtc, 24 * H)
  assert.equal(periods[0]!.nextAnchorUtc, 27 * H)
  assert.equal(periods[0]!.qualifying[0]!.variant, 'continuous_reduced')
  assert.equal(periods[1]!.startUtc, 27 * H)

  const regular = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 16),
      act('r', 'rest', 16, 27),
      act('d2', 'driving', 27, 40),
    ],
  })
  assert.equal(regular[0]!.status, 'crossing_rest_becomes_qualifying')
  assert.equal(regular[0]!.nextAnchorUtc, 27 * H)
  assert.equal(regular[0]!.qualifying[0]!.variant, 'continuous_regular')
})

test('vícečlenná osádka střídá 30 h a po jejím skončení 24 h', () => {
  const crew = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d1', 'driving', 0, 30, { isCrew: true }),
      act('d2', 'driving', 30, 70, { isCrew: true }),
    ],
  })
  assert.equal(crew[0]!.crewApplies, true)
  assert.equal(crew[0]!.windowMinutes, 30 * 60)
  assert.equal(crew[0]!.nextAnchorUtc, 30 * H)
  assert.equal(crew[1]!.startUtc, 30 * H)
  assert.equal(crew[1]!.windowMinutes, 30 * 60)

  const switched = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 10, { isCrew: true }),
      act('r', 'rest', 10, 19, { isCrew: true }),
      act('after', 'driving', 19, 50, { isCrew: false }),
    ],
  })
  assert.equal(switched[0]!.windowMinutes, 30 * 60)
  assert.equal(switched[0]!.status, 'qualifying_rest')
  assert.equal(switched[0]!.nextAnchorUtc, 19 * H)
  assert.equal(switched[1]!.startUtc, 19 * H)
  assert.equal(switched[1]!.crewApplies, false)
  assert.equal(switched[1]!.windowMinutes, 24 * 60)
})

const T0 = Date.parse('2024-10-25T00:00:00.000Z')
const MIN = 60_000

function at(startMin: number, endMin: number, kind: Activity['kind'], id: string, extra: Partial<Activity> = {}): Activity {
  return {
    id,
    kind,
    startUtc: T0 + startMin * MIN,
    endUtc: T0 + endMin * MIN,
    durationMinutes: endMin - startMin,
    slot: 1,
    ...extra,
  }
}

test('nejednoznačný 11h odpočinek neposune kotvu', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'd0'),
      at(120, 780, 'rest', 'r1', { slot: 1 }),
      at(240, 360, 'rest', 'r2', { slot: 2 }),
      at(780, 1600, 'driving', 'd1'),
    ],
  })
  assert.equal(periods.length, 1)
  assert.equal(periods[0]!.status, 'insufficient_data')
  assert.equal(periods[0]!.dataCompleteness, 'incomplete')
  assert.equal(periods[0]!.nextAnchorUtc, null)
  assert.equal(periods[0]!.confirmedForEnforcement, false)
})

test('dva kvalifikované odpočinky v překrývajících se oknech', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'd0'),
      at(120, 780, 'rest', 'r1'),
      at(780, 840, 'driving', 'd1'),
      at(840, 1500, 'rest', 'r2'),
      at(1500, 2000, 'driving', 'd2'),
    ],
  })
  assert.equal(periods[0]!.startUtc, T0)
  assert.equal(periods[0]!.endUtc, T0 + 24 * H)
  assert.equal(periods[0]!.nextAnchorUtc, T0 + 780 * MIN)
  assert.equal(periods[1]!.startUtc, T0 + 780 * MIN)
  assert.equal(periods[1]!.endUtc, T0 + 780 * MIN + 24 * H)
  assert.equal(periods[1]!.nextAnchorUtc, T0 + 1500 * MIN)
  assert.ok(periods[1]!.startUtc < periods[0]!.endUtc)
})

test('krátký přesah hranice započte jen minuty uvnitř každého okna', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, 1200, 'driving', 'd0'),
      at(1200, 1560, 'rest', 'r'),
      at(1560, 3000, 'driving', 'd1'),
    ],
  })
  assert.equal(periods[0]!.status, 'crossing_rest_remains_insufficient')
  assert.equal(periods[0]!.nextAnchorUtc, T0 + 24 * H)
  assert.equal(periods[0]!.rests.find((rest) => rest.startUtc === T0 + 1200 * MIN)?.minutesInsideWindow, 240)
  assert.equal(periods[1]!.startUtc, T0 + 24 * H)
  assert.equal(periods[1]!.rests.find((rest) => rest.startUtc === T0 + 1200 * MIN)?.minutesInsideWindow, 120)
})

test('přesné hranice 9 a 11 hodin se nezaokrouhlují nahoru', () => {
  const run = (minutes: number) => buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, minutes, 'rest', 'r'),
      at(minutes, minutes + 20 * 60, 'driving', 'd'),
    ],
  })[0]!
  const under9 = run(539)
  const at9 = run(540)
  const under11 = run(659)
  const at11 = run(660)
  assert.equal(under9.rests[0]!.reachesNamedMinimum, false)
  assert.equal(under9.status, 'consecutive_reference')
  assert.equal(at9.rests[0]!.reachesNamedMinimum, true)
  assert.equal(at9.rests[0]!.reachesRegularLength, false)
  assert.equal(at9.qualifying[0]!.variant, 'continuous_reduced')
  assert.equal(at9.reducedRestPermitted, 'not_assessed')
  assert.equal(at9.confirmedForEnforcement, false)
  assert.equal(under11.qualifying[0]!.variant, 'continuous_reduced')
  assert.equal(under11.rests[0]!.reachesRegularLength, false)
  assert.equal(at11.qualifying[0]!.variant, 'continuous_regular')
  assert.equal(at11.rests[0]!.reachesRegularLength, true)
  assert.equal(at11.reducedRestPermitted, 'not_required')

  const seconds = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      {
        id: 'r',
        kind: 'rest',
        startUtc: T0,
        endUtc: T0 + 8 * H + 59 * MIN + 31_000,
        durationMinutes: 539,
        slot: 1,
      },
      at(9 * 60, 30 * 60, 'driving', 'd'),
    ],
  })[0]!
  assert.equal(seconds.rests[0]!.reachesNamedMinimum, false)
  assert.equal(seconds.status, 'consecutive_reference')
})

test('podmíněná osádka není jediný potvrzený 30h výsledek', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'c1', { isCrew: true }),
      at(300, 40 * 60, 'driving', 'c2', { isCrew: true }),
    ],
  })
  assert.equal(periods.length, 1)
  assert.equal(periods[0]!.crewBasis, 'conditional')
  assert.equal(periods[0]!.confirmedForEnforcement, false)
  assert.equal(periods[0]!.nextAnchorUtc, null)
  assert.equal(periods[0]!.dataCompleteness, 'incomplete')
  assert.deepEqual(periods[0]!.windowVariants.map((item) => item.windowMinutes).sort((a, b) => a - b), [24 * 60, 30 * 60])
  assert.equal(periods[0]!.windowVariants.every((item) => item.confirmedForEnforcement === false), true)
})

test('přerušení osádky ponechá 24hodinové okno', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'c', { isCrew: true }),
      at(120, 300, 'driving', 'solo', { isCrew: false }),
      at(300, 40 * 60, 'driving', 'after', { isCrew: false }),
    ],
  })
  assert.equal(periods[0]!.crewApplies, false)
  assert.equal(periods[0]!.windowMinutes, 24 * 60)
  assert.equal(periods[0]!.crewRecord, 'crew_record_interrupted')
})

test('řetězec pokryje celé období záznamu a nezastaví se po 48 dnech', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [act('d', 'driving', 0, 50 * 24)],
  })
  assert.equal(periods.length, 50)
  assert.equal(periods[49]!.analysisTruncated, false)
  assert.equal(periods[49]!.startUtc, 49 * 24 * H)
  assert.equal(periods[49]!.nextAnchorUtc, 50 * 24 * H)
})

test('dělený 3+9 přes hranici okna zůstane nejistý', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: T0,
    activities: [
      at(0, 60, 'driving', 'd0'),
      at(60, 240, 'rest', 'r3'),
      at(240, 1200, 'driving', 'd1'),
      at(1200, 1740, 'rest', 'r9'),
      at(1740, 2200, 'driving', 'd2'),
    ],
  })
  assert.equal(periods.length, 1)
  assert.equal(periods[0]!.status, 'insufficient_data')
  assert.equal(periods[0]!.nextAnchorUtc, null)
  assert.equal(periods[0]!.confirmedForEnforcement, false)
  assert.match(periods[0]!.assessmentBasis, /3\+9/)
})

test('neznámý úsek a neúplná historie nestanoví další kotvu', () => {
  const unknown = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [
      act('d', 'driving', 0, 4),
      act('u', 'unknown', 4, 6),
      act('d2', 'driving', 6, 30),
    ],
  })
  assert.equal(unknown[0]!.status, 'insufficient_data')
  assert.equal(unknown[0]!.dataCompleteness, 'incomplete')
  assert.equal(unknown[0]!.nextAnchorUtc, null)
  assert.equal(unknown.length, 1)

  const history = buildGn7ControlPeriods({
    anchorUtc: 0,
    activities: [act('d', 'driving', 0, 10)],
  })
  assert.equal(history[0]!.status, 'history_incomplete')
  assert.equal(history[0]!.dataCompleteness, 'history_incomplete')
  assert.equal(history[0]!.nextAnchorUtc, null)
})

const CASE = (iso: string) => Date.parse(iso)

function clock(id: string, kind: Activity['kind'], start: string, end: string): Activity {
  const startUtc = CASE(start)
  const endUtc = CASE(end)
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / MIN),
    slot: 1,
  }
}

/** Časová osa období #114. Časy jsou zadané údaje, bez převodu na místní pásmo. */
function period114Activities(extra: Activity[] = []): Activity[] {
  return [
    clock('early-d0', 'driving', '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z'),
    clock('early-r3', 'rest', '2026-08-01T01:00:00Z', '2026-08-01T04:00:00Z'),
    clock('early-d1', 'driving', '2026-08-01T04:00:00Z', '2026-08-01T20:00:00Z'),
    clock('early-r9', 'rest', '2026-08-01T20:00:00Z', '2026-08-02T05:00:00Z'),
    clock('early-d2', 'driving', '2026-08-02T05:00:00Z', '2026-08-13T00:00:00Z'),
    clock('anchor-rest', 'rest', '2026-08-13T00:00:00Z', '2026-08-14T11:01:00Z'),
    clock('shift-d1', 'driving', '2026-08-14T11:01:00Z', '2026-08-15T22:35:00Z'),
    clock('short-rest', 'rest', '2026-08-15T22:35:00Z', '2026-08-16T05:48:00Z'),
    clock('shift-d2', 'driving', '2026-08-16T05:48:00Z', '2026-08-16T13:02:00Z'),
    clock('long-rest', 'rest', '2026-08-16T13:02:00Z', '2026-08-18T11:34:00Z'),
    clock('after', 'driving', '2026-08-18T11:34:00Z', '2026-08-18T14:00:00Z'),
    ...extra,
  ]
}

test('dřívější nejistota 3+9 nezastaví dvě nesplněná okna 50h období', () => {
  const periods = buildGn7ControlPeriods({
    anchorUtc: CASE('2026-08-01T00:00:00Z'),
    activities: period114Activities(),
  })
  assert.equal(periods[0]!.status, 'insufficient_data')
  assert.equal(periods[0]!.nextAnchorUtc, null)
  const first = periods.find((period) => period.startUtc === CASE('2026-08-14T11:01:00Z'))
  const second = periods.find((period) => period.startUtc === CASE('2026-08-15T11:01:00Z'))
  const third = periods.find((period) => period.startUtc === CASE('2026-08-16T11:01:00Z'))
  assert.ok(first != null && second != null && third != null)
  assert.equal(first.status, 'consecutive_reference')
  assert.equal(first.endUtc, CASE('2026-08-15T11:01:00Z'))
  assert.equal(first.qualifying.length, 0)
  assert.equal(second.status, 'consecutive_reference')
  assert.equal(second.endUtc, CASE('2026-08-16T11:01:00Z'))
  assert.equal(second.qualifying.length, 0)
  assert.equal(second.rests.some((rest) => rest.durationMinutes === 7 * 60 + 13), true)
  assert.equal(third.status, 'qualifying_rest')
  assert.equal(third.qualifying[0]?.variant, 'continuous_regular')
  assert.equal(third.nextAnchorUtc, CASE('2026-08-18T11:34:00Z'))
})

test('tři po sobě jdoucí nesplněná denní okna zůstanou v řetězci', () => {
  const start = CASE('2026-05-01T00:00:00Z')
  const periods = buildGn7ControlPeriods({
    anchorUtc: start,
    activities: [
      clock('long-drive', 'driving', '2026-05-01T00:00:00Z', '2026-05-04T00:00:00Z'),
      clock('later-rest', 'rest', '2026-05-04T00:00:00Z', '2026-05-04T11:00:00Z'),
      clock('tail', 'driving', '2026-05-04T11:00:00Z', '2026-05-04T14:00:00Z'),
    ],
  })
  assert.deepEqual(periods.slice(0, 4).map((period) => [period.startUtc - start, period.status]), [
    [0, 'consecutive_reference'],
    [24 * H, 'consecutive_reference'],
    [48 * H, 'consecutive_reference'],
    [72 * H, 'qualifying_rest'],
  ])
})
