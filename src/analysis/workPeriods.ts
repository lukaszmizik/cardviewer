import { findRestIntervals, type RestInterval } from './restIntervals.ts'
import type { Activity, ActivityKind, DriverCardData, VehicleUse } from '../types/tacho.ts'

const WORK_KINDS: readonly ActivityKind[] = ['driving', 'work', 'availability']

/** Odvozený přechod přítomnosti karty. Není ověřené fyzické vložení/vyjmutí. */
export type CardPresentEdge = {
  atUtc: number
  present: boolean
  slot: 1 | 2
}

export type CardPresentSupportLevel = 'none' | 'one_sided' | 'two_sided'

/** Událost nebo interval poškozující spolehlivost času. */
export type TimeOverlapSpan = {
  startUtc: number
  endUtc: number
  sourceId?: string
}

export type CandidateCutSupport = 'card_present_edge' | 'vehicle_use_gap'

export type CandidateCutBlocker = 'unknown' | 'manual_only' | 'time_overlap_event'

export type CandidateCutUncertainty = 'unknown_in_corridor' | 'one_sided_card_present'

export type CandidateCutRestSegment = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
  slot: 1 | 2 | null
}

export type CandidateCutUnknownSpan = {
  startUtc: number
  endUtc: number
}

export type CandidateCut = {
  previousWorkEndUtc: number
  nextWorkStartUtc: number
  restSegments: CandidateCutRestSegment[]
  unknownInCorridor: CandidateCutUnknownSpan[]
  cardPresentSupport: CardPresentSupportLevel
  support: CandidateCutSupport[]
  blockers: CandidateCutBlocker[]
  uncertainties: CandidateCutUncertainty[]
}

export type WorkEnvelopeBlocker = {
  kind: CandidateCutBlocker
  startUtc: number
  endUtc: number
}

export type WorkEnvelope = {
  startUtc: number | null
  endUtc: number | null
  /** Bez unknown v rozsahu obálky. Neznamená jistou hranici pracovní doby. */
  dataComplete: boolean
  workActivityIds: string[]
  cuts: CandidateCut[]
  blockers: WorkEnvelopeBlocker[]
}

export type AssessWorkPeriodsInput = {
  activities: readonly Activity[]
  vehicleUses?: readonly VehicleUse[]
  /** Volitelně; bez něj se card_present_edge nepoužije. */
  cardPresentEdges?: readonly CardPresentEdge[]
  timeOverlapSpans?: readonly TimeOverlapSpan[]
}

type CutGroupKey = `${number}|${number}`

type CutGroup = {
  previousWorkEndUtc: number
  nextWorkStartUtc: number
  restSegments: CandidateCutRestSegment[]
}

/**
 * Jedna obálka práce včetně vnitřních odpočinků a kandidátních předělů.
 * Nezávislé na denním řetězci a nařízení 561/2006.
 */
