import type { Activity, ActivityKind } from '../types/tacho'

const HOUR_MS = 60 * 60 * 1000

/** Nejasnost, která může ovlivnit správnost intervalu. Není to právní závěr. */
export type RestIntervalUncertainty =
  | 'overlaps_non_rest'
  | 'overlaps_rest_in_other_slot'
  | 'overlapping_same_slot_rest'
  | 'adjacent_other_slot'
  | 'manual_entry'

export type RestCandidateFlags = {
  atLeast9h: boolean
  atLeast11h: boolean
  atLeast24h: boolean
  atLeast45h: boolean
}

export type RestInterval = {
  startUtc: number
  endUtc: number
  durationMs: number
  durationMinutes: number
  /** Slot, ve kterém leží zdrojové záznamy. null = aktivita slot nemá. */
  slot: 1 | 2 | null
  sourceActivityIds: string[]
  /**
   * true, když z překryvu nelze prokázat nepřerušený odpočinek.
   * Délkové příznaky zůstávají jen informativní.
   */
  ambiguous: boolean
  uncertainties: RestIntervalUncertainty[]
  overlappingNonRestKinds: Array<Exclude<ActivityKind, 'rest'>>
  candidateFlags: RestCandidateFlags
}

type SlotKey = '1' | '2' | 'unspecified'

function slotKey(slot: Activity['slot']): SlotKey {
  if (slot === 1) return '1'
  if (slot === 2) return '2'
  return 'unspecified'
}

function slotFromKey(key: SlotKey): 1 | 2 | null {
  if (key === '1') return 1
  if (key === '2') return 2
  return null
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA
}

function candidateFlags(durationMs: number): RestCandidateFlags {
  return {
    atLeast9h: durationMs >= 9 * HOUR_MS,
    atLeast11h: durationMs >= 11 * HOUR_MS,
    atLeast24h: durationMs >= 24 * HOUR_MS,
    atLeast45h: durationMs >= 45 * HOUR_MS,
  }
}

function sameSlotRestOverlap(cluster: Activity[]): boolean {
  for (let i = 0; i < cluster.length; i += 1) {
    for (let j = i + 1; j < cluster.length; j += 1) {
      const left = cluster[i]!
      const right = cluster[j]!
      if (rangesOverlap(left.startUtc, left.endUtc, right.startUtc, right.endUtc)) return true
    }
  }
  return false
}

/**
 * Souvislé úseky `rest` z původních aktivit karty.
 *
 * Spojuje jen záznamy stejného slotu, které na sebe navazují nebo se překrývají
 * a mezi nimi není časová mezera. Slot 1 a slot 2 jsou paralelní osy jedné karty;
 * modul je neslučuje do jednoho řidiče. Mezera v záznamech není odpočinek.
 * Délkové příznaky jsou kandidáti, ne právní klasifikace.
 */
export function findRestIntervals(activities: readonly Activity[]): RestInterval[] {
  const sorted = [...activities].sort(
    (a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc || a.id.localeCompare(b.id),
  )
  const usable = sorted.filter((activity) => activity.endUtc > activity.startUtc)
  const rests = usable.filter((activity) => activity.kind === 'rest')
  const nonRests = usable.filter((activity) => activity.kind !== 'rest')

  const bySlot = new Map<SlotKey, Activity[]>()
  for (const rest of rests) {
    const key = slotKey(rest.slot)
    const list = bySlot.get(key)
    if (list) list.push(rest)
    else bySlot.set(key, [rest])
  }

  const intervals: RestInterval[] = []
  for (const [key, list] of bySlot) {
    let cluster: Activity[] = []
    let clusterEnd = Number.NEGATIVE_INFINITY

    const flush = () => {
      if (cluster.length === 0) return
      intervals.push(toInterval(cluster, key, nonRests, rests))
      cluster = []
      clusterEnd = Number.NEGATIVE_INFINITY
    }

    for (const rest of list) {
      if (cluster.length === 0) {
        cluster = [rest]
        clusterEnd = rest.endUtc
        continue
      }
      if (rest.startUtc > clusterEnd) {
        flush()
        cluster = [rest]
        clusterEnd = rest.endUtc
        continue
      }
      cluster.push(rest)
      if (rest.endUtc > clusterEnd) clusterEnd = rest.endUtc
    }
    flush()
  }

  markAdjacentOtherSlots(intervals)
  intervals.sort(
    (a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc || String(a.slot).localeCompare(String(b.slot)),
  )
  return intervals
}

function toInterval(
  cluster: Activity[],
  key: SlotKey,
  nonRests: Activity[],
  allRests: Activity[],
): RestInterval {
  const startUtc = Math.min(...cluster.map((activity) => activity.startUtc))
  const endUtc = Math.max(...cluster.map((activity) => activity.endUtc))
  const durationMs = endUtc - startUtc
  const overlappingNonRestKinds = uniqueKinds(
    nonRests
      .filter((activity) => rangesOverlap(startUtc, endUtc, activity.startUtc, activity.endUtc))
      .map((activity) => activity.kind)
      .filter((kind): kind is Exclude<ActivityKind, 'rest'> => kind !== 'rest'),
  )
  const overlapsOtherSlotRest = allRests.some(
    (activity) =>
      slotKey(activity.slot) !== key && rangesOverlap(startUtc, endUtc, activity.startUtc, activity.endUtc),
  )
  const uncertainties: RestIntervalUncertainty[] = []
  if (overlappingNonRestKinds.length > 0) uncertainties.push('overlaps_non_rest')
  if (overlapsOtherSlotRest) uncertainties.push('overlaps_rest_in_other_slot')
  if (sameSlotRestOverlap(cluster)) uncertainties.push('overlapping_same_slot_rest')
  if (cluster.some((activity) => activity.isManualEntry === true)) uncertainties.push('manual_entry')

  return {
    startUtc,
    endUtc,
    durationMs,
    durationMinutes: Math.round(durationMs / 60_000),
    slot: slotFromKey(key),
    sourceActivityIds: cluster.map((activity) => activity.id),
    ambiguous: uncertainties.includes('overlaps_non_rest') || uncertainties.includes('overlaps_rest_in_other_slot'),
    uncertainties,
    overlappingNonRestKinds,
    candidateFlags: candidateFlags(durationMs),
  }
}

function uniqueKinds(kinds: Array<Exclude<ActivityKind, 'rest'>>): Array<Exclude<ActivityKind, 'rest'>> {
  const order: Array<Exclude<ActivityKind, 'rest'>> = ['driving', 'work', 'availability', 'unknown']
  return order.filter((kind) => kinds.includes(kind))
}

function markAdjacentOtherSlots(intervals: RestInterval[]): void {
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const left = intervals[i]!
      const right = intervals[j]!
      if (left.slot === right.slot) continue
      const touches = left.endUtc === right.startUtc || right.endUtc === left.startUtc
      if (!touches) continue
      pushUncertainty(left, 'adjacent_other_slot')
      pushUncertainty(right, 'adjacent_other_slot')
    }
  }
}

function pushUncertainty(interval: RestInterval, uncertainty: RestIntervalUncertainty): void {
  if (!interval.uncertainties.includes(uncertainty)) interval.uncertainties.push(uncertainty)
}
