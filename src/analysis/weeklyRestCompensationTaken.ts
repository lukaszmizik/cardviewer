import { buildWeeklyRestAssignment } from './weeklyRestAssignment.ts'
import type { WeeklyRestCandidate } from './weeklyRest.ts'
import {
  assessWeeklyRestCompensation,
  type WeeklyRestCompensationReport,
} from './weeklyRestCompensation.ts'

const HOUR_MS = 60 * 60 * 1000
const NINE_HOURS = 9 * HOUR_MS
const FORTY_FIVE_HOURS = 45 * HOUR_MS

export type CompensationFulfillmentStatus = 'open' | 'taken' | 'missed' | 'undecided'

export type CompensationFulfillmentReason =
  | 'completed_on_time'
  | 'deadline_not_reached'
  | 'not_completed_before_deadline'
  | 'record_incomplete'
  | 'alternative_outcomes'
  | 'obligation_not_unique'

export type CompensationSliceRole = 'host' | 'compensation' | 'weekly_rest'

/** Úsek jednoho souvislého odpočinku. Minuta patří nejvýše jedné roli. */
export type CompensationTimeSlice = {
  role: CompensationSliceRole
  startUtc: number
  endUtc: number
  durationMs: number
  obligationId: string | null
}

export type CompensationAllocation = {
  id: string
  restStartUtc: number
  restEndUtc: number
  sourceActivityIds: string[]
  slices: CompensationTimeSlice[]
  /** Hostitelský odpočinek a už započtený týdenní odpočinek se do náhrady nepočítají. */
  excludesHostRestAndWeeklyRest: true
  /** Vztah k dennímu 24hodinovému oknu se z délky náhrady neurčuje. */
  dailyWindowEffect: 'not_evaluated'
}

export type CompensationReading = {
  assignsObligation: boolean
  onTime: boolean
  satisfiedObligationIds: string[]
  allocations: CompensationAllocation[]
}

export type ObligationFulfillment = {
  obligationId: string
  status: CompensationFulfillmentStatus
  reason: CompensationFulfillmentReason
  readings: CompensationReading[]
  dailyWindowEffect: 'not_evaluated'
}

export type CompensationSearchRest = {
  startUtc: number
  endUtc: number
  sourceActivityIds: readonly string[]
  ambiguous?: boolean
  established?: boolean
}

export type WeeklyRestCompensationTakenReport = {
  clockBasis: 'monday_00_00_utc'
  /** Výsledek první fáze beze změny. Čerpání je až ve `fulfillments`. */
  compensation: WeeklyRestCompensationReport
  fulfillments: ObligationFulfillment[]
  doubleCountPrevented: true
  /** Mezinárodní výjimka se z činností na kartě nedokládá. */
  internationalEntitlement: 'not_inferred'
  dailyWindowEffect: 'not_evaluated'
  /** Částečný úsek není splněná náhrada. Náhrada se bere vcelku. */
  partialFulfillment: 'not_accepted'
}

type SolverObligation = {
  id: string
  compensationMs: number
  deadlineUtc: number
  restEndUtc: number
  sourceNodeId: string
}

type SearchRest = CompensationSearchRest & {
  minHostMs: number
  hostRole: 'host' | 'weekly_rest'
}

type Layout = {
  rest: SearchRest
  slices: CompensationTimeSlice[]
  obligationIds: string[]
  onTime: boolean
}

type Combo = {
  layouts: Layout[]
  satisfied: string[]
}

/**
 * U jednoznačně určených povinností hledá navazující odpočinek,
 * ve kterém lze náhradu oddělit od hostitelského odpočinku nejméně 9 hodin.
 * Dlouhý odpočinek sám o sobě náhradu neprokazuje.
 * Denní odpočinky ani jejich zkrácení se nepřepočítávají.
 */