export function assessWorkPeriods(input: AssessWorkPeriodsInput): WorkEnvelope {
  const work = usableWork(input.activities)
  if (work.length === 0) {
    return emptyEnvelope()
  }

  const startUtc = Math.min(...work.map((item) => item.startUtc))
  const endUtc = Math.max(...work.map((item) => item.endUtc))
  const workActivityIds = work.map((item) => item.id)
  const dataComplete = !input.activities.some(
    (activity) => activity.kind === 'unknown' && overlaps(activity.startUtc, activity.endUtc, startUtc, endUtc),
  )

  const envelopeBlockers = localizedBlockers(input.activities, input.timeOverlapSpans, startUtc, endUtc)
  const rests = findRestIntervals(input.activities).filter((rest) =>
    overlaps(rest.startUtc, rest.endUtc, startUtc, endUtc),
  )

  const groups = new Map<CutGroupKey, CutGroup>()
  for (const rest of rests) {
    const previousWorkEndUtc = latestWorkEndBefore(work, rest.startUtc)
    const nextWorkStartUtc = earliestWorkStartAfter(work, rest.endUtc)
    if (previousWorkEndUtc == null || nextWorkStartUtc == null) continue
    if (previousWorkEndUtc > rest.startUtc || nextWorkStartUtc < rest.endUtc) continue
    if (hasWorkBetween(work, previousWorkEndUtc, rest.startUtc) || hasWorkBetween(work, rest.endUtc, nextWorkStartUtc)) {
      continue
    }

    const key: CutGroupKey = `${previousWorkEndUtc}|${nextWorkStartUtc}`
    const segment = restSegmentFromInterval(rest)
    const existing = groups.get(key)
    if (existing) {
      if (!existing.restSegments.some((item) => item.startUtc === segment.startUtc && item.endUtc === segment.endUtc)) {
        existing.restSegments.push(segment)
      }
    } else {
      groups.set(key, {
        previousWorkEndUtc,
        nextWorkStartUtc,
        restSegments: [segment],
      })
    }
  }

  const cuts: CandidateCut[] = []
  for (const group of groups.values()) {
    group.restSegments.sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
    const slot = slotForCut(work, group.previousWorkEndUtc, group.nextWorkStartUtc, group.restSegments)
    const cardPresentSupport = evaluateCardPresentSupport(
      input.cardPresentEdges,
      slot,
      group.previousWorkEndUtc,
      group.nextWorkStartUtc,
      group.restSegments,
    )
    const support: CandidateCutSupport[] = []
    if (cardPresentSupport === 'one_sided' || cardPresentSupport === 'two_sided') {
      support.push('card_present_edge')
    }
    if (
      hasVehicleUseGapForCorridor(
        input.vehicleUses,
        group.previousWorkEndUtc,
        group.nextWorkStartUtc,
        group.restSegments,
      )
    ) {
      support.push('vehicle_use_gap')
    }
    if (support.length === 0) continue

    const unknownInCorridor = unknownSpansInCorridor(
      input.activities,
      group.previousWorkEndUtc,
      group.nextWorkStartUtc,
    )
    const blockers = cutBlockers(
      input.activities,
      input.timeOverlapSpans,
      work,
      group.restSegments,
      group.previousWorkEndUtc,
      group.nextWorkStartUtc,
    )
    const uncertainties: CandidateCutUncertainty[] = []
    if (unknownInCorridor.length > 0) {
      uncertainties.push('unknown_in_corridor')
      if (!blockers.includes('unknown')) blockers.push('unknown')
    }
    if (cardPresentSupport === 'one_sided') {
      uncertainties.push('one_sided_card_present')
    }

    cuts.push({
      previousWorkEndUtc: group.previousWorkEndUtc,
      nextWorkStartUtc: group.nextWorkStartUtc,
      restSegments: group.restSegments.map((segment) => ({
        ...segment,
        sourceActivityIds: [...segment.sourceActivityIds],
      })),
      unknownInCorridor,
      cardPresentSupport,
      support,
      blockers,
      uncertainties,
    })
  }

  return {
    startUtc,
    endUtc,
    dataComplete,
    workActivityIds,
    cuts: cuts.sort((a, b) => a.previousWorkEndUtc - b.previousWorkEndUtc || a.nextWorkStartUtc - b.nextWorkStartUtc),
    blockers: envelopeBlockers,
  }
}

export type AssessWorkPeriodsFromCardInput = Pick<
  DriverCardData,
  'activities' | 'cardPresentEdges' | 'vehicleUses'
>

/** Mapovaná karta DDD → izolovaná analytika WorkPeriod (bez UI a 561/2006). */
export function assessWorkPeriodsFromCard(card: AssessWorkPeriodsFromCardInput): WorkEnvelope {
  return assessWorkPeriods({
    activities: card.activities,
    cardPresentEdges: card.cardPresentEdges,
    vehicleUses: card.vehicleUses,
  })
}

function emptyEnvelope(): WorkEnvelope {
  return {
    startUtc: null,
    endUtc: null,
    dataComplete: true,
    workActivityIds: [],
    cuts: [],
    blockers: [],
  }
}

function restSegmentFromInterval(rest: RestInterval): CandidateCutRestSegment {
  return {
    startUtc: rest.startUtc,
    endUtc: rest.endUtc,
    sourceActivityIds: [...rest.sourceActivityIds],
    slot: rest.slot,
  }
}

function usableWork(activities: readonly Activity[]): Activity[] {
  return activities
    .filter((activity) => WORK_KINDS.includes(activity.kind))
    .filter((activity) => activity.endUtc > activity.startUtc)
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
}

function latestWorkEndBefore(work: readonly Activity[], restStartUtc: number): number | null {
  let best: number | null = null
  for (const activity of work) {
    if (activity.endUtc > restStartUtc) continue
    if (best == null || activity.endUtc > best) best = activity.endUtc
  }
  return best
}

function earliestWorkStartAfter(work: readonly Activity[], restEndUtc: number): number | null {
  let best: number | null = null
  for (const activity of work) {
    if (activity.startUtc < restEndUtc) continue
    if (best == null || activity.startUtc < best) best = activity.startUtc
  }
  return best
}

function hasWorkBetween(work: readonly Activity[], fromUtc: number, toUtc: number): boolean {
  if (toUtc <= fromUtc) return false
  return work.some((activity) => activity.startUtc < toUtc && activity.endUtc > fromUtc)
}

function slotForCut(
  work: readonly Activity[],
  previousWorkEndUtc: number,
  nextWorkStartUtc: number,
  restSegments: readonly CandidateCutRestSegment[],
): 1 | 2 {
  const before = work.filter((activity) => activity.endUtc === previousWorkEndUtc)
  const after = work.filter((activity) => activity.startUtc === nextWorkStartUtc)
  const slot =
    before.find((activity) => activity.slot === 1 || activity.slot === 2)?.slot ??
    after.find((activity) => activity.slot === 1 || activity.slot === 2)?.slot ??
    restSegments.find((segment) => segment.slot === 1 || segment.slot === 2)?.slot
  return slot === 2 ? 2 : 1
}

