import type { WeeklyLengthClass, WeeklyRestCandidate } from './weeklyRest.ts'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const SIX_PERIODS = 6 * DAY_MS

export type WeeklyClockBasis = 'monday_00_00_utc'

export type WeeklyWeekOption = {
  weekId: string
  startUtc: number
  endUtc: number
  overlapStartUtc: number
  overlapEndUtc: number
  overlapMs: number
  attachment: 'single_week' | 'starting_week' | 'ending_week' | 'covered_slice'
}

export type WeeklyNextLink = {
  toId: string
  timing: 'on_time' | 'after_deadline'
  latestStartUtc: number
  role: 'possible_next' | 'nearest_recorded_after_deadline'
}

export type WeeklyAssignmentNode = {
  id: string
  startUtc: number
  endUtc: number
  durationMs: number
  sourceActivityIds: string[]
  lengthClass: WeeklyLengthClass
  manualEntry: boolean
  ambiguous: boolean
  weekChoice: 'single' | 'needs_controller' | 'continuous_cover'
  /** U dvou týdnů jsou to dvě možnosti, ne současné započtení. U delšího odpočinku jsou to nesdílené průniky. */
  possibleWeeks: WeeklyWeekOption[]
  /** Šestidobá lhůta běží od skutečného konce, ne uvnitř probíhajícího odpočinku. */
  sixPeriodMeasuredFrom: 'actual_end'
  latestNextStartUtc: number
  /** Návaznosti začínající nejpozději šestkrát 24 hodin po skutečném konci tohoto odpočinku. */
  nextOnTime: WeeklyNextLink[]
  /** Jen nejbližší pozdější odpočinek. Není to další přípustná varianta. */
  nextAfterDeadline: WeeklyNextLink | null
}

export type WeeklyAssignmentRecommendation =
  | { status: 'suggested'; nodeIds: string[]; reason: string }
  | { status: 'undecided'; reason: string }

export type WeeklyAutomaticAssignment = {
  clockBasis: WeeklyClockBasis
  consecutiveWeeks: 'not_evaluated'
  internationalRegime: 'not_evaluated'
  compensationTaken: 'not_evaluated'
  /** false znamená, že se z grafu nestaví kartézský součin cest. */
  pathsMaterialized: false
  /** Vzdálené pozdní hrany se nesestavují. Nejbližší odpočinek po lhůtě zůstává. */
  lateLinksReducedToNearest: true
  searchLimited: false
  nodes: WeeklyAssignmentNode[]
  rootIds: string[]
  recommendation: WeeklyAssignmentRecommendation
  /** Konce doporučené větve pro pozdější denní kotvy. Prázdné, když doporučení není. */
  suggestedBoundaryEndsUtc: number[]
  /** Právní závěr to není. */
  recommendationIsLegalFinding: false
  excludedByUnknown: Array<{ startUtc: number; endUtc: number; sourceActivityIds: string[] }>
}

type WeekSpan = { id: string; startUtc: number; endUtc: number }

/**
 * Graf možných týdenních návazností nad už klasifikovanými kandidáty.
 * Jeden odpočinek je jeden uzel. Délka sama roli nepřiděluje.
 */
