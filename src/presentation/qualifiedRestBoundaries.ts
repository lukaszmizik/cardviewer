import { findRestIntervals, type RestInterval } from '../analysis/restIntervals.ts'
import { classifyRestCandidates, type RestCandidate, type RestCandidateKind } from '../analysis/restCandidates.ts'
import { findDailyRestOptions, type DailyRestOption, type DailyRestVariantKind } from '../analysis/dailyRestOptions.ts'
import { DAILY_WINDOW_MS } from '../analysis/restWindowIntersection.ts'
import type { CardPresentEdge } from '../analysis/workPeriods.ts'
import type { Activity, ActivityKind } from '../types/tacho.ts'
import type { DailyRecordCoverageGap } from '../types/coverage.ts'

const HOUR_MS = 60 * 60 * 1000
const THREE_HOURS = 3 * HOUR_MS
const WORK_KINDS: readonly ActivityKind[] = ['driving', 'work', 'availability']

export type RestBoundaryEvidenceBasis =
  | 'activity_recorded'
  | 'card_absence_hint'
  | 'coverage_gap'
  | 'unknown_affected'

export type RestBoundaryPart = {
  startUtc: number
  endUtc: number
  durationMs: number
}

/** Kandidátní výklad hranice. Není to právní potvrzení odpočinku. */
export type RestBoundaryInterpretation = {
  variant: DailyRestVariantKind
  parts: RestBoundaryPart[]
  /** Součet délek částí. U děleného odpočinku nezahrnuje mezeru mezi nimi. */
  durationMs: number
  established: boolean
  windowStartUtc: number
  windowEndUtc: number
}

export type QualifiedRestBoundary = {
  /** Konec pracovního období = začátek druhé části (split) nebo začátek souvislého odpočinku. */
  workPeriodEndUtc: number
  nextWorkStartUtc: number
  /**
   * U souvislého odpočinku začátek a konec toho odpočinku.
   * U děleného odpočinku začátek a konec uzavírající druhé části, ne rozsah přes mezeru.
   */
  restStartUtc: number
  restEndUtc: number
  /** U děleného odpočinku součet částí, ne rozdíl konce druhé a začátku první. */
  durationMs: number
  /** Hlavní prezentační varianta. Při souběhu má přednost souvislý odpočinek začínající na hranici. */
  variant: DailyRestVariantKind
  parts: RestBoundaryPart[]
  /** Všechny ponechané kandidátní výklady, hlavní je první. */
  interpretations: RestBoundaryInterpretation[]
  windowStartUtc: number
  windowEndUtc: number
  kinds: RestCandidateKind[]
  slot: 1 | 2 | null
  sourceActivityIds: string[]
  evidenceBasis: RestBoundaryEvidenceBasis
  cardPresentSupport: 'none' | 'one_sided' | 'two_sided'
  preliminaryNotes: string[]
  established: boolean
}

export type FindQualifiedRestBoundariesInput = {
  activities: readonly Activity[]
  dailyRecordCoverageGaps?: readonly DailyRecordCoverageGap[]
  cardPresentEdges?: readonly CardPresentEdge[]
  envelopeStartUtc?: number
  envelopeEndUtc?: number
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB
}