export function assessWeeklyRestCompensationTaken(input: {
  candidates: readonly WeeklyRestCandidate[]
  rests: readonly CompensationSearchRest[]
  unknownIntervals?: readonly { startUtc: number; endUtc: number }[]
  recordEndUtc?: number | null
}): WeeklyRestCompensationTakenReport {
  const unknownIntervals = input.unknownIntervals ?? []
  const compensation = assessWeeklyRestCompensation(input)
  const assignment = buildWeeklyRestAssignment(input)
  const regularIds = new Set(assignment.nodes.filter((node) => node.lengthClass === 'regular' && !node.ambiguous).map((node) => node.id))
  const reducedIds = new Set(compensation.obligations.map((item) => item.sourceNodeId))
  const determined = compensation.obligations.filter(
    (item): item is typeof item & { deadlineUtc: number } => item.certainty === 'determined' && item.deadlineUtc != null,
  )
  const solverObligations: SolverObligation[] = determined.map((item) => ({
    id: item.id,
    compensationMs: item.compensationMs,
    deadlineUtc: item.deadlineUtc,
    restEndUtc: item.restEndUtc,
    sourceNodeId: item.sourceNodeId,
  }))
  const hosts = hostRests(input.rests, regularIds, reducedIds, input.recordEndUtc)
  const layoutsByRest = hosts.map((rest) => layoutsFor(rest, solverObligations))
  const onTimeCombos = maximal(combineOnTime(layoutsByRest))
  const fulfillments: ObligationFulfillment[] = []

  for (const item of compensation.obligations) {
    if (item.certainty !== 'determined' || item.deadlineUtc == null) {
      fulfillments.push(fulfillment(item.id, 'undecided', 'obligation_not_unique', []))
      continue
    }
    const obligation = solverObligations.find((entry) => entry.id === item.id)!
    const coverage = windowCoverage(obligation.restEndUtc, obligation.deadlineUtc, input.recordEndUtc, unknownIntervals)
    const unproven = unprovenHostInWindow(input.rests, obligation, unknownIntervals, input.recordEndUtc)
    const lateLayouts = layoutsByRest.flat().filter((layout) => !layout.onTime && layout.obligationIds.includes(obligation.id))
    const containing = onTimeCombos.filter((combo) => combo.satisfied.includes(obligation.id))
    const agreeing = onTimeCombos.length > 0 && onTimeCombos.every((combo) => combo.satisfied.includes(obligation.id))
    const conflicting = onTimeCombos.some((combo) => combo.satisfied.includes(obligation.id)) && !agreeing
    const splitDisagreement = hosts.some((_, index) => {
      const layouts = layoutsByRest[index] ?? []
      const onTime = layouts.some((layout) => layout.onTime && layout.obligationIds.includes(obligation.id))
      const late = layouts.some((layout) => !layout.onTime && layout.obligationIds.includes(obligation.id))
      return onTime && late
    })

    if (conflicting || (agreeing && splitDisagreement)) {
      const readings = conflicting
        ? onTimeCombos.map((combo) => readingFromCombo(combo, obligation.id))
        : [
            ...containing.map((combo) => readingFromCombo(combo, obligation.id)),
            ...lateLayouts.map((layout) => readingFromLayout(layout, obligation.id, false)),
          ]
      fulfillments.push(fulfillment(obligation.id, 'undecided', 'alternative_outcomes', readings))
      continue
    }
    if (agreeing) {
      fulfillments.push(
        fulfillment(
          obligation.id,
          'taken',
          'completed_on_time',
          containing.map((combo) => readingFromCombo(combo, obligation.id)),
        ),
      )
      continue
    }
    if (coverage === 'incomplete' || unproven) {
      fulfillments.push(fulfillment(obligation.id, 'undecided', 'record_incomplete', []))
      continue
    }
    if (coverage === 'not_reached') {
      fulfillments.push(fulfillment(obligation.id, 'open', 'deadline_not_reached', []))
      continue
    }
    fulfillments.push(
      fulfillment(
        obligation.id,
        'missed',
        'not_completed_before_deadline',
        lateLayouts.map((layout) => readingFromLayout(layout, obligation.id, false)),
      ),
    )
  }

  return {
    clockBasis: 'monday_00_00_utc',
    compensation,
    fulfillments,
    doubleCountPrevented: true,
    internationalEntitlement: 'not_inferred',
    dailyWindowEffect: 'not_evaluated',
    partialFulfillment: 'not_accepted',
  }
}

