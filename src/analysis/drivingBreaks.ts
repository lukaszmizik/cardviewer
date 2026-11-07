import type { ActivityKind } from '../types/tacho.ts'

/** Limit souvislého součtu řízení mezi přestávkami. Přesná hodnota ještě limitem projde. */
export const DRIVING_LIMIT_MS = 4.5 * 60 * 60 * 1000
export const BREAK_FULL_MS = 45 * 60 * 1000
export const BREAK_FIRST_MS = 15 * 60 * 1000
export const BREAK_SECOND_MS = 30 * 60 * 1000

export type DrivingBreakStatus = 'within_limit' | 'exceeded' | 'insufficient_data' | 'crew_break_unconfirmed'

export type QualifyingDrivingBreak = {
  kind: 'continuous_45' | 'split_15_30'
  startUtc: number
  completedAtUtc: number
  sourceActivityIds: string[]
}

/** Ruční potvrzení jednoho intervalu pohotovosti. Bez obou podmínek se nepoužije. */
export type CrewBreakConfirmation = {
  startUtc: number
  endUtc: number
  sourceActivityIds: readonly string[]
  secondDriverDrove: true
  didNotAssist: true
}

export type DrivingBreakEvidence = 'tachograph' | 'manual_crew_confirmation'

export type ConfirmableCrewBreak = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
}

/**
 * Jeden úsek součtu řízení. Překročení není přestupek.
 * `crew_break_unconfirmed` znamená, že limit vychází jinak, pokud by se pohotovost v osádce uznala jako přestávka.
 * Karta takovou přestávku neprokazuje.
 */
export type DrivingBreakPeriod = {
  status: DrivingBreakStatus
  startUtc: number
  endUtc: number
  drivingMs: number
  /** Okamžik, kdy známé řízení překročilo 4 h 30 min. Jinak chybí. */
  limitReachedUtc: number | null
  drivingSourceActivityIds: string[]
  qualifyingBreak: QualifyingDrivingBreak | null
  /** `manual_crew_confirmation` platí jen pro potvrzené intervaly pohotovosti, ne pro celý výpočet z karty. */
  evidence: DrivingBreakEvidence
  /** Pohotovost v osádce, jejíž potvrzení může změnit tento úsek. Prázdné, když už o výsledku nerozhoduje. */
  confirmableCrewBreaks: ConfirmableCrewBreak[]
}

export type BreakActivity = {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
  /** Příznak osádky z karty. Sám o sobě nedokládá řízení druhého řidiče. */
  isCrew?: boolean
}

type Mode = 'unknown' | 'driving' | 'rest' | 'other'

type Segment = {
  mode: Mode
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
}

type OpenPeriod = {
  startUtc: number
  endUtc: number
  drivingMs: number
  drivingSourceActivityIds: string[]
  limitReachedUtc: number | null
  unknownStartedAt: number | null
  firstPart: { startUtc: number; sourceActivityIds: string[] } | null
}

/**
 * Sečte řízení do 4 h 30 min. Prokázaně ho vynuluje jen souvislý odpočinek alespoň 45 minut,
 * nebo v tomtéž úseku nejdřív odpočinek alespoň 15 minut a až po něm alespoň 30 minut.
 * Pohotovost a jiná práce prokázaný součet nevynulují. Neznámý úsek před rozhodnutím není překročení.
 * Pohotovost s příznakem osádky může být přestávkou ve vozidle řízeném jiným řidičem, jen pokud řidič nepomáhá.
 * Karta druhé z těchto podmínek nedokládá, proto nepotvrzená pohotovost není kvalifikovaná přestávka.
 * Pokud by její uznání udrželo řízení v limitu, výsledek zůstane `crew_break_unconfirmed`.
 * Potvrzení platí jen pro pohotovost s příznakem osádky a oběma podmínkami. Řízení, práci a neznámý úsek nemění.
 */
export function assessDrivingBreaks(
  activities: readonly BreakActivity[],
  confirmations: readonly CrewBreakConfirmation[] = [],
): DrivingBreakPeriod[] {
  const accepted = usableConfirmations(activities, confirmations)
  return collect(activities, accepted).map((period) => {
    const evidence = evidenceOf(period.qualifyingBreak, accepted)
    if (period.status !== 'exceeded') return { ...period, evidence, confirmableCrewBreaks: [] }
    const hypothetical = collect(clip(activities, period.startUtc, period.endUtc), [], true)
    if (hypothetical.length === 0 || hypothetical.some((item) => item.status !== 'within_limit')) {
      return { ...period, evidence: 'tachograph', confirmableCrewBreaks: [] }
    }
    return {
      ...period,
      status: 'crew_break_unconfirmed',
      limitReachedUtc: null,
      evidence: 'tachograph',
      confirmableCrewBreaks: confirmableBreaks(activities, period.startUtc, period.endUtc),
    }
  })
}

