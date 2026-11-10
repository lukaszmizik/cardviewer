import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailyRestChain, type DailyRestChain } from '../src/analysis/dailyRestChain.ts'
import { findFerryRestCandidates } from '../src/analysis/ferryRestCandidates.ts'
import { buildGn7ControlPeriods } from '../src/analysis/gn7ControlPeriods.ts'
import { assessReducedDailyRestLimit, type ReducedDailyRestAssessment } from '../src/analysis/reducedDailyRestLimit.ts'
import { classifyRestCandidates } from '../src/analysis/restCandidates.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import { classifyWeeklyRestCandidates } from '../src/analysis/weeklyRest.ts'
import { buildComplianceReview } from '../src/components/complianceReview.ts'
import type { Activity, ActivityKind, SpecificConditionEntry } from '../src/types/tacho.ts'

const H = 60 * 60 * 1000
const MIN = 60_000
const T0 = Date.parse('2026-04-06T00:00:00.000Z')
const NOW = Date.parse('2026-04-27T20:00:00.000Z')

function act(id: string, kind: ActivityKind, startMin: number, endMin: number, extra: Partial<Activity> = {}): Activity {
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

function assess(activities: Activity[], specificConditions: SpecificConditionEntry[] = []): ReducedDailyRestAssessment[] {
  const candidates = classifyRestCandidates(findRestIntervals(activities))
  const unknownIntervals = activities
    .filter((activity) => activity.kind === 'unknown')
    .map((activity) => ({ startUtc: activity.startUtc, endUtc: activity.endUtc }))
  const recordEndUtc = activities.reduce((end, activity) => Math.max(end, activity.endUtc), 0)
  const anchor = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= 11 * H)
    .filter((candidate) => !unknownIntervals.some((interval) => candidate.startUtc < interval.endUtc && interval.startUtc < candidate.endUtc))
    .sort((left, right) => left.endUtc - right.endUtc)[0]
  const chain = anchor == null ? null : buildDailyRestChain(anchor.endUtc, candidates, unknownIntervals, recordEndUtc, activities)
  return assessReducedDailyRestLimit({
    chain,
    weeklyCandidates: classifyWeeklyRestCandidates(candidates),
    unknownIntervals,
    ferryCandidates: findFerryRestCandidates({ activities, specificConditions }),
  })
}

function reduced(rows: readonly ReducedDailyRestAssessment[]) {
  return rows.filter((row) => row.kind === 'reduced_9h')
}

/** Týdenní odpočinek a pak střídání 1 h práce a denního odpočinku daných délek. */
function afterWeekly(weeklyHours: number, dailyHours: number[]): Activity[] {
  const rows: Activity[] = [act('weekly', 'rest', 0, weeklyHours * 60)]
  let cursor = weeklyHours * 60
  dailyHours.forEach((hours, index) => {
    rows.push(act(`work-${index}`, 'work', cursor, cursor + 60))
    cursor += 60
    rows.push(act(`rest-${index}`, 'rest', cursor, cursor + hours * 60))
    cursor += hours * 60
  })
  rows.push(act('tail', 'work', cursor, cursor + 60))
  return rows
}

test('tři zkrácení mezi týdenními odpočinky nejsou porušení', () => {
  const rows = reduced(assess(afterWeekly(45, [9, 9, 9])))
  assert.deepEqual(rows.map((row) => row.reductionOrder), [1, 2, 3])
  assert.equal(rows.every((row) => row.status === 'compliant'), true)
})

test('čtvrté zkrácení je jedno porušení', () => {
  const rows = reduced(assess(afterWeekly(45, [9, 9, 9, 9])))
  assert.deepEqual(rows.map((row) => row.status), ['compliant', 'compliant', 'compliant', 'violation'])
  assert.equal(rows[3]!.reductionOrder, 4)
  assert.match(rows[3]!.reason, /tří zkrácených denních odpočinků/)
  const view = buildComplianceReview({ activities: afterWeekly(45, [9, 9, 9, 9]), nowUtc: NOW, clockMode: 'utc' })
  const findings = view.findings.filter((finding) => finding.id.startsWith('article-8-4:'))
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.severity, 'violation')
  assert.equal(findings[0]!.reviewStatus, 'proven')
  assert.match(findings[0]!.explanation, /Pořadí zkrácení: 4/)
  assert.equal(view.findings.filter((finding) => finding.methodology === 'gn7' && finding.severity === 'violation').length, 0)
})

test('páté zkrácení je další samostatné zjištění', () => {
  const rows = reduced(assess(afterWeekly(45, [9, 9, 9, 9, 9])))
  assert.deepEqual(rows.slice(3).map((row) => [row.reductionOrder, row.status]), [[4, 'violation'], [5, 'violation']])
  const view = buildComplianceReview({ activities: afterWeekly(45, [9, 9, 9, 9, 9]), nowUtc: NOW, clockMode: 'utc' })
  assert.equal(view.findings.filter((finding) => finding.id.startsWith('article-8-4:') && finding.severity === 'violation').length, 2)
})

