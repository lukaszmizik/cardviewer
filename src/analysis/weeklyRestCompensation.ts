import { buildWeeklyRestAssignment, type WeeklyAssignmentNode } from './weeklyRestAssignment.ts'
import type { WeeklyRestCandidate } from './weeklyRest.ts'

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS
const FORTY_FIVE_HOURS = 45 * HOUR_MS

export type CompensationDeadlineRegime = 'end_of_third_following_week'

export type CompensationCertainty = 'determined' | 'ambiguous'

export type CompensationWeekAlternative = {
  weekId: string
  weekStartUtc: number
  weekEndUtc: number
  deadlineUtc: number
  deadlineRegime: CompensationDeadlineRegime
}

/**
 * Rezervace pro druhou fázi. Hostitelský odpočinek nejméně 9 hodin
 * a minuty už použité jako týdenní odpočinek se do náhrady nezapočítají.
 */
export type CompensationTakenReservation = {
  status: 'not_searched'
  excludesHostRestAndWeeklyRest: true
}

export type WeeklyRestCompensationObligation = {
  id: string
  sourceNodeId: string
  sourceActivityIds: string[]
  restStartUtc: number
  restEndUtc: number
  restMs: number
  compensationMs: number
  /** Obsazeno jen když týden není na výběr. */
  weekId: string | null
  alternatives: CompensationWeekAlternative[]
  deadlineUtc: number | null
  deadlineRegime: CompensationDeadlineRegime
  certainty: CompensationCertainty
  taken: CompensationTakenReservation
}

export type CompensationNotRequired = {
  sourceNodeId: string
  sourceActivityIds: string[]
  reason: 'regular_length' | 'additional_reduced'
}

export type CompensationUnresolved = {
  sourceNodeId: string
  sourceActivityIds: string[]
  reason: 'ambiguous_rest' | 'end_not_documented' | 'multiple_starts' | 'spans_more_than_two_weeks' | 'unknown_excluded' | 'same_deadline_distance'
}

/** Dva rozhodné zkrácené odpočinky za sebou. Výjimka pro mezinárodní náklad se z karty nedokládá. */
export type InternationalConsecutiveReduced = {
  status: 'not_proven'
  sourceNodeIds: string[]
  entitlement: 'not_inferred'
  deadlineEffect: 'none'
}

export type WeeklyRestCompensationReport = {
  clockBasis: 'monday_00_00_utc'
  obligations: WeeklyRestCompensationObligation[]
  notRequired: CompensationNotRequired[]
  unresolved: CompensationUnresolved[]
  internationalConsecutive: InternationalConsecutiveReduced[]
  compensationTaken: 'not_evaluated'
}

/**
 * Určí, které zkrácené týdenní odpočinky zakládají náhradu.
 * Čerpání náhrady nehledá a porušení nevytváří.
 * Další odpočinek mezi 24 a 45 hodinami, který není ten nejbližší lhůtě šesti 24hodinových období, dluh nezakládá.
 */
export function assessWeeklyRestCompensation(input: {
  candidates: readonly WeeklyRestCandidate[]
  unknownIntervals?: readonly { startUtc: number; endUtc: number }[]
  recordEndUtc?: number | null
}): WeeklyRestCompensationReport {
  const assignment = buildWeeklyRestAssignment(input)
  const byId = new Map(assignment.nodes.map((node) => [node.id, node]))
  const report: WeeklyRestCompensationReport = {
    clockBasis: 'monday_00_00_utc',
    obligations: [],
    notRequired: [],
    unresolved: assignment.excludedByUnknown.map((item) => ({
      sourceNodeId: `${item.startUtc}:${item.sourceActivityIds.join('+')}`,
      sourceActivityIds: [...item.sourceActivityIds],
      reason: 'unknown_excluded',
    })),
    internationalConsecutive: [],
    compensationTaken: 'not_evaluated',
  }
  if (assignment.nodes.length === 0) return report
  if (assignment.rootIds.length !== 1) {
    for (const node of assignment.nodes) report.unresolved.push(unresolved(node, 'multiple_starts'))
    return report
  }

  const walk = walkDecisive(assignment.rootIds[0]!, byId)
  for (const node of walk.sameDistance) report.unresolved.push(unresolved(node, 'same_deadline_distance'))
  const successorOf = walk.successorOf
  const decisiveReduced: WeeklyAssignmentNode[] = []

  for (const nodeId of walk.additionalIds) {
    const node = byId.get(nodeId)
    if (node == null || node.lengthClass !== 'reduced') continue
    report.notRequired.push(notRequired(node, 'additional_reduced'))
  }

  for (const nodeId of walk.decisiveIds) {
    const node = byId.get(nodeId)
    if (node == null) continue
    if (node.lengthClass === 'regular') {
      report.notRequired.push(notRequired(node, 'regular_length'))
      continue
    }
    if (node.ambiguous) {
      report.unresolved.push(unresolved(node, 'ambiguous_rest'))
      continue
    }
    if (!endDocumented(node, input.recordEndUtc)) {
      report.unresolved.push(unresolved(node, 'end_not_documented'))
      continue
    }
    if (node.weekChoice === 'continuous_cover') {
      report.unresolved.push(unresolved(node, 'spans_more_than_two_weeks'))
      continue
    }
    const obligation = obligationFor(node)
    report.obligations.push(obligation)
    if (obligation.certainty === 'determined' || obligation.certainty === 'ambiguous') decisiveReduced.push(node)
  }

  report.internationalConsecutive = consecutiveReduced(decisiveReduced, successorOf)
  return report
}