function hostRests(
  rests: readonly CompensationSearchRest[],
  regularIds: ReadonlySet<string>,
  reducedIds: ReadonlySet<string>,
  recordEndUtc: number | null | undefined,
): SearchRest[] {
  const hosts: SearchRest[] = []
  for (const rest of rests) {
    if (rest.ambiguous === true || rest.established === false) continue
    if (recordEndUtc == null || rest.endUtc >= recordEndUtc) continue
    if (rest.endUtc - rest.startUtc < NINE_HOURS) continue
    const id = restKey(rest)
    if (reducedIds.has(id)) continue
    const regular = regularIds.has(id)
    hosts.push({
      ...rest,
      minHostMs: regular ? FORTY_FIVE_HOURS : NINE_HOURS,
      hostRole: regular ? 'weekly_rest' : 'host',
    })
  }
  return hosts
}

function layoutsFor(rest: SearchRest, obligations: readonly SolverObligation[]): Layout[] {
  const eligible = obligations.filter(
    (item) => rest.startUtc >= item.restEndUtc && rest.endUtc - rest.startUtc >= item.compensationMs + rest.minHostMs,
  )
  const layouts: Layout[] = []
  for (const subset of subsets(eligible)) {
    if (subset.length === 0) continue
    for (const order of permutations(subset)) {
      for (let split = 0; split <= order.length; split += 1) {
        const left = order.slice(0, split)
        const right = order.slice(split)
        const sum = order.reduce((total, item) => total + item.compensationMs, 0)
        const hostMs = rest.endUtc - rest.startUtc - sum
        if (hostMs < rest.minHostMs) continue
        const built = place(rest, left, hostMs, right)
        if (built != null) layouts.push(built)
      }
    }
  }
  return layouts
}

function place(rest: SearchRest, left: readonly SolverObligation[], hostMs: number, right: readonly SolverObligation[]): Layout | null {
  const slices: CompensationTimeSlice[] = []
  let cursor = rest.startUtc
  const onTime = new Map<string, boolean>()
  for (const item of [...left, ...right]) onTime.set(item.id, false)
  for (const item of left) {
    const endUtc = cursor + item.compensationMs
    slices.push(compensationSlice(item, cursor, endUtc))
    onTime.set(item.id, endUtc <= item.deadlineUtc)
    cursor = endUtc
  }
  const hostEnd = cursor + hostMs
  slices.push({
    role: rest.hostRole,
    startUtc: cursor,
    endUtc: hostEnd,
    durationMs: hostMs,
    obligationId: null,
  })
  cursor = hostEnd
  for (const item of right) {
    const endUtc = cursor + item.compensationMs
    slices.push(compensationSlice(item, cursor, endUtc))
    onTime.set(item.id, endUtc <= item.deadlineUtc)
    cursor = endUtc
  }
  if (cursor !== rest.endUtc) return null
  const obligationIds = [...left, ...right].map((item) => item.id)
  return {
    rest,
    slices,
    obligationIds,
    onTime: obligationIds.every((id) => onTime.get(id) === true),
  }
}

function compensationSlice(item: SolverObligation, startUtc: number, endUtc: number): CompensationTimeSlice {
  return {
    role: 'compensation',
    startUtc,
    endUtc,
    durationMs: item.compensationMs,
    obligationId: item.id,
  }
}

function combineOnTime(layoutsByRest: readonly Layout[][]): Combo[] {
  const combos: Combo[] = []
  const chosen: Layout[] = []
  const used = new Set<string>()
  const walk = (index: number) => {
    if (index === layoutsByRest.length) {
      combos.push({ layouts: chosen.filter((layout) => layout.obligationIds.length > 0), satisfied: [...used] })
      return
    }
    const options = [null, ...(layoutsByRest[index] ?? []).filter((layout) => layout.onTime)]
    for (const layout of options) {
      if (layout != null && layout.obligationIds.some((id) => used.has(id))) continue
      if (layout != null) {
        for (const id of layout.obligationIds) used.add(id)
        chosen.push(layout)
      }
      walk(index + 1)
      if (layout != null) {
        chosen.pop()
        for (const id of layout.obligationIds) used.delete(id)
      }
    }
  }
  walk(0)
  return combos
}

