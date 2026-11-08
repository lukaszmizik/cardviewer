import type { ActivityKind } from '../types/tacho.ts'

/** Kandidátní období režimu osádky. Není to délka denního okna pro jednoho řidiče. */
export const CREW_WINDOW_MS = 30 * 60 * 60 * 1000
export const CREW_REST_MS = 9 * 60 * 60 * 1000
/** První hodina vícečlenné osádky. Výjimka se neopakuje po pozdějším přerušení. */
const CREW_FIRST_HOUR_MS = 60 * 60 * 1000

export type CrewRecording = 'recorded' | 'partial' | 'insufficient_data' | 'not_recorded'

/**
 * Konzistence záznamu příznaku osádky. Není to přítomnost druhého řidiče
 * ani právní splnění režimu osádky.
 */
export type CrewRecordCourse = 'crew_record_consistent' | 'crew_record_interrupted' | 'crew_record_uncertain'

/** Úsek, ve kterém záznam osádku ani neprokazuje, ani nevyvrací. */
export type CrewUncertainInterval = {
  startUtc: number
  endUtc: number
}

/** recorded = tachograf. conditional = nejistota bez důkazu nesplnění. */
export type CrewWindowBasis = 'recorded' | 'conditional'

export type CrewInterval = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
}

export type CrewQualifyingRest = {
  startUtc: number
  endUtc: number
  /** Okamžik, kdy od začátku tohoto souvislého odpočinku uplyne 9 hodin. */
  nineHoursAtUtc: number
  durationMs: number
  sourceActivityIds: string[]
}

export type CrewUncertainty =
  | 'legal_not_decided'
  | 'crew_partial'
  | 'crew_not_recorded'
  | 'unknown_in_period'
  | 'nine_hours_missing'
  | 'nine_hours_late'

/**
 * Technický výsledek časové podmínky. Právní použitelnost režimu osádky to není.
 */
export type CrewDailyCandidate = {
  windowStartUtc: number
  windowEndUtc: number
  crewIntervals: CrewInterval[]
  recording: CrewRecording
  qualifyingRest: CrewQualifyingRest | null
  nineHourCondition: 'met' | 'not_met'
  /** Kladná hodnota je rezerva před hranicí, záporná je zpoždění. Bez devítihodinového odpočinku chybí. */
  marginMs: number | null
  /** Průběh dostupného záznamu osádky v pracovním úseku. Právní závěr to není. */
  crewRecord: CrewRecordCourse
  /** Vyplněno jen při crew_record_uncertain. Nejsou to prokázaná přerušení. */
  uncertainIntervals: CrewUncertainInterval[]
  /** Nejistota z výměny, ručního záznamu nebo mezery bez důkazu nesplnění. Neznámý úsek sem nepatří. */
  conditionalEligible: boolean
  legalApplicability: 'undecided'
  uncertainties: CrewUncertainty[]
}

export type CrewActivity = {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
  isCrew: boolean
  /** Vložená karta. Ruční záznam při vyjmuté kartě příznak osádky nedokládá. */
  isManualEntry?: boolean
  slot?: 1 | 2
}

export type CrewUnknown = {
  startUtc: number
  endUtc: number
}

type RestPiece = {
  startUtc: number
  endUtc: number
  slot: 1 | 2 | null
  sourceActivityIds: string[]
}

/**
 * Kandidátní 30hodinové období od konce předchozího odpočinku.
 * Součet kratších odpočinků devět hodin nenahrazuje. Neznámý úsek odpočinek není.
 */
/**
 * 30hodinové okno se použije při prokázaném záznamu osádky, nebo podmíněně
 * při nejistotě bez důkazu nesplnění. Přerušení okno neotevře.
 * Podmíněné uznání není důkaz, že druhý řidič vozidlo řídil.
 */
