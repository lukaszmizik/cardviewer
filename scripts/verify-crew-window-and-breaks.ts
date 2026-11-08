import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDailyRestChain } from '../src/analysis/dailyRestChain.ts'
import { assessDrivingBreaks, type BreakActivity } from '../src/analysis/drivingBreaks.ts'
import { DAILY_WINDOW_MS, intersectRestWithDailyWindow } from '../src/analysis/restWindowIntersection.ts'
import { CREW_WINDOW_MS } from '../src/analysis/crewDailyRest.ts'
import { classifyRestCandidates, type RestCandidate } from '../src/analysis/restCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import { buildComplianceDiagnostic, buildComplianceReview } from '../src/components/complianceReview.ts'
import type { Activity } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const ANCHOR = Date.parse('2024-10-23T19:15:00.000Z')
const REST_START = Date.parse('2024-10-24T11:57:00.000Z')
const REST_END = Date.parse('2024-10-25T09:36:00.000Z')
const START = Date.parse('2026-06-01T06:00:00.000Z')

function candidate(startUtc: number, endUtc: number, overrides: Partial<RestCandidate> = {}): RestCandidate {
  const durationMs = endUtc - startUtc
  return {
    startUtc,
    endUtc,
    durationMs,
    durationMinutes: Math.round(durationMs / 60_000),
    slot: 1,
    sourceActivityIds: ['rest'],
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    overlappingNonRestKinds: [],
    kinds: [],
    ...overrides,
  }
}

function crewActivity(id: string, kind: Activity['kind'], startUtc: number, endUtc: number, isCrew: boolean): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
    isCrew,
    slot: 1,
  }
}

function breakActivity(id: string, kind: BreakActivity['kind'], startUtc: number, endUtc: number, isCrew = false): BreakActivity {
  return { id, kind, startUtc, endUtc, isCrew }
}

const CREW_BREAK_WARNING = 'Přestávka je uznatelná za předpokladu, že vozidlo řídil druhý řidič a odpočívající řidič mu během této doby nepomáhal při řízení.'

test('24hodinové okno jednoho řidiče zůstává beze změny', () => {
  const rest = candidate(REST_START, REST_END, { sourceActivityIds: ['act-167', 'act-168', 'act-169'], ambiguous: true, established: false })
  const plain = buildDailyRestChain(ANCHOR, [rest], [], REST_END, [
    crewActivity('drive', 'driving', ANCHOR, REST_START, false),
    crewActivity('rest', 'rest', REST_START, REST_END, false),
  ])
  const node = plain.nodes[0]!
  const inside = intersectRestWithDailyWindow(rest, ANCHOR, DAILY_WINDOW_MS)
  assert.equal(node.windowMode, 'single_driver_24h')
  assert.equal(node.windowEndUtc - node.windowStartUtc, DAILY_WINDOW_MS)
  assert.equal(node.status, 'window_unsatisfied')
  assert.equal(inside.restMinutesInsideWindow, 438)
  assert.equal(node.interpretations[0]?.qualifiesWindow, false)
  assert.equal(node.interpretations[0]?.nextAnchorEstablished, false)
})

test('říjnový odpočinek má v 30hodinovém okně 798 minut a nejednoznačnost slotu zůstává', () => {
  const rest = candidate(REST_START, REST_END, {
    sourceActivityIds: ['act-167', 'act-168', 'act-169'],
    ambiguous: true,
    established: false,
    uncertainties: ['overlaps_rest_in_other_slot'],
  })
  const activities = [
    crewActivity('first-hour', 'driving', ANCHOR, ANCHOR + HOUR, false),
    crewActivity('crew-drive', 'driving', ANCHOR + HOUR, REST_START, true),
    crewActivity('rest', 'rest', REST_START, REST_END, true),
  ]
  const chain = buildDailyRestChain(ANCHOR, [rest], [], REST_END, activities)
  const node = chain.nodes[0]!
  const inside24 = intersectRestWithDailyWindow(rest, ANCHOR, DAILY_WINDOW_MS)
  const inside30 = intersectRestWithDailyWindow(rest, ANCHOR, CREW_WINDOW_MS)
  const interpretation = node.interpretations[0]!
  assert.equal(inside24.restMinutesInsideWindow, 438)
  assert.equal(inside30.restMinutesInsideWindow, 798)
  assert.equal(node.crewBasis, 'recorded')
  assert.equal(node.windowMode, 'crew_30h')
  assert.equal(node.windowEndUtc - node.windowStartUtc, CREW_WINDOW_MS)
  assert.equal(node.status, 'evaluated')
  assert.equal(interpretation.qualifiesWindow, true)
  assert.equal(interpretation.established, false)
  assert.equal(interpretation.parts[0]?.restMinutesInsideWindow, 798)
  assert.equal(interpretation.nextAnchorUtc, REST_END)
  assert.equal(interpretation.nextAnchorEstablished, false)
  assert.equal(chain.nodes[1]?.anchorEstablished, false)
  assert.equal(rest.ambiguous, true)
})