function usableWork(activities: readonly Activity[]): Activity[] {
  return activities
    .filter((activity) => WORK_KINDS.includes(activity.kind))
    .filter((activity) => activity.endUtc > activity.startUtc)
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
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

function unknownIntervals(activities: readonly Activity[]): Array<{ startUtc: number; endUtc: number }> {
  return activities
    .filter((activity) => activity.kind === 'unknown')
    .map((activity) => ({ startUtc: activity.startUtc, endUtc: activity.endUtc }))
}

function unknownInSpan(
  intervals: readonly { startUtc: number; endUtc: number }[],
  startUtc: number,
  endUtc: number,
): boolean {
  return intervals.some((interval) => overlaps(interval.startUtc, interval.endUtc, startUtc, endUtc))
}

function slotForBoundary(
  work: readonly Activity[],
  workPeriodEndUtc: number,
  nextWorkStartUtc: number,
  slot: 1 | 2 | null,
): 1 | 2 {
  const before = work.filter((activity) => activity.endUtc <= workPeriodEndUtc && activity.endUtc > workPeriodEndUtc - HOUR_MS)
  const after = work.filter((activity) => activity.startUtc >= nextWorkStartUtc)
  const resolved =
    before.find((activity) => activity.slot === 1 || activity.slot === 2)?.slot ??
    after.find((activity) => activity.slot === 1 || activity.slot === 2)?.slot ??
    slot
  return resolved === 2 ? 2 : 1
}

function evaluateCardPresentSupport(
  edges: readonly CardPresentEdge[] | undefined,
  slot: 1 | 2,
  workPeriodEndUtc: number,
  nextWorkStartUtc: number,
  restStartUtc: number,
  restEndUtc: number,
): 'none' | 'one_sided' | 'two_sided' {
  if (!edges || edges.length === 0) return 'none'
  const slotEdges = edges.filter((edge) => edge.slot === slot)
  if (slotEdges.length === 0) return 'none'

  const supportsEndOfPriorWork = slotEdges.some(
    (edge) => edge.present === false && (edge.atUtc === workPeriodEndUtc || edge.atUtc === restStartUtc),
  )
  const supportsStartOfNextWork = slotEdges.some(
    (edge) => edge.present === true && (edge.atUtc === nextWorkStartUtc || edge.atUtc === restEndUtc),
  )
  if (supportsEndOfPriorWork && supportsStartOfNextWork) return 'two_sided'
  if (supportsEndOfPriorWork || supportsStartOfNextWork) return 'one_sided'
  return 'none'
}

function overlapsCoverageGap(
  gaps: readonly DailyRecordCoverageGap[] | undefined,
  startUtc: number,
  endUtc: number,
): boolean {
  if (!gaps) return false
  return gaps.some((gap) => overlaps(startUtc, endUtc, gap.startUtc, gap.endUtc))
}

function findCandidate(candidates: readonly RestCandidate[], part: { startUtc: number; endUtc: number; sourceActivityIds: string[] }): RestCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.startUtc === part.startUtc &&
      candidate.endUtc === part.endUtc &&
      sameIds(candidate.sourceActivityIds, part.sourceActivityIds),
  )
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function collectKinds(candidates: readonly RestCandidate[]): RestCandidateKind[] {
  const kinds = new Set<RestCandidateKind>()
  for (const candidate of candidates) {
    for (const kind of candidate.kinds) kinds.add(kind)
  }
  return [...kinds]
}

function evidenceForParts(
  parts: Array<{ startUtc: number; endUtc: number; manualEntry: boolean; ambiguous: boolean }>,
  matched: RestCandidate[],
  cardPresentSupport: 'none' | 'one_sided' | 'two_sided',
  gaps: readonly DailyRecordCoverageGap[] | undefined,
  activities: readonly Activity[],
  variant: DailyRestVariantKind,
): { evidenceBasis: RestBoundaryEvidenceBasis; preliminaryNotes: string[]; established: boolean } {
  const notes: string[] = []
  if (variant === 'split_regular') {
    notes.push('kandidát děleného denního odpočinku 3+9 (prezentační hranice)')
  }

  const spanStart = parts[0]!.startUtc
  const spanEnd = parts[parts.length - 1]!.endUtc
  if (overlapsCoverageGap(gaps, spanStart, spanEnd)) {
    notes.push('odpočinek překrývá mezeru v denních záznamech')
    return { evidenceBasis: 'coverage_gap', preliminaryNotes: notes, established: false }
  }
  if (unknownInSpan(unknownIntervals(activities), spanStart, spanEnd)) {
    notes.push('v odpočinku je unknown')
    return { evidenceBasis: 'unknown_affected', preliminaryNotes: notes, established: false }
  }

  let established = parts.every((part) => !part.ambiguous)
  for (const candidate of matched) {
    if (candidate.manualEntry) {
      notes.push('zdroj obsahuje ruční záznam — není automaticky prokázaný')
      established = false
    }
    if (candidate.uncertainties.includes('adjacent_other_slot')) {
      notes.push('sousední odpočinek v jiném slotu')
      established = false
    }
  }
  if (cardPresentSupport !== 'none') {
    notes.push(`card_present: ${cardPresentSupport} (doplňkový důkaz)`)
  }
  return { evidenceBasis: 'activity_recorded', preliminaryNotes: notes, established }
}