export function decideCrewDailyWindow(input: {
  windowStartUtc: number
  activities: readonly CrewActivity[]
  unknownIntervals?: readonly CrewUnknown[]
}): { applies: boolean; crewRecord: CrewRecordCourse; uncertainIntervals: CrewUncertainInterval[]; basis: CrewWindowBasis | null; refusal: string | null } {
  const assessed = assessCrewDailyWindow(input)
  const crewSeen = assessed.recording === 'recorded' || assessed.recording === 'partial'
  const recorded = assessed.crewRecord === 'crew_record_consistent'
  const conditional = assessed.conditionalEligible
  return {
    applies: crewSeen && (recorded || conditional),
    crewRecord: assessed.crewRecord,
    uncertainIntervals: assessed.uncertainIntervals,
    basis: recorded ? 'recorded' : conditional ? 'conditional' : null,
    refusal: assessed.crewRecord === 'crew_record_interrupted'
      ? 'V pracovním úseku po první hodině je řízení nebo práce bez příznaku osádky, která není výměna slotu ani ruční záznam.'
      : null,
  }
}

export function assessCrewDailyWindow(input: {
  windowStartUtc: number
  activities: readonly CrewActivity[]
  unknownIntervals?: readonly CrewUnknown[]
}): CrewDailyCandidate {
  const windowStartUtc = input.windowStartUtc
  const windowEndUtc = windowStartUtc + CREW_WINDOW_MS
  const unknowns = input.unknownIntervals ?? []
  const rests = continuousRests(input.activities, unknowns)
  const viable = rests
    .filter((rest) => rest.endUtc - rest.startUtc >= CREW_REST_MS && rest.startUtc < windowEndUtc && rest.endUtc > windowStartUtc)
    .map((rest) => ({ ...rest, nineHoursAtUtc: rest.startUtc + CREW_REST_MS }))
    .filter((rest) => rest.nineHoursAtUtc > windowStartUtc)
    .sort((left, right) => left.nineHoursAtUtc - right.nineHoursAtUtc || left.startUtc - right.startUtc)
  const inTime = viable.filter((rest) => rest.nineHoursAtUtc <= windowEndUtc)
  const chosen = inTime[0] ?? viable[0] ?? null
  const nineHourCondition = chosen != null && chosen.nineHoursAtUtc <= windowEndUtc ? 'met' : 'not_met'
  const segmentEndUtc = chosen != null ? Math.min(Math.max(chosen.startUtc, windowStartUtc), windowEndUtc) : windowEndUtc
  const recording = classifyRecording(input.activities, unknowns, windowStartUtc, segmentEndUtc)
  const uncertainties: CrewUncertainty[] = ['legal_not_decided']
  if (recording === 'partial') uncertainties.push('crew_partial')
  if (recording === 'not_recorded') uncertainties.push('crew_not_recorded')
  if (recording === 'insufficient_data') uncertainties.push('unknown_in_period')
  if (chosen == null) uncertainties.push('nine_hours_missing')
  else if (nineHourCondition === 'not_met') uncertainties.push('nine_hours_late')

  return {
    windowStartUtc,
    windowEndUtc,
    crewIntervals: crewCourse(input.activities, windowStartUtc, windowEndUtc),
    recording,
    qualifyingRest: chosen == null
      ? null
      : {
          startUtc: chosen.startUtc,
          endUtc: chosen.endUtc,
          nineHoursAtUtc: chosen.nineHoursAtUtc,
          durationMs: chosen.endUtc - chosen.startUtc,
          sourceActivityIds: chosen.sourceActivityIds,
        },
    nineHourCondition,
    marginMs: chosen == null ? null : windowEndUtc - chosen.nineHoursAtUtc,
    ...assessCrewRecord(input.activities, unknowns, windowStartUtc, segmentEndUtc),
    legalApplicability: 'undecided',
    uncertainties,
  }
}

/**
 * Pracovní úsek je od konce předchozího odpočinku po začátek kandidátního
 * devítihodinového odpočinku. Kontrola bere oba sloty.
 * První hodina se toleruje jen na začátku úseku.
 * Ruční záznam bez příznaku osádku neukončuje. Příznak před mezerou a po ní
 * mezeru sám nevyplní. Výměna slotu není důkaz nesplnění. Konkrétní řízení
 * nebo práce bez příznaku mimo výměnu slotu je přerušení.
 */
