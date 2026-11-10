import { decideCrewDailyWindow, CREW_WINDOW_MS, type CrewWindowBasis, type CrewRecordCourse } from './crewDailyRest.ts'
import { findDailyRestOptions, type DailyRestOption, type DailyRestVariantKind } from './dailyRestOptions.ts'
import { classifyRestCandidates, type RestCandidate } from './restCandidates.ts'
import { findRestIntervals } from './restIntervals.ts'
import { DAILY_WINDOW_MS } from './restWindowIntersection.ts'
import type { Activity } from '../types/tacho.ts'

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const THREE_HOURS = 3 * HOUR_MS
const NINE_HOURS = 9 * HOUR_MS
const ELEVEN_HOURS = 11 * HOUR_MS
const MAX_PERIODS = 48

/**
 * Referenční období podle TRACE II, Annex 1, Guidance Note 7.
 * Není to hranice směny ani zápis přestupku.
 * Trajekt, vlak a další výjimky, které stávající analytika nerozpozná, se neuplatňují.
 */
export const GN7_UNSUPPORTED = [
  'Přerušení denního odpočinku na trajektu nebo ve vlaku se nerozpoznává.',
  'Dostupnost zkráceného denního odpočinku mezi týdenními odpočinky se nerozhoduje.',
  'Značky země začátku a konce směny období nevytvářejí.',
] as const

export type Gn7DataCompleteness = 'complete' | 'incomplete' | 'history_incomplete'

export type Gn7PeriodStatus =
  | 'qualifying_rest'
  | 'consecutive_reference'
  | 'crossing_rest_becomes_qualifying'
  | 'crossing_rest_remains_insufficient'
  | 'insufficient_data'
  | 'history_incomplete'

export type Gn7ReducedAvailability = 'not_assessed' | 'not_required' | 'not_applicable'

export type Gn7RestOverlap = {
  startUtc: number
  endUtc: number
  /** Přesná délka intervalu. Prahy 9 a 11 hodin se neberou ze zaokrouhlených minut. */
  durationMs: number
  durationMinutes: number
  /** Celé minuty průniku, zaokrouhlené dolů. */
  minutesInsideWindow: number
  sourceActivityIds: string[]
  established: boolean
  /** Odpočinek obsahuje okamžik konce referenčního okna. */
  crossesWindowEnd: boolean
  /** Celková délka dosahuje 9 hodin. Není to právní přípustnost zkrácení. */
  reachesNamedMinimum: boolean
  /** Celková délka dosahuje 11 hodin. */
  reachesRegularLength: boolean
}

export type Gn7WindowVariant = {
  windowMinutes: number
  endUtc: number
  status: Gn7PeriodStatus
  nextAnchorUtc: number | null
  assessmentBasis: string
  confirmedForEnforcement: boolean
}

export type Gn7QualifyingBasis = {
  variant: DailyRestVariantKind
  startUtc: number
  endUtc: number
  established: boolean
  sourceActivityIds: string[]
}

export type Gn7ControlPeriod = {
  startUtc: number
  /** Konec referenčního okna, ne nutně další kotva. */
  endUtc: number
  windowMinutes: number
  boundarySource: 'gn7'
  dataCompleteness: Gn7DataCompleteness
  status: Gn7PeriodStatus
  /** Kam začíná další referenční období. null, když to ze záznamu nelze určit. */
  nextAnchorUtc: number | null
  crewApplies: boolean
  crewBasis: CrewWindowBasis | null
  crewRecord: CrewRecordCourse | null
  crewRefusal: string | null
  rests: Gn7RestOverlap[]
  qualifying: Gn7QualifyingBasis[]
  /** Popis, podle kterého se kotva a odpočinek posoudily. Není to přestupek. */
  assessmentBasis: string
  limitations: string[]
  /**
   * false, když výsledek nemá být podkladem přestupku: nejistá data, zkrácení bez evidence,
   * nebo podmíněná osádka.
   */
  confirmedForEnforcement: boolean
  /** Právní přípustnost dalšího zkrácení. Bez počtu zkrácení zůstává not_assessed. */
  reducedRestPermitted: Gn7ReducedAvailability
  /** true jen na období, za kterým výpočet skončil kvůli limitu a historie pokračuje. */
  analysisTruncated: boolean
  /** U podmíněné osádky 24h i 30h. Jinak jedno použité okno. */
  windowVariants: Gn7WindowVariant[]
}