test('běžný 11h odpočinek mezi zkráceními počitadlo nenuluje', () => {
  const rows = reduced(assess(afterWeekly(45, [9, 11, 9, 9, 9])))
  assert.deepEqual(rows.map((row) => row.reductionOrder), [1, 2, 3, 4])
  assert.equal(rows[3]!.status, 'violation')
})

test('dělený odpočinek 3+9 nezvyšuje počitadlo', () => {
  const rows = assess(afterWeekly(45, [3, 9, 9, 9, 9]))
  assert.equal(rows.some((row) => row.kind === 'split_3_9'), true)
  const counted = reduced(rows)
  assert.deepEqual(counted.map((row) => row.reductionOrder), [1, 2, 3])
  assert.equal(counted.some((row) => row.status === 'violation'), false)
})

test('zkrácený týdenní odpočinek 24 h vrací počet na nulu', () => {
  const rows = assess(afterWeekly(45, [9, 9, 9, 24, 9]))
  const counted = reduced(rows)
  assert.deepEqual(counted.map((row) => row.reductionOrder), [1, 2, 3, 1])
  assert.equal(counted.every((row) => row.status === 'compliant'), true)
  assert.equal(rows.some((row) => row.kind === 'weekly_reduced'), true)
})

test('běžný týdenní odpočinek 45 h vrací počet na nulu', () => {
  const rows = assess(afterWeekly(45, [9, 9, 9, 45, 9]))
  const counted = reduced(rows)
  assert.deepEqual(counted.map((row) => row.reductionOrder), [1, 2, 3, 1])
  assert.equal(rows.some((row) => row.kind === 'weekly_regular'), true)
  assert.equal(counted.every((row) => row.status === 'compliant'), true)
})

test('neúplná historie před prvním zkrácením nedovolí potvrdit výsledek', () => {
  const rows = reduced(assess([
    act('gap', 'unknown', 0, 2 * 60),
    act('regular', 'rest', 2 * 60, 13 * 60),
    act('work', 'work', 13 * 60, 14 * 60),
    act('short', 'rest', 14 * 60, 23 * 60),
    act('tail', 'work', 23 * 60, 24 * 60),
  ]))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.intervalStartKnown, false)
  assert.equal(rows[0]!.status, 'needs_verification')
  assert.equal(rows[0]!.reductionOrder, null)
})

test('osmihodinový odpočinek není využité zkrácení', () => {
  const activities = afterWeekly(45, [8])
  const last = activities[activities.length - 1]!
  activities.push(act('cover', 'work', (last.endUtc - T0) / MIN, (last.endUtc - T0) / MIN + 24 * 60))
  const rows = assess(activities)
  assert.equal(reduced(rows).length, 0)
  const view = buildComplianceReview({ activities, nowUtc: NOW, clockMode: 'utc' })
  assert.equal(view.findings.some((finding) => finding.id.startsWith('article-8-4:')), false)
  assert.equal(view.findings.some((finding) => finding.methodology === 'gn7'), true)
})

test('překrývající se referenční okna nezapočtou stejné zkrácení dvakrát', () => {
  const activities = afterWeekly(45, [9])
  const rows = reduced(assess(activities))
  assert.equal(rows.length, 1)
  const anchor = T0 + 45 * H
  const periods = buildGn7ControlPeriods({ anchorUtc: anchor, activities, recordEndUtc: activities.at(-1)!.endUtc })
  const touched = periods.filter((period) => period.rests.some((rest) => rest.endUtc === rows[0]!.endUtc))
  assert.equal(touched.length >= 1, true)
  assert.equal(new Set(rows.map((row) => `${row.startUtc}:${row.endUtc}`)).size, rows.length)
})

test('neověřený trajektový odpočinek nepotvrdí čtvrté zkrácení', () => {
  const weekly = 45 * 60
  const activities: Activity[] = [act('weekly', 'rest', 0, weekly)]
  let cursor = weekly
  for (let index = 0; index < 3; index += 1) {
    activities.push(act(`work-${index}`, 'work', cursor, cursor + 60))
    cursor += 60
    activities.push(act(`rest-${index}`, 'rest', cursor, cursor + 9 * 60))
    cursor += 9 * 60
  }
  activities.push(act('before', 'work', cursor, cursor + 60))
  cursor += 61
  const ferryRest = cursor
  activities.push(act('ferry-rest', 'rest', cursor, cursor + 9 * 60))
  cursor += 9 * 60
  const ferryStart = cursor
  activities.push(act('ferry-work', 'work', cursor, cursor + 20))
  cursor += 20
  activities.push(act('ferry-tail', 'rest', cursor, cursor + 3 * 60))
  cursor += 3 * 60 + 1
  activities.push(act('tail', 'driving', cursor, cursor + 60))
  const conditions: SpecificConditionEntry[] = [
    { atUtc: T0 + ferryStart * MIN, kind: 'ferry' },
    { atUtc: T0 + (ferryStart + 20) * MIN, kind: 'ferry_end' },
  ]
  const rows = reduced(assess(activities, conditions))
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.slice(0, 3).map((row) => row.status), ['compliant', 'compliant', 'compliant'])
  assert.equal(rows[3]!.startUtc, T0 + ferryRest * MIN)
  assert.equal(rows[3]!.status, 'needs_verification')
  assert.equal(rows[3]!.uncertainty, 'ferry_unverified')
  assert.equal(rows[3]!.reductionOrder, null)
})