function assessCrewRecord(
  activities: readonly CrewActivity[],
  unknowns: readonly CrewUnknown[],
  segmentStartUtc: number,
  segmentEndUtc: number,
): { crewRecord: CrewRecordCourse; uncertainIntervals: CrewUncertainInterval[]; conditionalEligible: boolean } {
  const requiredStartUtc = segmentStartUtc + CREW_FIRST_HOUR_MS
  if (segmentEndUtc <= requiredStartUtc) return { crewRecord: 'crew_record_consistent', uncertainIntervals: [], conditionalEligible: false }
  const clipped = clipToSpan(activities, requiredStartUtc, segmentEndUtc)
  const crewPieces = clipped.filter((activity) => isRecordedCrew(activity))
  const gaps = coverageGaps(crewPieces, requiredStartUtc, segmentEndUtc)
  const uncertainIntervals: CrewUncertainInterval[] = []
  let interrupted = false
  let unknownOverlap = false
  for (const unknown of unknowns) {
    const startUtc = Math.max(unknown.startUtc, requiredStartUtc)
    const endUtc = Math.min(unknown.endUtc, segmentEndUtc)
    if (endUtc > startUtc) {
      unknownOverlap = true
      uncertainIntervals.push({ startUtc, endUtc })
    }
  }
  for (const gap of gaps) {
    const course = classifyCrewGap(gap, activities, clipped, crewPieces)
    if (course === 'interrupted') interrupted = true
    else uncertainIntervals.push({ startUtc: gap[0], endUtc: gap[1] })
  }
  if (interrupted) return { crewRecord: 'crew_record_interrupted', uncertainIntervals: [], conditionalEligible: false }
  const unique = dedupeIntervals(uncertainIntervals)
  if (unique.length > 0) return { crewRecord: 'crew_record_uncertain', uncertainIntervals: unique, conditionalEligible: !unknownOverlap }
  return { crewRecord: 'crew_record_consistent', uncertainIntervals: [], conditionalEligible: false }
}

type GapCourse = 'interrupted' | 'uncertain'

function classifyCrewGap(
  gap: readonly [number, number],
  activities: readonly CrewActivity[],
  clipped: readonly CrewActivity[],
  crewPieces: readonly CrewActivity[],
): GapCourse {
  const [gapStartUtc, gapEndUtc] = gap
  const beforeSlots = edgeSlots(crewPieces, (activity) => activity.endUtc === gapStartUtc && activity.startUtc < gapStartUtc)
  const afterSlots = edgeSlots(crewPieces, (activity) => activity.startUtc === gapEndUtc && activity.endUtc > gapEndUtc)
  const inside = clipped.filter((activity) => overlaps(gapStartUtc, gapEndUtc, activity.startUtc, activity.endUtc))
  const solos = inside.filter((activity) => !isRecordedCrew(activity) && activity.kind !== 'unknown' && activity.isManualEntry !== true)
  const manuals = [
    ...inside.filter((activity) => activity.isManualEntry === true || activity.kind === 'unknown'),
    ...activities.filter((activity) =>
      activity.isManualEntry === true
      && activity.endUtc <= activity.startUtc
      && activity.startUtc >= gapStartUtc
      && activity.startUtc <= gapEndUtc
    ),
  ]
  if (slotExchange(gap, beforeSlots, afterSlots, solos, manuals)) return 'uncertain'
  if (solos.length > 0) return 'interrupted'
  return 'uncertain'
}

function dedupeIntervals(intervals: readonly CrewUncertainInterval[]): CrewUncertainInterval[] {
  const sorted = [...intervals].sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)
  const unique: CrewUncertainInterval[] = []
  for (const interval of sorted) {
    const last = unique[unique.length - 1]
    if (last != null && interval.startUtc <= last.endUtc && interval.endUtc <= last.endUtc && interval.startUtc >= last.startUtc) continue
    unique.push(interval)
  }
  return unique
}