export type BuildGn7ControlPeriodsInput = {
  /** Konec posledního kvalifikovaného denního nebo týdenního odpočinku. */
  anchorUtc: number
  activities: readonly Activity[]
  /** Hotoví kandidáti. Bez nich se spočítají stávajícími funkcemi. */
  candidates?: readonly RestCandidate[]
  /** Konec známého záznamu. Bez něj se vezme konec poslední činnosti. */
  recordEndUtc?: number | null
}

export function buildGn7ControlPeriods(input: BuildGn7ControlPeriodsInput): Gn7ControlPeriod[] {
  const candidates = input.candidates ?? classifyRestCandidates(findRestIntervals(input.activities))
  const unknowns = unknownIntervals(input.activities)
  const recordEndUtc = input.recordEndUtc ?? latestEnd(input.activities)
  const periods: Gn7ControlPeriod[] = []
  let anchor = input.anchorUtc

  for (let index = 0; index < MAX_PERIODS; index += 1) {
    const period = evaluatePeriod(anchor, input.activities, candidates, unknowns, recordEndUtc)
    const canContinue = period.nextAnchorUtc != null
      && period.nextAnchorUtc > anchor
      && (recordEndUtc == null || period.nextAnchorUtc < recordEndUtc)
    if (index === MAX_PERIODS - 1 && canContinue) period.analysisTruncated = true
    periods.push(period)
    if (!canContinue) break
    anchor = period.nextAnchorUtc!
  }

  return periods
}

function evaluatePeriod(
  anchorUtc: number,
  activities: readonly Activity[],
  candidates: readonly RestCandidate[],
  unknowns: readonly { startUtc: number; endUtc: number }[],
  recordEndUtc: number | null,
): Gn7ControlPeriod {
  const crew = decideCrewDailyWindow({
    windowStartUtc: anchorUtc,
    activities: activities.map((activity) => ({
      id: activity.id,
      kind: activity.kind,
      startUtc: activity.startUtc,
      endUtc: activity.endUtc,
      isCrew: activity.isCrew === true,
      isManualEntry: activity.isManualEntry,
      slot: activity.slot,
    })),
    unknownIntervals: unknowns,
  })
  const limitations = [...GN7_UNSUPPORTED]
  if (crew.basis === 'conditional') {
    limitations.push('30hodinové okno vychází z podmíněného rozhodnutí osádky, ne z prokázaného druhého řidiče.')
    const single = assessWindow(anchorUtc, DAILY_WINDOW_MS, candidates, unknowns, recordEndUtc)
    const crewWindow = assessWindow(anchorUtc, CREW_WINDOW_MS, candidates, unknowns, recordEndUtc)
    return {
      ...crewFields(anchorUtc, crew, limitations),
      ...single,
      endUtc: crewWindow.endUtc,
      windowMinutes: crewWindow.windowMinutes,
      rests: crewWindow.rests,
      status: 'insufficient_data',
      nextAnchorUtc: null,
      dataCompleteness: 'incomplete',
      qualifying: [],
      confirmedForEnforcement: false,
      reducedRestPermitted: 'not_applicable',
      assessmentBasis: 'Podmíněná osádka není prokázaná vícečlenná osádka. 24hodinová i 30hodinová varianta jsou jen diagnostické a kotva se podle nich neposouvá.',
      windowVariants: [toVariant(single, false), toVariant(crewWindow, false)],
    }
  }

  const windowMs = crew.applies ? CREW_WINDOW_MS : DAILY_WINDOW_MS
  const assessed = assessWindow(anchorUtc, windowMs, candidates, unknowns, recordEndUtc)
  return {
    ...crewFields(anchorUtc, crew, limitations),
    ...assessed,
    windowVariants: [toVariant(assessed, assessed.confirmedForEnforcement)],
  }
}