function collectWindowAnchors(
  envelopeStart: number,
  envelopeEnd: number,
  candidates: readonly RestCandidate[],
): number[] {
  const set = new Set<number>()
  set.add(envelopeStart)
  for (const candidate of candidates) {
    if (candidate.startUtc >= envelopeStart && candidate.startUtc <= envelopeEnd) {
      set.add(candidate.startUtc)
    }
    const windowStart = candidate.endUtc - DAILY_WINDOW_MS
    if (windowStart >= envelopeStart && windowStart <= envelopeEnd) {
      set.add(windowStart)
    }
  }
  return [...set].sort((a, b) => a - b)
}

function boundaryFromOption(
  option: DailyRestOption,
  work: readonly Activity[],
  candidates: readonly RestCandidate[],
  input: FindQualifiedRestBoundariesInput,
  unknowns: readonly { startUtc: number; endUtc: number }[],
): QualifiedRestBoundary | null {
  if (option.parts.some((part) => unknownInSpan(unknowns, part.startUtc, part.endUtc))) {
    return null
  }

  if (option.kind === 'split_regular') {
    const first = option.parts[0]!
    const second = option.parts[1]!
    if (first.restMinutesInsideWindow < 3 * 60 || second.restMinutesInsideWindow < 9 * 60) {
      return null
    }
    const workPeriodEndUtc = second.startUtc
    const restEndUtc = second.endUtc
    const nextWorkStartUtc = earliestWorkStartAfter(work, restEndUtc)
    if (nextWorkStartUtc == null) return null
    if (hasWorkBetween(work, restEndUtc, nextWorkStartUtc)) return null

    const matched = [findCandidate(candidates, first), findCandidate(candidates, second)].filter(
      (item): item is RestCandidate => item != null,
    )
    const slot = matched[1]?.slot ?? matched[0]?.slot ?? null
    const cardPresentSupport = evaluateCardPresentSupport(
      input.cardPresentEdges,
      slotForBoundary(work, workPeriodEndUtc, nextWorkStartUtc, slot),
      workPeriodEndUtc,
      nextWorkStartUtc,
      first.startUtc,
      restEndUtc,
    )
    const { evidenceBasis, preliminaryNotes, established } = evidenceForParts(
      [first, second],
      matched,
      cardPresentSupport,
      input.dailyRecordCoverageGaps,
      input.activities,
      'split_regular',
    )

    const parts = [toBoundaryPart(first.startUtc, first.endUtc), toBoundaryPart(second.startUtc, second.endUtc)]
    return withInterpretation({
      workPeriodEndUtc,
      nextWorkStartUtc,
      restStartUtc: second.startUtc,
      restEndUtc,
      durationMs: parts.reduce((sum, part) => sum + part.durationMs, 0),
      variant: 'split_regular',
      parts,
      windowStartUtc: option.windowStartUtc,
      windowEndUtc: option.windowEndUtc,
      kinds: collectKinds(matched),
      slot,
      sourceActivityIds: [...new Set([...first.sourceActivityIds, ...second.sourceActivityIds])],
      evidenceBasis,
      cardPresentSupport,
      preliminaryNotes,
      established: established && option.established,
    })
  }

  if (option.kind !== 'continuous_reduced' && option.kind !== 'continuous_regular') {
    return null
  }

  const part = option.parts[0]!
  const minInside = option.kind === 'continuous_regular' ? 11 * 60 : 9 * 60
  if (part.restMinutesInsideWindow < minInside) return null

  const matched = findCandidate(candidates, part)
  if (matched?.ambiguous) return null

  const workPeriodEndUtc = part.startUtc
  const restEndUtc = part.endUtc
  const nextWorkStartUtc = earliestWorkStartAfter(work, restEndUtc)
  if (nextWorkStartUtc == null) return null
  if (hasWorkBetween(work, restEndUtc, nextWorkStartUtc)) return null

  const slot = matched?.slot ?? null
  const cardPresentSupport = evaluateCardPresentSupport(
    input.cardPresentEdges,
    slotForBoundary(work, workPeriodEndUtc, nextWorkStartUtc, slot),
    workPeriodEndUtc,
    nextWorkStartUtc,
    part.startUtc,
    restEndUtc,
  )
  const { evidenceBasis, preliminaryNotes, established } = evidenceForParts(
    [part],
    matched ? [matched] : [],
    cardPresentSupport,
    input.dailyRecordCoverageGaps,
    input.activities,
    option.kind,
  )

  const parts = [toBoundaryPart(part.startUtc, part.endUtc)]
  return withInterpretation({
    workPeriodEndUtc,
    nextWorkStartUtc,
    restStartUtc: part.startUtc,
    restEndUtc,
    durationMs: parts[0]!.durationMs,
    variant: option.kind,
    parts,
    windowStartUtc: option.windowStartUtc,
    windowEndUtc: option.windowEndUtc,
    kinds: matched ? [...matched.kinds] : [],
    slot,
    sourceActivityIds: [...part.sourceActivityIds],
    evidenceBasis,
    cardPresentSupport,
    preliminaryNotes,
    established: established && option.established,
  })
}