export function buildWeeklyRestAssignment(input: {
  candidates: readonly WeeklyRestCandidate[]
  unknownIntervals?: readonly { startUtc: number; endUtc: number }[]
}): WeeklyAutomaticAssignment {
  const unknowns = input.unknownIntervals ?? []
  const excludedByUnknown = input.candidates
    .filter((candidate) => overlapsAny(candidate.startUtc, candidate.endUtc, unknowns))
    .map((candidate) => ({
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      sourceActivityIds: [...candidate.sourceActivityIds],
    }))
  const usable = input.candidates.filter((candidate) => !overlapsAny(candidate.startUtc, candidate.endUtc, unknowns))
  const ordered = [...usable].sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
  const weeks = mondayWeeks(ordered)
  const nodes = ordered.map((candidate) => toNode(candidate, weeks))
  const byId = new Map(nodes.map((node) => [node.id, node]))

  for (const node of nodes) {
    const latestStartUtc = node.endUtc + SIX_PERIODS
    node.latestNextStartUtc = latestStartUtc
    const later = nodes.filter((item) => item.startUtc >= node.endUtc && !unknownBetween(node.endUtc, item.startUtc, unknowns))
    node.nextOnTime = later
      .filter((item) => item.startUtc <= latestStartUtc)
      .map((item) => ({ toId: item.id, timing: 'on_time' as const, latestStartUtc, role: 'possible_next' as const }))
    const afterDeadline = later.find((item) => item.startUtc > latestStartUtc)
    node.nextAfterDeadline =
      afterDeadline == null
        ? null
        : {
            toId: afterDeadline.id,
            timing: 'after_deadline',
            latestStartUtc,
            role: 'nearest_recorded_after_deadline',
          }
  }

  const incoming = new Set(
    nodes.flatMap((node) => [...node.nextOnTime, ...(node.nextAfterDeadline == null ? [] : [node.nextAfterDeadline])].map((link) => link.toId)),
  )
  const rootIds = nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id)
  const recommendation = recommend(nodes, byId, rootIds)

  return {
    clockBasis: 'monday_00_00_utc',
    consecutiveWeeks: 'not_evaluated',
    internationalRegime: 'not_evaluated',
    compensationTaken: 'not_evaluated',
    pathsMaterialized: false,
    lateLinksReducedToNearest: true,
    searchLimited: false,
    nodes,
    rootIds,
    recommendation,
    suggestedBoundaryEndsUtc:
      recommendation.status === 'suggested'
        ? recommendation.nodeIds.map((id) => byId.get(id)?.endUtc).filter((value): value is number => value != null)
        : [],
    recommendationIsLegalFinding: false,
    excludedByUnknown,
  }
}

function toNode(candidate: WeeklyRestCandidate, weeks: readonly WeekSpan[]): WeeklyAssignmentNode {
  const overlapped = weeks.filter((week) => rangesOverlap(candidate.startUtc, candidate.endUtc, week.startUtc, week.endUtc))
  const possibleWeeks = overlapped.map((week, index) => {
    const overlapStartUtc = Math.max(candidate.startUtc, week.startUtc)
    const overlapEndUtc = Math.min(candidate.endUtc, week.endUtc)
    const attachment =
      overlapped.length === 1 ? ('single_week' as const) : overlapped.length === 2 ? (index === 0 ? ('starting_week' as const) : ('ending_week' as const)) : ('covered_slice' as const)
    return {
      weekId: week.id,
      startUtc: week.startUtc,
      endUtc: week.endUtc,
      overlapStartUtc,
      overlapEndUtc,
      overlapMs: overlapEndUtc - overlapStartUtc,
      attachment,
    }
  })
  return {
    id: `${candidate.startUtc}:${candidate.sourceActivityIds.join('+')}`,
    startUtc: candidate.startUtc,
    endUtc: candidate.endUtc,
    durationMs: candidate.durationMs,
    sourceActivityIds: [...candidate.sourceActivityIds],
    lengthClass: candidate.lengthClass,
    manualEntry: candidate.manualEntry,
    ambiguous: candidate.ambiguous,
    weekChoice: overlapped.length > 2 ? 'continuous_cover' : overlapped.length === 2 ? 'needs_controller' : 'single',
    possibleWeeks,
    sixPeriodMeasuredFrom: 'actual_end',
    latestNextStartUtc: candidate.endUtc + SIX_PERIODS,
    nextOnTime: [],
    nextAfterDeadline: null,
  }
}