test('neúplný nebo přerušený záznam osádky 30hodinové okno neotevře', () => {
  const rest = candidate(REST_START, REST_END)
  const singleFlag = buildDailyRestChain(ANCHOR, [rest], [], REST_END, [
    crewActivity('plain', 'driving', ANCHOR, REST_START - 10 * MINUTE, false),
    crewActivity('blip', 'driving', REST_START - 10 * MINUTE, REST_START, true),
    crewActivity('rest', 'rest', REST_START, REST_END, false),
  ])
  const unknown = buildDailyRestChain(ANCHOR, [rest], [{ startUtc: ANCHOR + 2 * HOUR, endUtc: ANCHOR + 3 * HOUR }], REST_END, [
    crewActivity('crew', 'driving', ANCHOR, REST_START, true),
    crewActivity('gap', 'unknown', ANCHOR + 2 * HOUR, ANCHOR + 3 * HOUR, false),
    crewActivity('rest', 'rest', REST_START, REST_END, true),
  ])
  assert.equal(singleFlag.nodes[0]?.windowMode, 'single_driver_24h')
  assert.equal(singleFlag.nodes[0]?.status, 'window_unsatisfied')
  assert.equal(singleFlag.nodes[0]?.interpretations[0]?.qualifiesWindow, false)
  assert.equal(unknown.nodes[0]?.windowMode, 'single_driver_24h')
  assert.notEqual(unknown.nodes[0]?.status, 'evaluated')
})

test('pohotovost 45 minut v osádce je podmíněně uznaná a data nemění', () => {
  const activities = [
    breakActivity('drive-1', 'driving', START, START + 4 * HOUR, true),
    breakActivity('wait', 'availability', START + 4 * HOUR, START + 4 * HOUR + 45 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 5 * HOUR, START + 6 * HOUR, true),
  ]
  const snapshot = structuredClone(activities)
  const periods = assessDrivingBreaks(activities)
  const conditional = periods.find((period) => period.status === 'crew_break_conditional')
  assert.equal(conditional?.evidence, 'crew_availability_assumption')
  assert.equal(conditional?.qualifyingBreak?.kind, 'continuous_45')
  assert.equal(periods.some((period) => period.status === 'exceeded'), false)
  assert.equal(periods.some((period) => period.status === 'within_limit' && period.evidence === 'crew_availability_assumption'), false)
  assert.deepEqual(activities, snapshot)
})

test('intervaly 15 a 30 minut platí jen ve správném pořadí a zůstávají podmíněné', () => {
  const ordered = [
    breakActivity('drive-1', 'driving', START, START + 2 * HOUR, true),
    breakActivity('first', 'availability', START + 2 * HOUR, START + 2 * HOUR + 15 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 3 * HOUR, START + 5 * HOUR, true),
    breakActivity('second', 'availability', START + 5 * HOUR, START + 5 * HOUR + 30 * MINUTE, true),
    breakActivity('drive-3', 'driving', START + 6 * HOUR, START + 7 * HOUR, true),
  ]
  const reversed = [
    breakActivity('drive-1', 'driving', START, START + 2 * HOUR, true),
    breakActivity('second', 'availability', START + 2 * HOUR, START + 2 * HOUR + 30 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 3 * HOUR, START + 5 * HOUR, true),
    breakActivity('first', 'availability', START + 5 * HOUR, START + 5 * HOUR + 15 * MINUTE, true),
    breakActivity('drive-3', 'driving', START + 6 * HOUR, START + 7 * HOUR, true),
  ]
  const closed = assessDrivingBreaks(ordered)
  const wrongOrder = assessDrivingBreaks(reversed)
  assert.equal(closed[0]?.status, 'crew_break_conditional')
  assert.equal(closed[0]?.qualifyingBreak?.kind, 'split_15_30')
  assert.equal(closed[0]?.evidence, 'crew_availability_assumption')
  assert.equal(wrongOrder[0]?.status, 'exceeded')
  assert.equal(wrongOrder[0]?.qualifyingBreak, null)
})

