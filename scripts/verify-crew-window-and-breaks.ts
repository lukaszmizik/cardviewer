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
import { CREW_WINDOW_MS } from '../src/analysis/crewDailyRest.ts'
import type { RestCandidate } from '../src/analysis/restCandidates.ts'
import { buildComplianceReview } from '../src/components/complianceReview.ts'
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
