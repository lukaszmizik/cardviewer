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
export type CrewRecordCourse = 'crew_record_consistent' | 'crew_record_interrupted' | 'crew_record_unknown'

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
 * 30hodinové okno se použije jen při souvislém záznamu příznaku osádky
 * v pracovním úseku po první hodině. Jediný příznak ani neúplný úsek nestačí.
 * Není to důkaz, že druhý řidič vozidlo řídil.
 */
export function decideCrewDailyWindow(input: {
  windowStartUtc: number
  activities: readonly CrewActivity[]
  unknownIntervals?: readonly CrewUnknown[]
}): { applies: boolean; crewRecord: CrewRecordCourse } {
  const assessed = assessCrewDailyWindow(input)
  const crewSeen = assessed.recording === 'recorded' || assessed.recording === 'partial'
  return {
    applies: crewSeen && assessed.crewRecord === 'crew_record_consistent',
    crewRecord: assessed.crewRecord,
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
    crewRecord: assessCrewRecord(input.activities, unknowns, windowStartUtc, segmentEndUtc),
    legalApplicability: 'undecided',
    uncertainties,
  }
}

/**
 * Pracovní úsek je od konce předchozího odpočinku po začátek kandidátního
 * devítihodinového odpočinku. Změna slotu průběh sama nepřerušuje.
 * První hodina se toleruje jen na začátku úseku.
 */
function assessCrewRecord(
  activities: readonly CrewActivity[],
  unknowns: readonly CrewUnknown[],
  segmentStartUtc: number,
  segmentEndUtc: number,
): CrewRecordCourse {
  const requiredStartUtc = segmentStartUtc + CREW_FIRST_HOUR_MS
  if (segmentEndUtc <= requiredStartUtc) return 'crew_record_consistent'
  const reliable: Array<[number, number]> = []
  let cardOut = false
  let interrupted = false
  for (const activity of activities) {
    if (activity.endUtc <= activity.startUtc) continue
    const startUtc = Math.max(activity.startUtc, requiredStartUtc)
    const endUtc = Math.min(activity.endUtc, segmentEndUtc)
    if (endUtc <= startUtc) continue
    if (activity.kind === 'unknown' || activity.isManualEntry === true) {
      cardOut = true
      continue
    }
    if (!activity.isCrew) {
      interrupted = true
      continue
    }
    reliable.push([startUtc, endUtc])
  }
  if (interrupted) return 'crew_record_interrupted'
  const unknown = unknowns.some((interval) => overlaps(requiredStartUtc, segmentEndUtc, interval.startUtc, interval.endUtc))
  if (unknown || cardOut || !covers(reliable, requiredStartUtc, segmentEndUtc)) return 'crew_record_unknown'
  return 'crew_record_consistent'
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
