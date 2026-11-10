import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyRestChain } from '../src/analysis/dailyRestChain.ts'
import { assessDrivingBreaks } from '../src/analysis/drivingBreaks.ts'
import { utcWeekStart } from '../src/analysis/dailyDrivingTime.ts'
import { findFerryRestCandidates } from '../src/analysis/ferryRestCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import { classifyRestCandidates } from '../src/analysis/restCandidates.ts'
import { assessReducedDailyRestLimit } from '../src/analysis/reducedDailyRestLimit.ts'
import { classifyWeeklyRestCandidates } from '../src/analysis/weeklyRest.ts'
import {
  activitiesUnderAuthorizedOut,
  activitiesUnderOutHypothesis,
  resolveOutOfScope,
  type OutScopeSegment,
} from '../src/analysis/outOfScopeResolver.ts'
import { assessWeeklyDrivingTime } from '../src/analysis/weeklyDrivingTime.ts'
import { buildComplianceReview } from '../src/components/complianceReview.ts'
import type { Activity, ActivityKind, SpecificConditionEntry } from '../src/types/tacho.ts'

const H = 60 * 60 * 1000
const MIN = 60_000
const DAY = 24 * H
const WEEK = 7 * DAY
const T0 = Date.parse('2026-04-06T00:00:00.000Z')

function act(id: string, kind: ActivityKind, startUtc: number, endUtc: number): Activity {
  return { id, kind, startUtc, endUtc, durationMinutes: (endUtc - startUtc) / MIN, slot: 1 }
}

function mark(kind: 'out' | 'out_end', atUtc: number): SpecificConditionEntry {
  return { kind, atUtc }
}

function resolution(activities: Activity[], conditions: SpecificConditionEntry[]) {
  const recordEndUtc = Math.max(...activities.map((activity) => activity.endUtc))
  return resolveOutOfScope({ activities, specificConditions: conditions, recordEndUtc })
}

function active(segments: readonly OutScopeSegment[]) {
  return segments.filter((segment) => segment.outActive)
}

function review(activities: Activity[], conditions: SpecificConditionEntry[] = []) {
  const endUtc = Math.max(...activities.map((activity) => activity.endUtc))
  return buildComplianceReview({
    activities,
    specificConditions: conditions,
    nowUtc: endUtc + DAY,
    clockMode: 'utc',
    period: { mode: 'history' },
  })
}

function drivingMs(activities: readonly Activity[]): number {
  return activities
    .filter((activity) => activity.kind === 'driving')
    .reduce((sum, activity) => sum + (activity.endUtc - activity.startUtc), 0)
}

test('OUT uprostřed řízení rozdělí aktivitu a zachová součet', () => {
  const start = T0 + 10 * H
  const end = T0 + 12 * H
  const activities = [act('drive', 'driving', start, end)]
  const resolved = resolution(activities, [mark('out', start + 15 * MIN), mark('out_end', start + 60 * MIN)])
  assert.equal(resolved.closedIntervals.length, 1)
  assert.deepEqual(resolved.segments.map((segment) => segment.recordedKind), ['driving', 'driving', 'driving'])
  assert.deepEqual(resolved.segments.map((segment) => segment.outActive), [false, true, false])
  assert.equal(resolved.segments[1]!.authorizedKind, 'work')
  assert.equal(resolved.segments[1]!.unverifiedKind, 'driving')
  assert.equal(resolved.segments.reduce((sum, segment) => sum + (segment.endUtc - segment.startUtc), 0), 2 * H)
  const authorized = activitiesUnderAuthorizedOut(activities, resolved)
  assert.equal(drivingMs(authorized), 75 * MIN)
  assert.equal(authorized.reduce((sum, activity) => sum + (activity.endUtc - activity.startUtc), 0), 2 * H)
})

test('OUT přes půlnoc pokryje jen vnitřek intervalu', () => {
  const start = T0 + 22 * H
  const end = T0 + DAY + 4 * H
  const activities = [act('drive', 'driving', start, end)]
  const resolved = resolution(activities, [mark('out', T0 + 23 * H), mark('out_end', T0 + DAY + 2 * H)])
  const covered = active(resolved.segments)
  assert.equal(covered.length, 1)
  assert.equal(covered[0]!.startUtc, T0 + 23 * H)
  assert.equal(covered[0]!.endUtc, T0 + DAY + 2 * H)
  assert.ok(covered[0]!.startUtc < T0 + DAY && covered[0]!.endUtc > T0 + DAY)
  assert.equal(covered[0]!.authorizedKind, 'work')
  assert.equal(drivingMs(activitiesUnderOutHypothesis(activities, resolved)), 3 * H)
})