function assessWindow(
  anchorUtc: number,
  windowMs: number,
  candidates: readonly RestCandidate[],
  unknowns: readonly { startUtc: number; endUtc: number }[],
  recordEndUtc: number | null,
): Omit<Gn7ControlPeriod, 'crewApplies' | 'crewBasis' | 'crewRecord' | 'crewRefusal' | 'limitations' | 'windowVariants'> {
  const windowEndUtc = anchorUtc + windowMs
  const rests = candidates
    .filter((candidate) => overlaps(candidate.startUtc, candidate.endUtc, anchorUtc, windowEndUtc))
    .map((candidate) => toOverlap(candidate, anchorUtc, windowEndUtc))
  const unknownOverlaps = unknowns.some((interval) => overlaps(interval.startUtc, interval.endUtc, anchorUtc, windowEndUtc))
  const visibleOptions = findDailyRestOptions(candidates, anchorUtc, windowMs).filter((option) =>
    option.parts.every((part) => !intersects(part.startUtc, part.endUtc, unknowns)),
  )
  const options = visibleOptions.filter((option) => option.established)
  const uncertainOptions = visibleOptions.filter((option) => !option.established)
  const base = {
    startUtc: anchorUtc,
    endUtc: windowEndUtc,
    windowMinutes: windowMs / MINUTE_MS,
    boundarySource: 'gn7' as const,
    rests,
    analysisTruncated: false,
  }

  if (uncertainOptions.length > 0 && options.length === 0) {
    return finish(base, {
      dataCompleteness: 'incomplete',
      status: 'insufficient_data',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'V okně je nejednoznačný kandidát kvalifikovaného odpočinku. Není to prokázaná absence odpočinku a kotva se neposouvá.',
    })
  }

  if (unknownOverlaps && options.length === 0) {
    return finish(base, {
      dataCompleteness: 'incomplete',
      status: 'insufficient_data',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'V referenčním okně je neznámý úsek a není v něm prokázaný kvalifikovaný odpočinek. Další kotva se nestanovuje.',
    })
  }

  if (options.length > 0) {
    const qualifying = options.map(toBasis).sort((a, b) => a.endUtc - b.endUtc || a.startUtc - b.startUtc)
    const chosen = qualifying[0]!
    const note = qualifying.length > 1 && qualifying.some((item) => item.endUtc !== chosen.endUtc)
      ? ' Další kotva je konec nejdříve dokončeného kvalifikovaného odpočinku. Ostatní varianty jsou jen v podkladu.'
      : ''
    const reduced = chosen.variant === 'continuous_reduced'
    return finish(base, {
      dataCompleteness: 'complete',
      status: 'qualifying_rest',
      nextAnchorUtc: chosen.endUtc,
      qualifying,
      assessmentBasis: reduced
        ? `Délka odpočinku dosahuje 9 hodin a končí v ${chosen.endUtc}. Právní přípustnost dalšího zkrácení se bez počtu dosavadních zkrácení nepotvrzuje.${note}`
        : `Kvalifikovaný odpočinek ${chosen.variant} končí v ${chosen.endUtc}. Další referenční období začíná na jeho konci, i když je to dříve nebo později než konec okna.${note}`,
    })
  }

  const crossing = rests.filter((rest) => rest.crossesWindowEnd && rest.established)
  const unclearCrossing = rests.some((rest) => rest.crossesWindowEnd && !rest.established)
  if (unclearCrossing) {
    return finish(base, {
      dataCompleteness: 'incomplete',
      status: 'insufficient_data',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'Odpočinek přes hranici okna není jednoznačný. Další kotva se nestanovuje.',
    })
  }
  const truncated = rests.some((rest) => rest.crossesWindowEnd && !restClosedBeforeRecordEnd(rest, recordEndUtc))
  if (recordEndUtc != null && recordEndUtc < windowEndUtc && crossing.length === 0) {
    return finish(base, {
      dataCompleteness: 'history_incomplete',
      status: 'history_incomplete',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'Záznam končí dříve než referenční okno a kvalifikovaný odpočinek v něm není.',
    })
  }
  if (truncated || (recordEndUtc != null && crossing.some((rest) => rest.endUtc >= recordEndUtc))) {
    return finish(base, {
      dataCompleteness: 'history_incomplete',
      status: 'history_incomplete',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'Odpočinek přesahuje známý záznam, takže nelze určit, zda po hranici okna dosáhne 9 nebo 11 hodin.',
    })
  }

  const becoming = crossing.filter((rest) => rest.durationMs >= NINE_HOURS)
  if (becoming.some((rest) => hasEarlierThreeHourPart(rests, rest))) {
    return finish(base, {
      dataCompleteness: 'incomplete',
      status: 'insufficient_data',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'Před odpočinkem přesahujícím hranici okna je alespoň tříhodinová část. Zda jde o dělený odpočinek 3+9, dostupný text GN7 neurčuje. Kotva se nestanovuje.',
    })
  }
  if (becoming.length === 1) {
    const rest = becoming[0]!
    const regular = rest.durationMs >= ELEVEN_HOURS
    return finish(base, {
      dataCompleteness: 'complete',
      status: 'crossing_rest_becomes_qualifying',
      nextAnchorUtc: rest.endUtc,
      qualifying: [{
        variant: regular ? 'continuous_regular' : 'continuous_reduced',
        startUtc: rest.startUtc,
        endUtc: rest.endUtc,
        established: rest.established,
        sourceActivityIds: rest.sourceActivityIds,
      }],
      assessmentBasis: regular
        ? 'Minimum 11 hodin není uvnitř referenčního okna, ale souvislý odpočinek ho po hranici dosáhne. Další kotva je jeho konec.'
        : `Délka přesahujícího odpočinku dosahuje 9 hodin a končí v ${rest.endUtc}. Právní přípustnost dalšího zkrácení se nepotvrzuje. Kotva je konec tohoto odpočinku.`,
    })
  }
  if (becoming.length > 1) {
    return finish(base, {
      dataCompleteness: 'incomplete',
      status: 'insufficient_data',
      nextAnchorUtc: null,
      qualifying: [],
      assessmentBasis: 'Hranici okna protíná víc odpočinků, které po pokračování dosáhnou 9 nebo 11 hodin. Další kotva se nestanovuje.',
    })
  }

  if (crossing.length > 0) {
    return finish(base, {
      dataCompleteness: 'complete',
      status: 'crossing_rest_remains_insufficient',
      nextAnchorUtc: windowEndUtc,
      qualifying: [],
      assessmentBasis: 'Odpočinek přesahuje hranici okna, ale ani po pokračování nedosáhne 9 ani 11 hodin. Další referenční období začíná na hranici okna.',
    })
  }

  const historyEnds = recordEndUtc != null && recordEndUtc < windowEndUtc
  return finish(base, {
    dataCompleteness: historyEnds ? 'history_incomplete' : 'complete',
    status: historyEnds ? 'history_incomplete' : 'consecutive_reference',
    nextAnchorUtc: historyEnds ? null : windowEndUtc,
    qualifying: [],
    assessmentBasis: 'V referenčním okně není kvalifikovaný denní odpočinek. Další období navazuje přesně na hranici 24 nebo 30 hodin.',
  })
}

