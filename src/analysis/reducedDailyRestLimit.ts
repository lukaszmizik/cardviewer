import type { DailyChainInterpretation, DailyChainNode, DailyRestChain } from './dailyRestChain.ts'
import type { FerryRestCandidate } from './ferryRestCandidates.ts'
import type { WeeklyRestCandidate } from './weeklyRest.ts'

/**
 * Čl. 8 odst. 4 nařízení (ES) č. 561/2006.
 * Počítá už klasifikované denní odpočinky mezi prokázanými týdenními odpočinky.
 * Nové denní odpočinky nesestavuje a GN7 okna nepřevádí na odpočinky.
 */
export type ReducedDailyRestKind =
  | 'regular_11h'
  | 'split_3_9'
  | 'reduced_9h'
  | 'weekly_reduced'
  | 'weekly_regular'

export type ReducedDailyRestLimitStatus = 'compliant' | 'violation' | 'needs_verification'

export type ReducedDailyRestUncertainty =
  | 'interval_start_unknown'
  | 'unknown_interval'
  | 'ambiguous_classification'
  | 'ferry_unverified'
  | 'crew_conditional'
  | 'anchor_unestablished'
  | 'history_incomplete'

export type ReducedDailyRestAssessment = {
  startUtc: number
  endUtc: number
  kind: ReducedDailyRestKind
  /** Potvrzená zkrácení od posledního prokázaného týdenního odpočinku, bez tohoto odpočinku. */
  confirmedReducedBefore: number
  /**
   * Další zkrácení, která v intervalu mohou být, ale nejsou potvrzená.
   * null znamená, že horní hranice nejde určit.
   */
  possibleReducedBefore: number | null
  /** Pořadí tohoto odpočinku, jen když je sám potvrzené zkrácení. */
  reductionOrder: number | null
  intervalStartKnown: boolean
  intervalStartUtc: number | null
  status: ReducedDailyRestLimitStatus
  reason: string
  uncertainty: ReducedDailyRestUncertainty | null
}

export type AssessReducedDailyRestLimitInput = {
  chain: DailyRestChain | null
  weeklyCandidates: readonly WeeklyRestCandidate[]
  unknownIntervals?: readonly { startUtc: number; endUtc: number }[]
  ferryCandidates?: readonly FerryRestCandidate[]
}

type ProvenWeekly = {
  startUtc: number
  endUtc: number
  kind: 'weekly_reduced' | 'weekly_regular'
}

type Cursor = {
  confirmed: number
  possibleExtra: number
  /** Neznámý úsek nebo neustavená kotva. 11 h jistotu nevrací. */
  sequenceBroken: boolean
  breakUncertainty: ReducedDailyRestUncertainty | null
  intervalStartUtc: number | null
  intervalStartKnown: boolean
}

export function assessReducedDailyRestLimit(input: AssessReducedDailyRestLimitInput): ReducedDailyRestAssessment[] {
  const chain = input.chain
  if (chain == null) return []
  const unknowns = input.unknownIntervals ?? []
  const ferries = input.ferryCandidates ?? []
  const weeklies = provenWeeklies(input.weeklyCandidates, unknowns)
  const seen = new Set<string>()
  const assessments: ReducedDailyRestAssessment[] = []
  const cursor = emptyCursor()
  let weeklyIndex = 0

  const opening = weeklies.find((weekly) => weekly.endUtc === chain.startAnchorUtc)
  if (opening != null) {
    openInterval(cursor, opening.endUtc)
    weeklyIndex = weeklies.findIndex((weekly) => weekly === opening) + 1
  }

  const nodes = [...chain.nodes].sort((left, right) => left.anchorUtc - right.anchorUtc)
  for (const node of nodes) {
    weeklyIndex = flushWeeklies(weeklies, weeklyIndex, node.anchorUtc, cursor)
    if (cursor.intervalStartKnown && cursor.intervalStartUtc != null && overlapsAny(cursor.intervalStartUtc, node.anchorUtc, unknowns)) {
      cursor.sequenceBroken = true
      cursor.breakUncertainty = 'unknown_interval'
    } else if (!cursor.intervalStartKnown && overlapsAny(chain.startAnchorUtc, node.anchorUtc, unknowns)) {
      cursor.sequenceBroken = true
      cursor.breakUncertainty = 'unknown_interval'
    }
    if (!node.anchorEstablished) {
      cursor.sequenceBroken = true
      cursor.breakUncertainty = 'anchor_unestablished'
    }
    if (node.status === 'history_incomplete' || node.status === 'insufficient_data') {
      cursor.sequenceBroken = true
      cursor.breakUncertainty = 'history_incomplete'
    }

    const classified = classifyNode(node, weeklies, ferries)
    if (classified == null) continue
    const key = `${classified.startUtc}:${classified.endUtc}:${classified.kind}`
    if (seen.has(key)) continue
    seen.add(key)

    if (classified.kind === 'weekly_reduced' || classified.kind === 'weekly_regular') {
      assessments.push(boundaryAssessment(classified, cursor))
      openInterval(cursor, classified.endUtc)
      weeklyIndex = Math.max(weeklyIndex, weeklies.findIndex((weekly) => weekly.endUtc === classified.endUtc && weekly.startUtc === classified.startUtc) + 1)
      continue
    }

    if (classified.kind === 'regular_11h' || classified.kind === 'split_3_9') {
      assessments.push(neutralAssessment(classified, cursor))
      continue
    }

    assessments.push(reducedAssessment(classified, cursor))
  }
  return assessments
}

