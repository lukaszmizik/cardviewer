import type { RestCandidate, RestCandidateKind } from './restCandidates.ts'
import type { DailyRestOption, DailyRestOptionPart, DailyRestVariantKind } from './dailyRestOptions.ts'
import { findDailyRestOptions } from './dailyRestOptions.ts'
import { CREW_WINDOW_MS, decideCrewDailyWindow, type CrewActivity, type CrewIntervalConfirmation, type CrewRecordCourse, type CrewUncertainInterval, type CrewWindowBasis } from './crewDailyRest.ts'
import { DAILY_WINDOW_MS, intersectRestWithDailyWindow } from './restWindowIntersection.ts'

const HOUR_MS = 60 * 60 * 1000
const NINE_HOURS = 9 * HOUR_MS

const WEEKLY_KINDS: readonly RestCandidateKind[] = ['weekly_reduced', 'weekly_regular']

/** Úsek bez záznamu. Není to odpočinek a nesmí se jím stát. */
export type UnrecordedInterval = {
  startUtc: number
  endUtc: number
}

export type DailyChainPart = {
  startUtc: number
  endUtc: number
  candidateMinutes: number
  restMinutesInsideWindow: number
  intersectionEndUtc: number | null
  sourceActivityIds: string[]
}

export type DailyChainInterpretation = {
  id: string
  kind: DailyRestVariantKind | 'window_unsatisfied'
  /** true jen když potřebné minimum leží uvnitř tohoto okna. */
  qualifiesWindow: boolean
  /** false při nejednoznačném intervalu. Není to právní platnost. */
  established: boolean
  /** Skutečný konec dokončujícího odpočinku. null, když další kotva není. */
  nextAnchorUtc: number | null
  /** true jen u odpočinku, který okno splnil a není nejednoznačný. */
  nextAnchorEstablished: boolean
  reducedDelta: number
  /** Kandidát má týdenní délkovou roli. Tato vrstva ji nerozhoduje. */
  weeklyRolePossible: boolean
  parts: DailyChainPart[]
}

export type DailyChainNodeStatus = 'evaluated' | 'window_unsatisfied' | 'history_incomplete' | 'insufficient_data'

export type DailyWindowMode = 'single_driver_24h' | 'crew_30h'

export type DailyChainNode = {
  anchorUtc: number
  windowStartUtc: number
  windowEndUtc: number
  windowMode: DailyWindowMode
  /** null, když volající aktivity s příznakem osádky nepředal. */
  crewRecord: CrewRecordCourse | null
  /** recorded je tachograf. confirmed je potvrzení nejistých úseků. */
  crewBasis: CrewWindowBasis | null
  uncertainIntervals: readonly CrewUncertainInterval[]
  /** Checkbox jen když 24 h nestačí a potvrzení otevře 30 h. */
  crewConfirmationAvailable: boolean
  /** false, když tato kotva vznikla z odpočinku, který okno nesplnil nebo není jednoznačný. */
  anchorEstablished: boolean
  status: DailyChainNodeStatus
  interpretations: DailyChainInterpretation[]
}

export type DailyChainStep = {
  anchorUtc: number
  interpretationId: string | null
}

export type DailyChainPath = {
  steps: DailyChainStep[]
  reducedCount: number
  /** Hranice týdenních odpočinků nejsou určené, limit tří se neposuzuje. */
  weeklyBoundariesDetermined: false
}

export type DailyRestChain = {
  startAnchorUtc: number
  nodes: DailyChainNode[]
  paths: DailyChainPath[]
}

/**
 * Návazná denní období od explicitní kotvy.
 * Nejdřív se vždy posoudí 24hodinové okno. Splněné 24hodinové okno zůstává,
 * i když se v období později objeví příznak osádky.
 * 30 hodin se zkouší jen když 24hodinové okno splněné není a záznam osádky
 * po první hodině je souvislý, nebo uživatel potvrdil právě jeho nejisté úseky.
 * Neprokázaná osádka 24hodinový výsledek nemění. Potvrzení přerušení nepokryje.
 * Nevytváří přestupky a nevolí jednu interpretaci.
 * Další kotva je skutečný konec odpočinku, ne konec okna ani dosažení minima.
 * Nejednoznačný odpočinek tuto kotvu neoznačí jako prokázanou.
 */