function maximal(combos: readonly Combo[]): Combo[] {
  return combos.filter((combo, index) => {
    const mine = new Set(combo.satisfied)
    return !combos.some((other, otherIndex) => {
      if (otherIndex === index || other.satisfied.length <= combo.satisfied.length) return false
      return combo.satisfied.every((id) => other.satisfied.includes(id)) && other.satisfied.some((id) => !mine.has(id))
    })
  })
}

function windowCoverage(
  fromUtc: number,
  deadlineUtc: number,
  recordEndUtc: number | null | undefined,
  unknownIntervals: readonly { startUtc: number; endUtc: number }[],
): 'complete' | 'not_reached' | 'incomplete' {
  if (recordEndUtc == null) return 'incomplete'
  const until = Math.min(recordEndUtc, deadlineUtc)
  const unknown = unknownIntervals.some((interval) => interval.startUtc < until && interval.endUtc > fromUtc)
  if (unknown) return 'incomplete'
  if (recordEndUtc < deadlineUtc) return 'not_reached'
  return 'complete'
}

function unprovenHostInWindow(
  rests: readonly CompensationSearchRest[],
  obligation: SolverObligation,
  unknownIntervals: readonly { startUtc: number; endUtc: number }[],
  recordEndUtc: number | null | undefined,
): boolean {
  return rests.some((rest) => {
    const longEnough = rest.endUtc - rest.startUtc >= obligation.compensationMs + NINE_HOURS
    const follows = rest.startUtc >= obligation.restEndUtc && rest.startUtc < obligation.deadlineUtc
    if (!longEnough || !follows) return false
    const unprovenRest = rest.ambiguous === true || rest.established === false || (recordEndUtc != null && rest.endUtc >= recordEndUtc)
    const unknown = unknownIntervals.some((interval) => interval.startUtc < rest.endUtc && interval.endUtc > rest.startUtc)
    return unprovenRest || unknown
  })
}

function readingFromCombo(combo: Combo, obligationId: string): CompensationReading {
  return {
    assignsObligation: combo.satisfied.includes(obligationId),
    onTime: true,
    satisfiedObligationIds: [...combo.satisfied],
    allocations: combo.layouts.map(toAllocation),
  }
}

function readingFromLayout(layout: Layout, obligationId: string, onTime: boolean): CompensationReading {
  return {
    assignsObligation: layout.obligationIds.includes(obligationId),
    onTime,
    satisfiedObligationIds: onTime ? [...layout.obligationIds] : [],
    allocations: [toAllocation(layout)],
  }
}

function toAllocation(layout: Layout): CompensationAllocation {
  const host = layout.slices.find((slice) => slice.role !== 'compensation')
  return {
    id: `weekly-compensation-allocation:${layout.rest.startUtc}:${layout.obligationIds.join('+')}:${host?.startUtc ?? layout.rest.startUtc}`,
    restStartUtc: layout.rest.startUtc,
    restEndUtc: layout.rest.endUtc,
    sourceActivityIds: [...layout.rest.sourceActivityIds],
    slices: layout.slices.map((slice) => ({ ...slice })),
    excludesHostRestAndWeeklyRest: true,
    dailyWindowEffect: 'not_evaluated',
  }
}

function fulfillment(
  obligationId: string,
  status: CompensationFulfillmentStatus,
  reason: CompensationFulfillmentReason,
  readings: CompensationReading[],
): ObligationFulfillment {
  return { obligationId, status, reason, readings, dailyWindowEffect: 'not_evaluated' }
}

function restKey(rest: CompensationSearchRest): string {
  return `${rest.startUtc}:${rest.sourceActivityIds.join('+')}`
}

function subsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [[]]
  for (const item of items) {
    const next = out.map((entry) => [...entry, item])
    out.push(...next)
  }
  return out
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  const out: T[][] = []
  for (let index = 0; index < items.length; index += 1) {
    const rest = items.filter((_, itemIndex) => itemIndex !== index)
    for (const perm of permutations(rest)) out.push([items[index]!, ...perm])
  }
  return out
}