function emptyCursor(): Cursor {
  return {
    confirmed: 0,
    possibleExtra: 0,
    sequenceBroken: false,
    breakUncertainty: null,
    intervalStartUtc: null,
    intervalStartKnown: false,
  }
}

function openInterval(cursor: Cursor, endUtc: number) {
  cursor.confirmed = 0
  cursor.possibleExtra = 0
  cursor.sequenceBroken = false
  cursor.breakUncertainty = null
  cursor.intervalStartUtc = endUtc
  cursor.intervalStartKnown = true
}

function flushWeeklies(weeklies: readonly ProvenWeekly[], index: number, upToUtc: number, cursor: Cursor): number {
  let next = index
  while (next < weeklies.length && weeklies[next]!.endUtc <= upToUtc) {
    openInterval(cursor, weeklies[next]!.endUtc)
    next += 1
  }
  return next
}

function provenWeeklies(
  candidates: readonly WeeklyRestCandidate[],
  unknowns: readonly { startUtc: number; endUtc: number }[],
): ProvenWeekly[] {
  return candidates
    .filter((candidate) => candidate.established && !candidate.ambiguous && !overlapsAny(candidate.startUtc, candidate.endUtc, unknowns))
    .map((candidate) => ({
      startUtc: candidate.startUtc,
      endUtc: candidate.endUtc,
      kind: candidate.lengthClass === 'regular' ? 'weekly_regular' as const : 'weekly_reduced' as const,
    }))
    .sort((left, right) => left.endUtc - right.endUtc || left.startUtc - right.startUtc)
}

type ClassifiedRest = {
  kind: ReducedDailyRestKind
  startUtc: number
  endUtc: number
  uncertain: ReducedDailyRestUncertainty | null
}

function classifyNode(
  node: DailyChainNode,
  weeklies: readonly ProvenWeekly[],
  ferries: readonly FerryRestCandidate[],
): ClassifiedRest | null {
  const qualifying = node.interpretations.filter((item) => item.qualifiesWindow && item.kind !== 'window_unsatisfied')
  if (qualifying.length === 0) return null
  const established = qualifying.filter((item) => item.established)
  const usable = established.length > 0 ? established : qualifying
  const chosen = earliestCompletions(usable)
  const weekly = chosen
    .map((item) => ({ item, weekly: matchingWeekly(item, weeklies) }))
    .find((entry) => entry.weekly != null)
  if (weekly?.weekly != null) {
    return {
      kind: weekly.weekly.kind,
      startUtc: weekly.weekly.startUtc,
      endUtc: weekly.weekly.endUtc,
      uncertain: null,
    }
  }
  if (chosen.some((item) => item.kind === 'split_regular')) {
    const split = chosen.find((item) => item.kind === 'split_regular')!
    return {
      kind: 'split_3_9',
      ...interpretationBounds(split),
      uncertain: split.established ? null : 'ambiguous_classification',
    }
  }
  const reduced = uniqueByBounds(chosen.filter((item) => item.kind === 'continuous_reduced'))
  const regular = uniqueByBounds(chosen.filter((item) => item.kind === 'continuous_regular'))
  if (reduced.length === 0 && regular.length > 0) {
    return { kind: 'regular_11h', ...regular[0]!, uncertain: regular.length > 1 || established.length === 0 ? 'ambiguous_classification' : null }
  }
  if (reduced.length === 0) return null
  const bounds = reduced[0]!
  let uncertain: ReducedDailyRestUncertainty | null = null
  if (node.crewBasis === 'conditional') uncertain = 'crew_conditional'
  else if (!node.anchorEstablished) uncertain = 'anchor_unestablished'
  else if (reduced.length > 1 || regular.length > 0 || established.length === 0) uncertain = 'ambiguous_classification'
  else if (ferries.some((candidate) => ferryMayReclassify(candidate, bounds.startUtc, bounds.endUtc))) uncertain = 'ferry_unverified'
  return { kind: 'reduced_9h', ...bounds, uncertain }
}

