import type { RestCandidate, RestCandidateKind } from './restCandidates.ts'
import type { DailyRestOption, DailyRestOptionPart, DailyRestVariantKind } from './dailyRestOptions.ts'
import { findDailyRestOptions } from './dailyRestOptions.ts'
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
  reducedDelta: number
  /** Kandidát má týdenní délkovou roli. Tato vrstva ji nerozhoduje. */
  weeklyRolePossible: boolean
  parts: DailyChainPart[]
}

export type DailyChainNodeStatus = 'evaluated' | 'window_unsatisfied' | 'insufficient_data'

export type DailyChainNode = {
  anchorUtc: number
  windowStartUtc: number
  windowEndUtc: number
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
 * Návazná 24hodinová období od explicitní kotvy.
 * Nevytváří přestupky a nevolí jednu interpretaci.
 * Další kotva je skutečný konec odpočinku, ne konec okna ani dosažení minima.
 */
export function buildDailyRestChain(
  anchorUtc: number,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly UnrecordedInterval[] = [],
): DailyRestChain {
  const nodes = new Map<number, DailyChainNode>()
  const order: number[] = []

  const nodeAt = (utc: number): DailyChainNode => {
    const existing = nodes.get(utc)
    if (existing) return existing
    const node = evaluateWindow(utc, candidates, unknownIntervals)
    nodes.set(utc, node)
    order.push(utc)
    return node
  }

  nodeAt(anchorUtc)
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
  nodeAt: (utc: number) => DailyChainNode,
  paths: DailyChainPath[],
): void {
  const node = nodeAt(anchorUtc)
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
): DailyChainNode {
  const windowStartUtc = anchorUtc
  const windowEndUtc = anchorUtc + DAILY_WINDOW_MS
  const base = { anchorUtc, windowStartUtc, windowEndUtc }
  const unknownOverlapsWindow = unknownIntervals.some((interval) =>
    rangesOverlap(windowStartUtc, windowEndUtc, interval.startUtc, interval.endUtc),
  )
  const options = findDailyRestOptions(candidates, anchorUtc).filter((option) =>
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

  return {
    ...base,
    status: 'window_unsatisfied',
    interpretations: continuations.map((candidate, index) =>
      interpretationFromContinuation(candidate, windowStartUtc, index),
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
    reducedDelta: option.kind === 'continuous_reduced' ? 1 : 0,
    weeklyRolePossible: matched.some(hasWeeklyLengthRole),
    parts: option.parts.map(toChainPart),
  }
}

function interpretationFromContinuation(
  candidate: RestCandidate,
  windowStartUtc: number,
  index: number,
): DailyChainInterpretation {
  const intersection = intersectRestWithDailyWindow(candidate, windowStartUtc)
  return {
    id: `${windowStartUtc}:window_unsatisfied:${index}`,
    kind: 'window_unsatisfied',
    qualifiesWindow: false,
    established: !candidate.ambiguous,
    nextAnchorUtc: candidate.endUtc,
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
