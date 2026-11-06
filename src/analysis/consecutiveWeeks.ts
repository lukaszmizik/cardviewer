import type { WeeklyAutomaticAssignment, WeeklyAssignmentNode, WeeklyWeekOption } from './weeklyRestAssignment.ts'
import type { WeeklyLengthClass } from './weeklyRest.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const INTERPRETATION_LIMIT = 64
const INVOLVED_LIMIT = 8
/**
 * Konzervativní technická rezerva modelu `resting_throughout` vůči hranicím dvojice
 * na hodinách pondělí 00:00 UTC. Není to zákonné pravidlo ani řešení časových pásem.
 */
const TECHNICAL_EDGE_MARGIN_MS = 3 * 60 * 60 * 1000

export type ConsecutiveWeekStatus =
  | 'satisfied'
  | 'not_satisfied_basic_rule'
  | 'ambiguous'
  | 'insufficient_data'
  | 'not_evaluated'
  | 'resting_throughout'

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

export type RestingThroughoutCover = {
  nodeId: string
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
  /** Původní nesdílené průniky. Nejsou to další fyzické odpočinky. */
  weekOverlaps: WeeklyWeekOption[]
  marginBeforeMs: number
  marginAfterMs: number
  technicalMarginMs: number
}

type ConsecutiveWeekPeriodBase = {
  earlierWeek: { id: string; startUtc: number; endUtc: number }
  laterWeek: { id: string; startUtc: number; endUtc: number }
  clockBasis: 'monday_00_00_utc'
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

export type ConsecutiveWeekPeriod =
  | (ConsecutiveWeekPeriodBase & {
      status: Exclude<ConsecutiveWeekStatus, 'resting_throughout'>
      /** Základní pravidlo není přestupkový nález. */
      isInfringement: false
      cover: null
    })
  | (ConsecutiveWeekPeriodBase & {
      status: 'resting_throughout'
      /** Skladba podle čl. 8 odst. 6 se u tohoto stavu neposuzuje. */
      compositionEvaluated: false
      infringementAssessment: 'not_evaluated'
      cover: RestingThroughoutCover
    })

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
  reconcileAdjacentAssignments(periods)
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
    cover: null,
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
  const longRests = touching.filter((node) => node.weekChoice === 'continuous_cover')
  if (longRests.length > 0) return assessLongRest(base, earlier, later, longRests, touching)
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

function assessLongRest(
  base: Omit<ConsecutiveWeekPeriod, 'status' | 'usedRests' | 'alternatives' | 'reason' | 'missing' | 'needsController'>,
  earlier: Week,
  later: Week,
  longRests: readonly WeeklyAssignmentNode[],
  touching: readonly WeeklyAssignmentNode[],
): ConsecutiveWeekPeriod {
  const separate = touching.some((node) => node.weekChoice !== 'continuous_cover')
  const covering = longRests.filter((node) => containsWeek(node, earlier) && containsWeek(node, later))
  const qualified = covering.filter((node) => marginBefore(node, earlier) >= TECHNICAL_EDGE_MARGIN_MS && marginAfter(node, later) >= TECHNICAL_EDGE_MARGIN_MS)
  if (qualified.length === 1) {
    const cover = toCover(qualified[0]!, earlier, later)
    return {
      earlierWeek: base.earlierWeek,
      laterWeek: base.laterWeek,
      clockBasis: base.clockBasis,
      internationalRegime: base.internationalRegime,
      compensation: base.compensation,
      lengthEligibilityIsLegalUse: base.lengthEligibilityIsLegalUse,
      status: 'resting_throughout',
      compositionEvaluated: false,
      infringementAssessment: 'not_evaluated',
      cover,
      usedRests: [],
      alternatives: [],
      reason: restingReason(cover),
      missing: [],
      needsController: false,
    }
  }
  const usedRests = restsTouching(longRests, earlier, later)
  if (qualified.length > 1) {
    return {
      ...base,
      status: 'not_evaluated',
      usedRests,
      alternatives: [],
      reason: 'Oba týdny leží ve více nepřerušených odpočincích. Model mezi nimi nevolí a žádný nerozděluje.',
      missing: ['jeden fyzický odpočinek pokrývající dvojici'],
      needsController: false,
    }
  }
  if (covering.length === 1) {
    const node = covering[0]!
    return {
      ...base,
      status: 'not_evaluated',
      usedRests,
      alternatives: [],
      reason: `Oba týdny leží v jednom nepřerušeném odpočinku, ale rezerva je ${formatSpan(marginBefore(node, earlier))} před dvojicí a ${formatSpan(marginAfter(node, later))} po ní. Model vyžaduje alespoň 3 hodiny na obou stranách. Je to technická podmínka hodin pondělí 00:00 UTC, ne zákonné pravidlo ani řešení časových pásem. Skladba podle čl. 8 odst. 6 se neposuzuje.`,
      missing: ['technická rezerva vůči hranici dvojice'],
      needsController: false,
    }
  }
  const oneWeek = longRests.some((node) => containsWeek(node, earlier) !== containsWeek(node, later))
  const separateNote = separate ? ' Ve dvojici je také samostatný odpočinek.' : ''
  return {
    ...base,
    status: 'not_evaluated',
    usedRests,
    alternatives: [],
    reason: oneWeek
      ? `Jen jeden týden dvojice leží celý v dlouhém nepřerušeném odpočinku. Druhý týden tento odpočinek pouze začíná nebo končí. Jeden fyzický interval se nerozděluje a týden zápočtu u odpočinku přes více než dva týdny nařízení neurčuje.${separateNote}`
      : `Dlouhý nepřerušený odpočinek zasahuje do dvojice jen okrajem. Průnik s týdnem není samostatný odpočinek.${separateNote}`,
    missing: ['jednoznačné právní započtení dlouhého nepřerušeného odpočinku'],
    needsController: false,
  }
}

function containsWeek(node: WeeklyAssignmentNode, week: Week): boolean {
  return node.startUtc <= week.startUtc && node.endUtc >= week.endUtc
}

function marginBefore(node: WeeklyAssignmentNode, earlier: Week): number {
  return earlier.startUtc - node.startUtc
}

function marginAfter(node: WeeklyAssignmentNode, later: Week): number {
  return node.endUtc - later.endUtc
}

function toCover(node: WeeklyAssignmentNode, earlier: Week, later: Week): RestingThroughoutCover {
  return {
    nodeId: node.id,
    startUtc: node.startUtc,
    endUtc: node.endUtc,
    sourceActivityIds: [...node.sourceActivityIds],
    weekOverlaps: node.possibleWeeks.map((week) => ({ ...week })),
    marginBeforeMs: marginBefore(node, earlier),
    marginAfterMs: marginAfter(node, later),
    technicalMarginMs: TECHNICAL_EDGE_MARGIN_MS,
  }
}

function restingReason(cover: RestingThroughoutCover): string {
  return `Oba týdny leží celé v jednom nepřerušeném odpočinku od ${new Date(cover.startUtc).toISOString()} do ${new Date(cover.endUtc).toISOString()}. Rezerva před dvojicí je ${formatSpan(cover.marginBeforeMs)} a po dvojici ${formatSpan(cover.marginAfterMs)}. Tříhodinová rezerva je technická podmínka tohoto modelu, ne zákonné pravidlo. Skladba podle čl. 8 odst. 6 se neposuzuje a z průniků se nedělají další odpočinky.`
}

function formatSpan(ms: number): string {
  const sign = ms < 0 ? '−' : ''
  const absolute = Math.abs(ms)
  const hours = Math.floor(absolute / (60 * 60 * 1000))
  const minutes = Math.floor((absolute % (60 * 60 * 1000)) / 60_000)
  return minutes === 0 ? `${sign}${hours} h` : `${sign}${hours} h ${minutes} min`
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
    const canPlace = node.possibleWeeks.some((week) => !chosen.has(week.weekId) && !overlapsOther(node, chosen))
    if (canPlace) return false
  }
  return true
}

