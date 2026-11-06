import type { ActivityKind } from '../types/tacho.ts'

/** Limit souvislého součtu řízení mezi přestávkami. Přesná hodnota ještě limitem projde. */
export const DRIVING_LIMIT_MS = 4.5 * 60 * 60 * 1000
export const BREAK_FULL_MS = 45 * 60 * 1000
export const BREAK_FIRST_MS = 15 * 60 * 1000
export const BREAK_SECOND_MS = 30 * 60 * 1000

export type DrivingBreakStatus = 'within_limit' | 'exceeded' | 'insufficient_data'

export type QualifyingDrivingBreak = {
  kind: 'continuous_45' | 'split_15_30'
  startUtc: number
  completedAtUtc: number
  sourceActivityIds: string[]
}

/**
 * Jeden úsek součtu řízení. Překročení není přestupek.
 * `isCrew` se nečte a výjimka pro osádku se neposuzuje.
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
}

export type BreakActivity = {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
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
 * Sečte řízení do 4 h 30 min. Vynuluje je jen souvislý odpočinek alespoň 45 minut,
 * nebo v tomtéž úseku nejdřív odpočinek alespoň 15 minut a až po něm alespoň 30 minut.
 * Pohotovost a jiná práce součet nevynulují. Neznámý úsek před rozhodnutím není překročení.
 */
export function assessDrivingBreaks(activities: readonly BreakActivity[]): DrivingBreakPeriod[] {
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
    })
    open = null
  }

  for (const segment of timeline(activities)) {
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

function timeline(activities: readonly BreakActivity[]): Segment[] {
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
    const chosen = unknown.length > 0 ? unknown : driving.length > 0 ? driving : rest
    const mode: Mode = unknown.length > 0 ? 'unknown' : driving.length > 0 ? 'driving' : rest.length > 0 ? 'rest' : 'other'
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