/** Obě podmínky musí být pravdivé. Jinak se interval do výpočtu nedostane. */
export function acceptCrewBreakConfirmation(
  interval: { startUtc: number; endUtc: number; sourceActivityIds: readonly string[] },
  conditions: { secondDriverDrove: boolean; didNotAssist: boolean },
): CrewBreakConfirmation | null {
  if (!conditions.secondDriverDrove || !conditions.didNotAssist) return null
  if (interval.endUtc <= interval.startUtc || interval.sourceActivityIds.length === 0) return null
  return {
    startUtc: interval.startUtc,
    endUtc: interval.endUtc,
    sourceActivityIds: interval.sourceActivityIds,
    secondDriverDrove: true,
    didNotAssist: true,
  }
}

function collect(
  activities: readonly BreakActivity[],
  confirmations: readonly CrewBreakConfirmation[],
  acceptAllCrewAvailability = false,
): DrivingBreakPeriod[] {
  const periods: DrivingBreakPeriod[] = []
  let open: OpenPeriod | null = null

  const close = (endUtc: number, qualifyingBreak: QualifyingDrivingBreak | null) => {
    if (open == null) return
    if (open.drivingMs === 0 && open.unknownStartedAt == null) {
      open = null
      return
    }
    const unknownBlocks = open.unknownStartedAt != null && (open.limitReachedUtc == null || open.limitReachedUtc > open.unknownStartedAt)
    const status: DrivingBreakStatus = unknownBlocks ? 'insufficient_data' : open.limitReachedUtc != null ? 'exceeded' : 'within_limit'
    periods.push({
      status,
      startUtc: open.startUtc,
      endUtc,
      drivingMs: open.drivingMs,
      limitReachedUtc: status === 'exceeded' ? open.limitReachedUtc : null,
      drivingSourceActivityIds: open.drivingSourceActivityIds,
      qualifyingBreak,
      evidence: 'tachograph',
      confirmableCrewBreaks: [],
    })
    open = null
  }

  for (const segment of timeline(activities, confirmations, acceptAllCrewAvailability)) {
    if (segment.mode === 'driving') {
      open = ensure(open, segment.startUtc)
      const before = open.drivingMs
      open.drivingMs += segment.endUtc - segment.startUtc
      open.endUtc = segment.endUtc
      addIds(open.drivingSourceActivityIds, segment.sourceActivityIds)
      if (open.drivingMs > DRIVING_LIMIT_MS && open.limitReachedUtc == null) {
        open.limitReachedUtc = segment.startUtc + (DRIVING_LIMIT_MS - before)
      }
      continue
    }
    if (segment.mode === 'unknown') {
      open = ensure(open, segment.startUtc)
      if (open.unknownStartedAt == null) open.unknownStartedAt = segment.startUtc
      open.endUtc = segment.endUtc
      continue
    }
    if (segment.mode !== 'rest') continue
    const duration = segment.endUtc - segment.startUtc
    if (duration >= BREAK_FULL_MS) {
      close(segment.startUtc + BREAK_FULL_MS, {
        kind: 'continuous_45',
        startUtc: segment.startUtc,
        completedAtUtc: segment.startUtc + BREAK_FULL_MS,
        sourceActivityIds: segment.sourceActivityIds,
      })
      continue
    }
    if (open != null && open.firstPart != null && duration >= BREAK_SECOND_MS) {
      close(segment.startUtc + BREAK_SECOND_MS, {
        kind: 'split_15_30',
        startUtc: open.firstPart.startUtc,
        completedAtUtc: segment.startUtc + BREAK_SECOND_MS,
        sourceActivityIds: [...open.firstPart.sourceActivityIds, ...segment.sourceActivityIds],
      })
      continue
    }
    if (open != null && open.drivingMs > 0 && open.firstPart == null && duration >= BREAK_FIRST_MS) {
      open.firstPart = { startUtc: segment.startUtc, sourceActivityIds: [...segment.sourceActivityIds] }
      open.endUtc = segment.endUtc
    }
  }
  if (open != null) close(open.endUtc, null)
  return periods
}

function ensure(open: OpenPeriod | null, atUtc: number): OpenPeriod {
  if (open != null) return open
  return {
    startUtc: atUtc,
    endUtc: atUtc,
    drivingMs: 0,
    drivingSourceActivityIds: [],
    limitReachedUtc: null,
    unknownStartedAt: null,
    firstPart: null,
  }
}

function clip(activities: readonly BreakActivity[], startUtc: number, endUtc: number): BreakActivity[] {
  return activities.flatMap((activity) => {
    const start = Math.max(activity.startUtc, startUtc)
    const end = Math.min(activity.endUtc, endUtc)
    if (end <= start) return []
    return [{ ...activity, startUtc: start, endUtc: end }]
  })
}

