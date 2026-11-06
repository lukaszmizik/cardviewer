import type { WeeklyAutomaticAssignment, WeeklyAssignmentNode } from './weeklyRestAssignment.ts'
import type { WeeklyLengthClass } from './weeklyRest.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const INTERPRETATION_LIMIT = 64
const INVOLVED_LIMIT = 8

export type ConsecutiveWeekStatus =
  | 'satisfied'
  | 'not_satisfied_basic_rule'
  | 'ambiguous'
  | 'insufficient_data'
  | 'not_evaluated'

export type ConsecutiveWeekRestUse = {
  nodeId: string
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
  lengthClass: WeeklyLengthClass
  weekId: string
}

export type ConsecutiveWeekAlternative = {
  meetsBasicRule: boolean
  rests: ConsecutiveWeekRestUse[]
  reason: string
}

export type ConsecutiveWeekPeriod = {
  earlierWeek: { id: string; startUtc: number; endUtc: number }
  laterWeek: { id: string; startUtc: number; endUtc: number }
  status: ConsecutiveWeekStatus
  clockBasis: 'monday_00_00_utc'
  /** Základní pravidlo není přestupkový nález. */
  isInfringement: false
  internationalRegime: 'not_evaluated'
  compensation: 'not_evaluated'
  /** Délková třída není právně potvrzené použití odpočinku. */
  lengthEligibilityIsLegalUse: false
  usedRests: ConsecutiveWeekRestUse[]
  alternatives: ConsecutiveWeekAlternative[]
  reason: string
  missing: string[]
  needsController: boolean
}

export type ConsecutiveWeeksResult = {
  clockBasis: 'monday_00_00_utc'
  lengthEligibilityIsLegalUse: false
  internationalRegime: 'not_evaluated'
  compensation: 'not_evaluated'
  isInfringement: false
  periods: ConsecutiveWeekPeriod[]
  counts: Record<ConsecutiveWeekStatus, number>
}

type Week = { id: string; startUtc: number; endUtc: number }
type Interval = { startUtc: number; endUtc: number }

/**
 * Klouzavá kontrola každých dvou sousedních týdnů v běžném režimu.
 * Dlouhý nepřerušený odpočinek se nerozděluje na několik týdenních odpočinků.
 */
export function assessConsecutiveWeeks(input: {
  assignment: WeeklyAutomaticAssignment
  unknownIntervals?: readonly Interval[]
  /** Celý záznam, aby týden bez týdenního kandidáta v kontrole zůstal. */
  recordSpan?: Interval | null
}): ConsecutiveWeeksResult {
  const unknowns = input.unknownIntervals ?? []
  const nodes = input.assignment.nodes
  const roots = new Set(input.assignment.rootIds)
  const weeks = calendarWeeks(nodes, unknowns, input.assignment.excludedByUnknown, input.recordSpan ?? null)
  const periods: ConsecutiveWeekPeriod[] = []
  for (let index = 0; index < weeks.length - 1; index += 1) {
    const earlier = weeks[index]!
    const later = weeks[index + 1]!
    if (later.startUtc !== earlier.endUtc) continue
    periods.push(assessPair(earlier, later, nodes, roots, unknowns, input.assignment.excludedByUnknown))
  }
  return {
    clockBasis: 'monday_00_00_utc',
    lengthEligibilityIsLegalUse: false,
    internationalRegime: 'not_evaluated',
    compensation: 'not_evaluated',
    isInfringement: false,
    periods,
    counts: countStatuses(periods),
  }
}