test('krátká pohotovost, řízení, práce ani neznámý úsek podmíněné uznání neobejdou', () => {
  const short = assessDrivingBreaks([
    breakActivity('drive-1', 'driving', START, START + 4 * HOUR + 30 * MINUTE, true),
    breakActivity('wait', 'availability', START + 4 * HOUR + 30 * MINUTE, START + 4 * HOUR + 50 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 5 * HOUR, START + 6 * HOUR, true),
  ])
  const splitByWork = assessDrivingBreaks([
    breakActivity('drive-1', 'driving', START, START + 4 * HOUR + 30 * MINUTE, true),
    breakActivity('wait-1', 'availability', START + 4 * HOUR + 30 * MINUTE, START + 4 * HOUR + 52 * MINUTE, true),
    breakActivity('help', 'work', START + 4 * HOUR + 52 * MINUTE, START + 4 * HOUR + 53 * MINUTE, true),
    breakActivity('wait-2', 'availability', START + 4 * HOUR + 53 * MINUTE, START + 5 * HOUR + 20 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 5 * HOUR + 20 * MINUTE, START + 6 * HOUR, true),
  ])
  const unknown = assessDrivingBreaks([
    breakActivity('drive-1', 'driving', START, START + 4 * HOUR, true),
    breakActivity('gap', 'unknown', START + 4 * HOUR, START + 5 * HOUR, true),
    breakActivity('drive-2', 'driving', START + 5 * HOUR, START + 6 * HOUR, true),
  ])
  assert.equal(short[0]?.status, 'exceeded')
  assert.equal(splitByWork[0]?.status, 'exceeded')
  assert.equal(unknown[0]?.status, 'insufficient_data')
  assert.equal(short.some((period) => period.status === 'crew_break_conditional'), false)
  assert.equal(splitByWork.some((period) => period.status === 'crew_break_conditional'), false)
  assert.equal(unknown.some((period) => period.status === 'crew_break_conditional'), false)
})

test('podmíněná přestávka nemění prokázané denní okno a neukládá se', () => {
  const activities = [
    crewActivity('opening', 'rest', ANCHOR - 12 * HOUR, ANCHOR, false),
    crewActivity('first-hour', 'driving', ANCHOR, ANCHOR + HOUR, false),
    crewActivity('crew-drive', 'driving', ANCHOR + HOUR, ANCHOR + 4 * HOUR, true),
    crewActivity('wait', 'availability', ANCHOR + 4 * HOUR, ANCHOR + 4 * HOUR + 45 * MINUTE, true),
    crewActivity('after', 'driving', ANCHOR + 4 * HOUR + 45 * MINUTE, REST_START, true),
    crewActivity('rest', 'rest', REST_START, REST_END, true),
  ]
  const nowUtc = Date.parse('2024-10-26T00:00:00.000Z')
  const period = { mode: 'history' as const }
  const review = buildComplianceReview({ activities, nowUtc, clockMode: 'utc', period })
  const again = buildComplianceReview({ activities, nowUtc, clockMode: 'utc', period })
  const breakFinding = review.findings.find((finding) => finding.technicalText.includes('status crew_break_conditional'))
  assert.deepEqual(review.dailyWindowNotes, again.dailyWindowNotes)
  assert.equal(breakFinding?.explanation, CREW_BREAK_WARNING)
  assert.equal(breakFinding?.severity, 'uncertain')
  assert.equal(review.findings.some((finding) => finding.title === 'Přestávka uznaná ručním potvrzením'), false)
  assert.equal(review.dailyWindowNotes.some((note) => note.includes('Záznam osádky pokrývá pracovní úsek')), true)
  assert.equal(review.dailyWindowNotes.some((note) => note.includes('Podmíněně uznáno')), false)
  assert.equal(review.findings.some((finding) => finding.severity === 'violation' && finding.technicalText.includes('crew_break_conditional')), false)
  assert.equal(review.findings.some((finding) => finding.severity === 'violation' && finding.technicalText.includes('status exceeded')), true)
  const view = readFileSync(new URL('../src/components/ComplianceReviewView.tsx', import.meta.url), 'utf8')
  assert.equal(view.includes('localStorage'), false)
  assert.equal(view.includes('IndexedDB'), false)
  assert.equal(view.includes('useState<CrewBreakConfirmation[]>'), false)
  assert.equal(view.includes('useState<CrewIntervalConfirmation[]>'), false)
  assert.equal(view.includes('Ověření režimu osádky'), false)
  assert.equal(view.includes('Potvrdit'), false)
})