test('OUT přes hranici dvou týdnů ubere řízení jen v oprávněné variantě', () => {
  const week = utcWeekStart(T0)
  const crossStart = week + 6 * DAY + 22 * H
  const crossEnd = week + WEEK + 2 * H
  const baseEnd = week + 56 * H
  const activities = [
    act('base', 'driving', week, baseEnd),
    act('cross', 'driving', crossStart, crossEnd),
  ]
  const conditions = [mark('out', crossStart), mark('out_end', crossEnd)]
  const resolved = resolution(activities, conditions)
  assert.equal(active(resolved.segments).length, 1)
  assert.ok(active(resolved.segments)[0]!.startUtc < week + WEEK)
  assert.ok(active(resolved.segments)[0]!.endUtc > week + WEEK)
  const authorized = activitiesUnderAuthorizedOut(activities, resolved)
  const unverified = assessWeeklyDrivingTime({ activities, weekStartUtc: week })
  const withoutOutDriving = assessWeeklyDrivingTime({ activities: authorized, weekStartUtc: week })
  assert.equal(unverified.status, 'over_56h')
  assert.equal(unverified.drivingMs, 58 * H)
  assert.equal(withoutOutDriving.drivingMs, 56 * H)
  assert.notEqual(withoutOutDriving.status, 'over_56h')
  const finding = review(activities, conditions).findings.find((item) => item.id.startsWith('weekly-driving:'))
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(finding?.meterOver, false)
  assert.match(finding?.outLines?.join('\n') ?? '', /Řízení podle záznamu: 58 h/)
  assert.match(finding?.outLines?.join('\n') ?? '', /Při oprávněném OUT: 56 h/)
  assert.match(finding?.outLines?.join('\n') ?? '', /Rozdíl: 2 h/)
  assert.doesNotMatch(finding?.outLines?.join('\n') ?? '', /není potvrzen/)
})

test('chybějící out_end nevytvoří uzavřený interval', () => {
  const activities = [act('drive', 'driving', T0, T0 + 5 * H)]
  const resolved = resolution(activities, [mark('out', T0 + H)])
  assert.equal(resolved.closedIntervals.length, 0)
  assert.deepEqual(resolved.openStarts, [T0 + H])
  assert.equal(active(resolved.segments).length, 0)
  assert.equal(resolved.segments[0]!.uncertainty, null)
  assert.equal(resolved.segments[1]!.uncertainty, 'missing_out_end')
  assert.equal(resolved.segments[1]!.authorizedKind, 'driving')
  assert.equal(resolved.segments[1]!.possibleOut, true)
  assert.equal(resolved.segments[1]!.hypothesisKind, 'work')
  assert.equal(resolved.possibleIntervals.length, 1)
  assert.equal(resolved.possibleIntervals[0]!.endUtc, T0 + 5 * H)
  assert.equal(drivingMs(activitiesUnderAuthorizedOut(activities, resolved)), 5 * H)
  assert.equal(drivingMs(activitiesUnderOutHypothesis(activities, resolved)), H)
  assert.equal(activities[0]!.kind, 'driving')
})

test('osamocené out_end nemá smyšlený začátek', () => {
  const activities = [act('drive', 'driving', T0, T0 + 4 * H)]
  const resolved = resolution(activities, [mark('out_end', T0 + 2 * H)])
  assert.equal(resolved.closedIntervals.length, 0)
  assert.deepEqual(resolved.orphanEnds, [T0 + 2 * H])
  assert.equal(active(resolved.segments).length, 0)
  assert.equal(resolved.segments.some((segment) => segment.uncertainty === 'orphan_out_end'), true)
  assert.equal(resolved.segments.every((segment) => segment.authorizedKind === 'driving'), true)
})

test('opakovaný začátek OUT není jistý interval', () => {
  const activities = [act('drive', 'driving', T0, T0 + 4 * H)]
  const resolved = resolution(activities, [
    mark('out', T0 + H),
    mark('out', T0 + 2 * H),
    mark('out_end', T0 + 3 * H),
  ])
  assert.equal(resolved.closedIntervals.length, 0)
  assert.equal(active(resolved.segments).length, 0)
  assert.equal(resolved.segments.filter((segment) => segment.uncertainty === 'ambiguous_marks').length > 0, true)
  assert.equal(drivingMs(activitiesUnderAuthorizedOut(activities, resolved)), 4 * H)
})