function assessPair(
  earlier: Week,
  later: Week,
  nodes: readonly WeeklyAssignmentNode[],
  roots: ReadonlySet<string>,
  unknowns: readonly Interval[],
  excluded: readonly Interval[],
): ConsecutiveWeekPeriod {
  const span = { startUtc: earlier.startUtc, endUtc: later.endUtc }
  const base = {
    earlierWeek: earlier,
    laterWeek: later,
    clockBasis: 'monday_00_00_utc' as const,
    isInfringement: false as const,
    internationalRegime: 'not_evaluated' as const,
    compensation: 'not_evaluated' as const,
    lengthEligibilityIsLegalUse: false as const,
  }
  if (overlapsAny(span, unknowns) || overlapsAny(span, excluded)) {
    return {
      ...base,
      status: 'insufficient_data',
      usedRests: [],
      alternatives: [],
      reason: 'V období je neznámý úsek nebo odpočinek, který se s ním překrývá. Chybějící čas se nedoplňuje.',
      missing: ['neznámý úsek v posuzovaném období'],
      needsController: false,
    }
  }
  const touching = nodes.filter((node) => node.possibleWeeks.some((week) => week.weekId === earlier.id || week.weekId === later.id))
  if (touching.some((node) => node.weekChoice === 'continuous_cover')) {
    return {
      ...base,
      status: 'not_evaluated',
      usedRests: restsTouching(touching.filter((node) => node.weekChoice === 'continuous_cover'), earlier, later),
      alternatives: [],
      reason:
        'Období protíná jeden nepřerušený odpočinek delší než dva kalendářní týdny. Z jednoho fyzického intervalu se nedělá několik týdenních odpočinků a průnik s týdnem není splnění pravidla. Právní započtení model zatím neurčuje.',
      missing: ['jednoznačné právní započtení dlouhého nepřerušeného odpočinku'],
      needsController: false,
    }
  }
  if (touching.some((node) => node.ambiguous)) {
    return {
      ...base,
      status: 'insufficient_data',
      usedRests: [],
      alternatives: [],
      reason: 'Některý odpočinek v období nemá prokázanou souvislost. Nelze ho použít jako týdenní.',
      missing: ['prokázaná souvislost odpočinku'],
      needsController: false,
    }
  }
  if (touching.some((node) => roots.has(node.id))) {
    return {
      ...base,
      status: 'insufficient_data',
      usedRests: [],
      alternatives: [],
      reason: 'Před odpočinkem v tomto období není na kartě konec předchozího týdenního odpočinku. Historie na začátku záznamu chybí.',
      missing: ['konec předchozího týdenního odpočinku'],
      needsController: false,
    }
  }
  if (touching.length > INVOLVED_LIMIT) {
    return {
      ...base,
      status: 'not_evaluated',
      usedRests: [],
      alternatives: [],
      reason: `V období je více než ${INVOLVED_LIMIT} odpočinků. Výčet přiřazení se nespouští, aby nevznikl neúplný výsledek.`,
      missing: [],
      needsController: false,
    }
  }

  const enumerated = enumerate(touching, earlier.id, later.id)
  if (enumerated.truncated) {
    return {
      ...base,
      status: 'not_evaluated',
      usedRests: [],
      alternatives: [],
      reason: `Přípustných přiřazení je více než ${INTERPRETATION_LIMIT}. Kontrola se raději neuzavírá.`,
      missing: [],
      needsController: false,
    }
  }
  const alternatives = enumerated.items
  if (alternatives.length === 0) {
    return {
      ...base,
      status: 'not_satisfied_basic_rule',
      usedRests: [],
      alternatives: [],
      reason: emptyReason(),
      missing: [],
      needsController: false,
    }
  }
  const meets = alternatives.filter((item) => item.meetsBasicRule)
  const fails = alternatives.filter((item) => !item.meetsBasicRule)
  if (meets.length > 0 && fails.length > 0) {
    const shown = distinct(alternatives).slice(0, 8)
    return {
      ...base,
      status: 'ambiguous',
      usedRests: uniqueRests(shown),
      alternatives: shown,
      reason: 'Část přípustných přiřazení základní pravidlo splňuje a část ne. Rozhoduje, ke kterému týdnu se odpočinek započte.',
      missing: [],
      needsController: true,
    }
  }
  const satisfied = meets.length === alternatives.length
  const shown = distinct(alternatives).slice(0, 8)
  return {
    ...base,
    status: satisfied ? 'satisfied' : 'not_satisfied_basic_rule',
    usedRests: uniqueRests(shown),
    alternatives: shown,
    reason: satisfied
      ? `Všech ${alternatives.length} přípustných přiřazení dává dva běžné odpočinky, nebo jeden běžný a jeden zkrácený. Délka není právně potvrzené použití.`
      : emptyReason(),
    missing: [],
    needsController: false,
  }
}

function emptyReason(): string {
  return 'Žádné přípustné přiřazení nedává dva běžné odpočinky ani jeden běžný a jeden zkrácený. Zvláštní režim mezinárodní nákladní dopravy se neposuzuje. Výsledek není přestupek.'
}

function enumerate(
  involved: readonly WeeklyAssignmentNode[],
  weekA: string,
  weekB: string,
): { items: ConsecutiveWeekAlternative[]; truncated: boolean } {
  const items: ConsecutiveWeekAlternative[] = []
  const seen = new Set<string>()
  const chosen = new Map<string, WeeklyAssignmentNode>()
  let truncated = false

  const visit = (index: number): void => {
    if (truncated) return
    if (items.length > INTERPRETATION_LIMIT) {
      truncated = true
      return
    }
    if (index === involved.length) {
      if (!placementIsLegal(involved, chosen)) return
      const alternative = toAlternative(chosen, weekA, weekB)
      const key = `${alternative.rests.map((rest) => `${rest.weekId}:${rest.nodeId}`).join('|')}:${alternative.meetsBasicRule}`
      if (seen.has(key)) return
      seen.add(key)
      items.push(alternative)
      return
    }
    const node = involved[index]!
    for (const week of node.possibleWeeks) {
      if (chosen.has(week.weekId) || overlapsChosen(node, chosen)) continue
      chosen.set(week.weekId, node)
      visit(index + 1)
      chosen.delete(week.weekId)
    }
    visit(index + 1)
  }
  visit(0)
  return { items: truncated ? [] : items, truncated }
}