export function buildDailyRestChain(
  anchorUtc: number,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[] = [],
  /** Konec poslední zaznamenané aktivity. Bez něj se neúplné okno nerozliší. */
  recordEndUtc: number | null = null,
  activities: readonly CrewActivity[] = [],
  confirmations: readonly CrewIntervalConfirmation[] = [],
): DailyRestChain {
  const nodes = new Map<number, DailyChainNode>()
  const order: number[] = []

  const nodeAt = (utc: number, anchorEstablished: boolean): DailyChainNode => {
    const existing = nodes.get(utc)
    if (existing) {
      if (!anchorEstablished) existing.anchorEstablished = false
      return existing
    }
    const node = evaluateWindow(utc, candidates, unknownIntervals, recordEndUtc, activities, anchorEstablished, confirmations)
    nodes.set(utc, node)
    order.push(utc)
    return node
  }

  nodeAt(anchorUtc, true)
  const paths: DailyChainPath[] = []
  walk(anchorUtc, [], 0, new Set<number>(), nodeAt, paths)

  return {
    startAnchorUtc: anchorUtc,
    nodes: order.map((utc) => nodes.get(utc)!),
    paths,
  }
}

function walk(
  anchorUtc: number,
  steps: DailyChainStep[],
  reducedCount: number,
  seen: Set<number>,
  nodeAt: (utc: number, anchorEstablished: boolean) => DailyChainNode,
  paths: DailyChainPath[],
): void {
  const node = nodeAt(anchorUtc, true)
  if (node.interpretations.length === 0) {
    paths.push(finish([...steps, { anchorUtc, interpretationId: null }], reducedCount))
    return
  }

  for (const interpretation of node.interpretations) {
    const nextSteps = [...steps, { anchorUtc, interpretationId: interpretation.id }]
    const nextReduced = reducedCount + interpretation.reducedDelta
    const nextAnchor = interpretation.nextAnchorUtc
    if (nextAnchor == null || nextAnchor <= anchorUtc || seen.has(nextAnchor)) {
      paths.push(finish(nextSteps, nextReduced))
      continue
    }
    const nextSeen = new Set(seen)
    nextSeen.add(anchorUtc)
    nodeAt(nextAnchor, interpretation.nextAnchorEstablished)
    walk(nextAnchor, nextSteps, nextReduced, nextSeen, nodeAt, paths)
  }
}

function finish(steps: DailyChainStep[], reducedCount: number): DailyChainPath {
  return { steps, reducedCount, weeklyBoundariesDetermined: false }
}

function evaluateWindow(
  anchorUtc: number,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[],
  recordEndUtc: number | null,
  activities: readonly CrewActivity[],
  anchorEstablished: boolean,
  confirmations: readonly CrewIntervalConfirmation[],
): DailyChainNode {
  const decision = activities.length === 0
    ? null
    : decideCrewDailyWindow({ windowStartUtc: anchorUtc, activities, unknownIntervals, confirmedIntervals: confirmations })
  const attach = (node: Omit<DailyChainNode, 'crewBasis' | 'uncertainIntervals' | 'crewConfirmationAvailable'>, basis: CrewWindowBasis | null, available: boolean): DailyChainNode => ({
    ...node,
    crewBasis: basis,
    uncertainIntervals: decision?.uncertainIntervals ?? [],
    crewConfirmationAvailable: available,
  })
  const standard = evaluateFixedWindow(
    anchorUtc,
    candidates,
    unknownIntervals,
    recordEndUtc,
    anchorEstablished,
    decision?.crewRecord ?? null,
    DAILY_WINDOW_MS,
    'single_driver_24h',
  )
  if (standard.status === 'evaluated') return attach(standard, null, false)
  const accepted = decision?.applies === true
    ? evaluateFixedWindow(
      anchorUtc,
      candidates,
      unknownIntervals,
      recordEndUtc,
      anchorEstablished,
      decision.crewRecord,
      CREW_WINDOW_MS,
      'crew_30h',
    )
    : null
  if (accepted?.status === 'evaluated' && decision != null) return attach(accepted, decision.basis, decision.basis === 'confirmed')
  const available = decision?.crewRecord === 'crew_record_uncertain'
    && decision.uncertainIntervals.length > 0
    && decideCrewDailyWindow({
      windowStartUtc: anchorUtc,
      activities,
      unknownIntervals,
      confirmedIntervals: decision.uncertainIntervals.map((interval) => ({
        windowStartUtc: anchorUtc,
        startUtc: interval.startUtc,
        endUtc: interval.endUtc,
      })),
    }).applies
    && evaluateFixedWindow(
      anchorUtc,
      candidates,
      unknownIntervals,
      recordEndUtc,
      anchorEstablished,
      decision.crewRecord,
      CREW_WINDOW_MS,
      'crew_30h',
    ).status === 'evaluated'
  return attach(standard, null, available)
}