function toBoundaryPart(startUtc: number, endUtc: number): RestBoundaryPart {
  return { startUtc, endUtc, durationMs: endUtc - startUtc }
}

function withInterpretation(boundary: Omit<QualifiedRestBoundary, 'interpretations'>): QualifiedRestBoundary {
  return { ...boundary, interpretations: [toInterpretation(boundary)] }
}

function toInterpretation(boundary: Omit<QualifiedRestBoundary, 'interpretations'>): RestBoundaryInterpretation {
  return {
    variant: boundary.variant,
    parts: boundary.parts.map((part) => ({ ...part })),
    durationMs: boundary.durationMs,
    established: boundary.established,
    windowStartUtc: boundary.windowStartUtc,
    windowEndUtc: boundary.windowEndUtc,
  }
}

function presentationRank(variant: DailyRestVariantKind): number {
  if (variant === 'continuous_regular') return 0
  if (variant === 'continuous_reduced') return 1
  return 2
}

function interpretationKey(boundary: QualifiedRestBoundary): string {
  return `${boundary.variant}|${boundary.parts.map((part) => `${part.startUtc}|${part.endUtc}`).join(',')}`
}

function mergeBoundaries(raw: QualifiedRestBoundary[]): QualifiedRestBoundary[] {
  const byEnd = new Map<number, QualifiedRestBoundary[]>()
  for (const boundary of raw) {
    const list = byEnd.get(boundary.workPeriodEndUtc) ?? []
    list.push(boundary)
    byEnd.set(boundary.workPeriodEndUtc, list)
  }

  const merged: QualifiedRestBoundary[] = []
  for (const group of byEnd.values()) {
    const ranked = [...group].sort(
      (a, b) =>
        presentationRank(a.variant) - presentationRank(b.variant) ||
        Number(b.established) - Number(a.established) ||
        a.windowStartUtc - b.windowStartUtc ||
        a.nextWorkStartUtc - b.nextWorkStartUtc,
    )
    const unique: QualifiedRestBoundary[] = []
    const seen = new Set<string>()
    for (const boundary of ranked) {
      const key = interpretationKey(boundary)
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(boundary)
    }
    const primary = unique[0]!
    const notes = [...primary.preliminaryNotes]
    if (unique.length > 1) {
      notes.push('další kandidátní výklady odpočinku nejsou rozhodující')
    }
    merged.push({
      ...primary,
      preliminaryNotes: notes,
      interpretations: unique.map((item) => toInterpretation(item)),
    })
  }

  return merged.sort(
    (a, b) => a.workPeriodEndUtc - b.workPeriodEndUtc || a.nextWorkStartUtc - b.nextWorkStartUtc,
  )
}

/**
 * Hranice pracovních období z findDailyRestOptions (včetně split_regular).
 * Neprovádí legislativní potvrzení.
 */