test('OUT během REST, WORK a AVAILABILITY nemění druh', () => {
  const activities = [
    act('rest', 'rest', T0, T0 + 2 * H),
    act('work', 'work', T0 + 2 * H, T0 + 3 * H),
    act('avail', 'availability', T0 + 3 * H, T0 + 4 * H),
  ]
  const resolved = resolution(activities, [mark('out', T0), mark('out_end', T0 + 4 * H)])
  assert.deepEqual(resolved.segments.map((segment) => [segment.recordedKind, segment.authorizedKind, segment.unverifiedKind, segment.outActive]), [
    ['rest', 'rest', 'rest', true],
    ['work', 'work', 'work', true],
    ['availability', 'availability', 'availability', true],
  ])
})

test('2 h + OUT 1 h + 2 h 30 min nenuluje nasčítané řízení', () => {
  const activities = [act('drive', 'driving', T0, T0 + 5.5 * H)]
  const conditions = [mark('out', T0 + 2 * H), mark('out_end', T0 + 3 * H)]
  const resolved = resolution(activities, conditions)
  const authorizedBreaks = assessDrivingBreaks(activitiesUnderAuthorizedOut(activities, resolved))
  const recordedBreaks = assessDrivingBreaks(activities)
  assert.equal(recordedBreaks.length, 1)
  assert.equal(recordedBreaks[0]!.drivingMs, 5.5 * H)
  assert.equal(recordedBreaks[0]!.status, 'exceeded')
  assert.equal(authorizedBreaks.length, 1)
  assert.equal(authorizedBreaks[0]!.drivingMs, 4.5 * H)
  assert.equal(authorizedBreaks[0]!.status, 'within_limit')
  const finding = review(activities, conditions).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.meterOver, false)
  assert.equal(finding?.actualText, '4 h 30 min')
  assert.deepEqual(finding?.outLines, [
    'Řízení podle záznamu: 5 h 30 min',
    'Při oprávněném OUT: 4 h 30 min',
    'Rozdíl: 1 h',
    'Výsledek: Vyžaduje ověření oprávněnosti OUT.',
  ])
  assert.doesNotMatch(finding?.explanation ?? '', /není potvrzen/)
})

test('porušení 4 h 30 min, které vychází při obou interpretacích, zůstane violation', () => {
  const activities = [act('drive', 'driving', T0, T0 + 7 * H)]
  const conditions = [mark('out', T0 + 3 * H), mark('out_end', T0 + 4 * H)]
  const finding = review(activities, conditions).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.severity, 'violation')
  assert.equal(finding?.reviewStatus, undefined)
  assert.equal(finding?.meterOver, true)
  assert.match(finding?.outLines?.join('\n') ?? '', /Rozdíl: 1 h/)
  assert.match(finding?.outLines?.join('\n') ?? '', /Prokázané porušení/)
})

test('denní limit nad 10 h závisí na oprávněnosti OUT', () => {
  const restEnd = T0 + 11 * H
  const driveEnd = restEnd + 10.5 * H
  const activities = [
    act('open', 'rest', T0, restEnd),
    act('drive', 'driving', restEnd, driveEnd),
    act('close', 'rest', driveEnd, driveEnd + 11 * H),
  ]
  const depends = review(activities, [mark('out', restEnd + 2 * H), mark('out_end', restEnd + 3 * H)])
  const daily = depends.findings.find((item) => item.id.startsWith('daily-driving:'))
  assert.equal(daily?.severity, 'uncertain')
  assert.equal(daily?.reviewStatus, 'needs_verification')

  const bothEnd = restEnd + 11 * H
  const both = review([
    act('open', 'rest', T0, restEnd),
    act('drive', 'driving', restEnd, bothEnd),
    act('close', 'rest', bothEnd, bothEnd + 11 * H),
  ], [mark('out', restEnd + H), mark('out_end', restEnd + 1.5 * H)])
  const proven = both.findings.find((item) => item.id.startsWith('daily-driving:'))
  assert.equal(proven?.severity, 'violation')
  assert.equal(proven?.reviewStatus, undefined)
})