/** Výměna slotu doložená navazujícím příznakem. Ruční úsek sám průběh neuzavře. */
function slotExchange(
  gap: readonly [number, number],
  beforeSlots: ReadonlySet<1 | 2>,
  afterSlots: ReadonlySet<1 | 2>,
  solos: readonly CrewActivity[],
  manuals: readonly CrewActivity[],
): boolean {
  const [gapStartUtc, gapEndUtc] = gap
  const slotChanged = [...beforeSlots].some((slot) => [...afterSlots].some((other) => other !== slot))
  if (!slotChanged || solos.length === 0 || solos.some((activity) => activity.kind === 'driving')) return false
  const boundary = solos.every((activity) => {
    const slot = activity.slot
    if (slot !== 1 && slot !== 2) return false
    const leavesOldSlot = activity.startUtc === gapStartUtc && beforeSlots.has(slot) && activity.endUtc < gapEndUtc
    const entersNewSlot = activity.endUtc === gapEndUtc && afterSlots.has(slot) && activity.startUtc > gapStartUtc
    return (leavesOldSlot || entersNewSlot) && manuals.some((manual) => touches(activity, manual))
  })
  if (!boundary) return false
  const positiveManuals = manuals.filter((activity) => activity.endUtc > activity.startUtc)
  return covers([...solos, ...positiveManuals].map((activity) => [activity.startUtc, activity.endUtc] as [number, number]), gapStartUtc, gapEndUtc)
}

function edgeSlots(pieces: readonly CrewActivity[], atEdge: (activity: CrewActivity) => boolean): Set<1 | 2> {
  const slots = new Set<1 | 2>()
  for (const activity of pieces) {
    if (!atEdge(activity)) continue
    if (activity.slot === 1 || activity.slot === 2) slots.add(activity.slot)
  }
  return slots
}

function isRecordedCrew(activity: CrewActivity): boolean {
  return activity.isCrew && activity.kind !== 'unknown' && activity.isManualEntry !== true
}

function clipToSpan(activities: readonly CrewActivity[], startUtc: number, endUtc: number): CrewActivity[] {
  return activities.flatMap((activity) => {
    if (activity.endUtc <= activity.startUtc) return []
    const clippedStartUtc = Math.max(activity.startUtc, startUtc)
    const clippedEndUtc = Math.min(activity.endUtc, endUtc)
    if (clippedEndUtc <= clippedStartUtc) return []
    return [{ ...activity, startUtc: clippedStartUtc, endUtc: clippedEndUtc }]
  })
}

function coverageGaps(pieces: readonly CrewActivity[], startUtc: number, endUtc: number): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const activity of [...pieces].sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)) {
    const last = merged[merged.length - 1]
    if (last != null && activity.startUtc <= last[1]) last[1] = Math.max(last[1], activity.endUtc)
    else merged.push([activity.startUtc, activity.endUtc])
  }
  const gaps: Array<[number, number]> = []
  let cursor = startUtc
  for (const [start, end] of merged) {
    if (start > cursor) gaps.push([cursor, start])
    cursor = Math.max(cursor, end)
    if (cursor >= endUtc) return gaps
  }
  if (cursor < endUtc) gaps.push([cursor, endUtc])
  return gaps
}

function touches(activity: CrewActivity, manual: CrewActivity): boolean {
  return manual.startUtc <= activity.endUtc && manual.endUtc >= activity.startUtc
}