test('devět hodin při vícečlenné osádce není výjimka z limitu tří zkrácení', () => {
  const rows = reduced(assess(afterWeekly(45, [9, 9, 9, 9]).map((activity) => (
    activity.kind === 'work' ? { ...activity, isCrew: true } : activity
  ))))
  assert.equal(rows[3]!.status, 'violation')
  assert.equal(rows[3]!.reductionOrder, 4)
})

test('podmíněná osádka nepotvrdí čtvrté zkrácení', () => {
  const anchor = T0 + 45 * H
  const nodes = [0, 1, 2, 3].map((index) => {
    const startUtc = anchor + index * 10 * H
    const endUtc = startUtc + 9 * H
    return {
      anchorUtc: startUtc,
      windowStartUtc: startUtc,
      windowEndUtc: startUtc + 30 * H,
      windowMode: 'crew_30h' as const,
      crewRecord: 'crew_record_uncertain' as const,
      crewBasis: 'conditional' as const,
      uncertainIntervals: [],
      crewRefusal: null,
      anchorEstablished: true,
      status: 'evaluated' as const,
      interpretations: [{
        id: `reduced-${index}`,
        kind: 'continuous_reduced' as const,
        qualifiesWindow: true,
        established: true,
        nextAnchorUtc: endUtc,
        nextAnchorEstablished: true,
        reducedDelta: 1,
        weeklyRolePossible: false,
        parts: [{
          startUtc,
          endUtc,
          candidateMinutes: 540,
          restMinutesInsideWindow: 540,
          intersectionEndUtc: endUtc,
          sourceActivityIds: [`rest-${index}`],
        }],
      }],
    }
  })
  const chain: DailyRestChain = { startAnchorUtc: anchor, nodes, paths: [] }
  const rows = reduced(assessReducedDailyRestLimit({
    chain,
    weeklyCandidates: [{
      startUtc: T0,
      endUtc: anchor,
      durationMs: 45 * H,
      durationMinutes: 45 * 60,
      sourceActivityIds: ['weekly'],
      manualEntry: false,
      ambiguous: false,
      established: true,
      uncertainties: [],
      lengthClass: 'regular',
    }],
  }))
  assert.equal(rows.length, 4)
  assert.equal(rows.every((row) => row.status === 'needs_verification' && row.uncertainty === 'crew_conditional'), true)
  assert.equal(rows.some((row) => row.status === 'violation'), false)
})

test('tři zkrácení, běžný odpočinek a další zkrácení jsou čtyři zkrácení', () => {
  const rows = reduced(assess(afterWeekly(45, [9, 9, 9, 11, 9])))
  assert.deepEqual(rows.map((row) => row.reductionOrder), [1, 2, 3, 4])
  assert.equal(rows[3]!.status, 'violation')
})

test('týdenní odpočinek přes pondělí nuluje počet ve svém konci', () => {
  const monday = Date.parse('2026-04-06T00:00:00.000Z')
  assert.equal(new Date(monday).getUTCDay(), 1)
  const start = monday - 12 * H
  const end = start + 45 * H
  assert.equal(end > monday, true)
  const activities: Activity[] = [
    {
      id: 'weekly',
      kind: 'rest',
      startUtc: start,
      endUtc: end,
      durationMinutes: 45 * 60,
      slot: 1,
    },
  ]
  let cursor = end
  for (let index = 0; index < 4; index += 1) {
    activities.push({
      id: `work-${index}`,
      kind: 'work',
      startUtc: cursor,
      endUtc: cursor + H,
      durationMinutes: 60,
      slot: 1,
    })
    cursor += H
    activities.push({
      id: `rest-${index}`,
      kind: 'rest',
      startUtc: cursor,
      endUtc: cursor + 9 * H,
      durationMinutes: 9 * 60,
      slot: 1,
    })
    cursor += 9 * H
  }
  activities.push({
    id: 'tail',
    kind: 'work',
    startUtc: cursor,
    endUtc: cursor + H,
    durationMinutes: 60,
    slot: 1,
  })
  const rows = reduced(assess(activities))
  assert.equal(rows[0]!.intervalStartUtc, end)
  assert.notEqual(rows[0]!.intervalStartUtc, monday)
  assert.equal(rows[3]!.status, 'violation')
  assert.equal(rows[3]!.reductionOrder, 4)
})