function evaluateCardPresentSupport(
  edges: readonly CardPresentEdge[] | undefined,
  slot: 1 | 2,
  previousWorkEndUtc: number,
  nextWorkStartUtc: number,
  restSegments: readonly CandidateCutRestSegment[],
): CardPresentSupportLevel {
  if (!edges || edges.length === 0) return 'none'
  const slotEdges = edges.filter((edge) => edge.slot === slot)
  if (slotEdges.length === 0) return 'none'

  const firstRestStart = Math.min(...restSegments.map((segment) => segment.startUtc))
  const lastRestEnd = Math.max(...restSegments.map((segment) => segment.endUtc))

  const supportsEndOfPriorWork = slotEdges.some(
    (edge) =>
      edge.present === false &&
      (edge.atUtc === previousWorkEndUtc || edge.atUtc === firstRestStart),
  )
  const supportsStartOfNextWork = slotEdges.some(
    (edge) =>
      edge.present === true && (edge.atUtc === nextWorkStartUtc || edge.atUtc === lastRestEnd),
  )
  if (supportsEndOfPriorWork && supportsStartOfNextWork) return 'two_sided'
  if (supportsEndOfPriorWork || supportsStartOfNextWork) return 'one_sided'
  return 'none'
}

function hasVehicleUseGapForCorridor(
  uses: readonly VehicleUse[] | undefined,
  previousWorkEndUtc: number,
  nextWorkStartUtc: number,
  restSegments: readonly CandidateCutRestSegment[],
): boolean {
  if (!uses || uses.length === 0) return false
  const sorted = [...uses].sort((a, b) => a.fromUtc - b.fromUtc || a.toUtc - b.toUtc)
  for (const segment of restSegments) {
    if (sorted.some((use) => use.fromUtc < segment.endUtc && use.toUtc > segment.startUtc)) return false
  }

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index]!
    const right = sorted[index + 1]!
    if (left.toUtc !== previousWorkEndUtc || right.fromUtc !== nextWorkStartUtc) continue
    return true
  }
  return false
}

function unknownSpansInCorridor(
  activities: readonly Activity[],
  previousWorkEndUtc: number,
  nextWorkStartUtc: number,
): CandidateCutUnknownSpan[] {
  const spans: CandidateCutUnknownSpan[] = []
  for (const activity of activities) {
    if (activity.kind !== 'unknown') continue
    if (!overlaps(activity.startUtc, activity.endUtc, previousWorkEndUtc, nextWorkStartUtc)) continue
    spans.push({ startUtc: activity.startUtc, endUtc: activity.endUtc })
  }
  return spans.sort((a, b) => a.startUtc - b.startUtc)
}

function cutBlockers(
  activities: readonly Activity[],
  spans: readonly TimeOverlapSpan[] | undefined,
  work: readonly Activity[],
  restSegments: readonly CandidateCutRestSegment[],
  previousWorkEndUtc: number,
  nextWorkStartUtc: number,
): CandidateCutBlocker[] {
  const blockers: CandidateCutBlocker[] = []
  for (const segment of restSegments) {
    if (
      activities.some(
        (activity) =>
          activity.kind === 'unknown' &&
          overlaps(activity.startUtc, activity.endUtc, segment.startUtc, segment.endUtc),
      )
    ) {
      if (!blockers.includes('unknown')) blockers.push('unknown')
    }
    if (spans?.some((span) => overlaps(span.startUtc, span.endUtc, segment.startUtc, segment.endUtc))) {
      if (!blockers.includes('time_overlap_event')) blockers.push('time_overlap_event')
    }
  }
  const before = work.filter((activity) => activity.endUtc === previousWorkEndUtc)
  const after = work.filter((activity) => activity.startUtc === nextWorkStartUtc)
  const manualAtBoundary =
    before.some((activity) => activity.isManualEntry === true) ||
    after.some((activity) => activity.isManualEntry === true)
  if (manualAtBoundary) blockers.push('manual_only')
  return blockers
}

function localizedBlockers(
  activities: readonly Activity[],
  spans: readonly TimeOverlapSpan[] | undefined,
  startUtc: number,
  endUtc: number,
): WorkEnvelopeBlocker[] {
  const blockers: WorkEnvelopeBlocker[] = []
  for (const activity of activities) {
    if (activity.kind !== 'unknown') continue
    if (!overlaps(activity.startUtc, activity.endUtc, startUtc, endUtc)) continue
    blockers.push({ kind: 'unknown', startUtc: activity.startUtc, endUtc: activity.endUtc })
  }
  for (const span of spans ?? []) {
    if (!overlaps(span.startUtc, span.endUtc, startUtc, endUtc)) continue
    blockers.push({ kind: 'time_overlap_event', startUtc: span.startUtc, endUtc: span.endUtc })
  }
  return blockers
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB
}