function reconcileAdjacentAssignments(periods: ConsecutiveWeekPeriod[]): void {
  const fixed = new Map<string, { weekId: string; periods: ConsecutiveWeekPeriod[] }>()
  for (const period of periods) {
    if (period.status !== 'satisfied') continue
    for (const [nodeId, weekId] of fixedWeeks(period)) {
      const previous = fixed.get(nodeId)
      if (previous == null) {
        fixed.set(nodeId, { weekId, periods: [period] })
        continue
      }
      if (previous.weekId === weekId) {
        previous.periods.push(period)
        continue
      }
      for (const item of [...previous.periods, period]) markContradictory(item)
    }
  }
}

function fixedWeeks(period: ConsecutiveWeekPeriod): Map<string, string> {
  const weeks = new Map<string, Set<string>>()
  for (const alternative of period.alternatives) {
    for (const rest of alternative.rests) {
      const set = weeks.get(rest.nodeId) ?? new Set<string>()
      set.add(rest.weekId)
      weeks.set(rest.nodeId, set)
    }
  }
  const fixed = new Map<string, string>()
  for (const [nodeId, set] of weeks) {
    if (set.size === 1) fixed.set(nodeId, [...set][0]!)
  }
  return fixed
}

function markContradictory(period: ConsecutiveWeekPeriod): void {
  if (period.status !== 'satisfied') return
  period.status = 'ambiguous'
  period.needsController = true
  period.reason = 'Sousední dvojice by stejný odpočinek započetly k různým týdnům. Takové přiřazení není přípustné.'
}