function recommend(
  nodes: readonly WeeklyAssignmentNode[],
  byId: ReadonlyMap<string, WeeklyAssignmentNode>,
  rootIds: readonly string[],
): WeeklyAssignmentRecommendation {
  if (nodes.length === 0) {
    return { status: 'undecided', reason: 'Na kartě není odpočinek s týdenní délkou.' }
  }
  const components = componentGroups(nodes)
  const chosen: string[] = []
  for (const group of components) {
    const roots = group.filter((id) => rootIds.includes(id))
    if (roots.length !== 1) {
      return {
        status: 'undecided',
        reason: 'V jednom úseku začíná více odpočinků bez předchozí návaznosti. Algoritmus mezi nimi nevolí.',
      }
    }
    const walked = walkUniqueOnTime(roots[0]!, byId)
    if (walked == null) {
      return {
        status: 'undecided',
        reason: 'Alespoň v jednom kroku začíná do šesti 24hodinových období více odpočinků. Všechny zůstávají v grafu.',
      }
    }
    chosen.push(...walked)
  }
  const crossedDeadline = chosen.some((id) => {
    const node = byId.get(id)
    const nextId = chosen[chosen.indexOf(id) + 1]
    return node?.nextAfterDeadline != null && node.nextAfterDeadline.toId === nextId
  })
  const deadlineNote = crossedDeadline
    ? ' Krok po šesti 24 hodinách je jen nejbližší další zaznamenaný odpočinek po skutečném konci. Během nepřerušeného odpočinku se lhůta neporušuje a nejde o právní nález.'
    : ''
  return {
    status: 'suggested',
    nodeIds: chosen,
    reason: `V každém úseku je jediná včasná návaznost. Úseky oddělené neznámým úsekem se nespojují. Před prvním záznamem historie chybí. Není to právní potvrzení.${deadlineNote}`,
  }
}

function walkUniqueOnTime(rootId: string, byId: ReadonlyMap<string, WeeklyAssignmentNode>): string[] | null {
  const ids: string[] = []
  const seen = new Set<string>()
  let current = byId.get(rootId)
  while (current != null && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    if (current.nextOnTime.length > 1) return null
    const nextId = current.nextOnTime.length === 1 ? current.nextOnTime[0]!.toId : current.nextAfterDeadline?.toId
    if (nextId == null) break
    current = byId.get(nextId)
  }
  return ids
}

function componentGroups(nodes: readonly WeeklyAssignmentNode[]): string[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const current = parent.get(id) ?? id
    if (current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const unite = (left: string, right: string) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(b, a)
  }
  for (const node of nodes) parent.set(node.id, node.id)
  for (const node of nodes) {
    for (const link of [...node.nextOnTime, ...(node.nextAfterDeadline == null ? [] : [node.nextAfterDeadline])]) unite(node.id, link.toId)
  }
  const groups = new Map<string, string[]>()
  for (const node of nodes) {
    const root = find(node.id)
    const list = groups.get(root) ?? []
    list.push(node.id)
    groups.set(root, list)
  }
  return [...groups.values()]
}

function mondayWeeks(candidates: readonly WeeklyRestCandidate[]): WeekSpan[] {
  if (candidates.length === 0) return []
  const first = candidates[0]!.startUtc
  const last = candidates[candidates.length - 1]!.endUtc
  let cursor = mondayOnOrBefore(first)
  const end = mondayOnOrBefore(last) + WEEK_MS
  const weeks: WeekSpan[] = []
  while (cursor <= end) {
    weeks.push({ id: `monday:${cursor}`, startUtc: cursor, endUtc: cursor + WEEK_MS })
    cursor += WEEK_MS
  }
  return weeks
}

function mondayOnOrBefore(utc: number): number {
  const date = new Date(utc)
  const daysFromMonday = (date.getUTCDay() + 6) % 7
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysFromMonday)
}

function unknownBetween(
  fromUtc: number,
  toUtc: number,
  unknowns: readonly { startUtc: number; endUtc: number }[],
): boolean {
  return unknowns.some((interval) => interval.startUtc < toUtc && interval.endUtc > fromUtc)
}

function overlapsAny(
  startUtc: number,
  endUtc: number,
  intervals: readonly { startUtc: number; endUtc: number }[],
): boolean {
  return intervals.some((interval) => rangesOverlap(startUtc, endUtc, interval.startUtc, interval.endUtc))
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}