test('dvoutýdenní limit nad 90 h závisí na OUT a shodné překročení zůstane violation', () => {
  const week = utcWeekStart(T0)
  const later = week + WEEK
  const activities = [
    act('early', 'driving', week, week + 45 * H),
    act('late', 'driving', later, later + 45 * H),
    act('extra', 'driving', later + 50 * H, later + 51 * H),
  ]
  const depends = review(activities, [mark('out', later + 50 * H), mark('out_end', later + 51 * H)])
  const soft = depends.findings.find((item) => item.id.startsWith('fortnight-driving:'))
  assert.equal(soft?.reviewStatus, 'needs_verification')

  const hard = review([
    act('early', 'driving', week, week + 46 * H),
    act('late', 'driving', later, later + 46 * H),
  ])
  const proven = hard.findings.find((item) => item.id.startsWith('fortnight-driving:'))
  assert.equal(proven?.severity, 'violation')
})

test('OUT řízení není odpočinek a nenuluje počitadlo tří zkrácení', () => {
  const rows: Activity[] = [act('weekly', 'rest', T0, T0 + 45 * H)]
  let cursor = T0 + 45 * H
  for (let index = 0; index < 3; index += 1) {
    rows.push(act(`out-drive-${index}`, 'driving', cursor, cursor + H))
    cursor += H
    rows.push(act(`rest-${index}`, 'rest', cursor, cursor + 9 * H))
    cursor += 9 * H
  }
  const conditions = rows
    .filter((activity) => activity.id.startsWith('out-drive'))
    .flatMap((activity) => [mark('out', activity.startUtc), mark('out_end', activity.endUtc)])
  const resolved = resolution(rows, conditions)
  assert.equal(active(resolved.segments).every((segment) => segment.recordedKind === 'driving' && segment.authorizedKind === 'work'), true)
  const originalRests = findRestIntervals(rows)
  const authorizedRests = findRestIntervals(activitiesUnderAuthorizedOut(rows, resolved))
  assert.deepEqual(authorizedRests.map((interval) => [interval.startUtc, interval.endUtc]), originalRests.map((interval) => [interval.startUtc, interval.endUtc]))
  const asIfRest = findRestIntervals(rows.map((activity) => activity.kind === 'driving' ? { ...activity, kind: 'rest' } : activity))
  assert.equal(asIfRest.length < originalRests.length, true)

  const candidates = classifyRestCandidates(originalRests)
  const recordEndUtc = rows[rows.length - 1]!.endUtc
  const anchor = candidates.find((candidate) => candidate.established && candidate.durationMs >= 45 * H)
  assert.ok(anchor)
  const chain = buildDailyRestChain(anchor.endUtc, candidates, [], recordEndUtc, rows)
  const reduced = assessReducedDailyRestLimit({
    chain,
    weeklyCandidates: classifyWeeklyRestCandidates(candidates),
    unknownIntervals: [],
    ferryCandidates: findFerryRestCandidates({ activities: rows, specificConditions: conditions }),
  }).filter((item) => item.kind === 'reduced_9h')
  assert.deepEqual(reduced.map((item) => item.reductionOrder), [1, 2, 3])
  assert.equal(reduced.every((item) => item.status === 'compliant'), true)
})

test('GN7 u krátkého odpočinku se po přidání OUT na řízení nemění', () => {
  const base = Date.parse('2026-04-20T00:00:00.000Z')
  const activities = [
    act('r0', 'rest', base, base + 11 * H),
    act('w', 'work', base + 11 * H, base + 12 * H),
    act('r8', 'rest', base + 12 * H, base + 20 * H),
    act('d', 'driving', base + 20 * H, base + 47 * H),
  ]
  const plain = buildComplianceReview({
    activities,
    nowUtc: Date.parse('2026-04-27T20:00:00.000Z'),
    clockMode: 'utc',
  }).findings.find((item) => item.id.startsWith('gn7-daily:'))
  const withOut = buildComplianceReview({
    activities,
    nowUtc: Date.parse('2026-04-27T20:00:00.000Z'),
    clockMode: 'utc',
    specificConditions: [mark('out', base + 20 * H), mark('out_end', base + 24 * H)],
  }).findings.find((item) => item.id.startsWith('gn7-daily:'))
  assert.equal(plain?.severity, 'violation')
  assert.equal(withOut?.severity, 'violation')
  assert.equal(withOut?.reviewStatus, 'proven')
  assert.equal(withOut?.methodology, 'gn7')
  assert.equal(withOut?.startUtc, plain?.startUtc)
})