export function findQualifiedRestBoundaries(input: FindQualifiedRestBoundariesInput): QualifiedRestBoundary[] {
  const work = usableWork(input.activities)
  if (work.length === 0) return []

  const envelopeStart = input.envelopeStartUtc ?? Math.min(...work.map((item) => item.startUtc))
  const envelopeEnd = input.envelopeEndUtc ?? Math.max(...work.map((item) => item.endUtc))

  const intervals = findRestIntervals(input.activities)
  const candidates = classifyRestCandidates(intervals)
  const unknowns = unknownIntervals(input.activities)
  const anchors = collectWindowAnchors(envelopeStart, envelopeEnd, candidates)

  const raw: QualifiedRestBoundary[] = []
  for (const anchor of anchors) {
    const options = findDailyRestOptions(candidates, anchor, DAILY_WINDOW_MS)
    for (const option of options) {
      if (option.kind === 'split_regular' || option.kind === 'continuous_reduced' || option.kind === 'continuous_regular') {
        const boundary = boundaryFromOption(option, work, candidates, input, unknowns)
        if (boundary != null) raw.push(boundary)
      }
    }
  }

  const merged = mergeBoundaries(raw)
  const coveredEnds = new Set(merged.map((boundary) => boundary.workPeriodEndUtc))
  const candidateBySpan = new Map<string, RestCandidate>()
  for (const candidate of candidates) {
    candidateBySpan.set(`${candidate.startUtc}|${candidate.endUtc}|${candidate.slot}`, candidate)
  }
  for (const interval of intervals) {
    if (interval.durationMs < 9 * HOUR_MS || interval.ambiguous) continue
    const candidate = candidateBySpan.get(`${interval.startUtc}|${interval.endUtc}|${interval.slot}`)
    const fallback = findFallbackSingleRestBoundary(interval, work, input, candidate)
    if (fallback == null || coveredEnds.has(fallback.workPeriodEndUtc)) continue
    merged.push(fallback)
    coveredEnds.add(fallback.workPeriodEndUtc)
  }

  return merged.sort(
    (a, b) => a.workPeriodEndUtc - b.workPeriodEndUtc || a.nextWorkStartUtc - b.nextWorkStartUtc,
  )
}

/** Jednotlivé REST intervaly ≥9 h bez nejednoznačnosti — záloha, pokud nejsou v options. */
export function findFallbackSingleRestBoundary(
  interval: RestInterval,
  work: readonly Activity[],
  input: FindQualifiedRestBoundariesInput,
  candidate?: RestCandidate,
): QualifiedRestBoundary | null {
  if (interval.durationMs < 9 * HOUR_MS || interval.ambiguous) return null
  const restEndUtc = interval.endUtc
  const workPeriodEndUtc = interval.startUtc
  const nextWorkStartUtc = earliestWorkStartAfter(work, restEndUtc)
  if (nextWorkStartUtc == null) return null
  if (hasWorkBetween(work, restEndUtc, nextWorkStartUtc)) return null

  const slot = interval.slot
  const cardPresentSupport = evaluateCardPresentSupport(
    input.cardPresentEdges,
    slotForBoundary(work, workPeriodEndUtc, nextWorkStartUtc, slot),
    workPeriodEndUtc,
    nextWorkStartUtc,
    interval.startUtc,
    restEndUtc,
  )
  const part = {
    startUtc: interval.startUtc,
    endUtc: interval.endUtc,
    manualEntry: candidate?.manualEntry ?? false,
    ambiguous: interval.ambiguous,
  }
  const { evidenceBasis, preliminaryNotes, established } = evidenceForParts(
    [part],
    candidate ? [candidate] : [],
    cardPresentSupport,
    input.dailyRecordCoverageGaps,
    input.activities,
    interval.durationMs >= 11 * HOUR_MS ? 'continuous_regular' : 'continuous_reduced',
  )

  const variant = interval.durationMs >= 11 * HOUR_MS ? 'continuous_regular' : 'continuous_reduced'
  return withInterpretation({
    workPeriodEndUtc,
    nextWorkStartUtc,
    restStartUtc: interval.startUtc,
    restEndUtc,
    durationMs: interval.durationMs,
    variant,
    parts: [toBoundaryPart(interval.startUtc, interval.endUtc)],
    windowStartUtc: workPeriodEndUtc,
    windowEndUtc: workPeriodEndUtc + DAILY_WINDOW_MS,
    kinds: candidate ? [...candidate.kinds] : [],
    slot,
    sourceActivityIds: [...interval.sourceActivityIds],
    evidenceBasis,
    cardPresentSupport,
    preliminaryNotes,
    established,
  })
}