function evaluateFixedWindow(
  anchorUtc: number,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[],
  recordEndUtc: number | null,
  anchorEstablished: boolean,
  crewRecord: CrewRecordCourse | null,
  windowMs: number,
  windowMode: DailyWindowMode,
): DailyChainNode {
  const windowStartUtc = anchorUtc
  const windowEndUtc = anchorUtc + windowMs
  const base = {
    anchorUtc,
    windowStartUtc,
    windowEndUtc,
    windowMode,
    crewRecord,
    crewBasis: null,
    uncertainIntervals: [],
    crewConfirmationAvailable: false,
    anchorEstablished,
  }
  const unknownOverlapsWindow = unknownIntervals.some((interval) =>
    rangesOverlap(windowStartUtc, windowEndUtc, interval.startUtc, interval.endUtc),
  )
  const options = findDailyRestOptions(candidates, anchorUtc, windowMs).filter((option) =>
    option.parts.every((part) => !intersectsUnknown(part.startUtc, part.endUtc, unknownIntervals)),
  )

  if (unknownOverlapsWindow && options.length === 0) {
    return { ...base, status: 'insufficient_data', interpretations: [] }
  }

  if (options.length > 0) {
    return {
      ...base,
      status: 'evaluated',
      interpretations: options.map((option, index) =>
        interpretationFromOption(option, index, candidates),
      ),
    }
  }

  const continuations = candidates
    .filter((candidate) => continuesPastWindow(candidate, windowEndUtc, unknownIntervals))
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)

  if (continuations.length === 0 && recordEndUtc != null && recordEndUtc < windowEndUtc) {
    return { ...base, status: 'history_incomplete', interpretations: [] }
  }

  return {
    ...base,
    status: 'window_unsatisfied',
    interpretations: continuations.map((candidate, index) =>
      interpretationFromContinuation(candidate, windowStartUtc, windowMs, index),
    ),
  }
}

function interpretationFromOption(
  option: DailyRestOption,
  index: number,
  candidates: readonly RestCandidate[],
): DailyChainInterpretation {
  const completing = option.parts[option.parts.length - 1]!
  const matched = candidates.filter((candidate) =>
    option.parts.some((part) => sameRest(candidate, part)),
  )
  return {
    id: `${option.windowStartUtc}:${option.kind}:${index}`,
    kind: option.kind,
    qualifiesWindow: true,
    established: option.established,
    nextAnchorUtc: completing.endUtc,
    nextAnchorEstablished: option.established,
    reducedDelta: option.kind === 'continuous_reduced' ? 1 : 0,
    weeklyRolePossible: matched.some(hasWeeklyLengthRole),
    parts: option.parts.map(toChainPart),
  }
}

function interpretationFromContinuation(
  candidate: RestCandidate,
  windowStartUtc: number,
  windowMs: number,
  index: number,
): DailyChainInterpretation {
  const intersection = intersectRestWithDailyWindow(candidate, windowStartUtc, windowMs)
  return {
    id: `${windowStartUtc}:window_unsatisfied:${index}`,
    kind: 'window_unsatisfied',
    qualifiesWindow: false,
    established: !candidate.ambiguous,
    nextAnchorUtc: candidate.endUtc,
    nextAnchorEstablished: false,
    reducedDelta: 0,
    weeklyRolePossible: hasWeeklyLengthRole(candidate),
    parts: [
      {
        startUtc: candidate.startUtc,
        endUtc: candidate.endUtc,
        candidateMinutes: intersection.candidateMinutes,
        restMinutesInsideWindow: intersection.restMinutesInsideWindow,
        intersectionEndUtc: intersection.intersectionEndUtc,
        sourceActivityIds: [...candidate.sourceActivityIds],
      },
    ],
  }
}

function continuesPastWindow(
  candidate: RestCandidate,
  windowEndUtc: number,
  unknownIntervals: readonly UnrecordedInterval[],
): boolean {
  if (candidate.endUtc <= windowEndUtc || candidate.startUtc >= windowEndUtc) return false
  if (candidate.durationMs < NINE_HOURS) return false
  if (intersectsUnknown(candidate.startUtc, candidate.endUtc, unknownIntervals)) return false
  return true
}

function toChainPart(part: DailyRestOptionPart): DailyChainPart {
  return {
    startUtc: part.startUtc,
    endUtc: part.endUtc,
    candidateMinutes: part.candidateMinutes,
    restMinutesInsideWindow: part.restMinutesInsideWindow,
    intersectionEndUtc: part.intersectionEndUtc,
    sourceActivityIds: [...part.sourceActivityIds],
  }
}

function sameRest(candidate: RestCandidate, part: DailyRestOptionPart): boolean {
  return (
    candidate.startUtc === part.startUtc &&
    candidate.endUtc === part.endUtc &&
    sameIds(candidate.sourceActivityIds, part.sourceActivityIds)
  )
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function hasWeeklyLengthRole(candidate: RestCandidate): boolean {
  return candidate.kinds.some((kind) => WEEKLY_KINDS.includes(kind))
}

function intersectsUnknown(
  startUtc: number,
  endUtc: number,
  unknownIntervals: readonly UnrecordedInterval[],
): boolean {
  return unknownIntervals.some((interval) =>
    rangesOverlap(startUtc, endUtc, interval.startUtc, interval.endUtc),
  )
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}