test('kontrola přestupků u okna bez osádky uvádí 24 hodin', () => {
  const activities = [
    crewActivity('opening', 'rest', ANCHOR - 12 * HOUR, ANCHOR, false),
    crewActivity('drive', 'driving', ANCHOR, REST_START, false),
    crewActivity('rest', 'rest', REST_START, REST_END, false),
  ]
  const review = buildComplianceReview({
    activities,
    nowUtc: Date.parse('2024-10-26T00:00:00.000Z'),
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  const finding = review.findings.find((item) => item.id.startsWith('daily-window:'))
  assert.ok(finding)
  assert.match(finding.explanation, /24hodinové okno/)
  assert.match(finding.limitText, /24 h/)
  assert.equal(review.dailyWindowNotes.length, 0)
})

const LATE = Date.parse('2026-04-06T06:00:00.000Z')

function shift(
  id: string,
  kind: Activity['kind'],
  startUtc: number,
  endUtc: number,
  extra: { isCrew?: boolean; slot?: 1 | 2 } = {},
): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
    isCrew: extra.isCrew === true,
    slot: extra.slot ?? 1,
  }
}

function reviewed(activities: Activity[]) {
  return buildComplianceReview({
    activities,
    nowUtc: LATE + 3 * 24 * HOUR,
    clockMode: 'utc',
    period: { mode: 'history' },
  })
}

test('pozdní osádka s platným 24hodinovým odpočinkem není přestupek', () => {
  const restEnd = LATE + 22 * HOUR
  const activities = [
    shift('opening', 'rest', LATE - 12 * HOUR, LATE),
    shift('solo', 'work', LATE, LATE + 10 * HOUR, { slot: 1 }),
    shift('moved', 'availability', LATE + 10 * HOUR, LATE + 11 * HOUR, { slot: 2, isCrew: true }),
    shift('rest', 'rest', LATE + 11 * HOUR, restEnd, { slot: 2, isCrew: true }),
  ]
  const chain = buildDailyRestChain(LATE, [candidate(LATE + 11 * HOUR, restEnd, { sourceActivityIds: ['rest'], slot: 2 })], [], restEnd, activities)
  const node = chain.nodes[0]!
  assert.equal(node.windowMode, 'single_driver_24h')
  assert.equal(node.status, 'evaluated')
  assert.equal(node.interpretations.some((item) => item.kind === 'continuous_regular' && item.qualifiesWindow), true)
  assert.equal(node.interpretations.find((item) => item.kind === 'continuous_regular')?.reducedDelta, 0)
  assert.equal(node.interpretations.find((item) => item.kind === 'continuous_regular')?.nextAnchorUtc, restEnd)
  assert.equal(reviewed(activities).findings.some((finding) => finding.id.startsWith('daily-window:')), false)

  const covered = [
    shift('solo', 'work', LATE, LATE + 10 * HOUR, { isCrew: true }),
    shift('moved', 'availability', LATE + 10 * HOUR, LATE + 11 * HOUR, { slot: 2, isCrew: true }),
    shift('rest', 'rest', LATE + 11 * HOUR, restEnd, { slot: 2, isCrew: true }),
  ]
  const stillDaily = buildDailyRestChain(LATE, [candidate(LATE + 11 * HOUR, restEnd, { sourceActivityIds: ['rest'], slot: 2 })], [], restEnd, covered)
  assert.equal(stillDaily.nodes[0]?.windowMode, 'single_driver_24h')
  assert.equal(stillDaily.nodes[0]?.status, 'evaluated')
  assert.equal(stillDaily.paths[0]?.reducedCount, 0)
})