function overlapsChosen(node: WeeklyAssignmentNode, chosen: ReadonlyMap<string, WeeklyAssignmentNode>): boolean {
  return overlapsOther(node, chosen)
}

function overlapsOther(node: WeeklyAssignmentNode, chosen: ReadonlyMap<string, WeeklyAssignmentNode>): boolean {
  return [...chosen.values()].some(
    (holder) => holder.id !== node.id && rangesOverlap(holder.startUtc, holder.endUtc, node.startUtc, node.endUtc),
  )
}

function toAlternative(chosen: ReadonlyMap<string, WeeklyAssignmentNode>, weekA: string, weekB: string): ConsecutiveWeekAlternative {
  const rests = [...chosen.entries()]
    .map(([weekId, node]) => toUse(node, weekId))
    .sort((left, right) => left.startUtc - right.startUtc || left.weekId.localeCompare(right.weekId))
  const counted = rests.filter((rest) => rest.weekId === weekA || rest.weekId === weekB)
  const classes = counted.map((rest) => rest.lengthClass)
  const regular = classes.filter((item) => item === 'regular').length
  const reduced = classes.filter((item) => item === 'reduced').length
  const meetsBasicRule = counted.length === 2 && (regular === 2 || (regular === 1 && reduced === 1))
  return {
    meetsBasicRule,
    rests,
    reason: describeAlternative(rests, weekA, weekB, meetsBasicRule),
  }
}

function describeAlternative(rests: readonly ConsecutiveWeekRestUse[], weekA: string, weekB: string, meets: boolean): string {
  const text = (weekId: string) => {
    const rest = rests.find((item) => item.weekId === weekId)
    if (rest == null) return 'bez započteného odpočinku'
    return rest.lengthClass === 'regular' ? 'běžný délkový kandidát' : 'zkrácený délkový kandidát'
  }
  const outside = rests.filter((rest) => rest.weekId !== weekA && rest.weekId !== weekB)
  const moved = outside.length === 0 ? '' : ` Mimo dvojici je započten ${outside.length === 1 ? 'jeden odpočinek' : `${outside.length} odpočinků`}.`
  return `Dřívější týden: ${text(weekA)}. Pozdější týden: ${text(weekB)}.${moved} ${meets ? 'Základní pravidlo vychází.' : 'Základní pravidlo nevychází.'}`
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
    resting_throughout: 0,
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
