import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildDailyRestChain } from '../src/analysis/dailyRestChain.ts'
import {
  acceptCrewBreakConfirmation,
  assessDrivingBreaks,
  type BreakActivity,
  type CrewBreakConfirmation,
} from '../src/analysis/drivingBreaks.ts'
import { DAILY_WINDOW_MS, intersectRestWithDailyWindow } from '../src/analysis/restWindowIntersection.ts'
import { CREW_WINDOW_MS, type CrewIntervalConfirmation } from '../src/analysis/crewDailyRest.ts'
import { classifyRestCandidates, type RestCandidate } from '../src/analysis/restCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import { buildComplianceReview, groupCrewVerification, retainCrewConfirmations } from '../src/components/complianceReview.ts'
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

function confirm(activity: BreakActivity): CrewBreakConfirmation {
  const accepted = acceptCrewBreakConfirmation(
    { startUtc: activity.startUtc, endUtc: activity.endUtc, sourceActivityIds: [activity.id] },
    { secondDriverDrove: true, didNotAssist: true },
  )
  assert.ok(accepted)
  return accepted
}

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

test('potvrzená pohotovost 45 minut uzavře přestávku a nepotvrzená nechá nejistotu', () => {
  const activities = [
    breakActivity('drive-1', 'driving', START, START + 4 * HOUR, true),
    breakActivity('wait', 'availability', START + 4 * HOUR, START + 4 * HOUR + 45 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 5 * HOUR, START + 6 * HOUR, true),
  ]
  const snapshot = structuredClone(activities)
  const open = assessDrivingBreaks(activities)
  const closed = assessDrivingBreaks(activities, [confirm(activities[1]!)])
  const restored = assessDrivingBreaks(activities)
  assert.equal(open[0]?.status, 'crew_break_unconfirmed')
  assert.equal(open[0]?.evidence, 'tachograph')
  assert.equal(closed[0]?.status, 'within_limit')
  assert.equal(closed[0]?.evidence, 'manual_crew_confirmation')
  assert.equal(closed[0]?.qualifyingBreak?.kind, 'continuous_45')
  assert.equal(restored[0]?.status, 'crew_break_unconfirmed')
  assert.deepEqual(activities, snapshot)
})

test('potvrzené intervaly 15 a 30 minut platí jen ve správném pořadí', () => {
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
  const closed = assessDrivingBreaks(ordered, [confirm(ordered[1]!), confirm(ordered[3]!)])
  const wrongOrder = assessDrivingBreaks(reversed, [confirm(reversed[1]!), confirm(reversed[3]!)])
  assert.equal(closed[0]?.status, 'within_limit')
  assert.equal(closed[0]?.qualifyingBreak?.kind, 'split_15_30')
  assert.equal(closed[0]?.evidence, 'manual_crew_confirmation')
  assert.notEqual(wrongOrder[0]?.status, 'within_limit')
  assert.notEqual(wrongOrder[0]?.qualifyingBreak?.kind, 'split_15_30')
})

test('potvrzení neplatí pro řízení, práci ani neznámý interval a bez obou podmínek se neuloží', () => {
  const activities = [
    breakActivity('drive-1', 'driving', START, START + 4 * HOUR, true),
    breakActivity('wait', 'availability', START + 4 * HOUR, START + 4 * HOUR + 45 * MINUTE, true),
    breakActivity('drive-2', 'driving', START + 5 * HOUR, START + 6 * HOUR, true),
  ]
  const asInterval = (activity: BreakActivity) => ({
    startUtc: activity.startUtc,
    endUtc: activity.endUtc,
    sourceActivityIds: [activity.id],
  })
  const driving = acceptCrewBreakConfirmation(asInterval(activities[0]!), { secondDriverDrove: true, didNotAssist: true })
  const work = acceptCrewBreakConfirmation(
    asInterval(breakActivity('help', 'work', START + 4 * HOUR, START + 4 * HOUR + 45 * MINUTE, true)),
    { secondDriverDrove: true, didNotAssist: true },
  )
  const unknown = acceptCrewBreakConfirmation(
    asInterval(breakActivity('gap', 'unknown', START + 4 * HOUR, START + 4 * HOUR + 45 * MINUTE, true)),
    { secondDriverDrove: true, didNotAssist: true },
  )
  assert.equal(acceptCrewBreakConfirmation(asInterval(activities[1]!), { secondDriverDrove: true, didNotAssist: false }), null)
  assert.equal(acceptCrewBreakConfirmation(asInterval(activities[1]!), { secondDriverDrove: false, didNotAssist: true }), null)
  assert.ok(driving)
  assert.ok(work)
  assert.ok(unknown)
  const ignored = assessDrivingBreaks(activities, [driving, work, unknown])
  assert.equal(ignored[0]?.status, 'crew_break_unconfirmed')
  assert.equal(ignored[0]?.evidence, 'tachograph')
})