test('pozdní osádka bez platného 24hodinového odpočinku neuzná 30 hodin', () => {
  const restStart = LATE + 20 * HOUR
  const restEnd = LATE + 30 * HOUR
  const activities = [
    shift('opening', 'rest', LATE - 12 * HOUR, LATE),
    shift('solo', 'work', LATE, restStart - HOUR, { slot: 1 }),
    shift('moved', 'availability', restStart - HOUR, restStart, { slot: 2, isCrew: true }),
    shift('rest', 'rest', restStart, restEnd, { slot: 2, isCrew: true }),
  ]
  const chain = buildDailyRestChain(LATE, [candidate(restStart, restEnd, { sourceActivityIds: ['rest'], slot: 2 })], [], restEnd, activities)
  const node = chain.nodes[0]!
  assert.equal(node.windowMode, 'single_driver_24h')
  assert.equal(node.status, 'window_unsatisfied')
  assert.equal(node.interpretations.some((item) => item.qualifiesWindow), false)
  const finding = reviewed(activities).findings.find((item) => item.id.startsWith('daily-window:'))
  assert.ok(finding)
  assert.match(finding.technicalText, /single_driver_24h/)
  assert.doesNotMatch(finding.explanation, /Použito 30hodinové okno/)
})

test('řádná osádka s platným 30hodinovým oknem zůstává uznaná', () => {
  const restStart = LATE + 20 * HOUR
  const restEnd = LATE + 30 * HOUR
  const activities = [
    shift('opening', 'rest', LATE - 12 * HOUR, LATE),
    shift('first', 'work', LATE, LATE + HOUR),
    shift('crew', 'work', LATE + HOUR, restStart, { isCrew: true }),
    shift('rest', 'rest', restStart, restEnd, { isCrew: true }),
  ]
  const chain = buildDailyRestChain(LATE, [candidate(restStart, restEnd, { sourceActivityIds: ['rest'] })], [], restEnd, activities)
  const node = chain.nodes[0]!
  const interpretation = node.interpretations.find((item) => item.qualifiesWindow)
  assert.equal(node.windowMode, 'crew_30h')
  assert.equal(node.windowEndUtc - node.windowStartUtc, CREW_WINDOW_MS)
  assert.equal(node.status, 'evaluated')
  assert.equal(interpretation?.kind, 'continuous_reduced')
  assert.equal(interpretation?.reducedDelta, 1)
  assert.equal(interpretation?.nextAnchorUtc, restEnd)
  assert.equal(chain.paths.some((path) => path.reducedCount === 1), true)
  assert.equal(reviewed(activities).dailyWindowNotes.some((note) => note.includes('30 h')), true)
})

test('samostatný řidič s platným 24hodinovým odpočinkem zůstává beze změny', () => {
  const restEnd = LATE + 19 * HOUR
  const activities = [
    shift('opening', 'rest', LATE - 12 * HOUR, LATE),
    shift('solo', 'work', LATE, LATE + 8 * HOUR),
    shift('rest', 'rest', LATE + 8 * HOUR, restEnd),
  ]
  const chain = buildDailyRestChain(LATE, [candidate(LATE + 8 * HOUR, restEnd, { sourceActivityIds: ['rest'] })], [], restEnd, activities)
  const node = chain.nodes[0]!
  assert.equal(node.windowMode, 'single_driver_24h')
  assert.equal(node.windowEndUtc - node.windowStartUtc, DAILY_WINDOW_MS)
  assert.equal(node.status, 'evaluated')
  assert.deepEqual(node.interpretations.map((item) => item.kind), ['continuous_regular'])
  assert.equal(node.interpretations[0]?.reducedDelta, 0)
  assert.equal(node.interpretations[0]?.nextAnchorUtc, restEnd)
  assert.equal(chain.paths[0]?.reducedCount, 0)
  assert.equal(chain.paths[0]?.weeklyBoundariesDetermined, false)
  assert.equal(reviewed(activities).findings.some((finding) => finding.id.startsWith('daily-window:')), false)
})