function walkDecisive(
  rootId: string,
  byId: ReadonlyMap<string, WeeklyAssignmentNode>,
): { decisiveIds: string[]; additionalIds: string[]; sameDistance: WeeklyAssignmentNode[]; successorOf: Map<string, string> } {
  const decisiveIds: string[] = []
  const additionalIds: string[] = []
  const sameDistance: WeeklyAssignmentNode[] = []
  const successorOf = new Map<string, string>()
  const seen = new Set<string>()
  let current = byId.get(rootId) ?? null
  while (current != null && !seen.has(current.id)) {
    seen.add(current.id)
    decisiveIds.push(current.id)
    const onTime = current.nextOnTime
      .map((link) => byId.get(link.toId))
      .filter((node): node is WeeklyAssignmentNode => node != null)
    if (onTime.length === 0) {
      const late = current.nextAfterDeadline == null ? null : byId.get(current.nextAfterDeadline.toId) ?? null
      if (late == null) break
      successorOf.set(current.id, late.id)
      current = late
      continue
    }
    const latestStart = Math.max(...onTime.map((node) => node.startUtc))
    const closest = onTime.filter((node) => node.startUtc === latestStart)
    if (closest.length !== 1) {
      sameDistance.push(...closest)
      break
    }
    const chosen = closest[0]!
    successorOf.set(current.id, chosen.id)
    for (const node of onTime) {
      if (node.id !== chosen.id) additionalIds.push(node.id)
    }
    current = chosen
  }
  return { decisiveIds, additionalIds, sameDistance, successorOf }
}

function obligationFor(node: WeeklyAssignmentNode): WeeklyRestCompensationObligation {
  const alternatives = node.possibleWeeks
    .filter((week) => week.attachment !== 'covered_slice')
    .map((week) => ({
      weekId: week.weekId,
      weekStartUtc: week.startUtc,
      weekEndUtc: week.endUtc,
      deadlineUtc: week.endUtc + 3 * WEEK_MS,
      deadlineRegime: 'end_of_third_following_week' as const,
    }))
  const unique = node.weekChoice === 'single' && alternatives.length === 1
  const chosen = unique ? alternatives[0]! : null
  return {
    id: `weekly-compensation:${node.id}`,
    sourceNodeId: node.id,
    sourceActivityIds: [...node.sourceActivityIds],
    restStartUtc: node.startUtc,
    restEndUtc: node.endUtc,
    restMs: node.durationMs,
    compensationMs: FORTY_FIVE_HOURS - node.durationMs,
    weekId: chosen?.weekId ?? null,
    alternatives,
    deadlineUtc: chosen?.deadlineUtc ?? null,
    deadlineRegime: 'end_of_third_following_week',
    certainty: unique ? 'determined' : 'ambiguous',
    taken: { status: 'not_searched', excludesHostRestAndWeeklyRest: true },
  }
}

function consecutiveReduced(
  nodes: readonly WeeklyAssignmentNode[],
  successorOf: ReadonlyMap<string, string>,
): InternationalConsecutiveReduced[] {
  const records: InternationalConsecutiveReduced[] = []
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const earlier = nodes[index]!
    const later = nodes[index + 1]!
    if (earlier.lengthClass !== 'reduced' || later.lengthClass !== 'reduced') continue
    if (successorOf.get(earlier.id) !== later.id) continue
    records.push({
      status: 'not_proven',
      sourceNodeIds: [earlier.id, later.id],
      entitlement: 'not_inferred',
      deadlineEffect: 'none',
    })
  }
  return records
}

function endDocumented(node: WeeklyAssignmentNode, recordEndUtc: number | null | undefined): boolean {
  return recordEndUtc != null && node.endUtc < recordEndUtc
}

function notRequired(node: WeeklyAssignmentNode, reason: CompensationNotRequired['reason']): CompensationNotRequired {
  return { sourceNodeId: node.id, sourceActivityIds: [...node.sourceActivityIds], reason }
}

function unresolved(node: WeeklyAssignmentNode, reason: CompensationUnresolved['reason']): CompensationUnresolved {
  return { sourceNodeId: node.id, sourceActivityIds: [...node.sourceActivityIds], reason }
}