test('potvrzení přestávky nezmění denní okno a nepřežije nové volání', () => {
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
  const before = buildComplianceReview({ activities, nowUtc, clockMode: 'utc', period })
  const confirmation = acceptCrewBreakConfirmation(
    { startUtc: activities[3]!.startUtc, endUtc: activities[3]!.endUtc, sourceActivityIds: [activities[3]!.id] },
    { secondDriverDrove: true, didNotAssist: true },
  )
  assert.ok(confirmation)
  const after = buildComplianceReview({ activities, nowUtc, clockMode: 'utc', period, confirmedCrewBreaks: [confirmation] })
  const again = buildComplianceReview({ activities, nowUtc, clockMode: 'utc', period })
  assert.deepEqual(before.dailyWindowNotes, after.dailyWindowNotes)
  assert.equal(after.findings.some((finding) => finding.title === 'Přestávka uznaná ručním potvrzením'), true)
  assert.equal(after.findings.some((finding) => finding.explanation.includes('Tachograf')), true)
  assert.equal(again.findings.some((finding) => finding.title === 'Přestávka uznaná ručním potvrzením'), false)
  assert.equal(again.findings.some((finding) => finding.id.startsWith('break:')), true)
  assert.equal(after.dailyWindowNotes.some((note) => note.includes('30 h')), true)
  const view = readFileSync(new URL('../src/components/ComplianceReviewView.tsx', import.meta.url), 'utf8')
  assert.equal(view.includes('localStorage'), false)
  assert.equal(view.includes('useState<CrewBreakConfirmation[]>'), true)
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

test('potvrzení nejistých úseků otevře jen 30hodinové okno a přestávku nechá', () => {
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
    const open = buildComplianceReview({ activities: sample.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } })
    const finding = open.findings.find((item) => item.id === `daily-window:${sample.anchor}`)
    assert.ok(finding?.crewWindowConfirmation)
    assert.equal(finding.crewWindowConfirmation.confirmed, false)
    assert.deepEqual(
      finding.crewWindowConfirmation.intervals.map((interval) => interval.intervalText),
      sample.prague,
    )
    assert.equal(finding.technicalText.includes('single_driver_24h'), true)
    const confirmations: CrewIntervalConfirmation[] = finding.crewWindowConfirmation.intervals.map((interval) => ({
      windowStartUtc: sample.anchor,
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
    }))
    const partialReview = buildComplianceReview({
      activities: sample.activities,
      nowUtc,
      clockMode: 'utc',
      period: { mode: 'history' },
      confirmedCrewWindows: [confirmations[0]!],
    })
    assert.equal(partialReview.findings.find((item) => item.id === finding.id)?.technicalText.includes('single_driver_24h'), true)
    assert.equal(groupCrewVerification(partialReview.findings, [confirmations[0]!, confirmations[0]!])[0]?.days[0]?.status, 'částečně potvrzeno')
    const checked = buildComplianceReview({
      activities: sample.activities,
      nowUtc,
      clockMode: 'utc',
      period: { mode: 'history' },
      confirmedCrewWindows: confirmations,
    })
    const accepted = checked.findings.find((item) => item.id === finding.id)
    assert.equal(accepted?.crewWindowConfirmation?.confirmed, true)
    assert.equal(accepted?.technicalText.includes('window crew_30h'), true)
    assert.equal(accepted?.technicalText.includes('crew basis confirmed'), true)
    assert.equal(accepted?.technicalText.includes('manual_crew_confirmation'), false)
    assert.equal(accepted?.explanation.includes('na základě potvrzení uživatele'), true)
    assert.equal(checked.dailyWindowNotes.some((note) => note.includes('na základě potvrzení uživatele')), true)
    assert.equal(checked.dailyWindowNotes.some((note) => note.includes('Záznam osádky pokrývá pracovní úsek')), false)
    const chain = chainFrom(sample.activities, confirmations)
    assert.equal(chain.nodes[0]?.windowMode, 'crew_30h')
    assert.equal(chain.nodes[0]?.crewBasis, 'confirmed')
    assert.equal(chain.nodes[0]?.crewRecord, 'crew_record_uncertain')
    assert.equal(chain.nodes[0]?.interpretations[0]?.nextAnchorUtc, sample.restStart + 12 * HOUR)
    assert.equal(chain.nodes[1]?.windowStartUtc, sample.restStart + 12 * HOUR)
    const unchecked = buildComplianceReview({ activities: sample.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } })
    const restored = unchecked.findings.find((item) => item.id === finding.id)
    assert.equal(restored?.crewWindowConfirmation?.confirmed, false)
    assert.equal(restored?.technicalText.includes('single_driver_24h'), true)
    assert.equal(restored?.explanation.includes('na základě potvrzení uživatele'), false)
    assert.deepEqual(
      open.findings.filter((item) => item.id.startsWith('break:')).map((item) => item.technicalText),
      checked.findings.filter((item) => item.id.startsWith('break:')).map((item) => item.technicalText),
    )
    assert.equal(checked.findings.some((item) => item.technicalText.includes('crew_break_unconfirmed')), true)
    assert.equal(checked.findings.some((item) => item.technicalText.includes('manual_crew_confirmation')), false)
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
  const forged: CrewIntervalConfirmation = {
    windowStartUtc: interruptedAnchor,
    startUtc: interruptedAnchor + 3 * HOUR,
    endUtc: interruptedAnchor + 5 * HOUR,
  }
  const interruptedReview = buildComplianceReview({
    activities: interrupted,
    nowUtc: interruptedRest + 11 * HOUR,
    clockMode: 'utc',
    period: { mode: 'history' },
    confirmedCrewWindows: [forged],
  })
  const interruptedFinding = interruptedReview.findings.find((item) => item.id === `daily-window:${interruptedAnchor}`)
  assert.equal(interruptedFinding?.crewWindowConfirmation, undefined)
  assert.equal(interruptedFinding?.technicalText.includes('single_driver_24h'), true)
  assert.equal(chainFrom(interrupted, [forged]).nodes[0]?.crewBasis, null)

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
  const dailyConfirmation: CrewIntervalConfirmation = {
    windowStartUtc: dailyAnchor,
    startUtc: gap,
    endUtc: gap + MINUTE,
  }
  const kept = chainFrom(dailyActivities, [dailyConfirmation]).nodes[0]!
  assert.equal(kept.windowMode, 'single_driver_24h')
  assert.equal(kept.status, 'evaluated')
  assert.equal(kept.crewBasis, null)
  assert.equal(kept.crewConfirmationAvailable, false)

  const separated = groupCrewVerification(
    [
      buildComplianceReview({ activities: first.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } }).findings.find((item) => item.id.startsWith('daily-window:'))!,
      buildComplianceReview({ activities: second.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } }).findings.find((item) => item.id.startsWith('daily-window:'))!,
    ],
    [],
  )
  assert.deepEqual(separated.map((week) => week.rangeText), ['22. 09. 2025 – 28. 09. 2025', '29. 09. 2025 – 05. 10. 2025'])
  assert.equal(separated[0]?.windowsToVerify, 1)
  assert.equal(separated[0]?.confirmedDays, 0)
  const stale = retainCrewConfirmations(
    [
      { windowStartUtc: first.anchor, startUtc: 1, endUtc: 2 },
      { windowStartUtc: first.anchor, startUtc: separated[0]!.days[0]!.intervals[0]!.startUtc, endUtc: separated[0]!.days[0]!.intervals[0]!.endUtc },
      { windowStartUtc: first.anchor, startUtc: separated[0]!.days[0]!.intervals[0]!.startUtc, endUtc: separated[0]!.days[0]!.intervals[0]!.endUtc },
    ],
    [buildComplianceReview({ activities: first.activities, nowUtc, clockMode: 'utc', period: { mode: 'history' } }).findings.find((item) => item.id.startsWith('daily-window:'))!],
  )
  assert.equal(stale.length, 1)
  const view = readFileSync(new URL('../src/components/ComplianceReviewView.tsx', import.meta.url), 'utf8')
  assert.equal(view.includes('localStorage'), false)
  assert.equal(view.includes('IndexedDB'), false)
  assert.equal(view.includes('useState<CrewIntervalConfirmation[]>'), true)
  assert.equal(view.includes('Ověření režimu osádky'), true)
  assert.equal(view.includes('Potvrdit celý týden'), true)
  assert.equal(view.includes('Zrušit potvrzení týdne'), true)
  assert.equal(view.includes('Potvrdit den'), true)
  assert.equal(view.includes('Zrušit potvrzení dne'), true)
  assert.equal(view.includes('Potvrzuji, že druhý řidič byl během uvedených intervalů přítomen.'), false)
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

function chainFrom(activities: readonly Activity[], confirmations: readonly CrewIntervalConfirmation[]) {
  const positive = activities.filter((activity) => activity.endUtc > activity.startUtc)
  const candidates = classifyRestCandidates(findRestIntervals(positive))
  const anchor = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= 11 * HOUR)
    .sort((left, right) => left.endUtc - right.endUtc)[0]!.endUtc
  return buildDailyRestChain(anchor, candidates, [], positive.at(-1)!.endUtc, activities, confirmations)
}