test('nejistá výměna karet otevře 30hodinové okno podmíněně a přestávku posoudí samostatně', () => {
  const first = septemberWindow({
    anchor: Date.parse('2025-09-22T17:31:00.000Z'),
    manualStart: Date.parse('2025-09-22T21:38:00.000Z'),
    manualMinutes: 1,
    swap: Date.parse('2025-09-23T09:49:00.000Z'),
    restStart: Date.parse('2025-09-23T13:48:00.000Z'),
  })
  const second = septemberWindow({
    anchor: Date.parse('2025-09-30T07:14:00.000Z'),
    manualStart: Date.parse('2025-09-30T11:33:00.000Z'),
    manualMinutes: 5,
    swap: Date.parse('2025-09-30T23:41:00.000Z'),
    restStart: Date.parse('2025-10-01T03:11:00.000Z'),
  })
  const nowUtc = Date.parse('2025-10-05T12:00:00.000Z')
  for (const sample of [first, second]) {
    const snapshot = structuredClone(sample.activities)
    const review = buildComplianceReview({ activities: sample.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } })
    const finding = review.findings.find((item) => item.id === `daily-window:${sample.anchor}`)
    assert.equal(finding?.actualText, 'Podmíněně uznáno')
    assert.equal(finding?.severity, 'uncertain')
    assert.equal(finding?.technicalText.includes('window crew_30h'), true)
    assert.equal(finding?.technicalText.includes('crew basis conditional'), true)
    assert.equal(finding?.technicalText.includes('status within_limit'), false)
    for (const text of sample.prague) assert.equal(finding?.explanation.includes(text), true)
    assert.equal(review.dailyWindowNotes.some((note) => note.includes('Podmíněně uznáno')), true)
    assert.equal(review.dailyWindowNotes.some((note) => note.includes('Záznam osádky pokrývá pracovní úsek')), false)
    assert.equal(review.violationCount, review.findings.filter((item) => item.severity === 'violation').length)
    assert.equal(review.findings.some((item) => item.severity === 'violation' && item.id.startsWith('daily-window:')), false)
    const breakFinding = review.findings.find((item) => item.technicalText.includes('status crew_break_conditional'))
    assert.equal(breakFinding?.explanation, CREW_BREAK_WARNING)
    assert.equal(breakFinding?.severity, 'uncertain')
    assert.equal(finding?.explanation.includes(CREW_BREAK_WARNING), false)
    const chain = chainFrom(sample.activities)
    assert.equal(chain.nodes[0]?.windowMode, 'crew_30h')
    assert.equal(chain.nodes[0]?.crewBasis, 'conditional')
    assert.equal(chain.nodes[0]?.crewRecord, 'crew_record_uncertain')
    assert.equal(chain.nodes[0]?.crewRefusal, null)
    assert.equal(chain.nodes[0]?.uncertainIntervals.length > 0, true)
    assert.equal(chain.nodes[0]?.interpretations[0]?.nextAnchorUtc, sample.restStart + 12 * HOUR)
    assert.equal(chain.nodes[1]?.windowStartUtc, sample.restStart + 12 * HOUR)
    assert.equal(chain.nodes[1]?.windowStartUtc === chain.nodes[0]?.windowStartUtc, false)
    const diagnostic = buildComplianceDiagnostic({ activities: sample.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } })
    const exported = diagnostic.evaluation.findings.find((item) => item.id === finding?.id)
    assert.equal(exported?.technicalText.includes('crew basis conditional'), true)
    assert.equal(exported?.severity, 'uncertain')
    const day = diagnostic.evaluation.days.find((item) => item.dayStartUtc === finding?.mapDayUtc)
    assert.equal(day?.severity, 'uncertain')
    assert.notEqual(day?.severity, 'violation')
    assert.deepEqual(sample.activities, snapshot)
  }

  const interruptedAnchor = Date.parse('2025-11-02T06:00:00.000Z')
  const interruptedRest = interruptedAnchor + 20 * HOUR
  const interrupted = [
    card('open', 'rest', interruptedAnchor - 12 * HOUR, interruptedAnchor, false),
    card('crew', 'driving', interruptedAnchor, interruptedAnchor + 3 * HOUR, true),
    card('solo', 'driving', interruptedAnchor + 3 * HOUR, interruptedAnchor + 5 * HOUR, false),
    card('again', 'driving', interruptedAnchor + 5 * HOUR, interruptedRest, true),
    card('rest', 'rest', interruptedRest, interruptedRest + 10 * HOUR, true),
  ]
  const interruptedReview = buildComplianceReview({
    activities: interrupted,
    nowUtc: interruptedRest + 11 * HOUR,
    clockMode: 'utc',
    period: { mode: 'history' },
  })
  const interruptedFinding = interruptedReview.findings.find((item) => item.id === `daily-window:${interruptedAnchor}`)
  assert.equal(interruptedFinding?.actualText, 'Odpočinek v okně není prokázaný')
  assert.equal(interruptedFinding?.technicalText.includes('single_driver_24h'), true)
  assert.equal(interruptedFinding?.technicalText.includes('crew basis conditional'), false)
  assert.match(interruptedFinding?.explanation ?? '', /řízení nebo práce bez příznaku osádky/)
  assert.equal(chainFrom(interrupted).nodes[0]?.crewBasis, null)
  assert.equal(chainFrom(interrupted).nodes[0]?.windowMode, 'single_driver_24h')

  const dailyAnchor = Date.parse('2026-05-01T06:00:00.000Z')
  const gap = dailyAnchor + 4 * HOUR
  const dailyRest = dailyAnchor + 8 * HOUR
  const dailyActivities = [
    card('open', 'rest', dailyAnchor - 12 * HOUR, dailyAnchor, false),
    card('before', 'driving', dailyAnchor, gap, true),
    card('manual', 'rest', gap, gap + MINUTE, false, true),
    card('after', 'driving', gap + MINUTE, dailyRest, true),
    card('rest', 'rest', dailyRest, dailyRest + 11 * HOUR, false),
  ]
  const kept = chainFrom(dailyActivities).nodes[0]!
  assert.equal(kept.windowMode, 'single_driver_24h')
  assert.equal(kept.status, 'evaluated')
  assert.equal(kept.crewBasis, null)
  assert.equal(kept.crewRefusal, null)

  const view = readFileSync(new URL('../src/components/ComplianceReviewView.tsx', import.meta.url), 'utf8')
  assert.equal(view.includes('localStorage'), false)
  assert.equal(view.includes('IndexedDB'), false)
  assert.equal(view.includes('useState<CrewIntervalConfirmation[]>'), false)
  assert.equal(view.includes('Ověření režimu osádky'), false)
  assert.equal(view.includes('Potvrdit'), false)
  assert.equal(view.includes('Přestávky v režimu osádky'), false)
})