function finish(
  base: {
    startUtc: number
    endUtc: number
    windowMinutes: number
    boundarySource: 'gn7'
    rests: Gn7RestOverlap[]
    analysisTruncated: boolean
  },
  body: {
    dataCompleteness: Gn7DataCompleteness
    status: Gn7PeriodStatus
    nextAnchorUtc: number | null
    qualifying: Gn7QualifyingBasis[]
    assessmentBasis: string
  },
): Omit<Gn7ControlPeriod, 'crewApplies' | 'crewBasis' | 'crewRecord' | 'crewRefusal' | 'limitations' | 'windowVariants'> {
  const reducedRestPermitted = reducedAvailability(body.qualifying, body.status)
  const confirmedForEnforcement = body.dataCompleteness === 'complete' && reducedRestPermitted !== 'not_assessed'
  return { ...base, ...body, reducedRestPermitted, confirmedForEnforcement }
}

function reducedAvailability(qualifying: readonly Gn7QualifyingBasis[], status: Gn7PeriodStatus): Gn7ReducedAvailability {
  if (status !== 'qualifying_rest' && status !== 'crossing_rest_becomes_qualifying') return 'not_applicable'
  if (qualifying[0]?.variant === 'continuous_reduced') return 'not_assessed'
  return 'not_required'
}

