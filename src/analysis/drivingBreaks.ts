import type { ActivityKind } from '../types/tacho.ts'

/** Limit souvislého součtu řízení mezi přestávkami. Přesná hodnota ještě limitem projde. */
export const DRIVING_LIMIT_MS = 4.5 * 60 * 60 * 1000
export const BREAK_FULL_MS = 45 * 60 * 1000
export const BREAK_FIRST_MS = 15 * 60 * 1000
export const BREAK_SECOND_MS = 30 * 60 * 1000

export type DrivingBreakStatus = 'within_limit' | 'exceeded' | 'insufficient_data' | 'crew_break_conditional'

export type QualifyingDrivingBreak = {
  kind: 'continuous_45' | 'split_15_30'
  startUtc: number
  completedAtUtc: number
  sourceActivityIds: string[]
}

export type DrivingBreakEvidence = 'tachograph' | 'crew_availability_assumption'

export type ConfirmableCrewBreak = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
}

/**
 * Jeden úsek součtu řízení. Překročení není přestupek.
 * `crew_break_conditional` znamená, že limit vychází jen za předpokladu přestávky v osádce.
 * Karta řízení druhého řidiče ani nepomáhání nedokládá.
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
  /** `crew_availability_assumption` platí jen pro pohotovost s příznakem osádky, ne pro celý výpočet z karty. */
  evidence: DrivingBreakEvidence
  /** Pohotovost v osádce, ze které podmíněné uznání vychází. */
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
 * Karta druhé z těchto podmínek nedokládá. Když délka a pořadí vycházejí, výsledek je podmíněný.
 * Krátká pohotovost, práce uprostřed ani pohotovost bez příznaku osádky přestávku nevytvoří.
 */
export function assessDrivingBreaks(activities: readonly BreakActivity[]): DrivingBreakPeriod[] {
  const periods: DrivingBreakPeriod[] = []
  for (const period of collect(activities, false)) {
    if (period.status !== 'exceeded') {
      periods.push(period)
      continue
    }
    const slice = clip(activities, period.startUtc, period.endUtc)
    const hypothetical = collect(slice, true)
    const crewIds = new Set(slice.filter((activity) => activity.kind === 'availability' && activity.isCrew === true).map((activity) => activity.id))
    const assumedBreak = (item: DrivingBreakPeriod) =>
      item.qualifyingBreak?.sourceActivityIds.some((id) => crewIds.has(id)) === true && item.status === 'within_limit'
    if (hypothetical.length === 0 || !hypothetical.some(assumedBreak)) {
      periods.push(period)
      continue
    }
    for (const item of hypothetical) {
      const assumed = assumedBreak(item)
      periods.push({
        ...item,
        status: assumed ? 'crew_break_conditional' : item.status,
        evidence: assumed ? 'crew_availability_assumption' : 'tachograph',
        confirmableCrewBreaks: assumed ? confirmableBreaks(slice, item.startUtc, item.endUtc) : [],
      })
    }
  }
  return periods
}

function collect(activities: readonly BreakActivity[], acceptAllCrewAvailability: boolean): DrivingBreakPeriod[] {
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

  for (const segment of timeline(activities, acceptAllCrewAvailability)) {
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

function timeline(activities: readonly BreakActivity[], acceptAllCrewAvailability: boolean): Segment[] {
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
    const crewAvailability = acceptAllCrewAvailability
      && work.length === 0
      && availability.length > 0
      && availability.every((activity) => activity.isCrew === true)
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