function card(id: string, kind: Activity['kind'], startUtc: number, endUtc: number, isCrew: boolean, isManualEntry = false, slot: 1 | 2 = 1): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
    isCrew,
    isManualEntry,
    slot,
  }
}

function septemberWindow(input: {
  anchor: number
  manualStart: number
  manualMinutes: number
  swap: number
  restStart: number
}) {
  const { anchor, manualStart, manualMinutes, swap, restStart } = input
  return {
    anchor,
    restStart,
    prague: [
      `${prague(manualStart)} – ${prague(manualStart + manualMinutes * MINUTE)} (Europe/Prague)`,
      `${prague(swap)} – ${prague(swap + 2 * MINUTE)} (Europe/Prague)`,
    ],
    activities: [
      card('open', 'rest', anchor - 12 * HOUR, anchor, false),
      card('crew-before', 'driving', anchor, anchor + 2 * HOUR, true),
      card('crew-wait', 'availability', anchor + 2 * HOUR, anchor + 2 * HOUR + 45 * MINUTE, true),
      card('crew-next', 'driving', anchor + 2 * HOUR + 45 * MINUTE, manualStart, true),
      card('manual-gap', 'rest', manualStart, manualStart + manualMinutes * MINUTE, false, true),
      card('crew-slot-2', 'availability', manualStart + manualMinutes * MINUTE, swap, true, false, 2),
      card('leave-slot', 'availability', swap, swap + MINUTE, false, false, 2),
      card('card-mark', 'availability', swap + MINUTE, swap + MINUTE, false, true, 2),
      card('enter-slot', 'work', swap + MINUTE, swap + 2 * MINUTE, false, false, 1),
      card('crew-after', 'driving', swap + 2 * MINUTE, restStart, true),
      card('daily-rest', 'rest', restStart, restStart + 12 * HOUR, false, true),
    ],
  }
}

function prague(ms: number): string {
  const parts = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('day')}. ${pick('month')}. ${pick('year')} ${pick('hour')}:${pick('minute')}`
}

function chainFrom(activities: readonly Activity[]) {
  const positive = activities.filter((activity) => activity.endUtc > activity.startUtc)
  const candidates = classifyRestCandidates(findRestIntervals(positive))
  const anchor = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= 11 * HOUR)
    .sort((left, right) => left.endUtc - right.endUtc)[0]!.endUtc
  return buildDailyRestChain(anchor, candidates, [], positive.at(-1)!.endUtc, activities)
}
