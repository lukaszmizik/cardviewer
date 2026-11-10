import type { Activity, ActivityKind, SpecificConditionEntry } from '../types/tacho.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const MAX_INTERRUPTIONS = 2
const MAX_INTERRUPTION_MS = 60 * MINUTE_MS
const NINE_HOURS = 9 * HOUR_MS
const ELEVEN_HOURS = 11 * HOUR_MS
const REDUCED_WEEKLY = 24 * HOUR_MS
const REGULAR_WEEKLY = 45 * HOUR_MS

const WORK_KINDS: readonly ActivityKind[] = ['driving', 'work', 'availability']

/**
 * Kandidát odpočinku přerušeného při přepravě vozidla trajektem nebo vlakem.
 * Není to přestupek ani potvrzení čl. 9 odst. 1.
 *
 * Přerušení je souvislý blok řízení, jiné práce nebo pohotovosti mezi bloky REST.
 * Navazující činnosti bez mezery tvoří jedno přerušení. Neznámý úsek není REST ani přerušení.
 * Čistý REST je součet bloků REST. Celkový rozsah zahrnuje i přerušení.
 */
export type FerryRestQualification =
  | 'regular_daily'
  | 'reduced_weekly'
  | 'regular_weekly'
  | 'reduced_daily_not_covered'
  | 'below_thresholds'

export type FerryRestLegalApplicability = 'confirmed' | 'conditional' | 'not_applicable'

export type FerryModePairing = 'closed' | 'open_ended' | 'ambiguous'

export type FerryRestBlock = {
  startUtc: number
  endUtc: number
  durationMs: number
  sourceActivityIds: string[]
}

export type FerryRestInterruption = {
  startUtc: number
  endUtc: number
  durationMs: number
  kinds: ActivityKind[]
  sourceActivityIds: string[]
}

export type FerryModeLink = {
  startUtc: number
  endUtc: number | null
  pairing: FerryModePairing
}

export type FerryRestCandidate = {
  startUtc: number
  endUtc: number
  restBlocks: FerryRestBlock[]
  interruptions: FerryRestInterruption[]
  interruptionCount: number
  interruptionDurationMs: number
  interruptionMinutes: number
  netRestMs: number
  spanMs: number
  ferryLinks: FerryModeLink[]
  qualification: FerryRestQualification
  /** Počet a součet přerušení a délka odpočinku, na který se čl. 9 odst. 1 vztahuje. */
  timeConditionsMet: boolean
  legalApplicability: FerryRestLegalApplicability
  reasons: string[]
}

export type FindFerryRestCandidatesInput = {
  activities: readonly Activity[]
  specificConditions?: readonly SpecificConditionEntry[]
}

export function findFerryRestCandidates(input: FindFerryRestCandidatesInput): FerryRestCandidate[] {
  const modes = pairFerryModes(input.specificConditions ?? [])
  if (modes.length === 0) return []
  const runs = activityRuns(input.activities)
  const candidates: FerryRestCandidate[] = []
  for (const run of runs) {
    const links = modes.filter((mode) => overlapsMode(run.startUtc, run.endUtc, mode))
    if (links.length === 0 || run.restBlocks.length === 0) continue
    candidates.push(toCandidate(run, links))
  }
  return candidates
}

type Mode = FerryModeLink

function pairFerryModes(conditions: readonly SpecificConditionEntry[]): Mode[] {
  const events = conditions
    .filter((entry) => entry.kind === 'ferry' || entry.kind === 'ferry_end')
    .slice()
    .sort((a, b) => a.atUtc - b.atUtc)
  const modes: Mode[] = []
  let openStart: number | null = null
  let broken = false
  for (const event of events) {
    if (event.kind === 'ferry') {
      if (openStart != null) {
        broken = true
        modes.push({ startUtc: openStart, endUtc: null, pairing: 'ambiguous' })
      }
      openStart = event.atUtc
      continue
    }
    if (openStart == null) {
      broken = true
      modes.push({ startUtc: event.atUtc, endUtc: event.atUtc, pairing: 'ambiguous' })
      continue
    }
    modes.push({ startUtc: openStart, endUtc: event.atUtc, pairing: 'closed' })
    openStart = null
  }
  if (openStart != null) modes.push({ startUtc: openStart, endUtc: null, pairing: 'open_ended' })
  if (broken) {
    for (const mode of modes) mode.pairing = 'ambiguous'
  }
  return modes
}

type Run = {
  startUtc: number
  endUtc: number
  restBlocks: FerryRestBlock[]
  interruptions: FerryRestInterruption[]
  unknownInside: boolean
}