function placementIsLegal(involved: readonly WeeklyAssignmentNode[], chosen: ReadonlyMap<string, WeeklyAssignmentNode>): boolean {
  const placedIds = new Set([...chosen.values()].map((node) => node.id))
  for (const node of involved) {
    if (placedIds.has(node.id)) continue
    const canPlace = node.possibleWeeks.some((week) => !chosen.has(week.weekId) && !overlapsChosen(node, chosen))
    if (canPlace) return false
  }
  return true
}

function overlapsChosen(node: WeeklyAssignmentNode, chosen: ReadonlyMap<string, WeeklyAssignmentNode>): boolean {
  return [...chosen.values()].some((holder) => rangesOverlap(holder.startUtc, holder.endUtc, node.startUtc, node.endUtc))
}

function toAlternative(chosen: ReadonlyMap<string, WeeklyAssignmentNode>, weekA: string, weekB: string): ConsecutiveWeekAlternative {
  const rests = [weekA, weekB]
    .map((weekId) => {
      const node = chosen.get(weekId)
      return node == null ? null : toUse(node, weekId)
    })
    .filter((rest): rest is ConsecutiveWeekRestUse => rest != null)
  const classes = rests.map((rest) => rest.lengthClass)
  const regular = classes.filter((item) => item === 'regular').length
  const reduced = classes.filter((item) => item === 'reduced').length
  const meetsBasicRule = rests.length === 2 && (regular === 2 || (regular === 1 && reduced === 1))
  return {
    meetsBasicRule,
    rests,
    reason: describeAlternative(rests, weekA, weekB, meetsBasicRule),
  }
}

function describeAlternative(rests: readonly ConsecutiveWeekRestUse[], weekA: string, weekB: string, meets: boolean): string {
  const text = (weekId: string) => {
    const rest = rests.find((item) => item.weekId === weekId)
    if (rest == null) return 'bez odpočinku'
    return rest.lengthClass === 'regular' ? 'běžný délkový kandidát' : 'zkrácený délkový kandidát'
  }
  return `Dřívější týden: ${text(weekA)}. Pozdější týden: ${text(weekB)}. ${meets ? 'Základní pravidlo vychází.' : 'Základní pravidlo nevychází.'}`
}

function toUse(node: WeeklyAssignmentNode, weekId: string): ConsecutiveWeekRestUse {
  return {
    nodeId: node.id,
    startUtc: node.startUtc,
    endUtc: node.endUtc,
    sourceActivityIds: [...node.sourceActivityIds],
    lengthClass: node.lengthClass,
    weekId,
  }
}

function restsTouching(nodes: readonly WeeklyAssignmentNode[], earlier: Week, later: Week): ConsecutiveWeekRestUse[] {
  return nodes.flatMap((node) => {
    const week = node.possibleWeeks.find((item) => item.weekId === earlier.id || item.weekId === later.id)
    return week == null ? [] : [toUse(node, week.weekId)]
  })
}

function distinct(items: readonly ConsecutiveWeekAlternative[]): ConsecutiveWeekAlternative[] {
  const seen = new Set<string>()
  const result: ConsecutiveWeekAlternative[] = []
  for (const item of items) {
    const key = `${item.meetsBasicRule}:${item.rests.map((rest) => `${rest.weekId}:${rest.nodeId}`).join('|')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function uniqueRests(items: readonly ConsecutiveWeekAlternative[]): ConsecutiveWeekRestUse[] {
  const seen = new Set<string>()
  const rests: ConsecutiveWeekRestUse[] = []
  for (const item of items) {
    for (const rest of item.rests) {
      const key = `${rest.weekId}:${rest.nodeId}`
      if (seen.has(key)) continue
      seen.add(key)
      rests.push(rest)
    }
  }
  return rests
}

function countStatuses(periods: readonly ConsecutiveWeekPeriod[]): Record<ConsecutiveWeekStatus, number> {
  const counts: Record<ConsecutiveWeekStatus, number> = {
    satisfied: 0,
    not_satisfied_basic_rule: 0,
    ambiguous: 0,
    insufficient_data: 0,
    not_evaluated: 0,
  }
  for (const period of periods) counts[period.status] += 1
  return counts
}

function calendarWeeks(
  nodes: readonly WeeklyAssignmentNode[],
  unknowns: readonly Interval[],
  excluded: readonly Interval[],
  recordSpan: Interval | null,
): Week[] {
  const instants = [
    ...nodes.flatMap((node) => [node.startUtc, node.endUtc]),
    ...unknowns.flatMap((interval) => [interval.startUtc, interval.endUtc]),
    ...excluded.flatMap((interval) => [interval.startUtc, interval.endUtc]),
    ...(recordSpan == null ? [] : [recordSpan.startUtc, recordSpan.endUtc]),
  ]
  if (instants.length === 0) return []
  const first = Math.min(...instants)
  const last = Math.max(...instants)
  let cursor = mondayOnOrBefore(first)
  const end = mondayOnOrBefore(last - 1)
  const weeks: Week[] = []
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

function overlapsAny(span: Interval, intervals: readonly Interval[]): boolean {
  return intervals.some((interval) => rangesOverlap(span.startUtc, span.endUtc, interval.startUtc, interval.endUtc))
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}