function toVariant(
  period: Pick<Gn7ControlPeriod, 'windowMinutes' | 'endUtc' | 'status' | 'nextAnchorUtc' | 'assessmentBasis' | 'confirmedForEnforcement'>,
  confirmedForEnforcement: boolean,
): Gn7WindowVariant {
  return {
    windowMinutes: period.windowMinutes,
    endUtc: period.endUtc,
    status: period.status,
    nextAnchorUtc: period.nextAnchorUtc,
    assessmentBasis: period.assessmentBasis,
    confirmedForEnforcement,
  }
}

function crewFields(
  anchorUtc: number,
  crew: ReturnType<typeof decideCrewDailyWindow>,
  limitations: string[],
): Pick<Gn7ControlPeriod, 'startUtc' | 'crewApplies' | 'crewBasis' | 'crewRecord' | 'crewRefusal' | 'limitations'> {
  return {
    startUtc: anchorUtc,
    crewApplies: crew.applies,
    crewBasis: crew.basis,
    crewRecord: crew.crewRecord,
    crewRefusal: crew.refusal,
    limitations,
  }
}

function hasEarlierThreeHourPart(rests: readonly Gn7RestOverlap[], crossing: Gn7RestOverlap): boolean {
  return rests.some((rest) =>
    rest !== crossing
    && rest.established
    && rest.durationMs >= THREE_HOURS
    && rest.endUtc <= crossing.startUtc,
  )
}

function toBasis(option: DailyRestOption): Gn7QualifyingBasis {
  const last = option.parts[option.parts.length - 1]!
  return {
    variant: option.kind,
    startUtc: option.parts[0]!.startUtc,
    endUtc: last.endUtc,
    established: option.established,
    sourceActivityIds: [...new Set(option.parts.flatMap((part) => part.sourceActivityIds))],
  }
}

function toOverlap(candidate: RestCandidate, windowStartUtc: number, windowEndUtc: number): Gn7RestOverlap {
  const overlapMs = Math.min(candidate.endUtc, windowEndUtc) - Math.max(candidate.startUtc, windowStartUtc)
  return {
    startUtc: candidate.startUtc,
    endUtc: candidate.endUtc,
    durationMs: candidate.durationMs,
    durationMinutes: candidate.durationMinutes,
    minutesInsideWindow: Math.max(0, Math.floor(overlapMs / MINUTE_MS)),
    sourceActivityIds: [...candidate.sourceActivityIds],
    established: candidate.established,
    crossesWindowEnd: candidate.startUtc < windowEndUtc && candidate.endUtc > windowEndUtc,
    reachesNamedMinimum: candidate.durationMs >= NINE_HOURS,
    reachesRegularLength: candidate.durationMs >= ELEVEN_HOURS,
  }
}

function restClosedBeforeRecordEnd(rest: Gn7RestOverlap, recordEndUtc: number | null): boolean {
  return recordEndUtc != null && rest.endUtc < recordEndUtc
}

function unknownIntervals(activities: readonly Activity[]): Array<{ startUtc: number; endUtc: number }> {
  return activities
    .filter((activity) => activity.kind === 'unknown' && activity.endUtc > activity.startUtc)
    .map((activity) => ({ startUtc: activity.startUtc, endUtc: activity.endUtc }))
}

function latestEnd(activities: readonly Activity[]): number | null {
  let end: number | null = null
  for (const activity of activities) {
    if (end == null || activity.endUtc > end) end = activity.endUtc
  }
  return end
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB
}

function intersects(
  startUtc: number,
  endUtc: number,
  unknowns: readonly { startUtc: number; endUtc: number }[],
): boolean {
  return unknowns.some((interval) => overlaps(startUtc, endUtc, interval.startUtc, interval.endUtc))
}