function activityRuns(activities: readonly Activity[]): Run[] {
  const sorted = activities
    .filter((activity) => activity.endUtc > activity.startUtc)
    .slice()
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
  const runs: Run[] = []
  let current: Run | null = null
  let pending: Activity[] = []

  const flushPending = () => {
    if (current == null || pending.length === 0) {
      pending = []
      return
    }
    current.interruptions.push(interruptionFrom(pending))
    pending = []
  }

  for (const activity of sorted) {
    const contiguous = current != null && activity.startUtc === current.endUtc
    if (!contiguous) {
      flushPending()
      current = null
    }
    if (activity.kind === 'unknown') {
      if (current == null) continue
      flushPending()
      current.unknownInside = true
      current.endUtc = activity.endUtc
      continue
    }
    if (activity.kind === 'rest') {
      flushPending()
      if (current == null) {
        current = {
          startUtc: activity.startUtc,
          endUtc: activity.endUtc,
          restBlocks: [],
          interruptions: [],
          unknownInside: false,
        }
        runs.push(current)
      }
      current.restBlocks.push({
        startUtc: activity.startUtc,
        endUtc: activity.endUtc,
        durationMs: activity.endUtc - activity.startUtc,
        sourceActivityIds: [activity.id],
      })
      current.endUtc = activity.endUtc
      continue
    }
    if (current == null || !WORK_KINDS.includes(activity.kind)) {
      flushPending()
      current = null
      continue
    }
    pending.push(activity)
    current.endUtc = activity.endUtc
  }
  flushPending()
  return runs.filter((run) => run.restBlocks.length > 0)
}

function interruptionFrom(activities: readonly Activity[]): FerryRestInterruption {
  const startUtc = activities[0]!.startUtc
  const endUtc = activities[activities.length - 1]!.endUtc
  const kinds: ActivityKind[] = []
  for (const activity of activities) {
    if (!kinds.includes(activity.kind)) kinds.push(activity.kind)
  }
  return {
    startUtc,
    endUtc,
    durationMs: activities.reduce((sum, activity) => sum + (activity.endUtc - activity.startUtc), 0),
    kinds,
    sourceActivityIds: activities.map((activity) => activity.id),
  }
}

function toCandidate(run: Run, links: readonly Mode[]): FerryRestCandidate {
  const netRestMs = run.restBlocks.reduce((sum, block) => sum + block.durationMs, 0)
  const interruptionDurationMs = run.interruptions.reduce((sum, item) => sum + item.durationMs, 0)
  const qualification = qualify(netRestMs)
  const pairingUncertain = links.some((link) => link.pairing !== 'closed')
  const coveredLength = qualification === 'regular_daily' || qualification === 'reduced_weekly' || qualification === 'regular_weekly'
  const interruptionRulesMet = run.interruptions.length <= MAX_INTERRUPTIONS && interruptionDurationMs <= MAX_INTERRUPTION_MS
  const timeConditionsMet = !run.unknownInside && interruptionRulesMet && coveredLength
  const reasons: string[] = []
  if (run.unknownInside) reasons.push('Uvnitř úseku je neznámá činnost. Není započtena jako REST ani jako přerušení.')
  if (pairingUncertain) reasons.push('Párování ferry a ferry_end není uzavřené. Hranice režimu trajektu nejsou jednoznačné.')
  if (run.interruptions.length > MAX_INTERRUPTIONS) reasons.push('Přerušení je víc než dvě.')
  if (interruptionDurationMs > MAX_INTERRUPTION_MS) reasons.push('Součet přerušení je delší než 60 minut.')
  if (qualification === 'reduced_daily_not_covered') {
    reasons.push('Čistý REST dosahuje jen délky zkráceného denního odpočinku. Čl. 9 odst. 1 se na zkrácený denní odpočinek nevztahuje.')
  }
  if (qualification === 'below_thresholds') reasons.push('Čistý REST nedosahuje 11 hodin ani délky týdenního odpočinku.')
  if (qualification === 'regular_daily') {
    reasons.push('Délka odpovídá běžnému dennímu odpočinku. Přístup k lůžku, lůžkové kabině nebo lehátce záznam neprokazuje.')
  }
  if (qualification === 'reduced_weekly') {
    reasons.push('Délka odpovídá zkrácenému týdennímu odpočinku. Přístup k lůžku záznam neprokazuje.')
  }
  if (qualification === 'regular_weekly') {
    reasons.push('Délka odpovídá běžnému týdennímu odpočinku. Plánovaná cesta alespoň 8 hodin a spací kabina v záznamu nejsou.')
  }
  reasons.push('Značka ferry sama o sobě splnění čl. 9 odst. 1 nepotvrzuje.')

  let legalApplicability: FerryRestLegalApplicability = 'not_applicable'
  if (run.unknownInside || pairingUncertain) legalApplicability = 'conditional'
  else if (timeConditionsMet) legalApplicability = 'conditional'

  return {
    startUtc: run.startUtc,
    endUtc: run.endUtc,
    restBlocks: run.restBlocks,
    interruptions: run.interruptions,
    interruptionCount: run.interruptions.length,
    interruptionDurationMs,
    interruptionMinutes: interruptionDurationMs / MINUTE_MS,
    netRestMs,
    spanMs: run.endUtc - run.startUtc,
    ferryLinks: links.map((link) => ({ ...link })),
    qualification,
    timeConditionsMet,
    legalApplicability,
    reasons,
  }
}

function qualify(netRestMs: number): FerryRestQualification {
  if (netRestMs >= REGULAR_WEEKLY) return 'regular_weekly'
  if (netRestMs >= REDUCED_WEEKLY) return 'reduced_weekly'
  if (netRestMs >= ELEVEN_HOURS) return 'regular_daily'
  if (netRestMs >= NINE_HOURS) return 'reduced_daily_not_covered'
  return 'below_thresholds'
}

function overlapsMode(startUtc: number, endUtc: number, mode: Mode): boolean {
  const modeEnd = mode.endUtc ?? Number.POSITIVE_INFINITY
  return startUtc < modeEnd && endUtc > mode.startUtc
}