function usableConfirmations(
  activities: readonly BreakActivity[],
  confirmations: readonly CrewBreakConfirmation[],
): CrewBreakConfirmation[] {
  const byId = new Map(activities.map((activity) => [activity.id, activity]))
  return confirmations.filter((confirmation) => {
    if (confirmation.secondDriverDrove !== true || confirmation.didNotAssist !== true) return false
    if (confirmation.endUtc <= confirmation.startUtc || confirmation.sourceActivityIds.length === 0) return false
    return confirmation.sourceActivityIds.every((id) => {
      const activity = byId.get(id)
      return activity != null
        && activity.kind === 'availability'
        && activity.isCrew === true
        && activity.startUtc < confirmation.endUtc
        && activity.endUtc > confirmation.startUtc
    })
  })
}

function evidenceOf(qualifyingBreak: QualifyingDrivingBreak | null, confirmations: readonly CrewBreakConfirmation[]): DrivingBreakEvidence {
  if (qualifyingBreak == null) return 'tachograph'
  const confirmed = new Set(confirmations.flatMap((confirmation) => confirmation.sourceActivityIds))
  return qualifyingBreak.sourceActivityIds.some((id) => confirmed.has(id)) ? 'manual_crew_confirmation' : 'tachograph'
}

function confirmableBreaks(activities: readonly BreakActivity[], startUtc: number, endUtc: number): ConfirmableCrewBreak[] {
  return activities
    .filter((activity) => activity.kind === 'availability' && activity.isCrew === true)
    .filter((activity) => activity.endUtc - activity.startUtc >= BREAK_FIRST_MS)
    .filter((activity) => activity.startUtc < endUtc && activity.endUtc > startUtc)
    .map((activity) => ({
      startUtc: Math.max(activity.startUtc, startUtc),
      endUtc: Math.min(activity.endUtc, endUtc),
      sourceActivityIds: [activity.id],
    }))
    .filter((interval) => interval.endUtc - interval.startUtc >= BREAK_FIRST_MS)
}

function confirmationCovers(
  startUtc: number,
  endUtc: number,
  activityIds: readonly string[],
  confirmations: readonly CrewBreakConfirmation[],
): boolean {
  return confirmations.some((confirmation) =>
    confirmation.startUtc <= startUtc
    && confirmation.endUtc >= endUtc
    && activityIds.every((id) => confirmation.sourceActivityIds.includes(id)),
  )
}

function timeline(
  activities: readonly BreakActivity[],
  confirmations: readonly CrewBreakConfirmation[],
  acceptAllCrewAvailability: boolean,
): Segment[] {
  const usable = activities
    .filter((activity) => activity.endUtc > activity.startUtc)
    .sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc || left.id.localeCompare(right.id))
  const points = new Set<number>()
  for (const activity of usable) {
    points.add(activity.startUtc)
    points.add(activity.endUtc)
  }
  const bounds = [...points].sort((left, right) => left - right)
  const slices: Segment[] = []
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const startUtc = bounds[index]!
    const endUtc = bounds[index + 1]!
    const overlapping = usable.filter((activity) => activity.startUtc < endUtc && activity.endUtc > startUtc)
    const unknown = overlapping.filter((activity) => activity.kind === 'unknown')
    const driving = overlapping.filter((activity) => activity.kind === 'driving')
    const rest = overlapping.filter((activity) => activity.kind === 'rest')
    const work = overlapping.filter((activity) => activity.kind === 'work')
    const availability = overlapping.filter((activity) => activity.kind === 'availability')
    const crewAvailability = work.length === 0 && availability.length > 0 && availability.every((activity) => activity.isCrew === true)
      && (acceptAllCrewAvailability || confirmationCovers(startUtc, endUtc, availability.map((activity) => activity.id), confirmations))
    const chosen = unknown.length > 0 ? unknown : driving.length > 0 ? driving : rest.length > 0 ? rest : crewAvailability ? availability : []
    const mode: Mode =
      unknown.length > 0 ? 'unknown' : driving.length > 0 ? 'driving' : rest.length > 0 || crewAvailability ? 'rest' : 'other'
    slices.push({
      mode,
      startUtc,
      endUtc,
      sourceActivityIds: chosen.map((activity) => activity.id),
    })
  }
  const merged: Segment[] = []
  for (const slice of slices) {
    const last = merged[merged.length - 1]
    if (last != null && last.mode === slice.mode && last.endUtc === slice.startUtc) {
      last.endUtc = slice.endUtc
      addIds(last.sourceActivityIds, slice.sourceActivityIds)
      continue
    }
    merged.push({ ...slice, sourceActivityIds: [...slice.sourceActivityIds] })
  }
  return merged
}

function addIds(target: string[], ids: readonly string[]): void {
  for (const id of ids) {
    if (!target.includes(id)) target.push(id)
  }
}