test('stejný úsek bez out_end vyžaduje ověření a označí hypotézu', () => {
  const activities = [act('drive', 'driving', T0, T0 + 5.5 * H)]
  const finding = review(activities, [mark('out', T0 + 2 * H)]).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(finding?.meterOver, false)
  assert.equal(finding?.actualText, '2 h')
  assert.ok((finding?.meterPercent ?? 100) < 100)
  assert.deepEqual(finding?.outLines?.slice(0, 4), [
    'Řízení podle záznamu: 5 h 30 min',
    'Při oprávněném OUT: 2 h',
    'Rozdíl: 3 h 30 min',
    'Výsledek: Vyžaduje ověření oprávněnosti OUT.',
  ])
  assert.match(finding?.outLines?.join('\n') ?? '', /hypotetická/)
  assert.match(finding?.explanation ?? '', /není potvrzen/)
})

test('opakovaný začátek OUT není potvrzený přestupek', () => {
  const activities = [act('drive', 'driving', T0, T0 + 5.5 * H)]
  const finding = review(activities, [
    mark('out', T0 + 2 * H),
    mark('out', T0 + 2.5 * H),
    mark('out_end', T0 + 3 * H),
  ]).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(finding?.severity, 'uncertain')
  assert.match(finding?.outLines?.join('\n') ?? '', /Rozdíl: 1 h/)
  assert.match(finding?.explanation ?? '', /není potvrzen/)
})

test('osamocené out_end nemění prokázané překročení', () => {
  const activities = [act('drive', 'driving', T0, T0 + 5.5 * H)]
  const finding = review(activities, [mark('out_end', T0 + 3 * H)]).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.severity, 'violation')
  assert.equal(finding?.reviewStatus, undefined)
  assert.equal(finding?.outLines, undefined)
  assert.equal(finding?.meterOver, true)
})

test('otevřený OUT s neznámou činností nevytvoří prokázaný přestupek', () => {
  const activities = [
    act('drive', 'driving', T0, T0 + 5 * H),
    act('gap', 'unknown', T0 + 5 * H, T0 + 6 * H),
  ]
  const resolved = resolution(activities, [mark('out', T0 + 2 * H)])
  const hypothesis = activitiesUnderOutHypothesis(activities, resolved)
  assert.equal(hypothesis.some((activity) => activity.kind === 'unknown'), true)
  assert.equal(hypothesis.some((activity) => activity.kind === 'driving' && activity.id !== 'gap'), true)
  const finding = review(activities, [mark('out', T0 + 2 * H)]).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.notEqual(finding?.severity, 'violation')
})

test('otevřený OUT mimo už překročený úsek přestupek nemění', () => {
  const later = T0 + 6 * H + 45 * MIN
  const activities = [
    act('long', 'driving', T0, T0 + 6 * H),
    act('rest', 'rest', T0 + 6 * H, later),
    act('short', 'driving', later, later + 30 * MIN),
  ]
  const breaks = review(activities, [mark('out', later)]).findings.filter((item) => item.id.startsWith('break:'))
  assert.equal(breaks.length, 1)
  assert.equal(breaks[0]!.severity, 'violation')
  assert.equal(breaks[0]!.reviewStatus, undefined)
  assert.equal(breaks[0]!.outLines, undefined)
  assert.equal(breaks[0]!.meterOver, true)
})

test('přestávka 15 a 30 minut zůstane platná, když je mezi nimi řízení v OUT', () => {
  const firstRest = T0 + 4 * H
  const outStart = firstRest + 15 * MIN
  const secondRest = outStart + H
  const activities = [
    act('before', 'driving', T0, firstRest),
    act('quarter', 'rest', firstRest, outStart),
    act('inside', 'driving', outStart, secondRest),
    act('half', 'rest', secondRest, secondRest + 30 * MIN),
  ]
  const conditions = [mark('out', outStart), mark('out_end', secondRest)]
  const resolved = resolution(activities, conditions)
  const hypothesis = assessDrivingBreaks(activitiesUnderOutHypothesis(activities, resolved))
  const recorded = assessDrivingBreaks(activities)
  assert.equal(hypothesis[0]?.qualifyingBreak?.kind, 'split_15_30')
  assert.equal(hypothesis[0]?.drivingMs, 4 * H)
  assert.equal(hypothesis[0]?.status, 'within_limit')
  assert.equal(recorded[0]?.qualifyingBreak?.kind, 'split_15_30')
  assert.equal(recorded[0]?.drivingMs, 5 * H)
  assert.equal(recorded[0]?.status, 'exceeded')
  assert.equal(resolved.segments.find((segment) => segment.sourceActivityId === 'inside')?.hypothesisKind, 'work')
  const finding = review(activities, conditions).findings.find((item) => item.id.startsWith('break:'))
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(finding?.meterOver, false)
})