function earliestCompletions(items: readonly DailyChainInterpretation[]): DailyChainInterpretation[] {
  const earliest = items.reduce((min, item) => Math.min(min, interpretationBounds(item).endUtc), Number.POSITIVE_INFINITY)
  return items.filter((item) => interpretationBounds(item).endUtc === earliest)
}

function reducedAssessment(rest: ClassifiedRest, cursor: Cursor): ReducedDailyRestAssessment {
  const confirmedReducedBefore = cursor.confirmed
  const possibleReducedBefore = cursor.sequenceBroken ? null : cursor.possibleExtra
  if (rest.uncertain != null) {
    if (!cursor.sequenceBroken) cursor.possibleExtra += 1
    return {
      ...baseAssessment(rest, cursor, confirmedReducedBefore, possibleReducedBefore),
      reductionOrder: null,
      status: 'needs_verification',
      reason: uncertaintyReason(rest.uncertain),
      uncertainty: rest.uncertain,
    }
  }
  if (!cursor.intervalStartKnown || cursor.sequenceBroken) {
    return {
      ...baseAssessment(rest, cursor, confirmedReducedBefore, possibleReducedBefore),
      reductionOrder: null,
      status: 'needs_verification',
      reason: cursor.sequenceBroken
        ? uncertaintyReason(cursor.breakUncertainty ?? 'unknown_interval')
        : 'Před tímto zkrácením není prokázaný začátek intervalu po týdenním odpočinku.',
      uncertainty: cursor.sequenceBroken ? cursor.breakUncertainty ?? 'unknown_interval' : 'interval_start_unknown',
    }
  }
  const order = cursor.confirmed + 1
  cursor.confirmed = order
  const minimumOrder = order
  const maximumOrder = possibleReducedBefore == null ? null : order + possibleReducedBefore
  const status: ReducedDailyRestLimitStatus = minimumOrder >= 4
    ? 'violation'
    : maximumOrder != null && maximumOrder <= 3
      ? 'compliant'
      : 'needs_verification'
  return {
    ...baseAssessment(rest, cursor, confirmedReducedBefore, possibleReducedBefore),
    reductionOrder: order,
    status,
    reason: status === 'violation'
      ? 'Překročen maximální počet tří zkrácených denních odpočinků mezi dvěma týdenními odpočinky.'
      : status === 'compliant'
        ? `Zkrácení ${order} z 3 mezi týdenními odpočinky je v limitu.`
        : 'Potvrzený počet zkrácení ještě není čtyři, ale nepotvrzená zkrácení ho mohou překročit.',
    uncertainty: status === 'needs_verification' ? 'ambiguous_classification' : null,
  }
}

function neutralAssessment(rest: ClassifiedRest, cursor: Cursor): ReducedDailyRestAssessment {
  const uncertain = !cursor.intervalStartKnown || cursor.sequenceBroken || rest.uncertain != null
  return {
    ...baseAssessment(rest, cursor, cursor.confirmed, cursor.sequenceBroken ? null : cursor.possibleExtra),
    reductionOrder: null,
    status: uncertain ? 'needs_verification' : 'compliant',
    reason: rest.kind === 'split_3_9'
      ? 'Dělený odpočinek 3+9 je běžný denní odpočinek a počet zkrácení nemění.'
      : 'Běžný denní odpočinek počet zkrácení nemění.',
    uncertainty: rest.uncertain ?? (cursor.sequenceBroken ? cursor.breakUncertainty : !cursor.intervalStartKnown ? 'interval_start_unknown' : null),
  }
}