function covers(parts: Array<[number, number]>, startUtc: number, endUtc: number): boolean {
  const merged: Array<[number, number]> = []
  for (const [start, end] of [...parts].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const last = merged[merged.length - 1]
    if (last != null && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  let cursor = startUtc
  for (const [start, end] of merged) {
    if (start > cursor) return false
    cursor = Math.max(cursor, end)
    if (cursor >= endUtc) return true
  }
  return cursor >= endUtc
}

function classifyRecording(
  activities: readonly CrewActivity[],
  unknowns: readonly CrewUnknown[],
  startUtc: number,
  endUtc: number,
): CrewRecording {
  if (unknowns.some((interval) => overlaps(startUtc, endUtc, interval.startUtc, interval.endUtc))) return 'insufficient_data'
  const inside = activities.filter((activity) => activity.endUtc > activity.startUtc && overlaps(startUtc, endUtc, activity.startUtc, activity.endUtc))
  const crew = inside.some((activity) => activity.isCrew)
  const plain = inside.some((activity) => !activity.isCrew)
  if (!crew) return 'not_recorded'
  if (plain) return 'partial'
  return 'recorded'
}

function crewCourse(activities: readonly CrewActivity[], windowStartUtc: number, windowEndUtc: number): CrewInterval[] {
  const pieces = activities
    .filter((activity) => activity.isCrew && activity.endUtc > activity.startUtc)
    .map((activity) => ({
      startUtc: Math.max(activity.startUtc, windowStartUtc),
      endUtc: Math.min(activity.endUtc, windowEndUtc),
      sourceActivityIds: [activity.id],
    }))
    .filter((piece) => piece.endUtc > piece.startUtc)
    .sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)
  const merged: CrewInterval[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (last != null && piece.startUtc <= last.endUtc) {
      last.endUtc = Math.max(last.endUtc, piece.endUtc)
      for (const id of piece.sourceActivityIds) {
        if (!last.sourceActivityIds.includes(id)) last.sourceActivityIds.push(id)
      }
      continue
    }
    merged.push({ ...piece, sourceActivityIds: [...piece.sourceActivityIds] })
  }
  return merged
}

function continuousRests(activities: readonly CrewActivity[], unknowns: readonly CrewUnknown[]): RestPiece[] {
  const pieces: RestPiece[] = []
  for (const activity of activities) {
    if (activity.kind !== 'rest' || activity.endUtc <= activity.startUtc) continue
    for (const [startUtc, endUtc] of subtractUnknowns(activity.startUtc, activity.endUtc, unknowns)) {
      pieces.push({ startUtc, endUtc, slot: activity.slot ?? null, sourceActivityIds: [activity.id] })
    }
  }
  pieces.sort((left, right) => slotRank(left.slot) - slotRank(right.slot) || left.startUtc - right.startUtc || left.endUtc - right.endUtc)
  const merged: RestPiece[] = []
  for (const piece of pieces) {
    const last = merged[merged.length - 1]
    if (last != null && last.slot === piece.slot && piece.startUtc <= last.endUtc) {
      last.endUtc = Math.max(last.endUtc, piece.endUtc)
      for (const id of piece.sourceActivityIds) {
        if (!last.sourceActivityIds.includes(id)) last.sourceActivityIds.push(id)
      }
      continue
    }
    merged.push({ ...piece, sourceActivityIds: [...piece.sourceActivityIds] })
  }
  return merged
}

function subtractUnknowns(startUtc: number, endUtc: number, unknowns: readonly CrewUnknown[]): Array<[number, number]> {
  let parts: Array<[number, number]> = [[startUtc, endUtc]]
  for (const unknown of unknowns) {
    const next: Array<[number, number]> = []
    for (const [start, end] of parts) {
      if (!overlaps(start, end, unknown.startUtc, unknown.endUtc)) {
        next.push([start, end])
        continue
      }
      if (unknown.startUtc > start) next.push([start, unknown.startUtc])
      if (unknown.endUtc < end) next.push([unknown.endUtc, end])
    }
    parts = next
  }
  return parts.filter(([start, end]) => end > start)
}

function overlaps(startUtc: number, endUtc: number, otherStartUtc: number, otherEndUtc: number): boolean {
  return startUtc < otherEndUtc && otherStartUtc < endUtc
}

function slotRank(slot: 1 | 2 | null): number {
  if (slot === 1) return 1
  if (slot === 2) return 2
  return 0
}