function boundaryAssessment(rest: ClassifiedRest, cursor: Cursor): ReducedDailyRestAssessment {
  return {
    ...baseAssessment(rest, cursor, cursor.confirmed, cursor.sequenceBroken ? null : cursor.possibleExtra),
    reductionOrder: null,
    status: 'compliant',
    reason: 'Prokázaný týdenní odpočinek uzavírá interval a počet zkrácení se vrací na nulu.',
    uncertainty: null,
  }
}

function baseAssessment(
  rest: ClassifiedRest,
  cursor: Cursor,
  confirmedReducedBefore: number,
  possibleReducedBefore: number | null,
): Omit<ReducedDailyRestAssessment, 'reductionOrder' | 'status' | 'reason' | 'uncertainty'> {
  return {
    startUtc: rest.startUtc,
    endUtc: rest.endUtc,
    kind: rest.kind,
    confirmedReducedBefore,
    possibleReducedBefore,
    intervalStartKnown: cursor.intervalStartKnown,
    intervalStartUtc: cursor.intervalStartUtc,
  }
}

function uncertaintyReason(uncertainty: ReducedDailyRestUncertainty): string {
  if (uncertainty === 'ferry_unverified') return 'Neověřený trajektový odpočinek může změnit kvalifikaci. Zkrácení není potvrzené.'
  if (uncertainty === 'crew_conditional') return 'Podmíněná osádka nepotvrzuje, jak se devítihodinový odpočinek započte do limitu tří zkrácení.'
  if (uncertainty === 'ambiguous_classification') return 'Klasifikace odpočinku není jednoznačná. Počet zkrácení zůstává otevřený.'
  if (uncertainty === 'anchor_unestablished') return 'Kotva denního období není prokázaná. Počet zkrácení nelze potvrdit.'
  if (uncertainty === 'history_incomplete') return 'Historie denního období není úplná. Počet zkrácení nelze potvrdit.'
  if (uncertainty === 'unknown_interval') return 'Neznámý úsek může skrývat další zkrácení nebo týdenní odpočinek.'
  return 'Před tímto zkrácením není prokázaný začátek intervalu po týdenním odpočinku.'
}

function matchingWeekly(item: DailyChainInterpretation, weeklies: readonly ProvenWeekly[]): ProvenWeekly | null {
  const bounds = interpretationBounds(item)
  return weeklies.find((weekly) => weekly.startUtc === bounds.startUtc && weekly.endUtc === bounds.endUtc) ?? null
}

function interpretationBounds(item: DailyChainInterpretation): { startUtc: number; endUtc: number } {
  const first = item.parts[0]
  const last = item.parts[item.parts.length - 1]
  return {
    startUtc: first?.startUtc ?? item.nextAnchorUtc ?? 0,
    endUtc: last?.endUtc ?? item.nextAnchorUtc ?? 0,
  }
}

function uniqueByBounds(items: readonly DailyChainInterpretation[]): Array<{ startUtc: number; endUtc: number }> {
  const unique: Array<{ startUtc: number; endUtc: number }> = []
  for (const item of items) {
    const bounds = interpretationBounds(item)
    if (unique.some((entry) => entry.startUtc === bounds.startUtc && entry.endUtc === bounds.endUtc)) continue
    unique.push(bounds)
  }
  return unique
}

function ferryMayReclassify(candidate: FerryRestCandidate, startUtc: number, endUtc: number): boolean {
  if (!candidate.timeConditionsMet || candidate.legalApplicability === 'not_applicable') return false
  if (candidate.qualification !== 'regular_daily' && candidate.qualification !== 'reduced_weekly' && candidate.qualification !== 'regular_weekly') return false
  return startUtc < candidate.endUtc && candidate.startUtc < endUtc
}

function overlapsAny(startUtc: number, endUtc: number, intervals: readonly { startUtc: number; endUtc: number }[]): boolean {
  return intervals.some((interval) => startUtc < interval.endUtc && interval.startUtc < endUtc)
}
