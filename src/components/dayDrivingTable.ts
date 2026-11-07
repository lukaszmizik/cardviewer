import { assessDailyDrivingTime, type DailyDrivingPeriod } from '../analysis/dailyDrivingTime.ts'
import { buildDailyRestChain } from '../analysis/dailyRestChain.ts'
import { assessDrivingBreaks, type BreakActivity, type DrivingBreakPeriod, type QualifyingDrivingBreak } from '../analysis/drivingBreaks.ts'
import { classifyRestCandidates } from '../analysis/restCandidates.ts'
import { findRestIntervals } from '../analysis/restIntervals.ts'
import { clockParts, formatClockDateTime, formatClockTime, type ClockMode } from '../lib/clock.ts'
import type { Activity } from '../types/tacho.ts'

export type DayDrivingActivity = BreakActivity & {
  isCrew?: boolean
}

/** Vizuální stav podle výsledku analýzy. Není to závěr o přestupku. */
export type DayDrivingTone = 'clear' | 'caution' | 'exceeded' | 'undecided'

/** Razítko doby řízení podle délky. Neznamená soulad se všemi ustanoveními nařízení. */
export type DayDrivingMark = 'check' | 'alarm' | 'alert' | 'unknown' | 'open'

export type DayDrivingRow = {
  label: string
  /** Úplný text pro stávající kontroly. */
  value: string
  /** Hlavní údaj. U přestávek jen délky, bez časového rozsahu. */
  primary: string
  /** Doplněk, který nemá přebít hlavní údaj. */
  detail: string | null
  tone: DayDrivingTone | null
  /** Text stavového indikátoru. U metriky bez indikátoru zůstává null. */
  statusText: string | null
  /** Ikona razítka doby řízení. Ostatní řádky ji nemají. */
  mark: DayDrivingMark | null
  rule: 'article_6' | 'article_7' | null
  presentation: 'metric' | 'note' | 'status'
}

const UNRELIABLE = 'Nelze spolehlivě vyhodnotit.'
const PERIOD_LABEL = 'Doba řízení v pracovním období'
const NINE_HOURS = 9 * 60 * 60 * 1000
const TEN_HOURS = 10 * 60 * 60 * 1000
/** Delší odpočinek se v tabulce nevypisuje jako přestávka. Není to denní ani týdenní kategorie. */
const CYCLE_REST_MS = 24 * 60 * 60 * 1000
const ELEVEN_HOURS = 11 * 60 * 60 * 1000

/**
 * Řádky pod denní graf. Kalendářní den jen vybírá, která už spočítaná období se ukážou.
 * Doba řízení se počítá mezi kvalifikovanými odpočinky, ne od půlnoci do půlnoci.
 */
export function buildDayDrivingRows(input: {
  activities: readonly DayDrivingActivity[]
  dayStartUtc: number
  dayEndUtc: number
  clockMode?: ClockMode
}): DayDrivingRow[] {
  const clockMode = input.clockMode ?? 'utc'
  const periods = assessDrivingBreaks(input.activities)
  const relevant = periods.filter((period) => overlaps(period.startUtc, period.endUtc, input.dayStartUtc, input.dayEndUtc))
  const shownBreaks = breakLines(relevant, input.activities, clockMode)
  const daily = dailyDrivingPeriods(input.activities)
  const rows: DayDrivingRow[] = [
    ...dailyRows(daily, input.activities, input.dayStartUtc, input.dayEndUtc, clockMode),
    {
      label: 'Bezpečnostní přestávky',
      primary: shownBreaks.lengths.length > 0 ? shownBreaks.lengths.join(', ') : '—',
      detail: shownBreaks.ranges.length > 0 ? shownBreaks.ranges.join(', ') : null,
      value: shownBreaks.breaks.length > 0 ? shownBreaks.breaks.join(', ') : '—',
      tone: null,
      statusText: null,
      mark: null,
      rule: null,
      presentation: 'metric',
    },
  ]
  const tone = resultTone(relevant, input.activities)
  const result = resultText(relevant, input.activities)
  rows.push({
    label: 'Výsledek přestávek v řízení',
    primary: result,
    detail: tone === 'caution' ? 'Cyklus řízení není uzavřen.' : null,
    value: result,
    tone,
    statusText: result,
    mark: null,
    rule: 'article_7',
    presentation: 'status',
  })
  const closed = evaluated(relevant)
  if (closed.length > 0) {
    const longest = lengthText(closed.reduce((max, period) => Math.max(max, period.drivingMs), 0))
    rows.push({
      label: 'Nejdelší úsek řízení mezi přestávkami',
      primary: longest,
      detail: null,
      value: longest,
      tone: null,
      statusText: null,
      mark: null,
      rule: null,
      presentation: 'metric',
    })
  }
  return rows
}

function resultTone(periods: readonly DrivingBreakPeriod[], activities: readonly DayDrivingActivity[]): DayDrivingTone {
  const crew = periods.some((period) =>
    activities.some((activity) => activity.isCrew === true && overlaps(activity.startUtc, activity.endUtc, period.startUtc, period.endUtc)),
  )
  if (crew || periods.some((period) => period.status === 'insufficient_data')) return 'undecided'
  if (periods.some((period) => period.status === 'exceeded')) return 'exceeded'
  const decided = evaluated(periods)
  if (decided.length === 0) return 'undecided'
  if (decided.some((period) => period.qualifyingBreak == null)) return 'caution'
  return 'clear'
}

function resultText(periods: readonly DrivingBreakPeriod[], activities: readonly DayDrivingActivity[]): string {
  const crew = periods.some((period) => activities.some((activity) => activity.isCrew === true && overlaps(activity.startUtc, activity.endUtc, period.startUtc, period.endUtc)))
  if (crew || periods.some((period) => period.status === 'insufficient_data')) return UNRELIABLE
  if (periods.some((period) => period.status === 'exceeded')) return 'Limit 4 h 30 min překročen.'
  return 'V limitu 4 h 30 min.'
}

function breakLines(
  periods: readonly DrivingBreakPeriod[],
  activities: readonly DayDrivingActivity[],
  clockMode: ClockMode,
): { breaks: string[]; lengths: string[]; ranges: string[] } {
  const breaks: string[] = []
  const lengths: string[] = []
  const ranges: string[] = []
  for (const period of periods) {
    if (period.qualifyingBreak == null) continue
    for (const [startUtc, endUtc] of breakSpans(period.qualifyingBreak, activities)) {
      if (endUtc - startUtc > CYCLE_REST_MS) continue
      const length = lengthText(endUtc - startUtc)
      const range = rangeText(startUtc, endUtc, clockMode)
      lengths.push(length)
      ranges.push(range)
      breaks.push(`${length} (${range})`)
    }
  }
  return { breaks, lengths, ranges }
}

function breakSpans(item: QualifyingDrivingBreak, activities: readonly DayDrivingActivity[]): Array<[number, number]> {
  const ids = new Set(item.sourceActivityIds)
  const rests = activities
    .filter((activity) => ids.has(activity.id) && activity.kind === 'rest' && activity.endUtc > activity.startUtc)
    .map((activity) => [activity.startUtc, activity.endUtc] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: Array<[number, number]> = []
  for (const [startUtc, endUtc] of rests) {
    const last = merged[merged.length - 1]
    if (last != null && startUtc <= last[1]) last[1] = Math.max(last[1], endUtc)
    else merged.push([startUtc, endUtc])
  }
  return merged.length > 0 ? merged : [[item.startUtc, item.completedAtUtc]]
}

function rangeText(startUtc: number, endUtc: number, clockMode: ClockMode): string {
  const start = clockParts(startUtc, clockMode)
  const end = clockParts(endUtc, clockMode)
  const sameDay = start.day === end.day && start.month === end.month && start.year === end.year
  if (sameDay) return `${formatClockTime(startUtc, clockMode)}–${formatClockTime(endUtc, clockMode)}`
  return `${formatClockDateTime(startUtc, clockMode)}–${formatClockDateTime(endUtc, clockMode)}`
}

function evaluated(periods: readonly DrivingBreakPeriod[]): DrivingBreakPeriod[] {
  return periods.filter((period) => period.status !== 'insufficient_data')
}

function dailyRows(
  periods: readonly DailyDrivingPeriod[],
  activities: readonly DayDrivingActivity[],
  dayStartUtc: number,
  dayEndUtc: number,
  clockMode: ClockMode,
): DayDrivingRow[] {
  const overlapping = periods.filter((period) => overlaps(period.startUtc, period.endUtc ?? Number.POSITIVE_INFINITY, dayStartUtc, dayEndUtc))
  const dayHasDriving = activities.some(
    (activity) => activity.kind === 'driving' && overlaps(activity.startUtc, activity.endUtc, dayStartUtc, dayEndUtc),
  )
  if (overlapping.length === 0) {
    if (!dayHasDriving) return []
    return [undecidedDailyRow(PERIOD_LABEL)]
  }
  return overlapping.map((period, index) => {
    const label = overlapping.length === 1 ? PERIOD_LABEL : `${PERIOD_LABEL} ${index + 1}`
    const shown = drivingDisplay(period, clockMode)
    return {
      label,
      primary: shown.primary,
      detail: shown.detail,
      value: `${shown.primary}. ${shown.status.text}`,
      tone: shown.status.tone,
      statusText: shown.status.text,
      mark: shown.status.mark,
      rule: 'article_6' as const,
      presentation: 'status' as const,
    }
  })
}

type LengthBand = 'up_to_9h' | 'over_9h_up_to_10h' | 'over_10h'
type DrivingStamp = { text: string; tone: DayDrivingTone; mark: DayDrivingMark }

function drivingDisplay(
  period: DailyDrivingPeriod,
  clockMode: ClockMode,
): { primary: string; detail: string | null; status: DrivingStamp } {
  const alternatives = [...period.boundaryAlternatives].sort((left, right) => left.closingStartUtc - right.closingStartUtc)
  const span = period.drivingSpanMs
  if (alternatives.length > 1 && span != null) {
    const primary = span.lowMs === span.highMs ? lengthText(span.lowMs) : `${lengthText(span.lowMs)} – ${lengthText(span.highMs)}`
    const bands = alternatives.map((alternative) => lengthBand(alternative.drivingMs))
    const shared = bands[0] != null && bands.every((band) => band === bands[0])
    if (shared && bands[0] != null) {
      const lines = alternatives.map((alternative) => `${rangeText(period.startUtc, alternative.closingStartUtc, clockMode)}: ${lengthText(alternative.drivingMs)}`)
      return { primary, detail: lines.join('; '), status: lengthStamp(bands[0], false) }
    }
    const lines = alternatives.map((alternative) => {
      const band = lengthBand(alternative.drivingMs)
      return `${rangeText(period.startUtc, alternative.closingStartUtc, clockMode)}: ${lengthText(alternative.drivingMs)}, ${bandPhrase(band)}`
    })
    return {
      primary,
      detail: `Varianty nemají stejnou délkovou kategorii. ${lines.join('; ')}.`,
      status: unknownStamp(),
    }
  }
  if (alternatives.length > 1 && period.uncertainties.includes('unknown_interval')) {
    return {
      primary: '—',
      detail: 'Přesný rozsah součtů nelze určit, protože některá varianta obsahuje neznámý úsek.',
      status: unknownStamp(),
    }
  }
  const status = singleStamp(period)
  const primary = period.drivingMs == null ? '—' : lengthText(period.drivingMs)
  const endUtc = period.endUtc
  const range = endUtc == null ? `od ${formatClockDateTime(period.startUtc, clockMode)}` : rangeText(period.startUtc, endUtc, clockMode)
  const open = !period.closed && period.uncertainties.includes('closing_rest_missing') && status.text !== UNKNOWN_PERIOD
  return {
    primary,
    detail: open ? `${range}. Dosavadní stav. Období není uzavřeno.` : range,
    status,
  }
}

function singleStamp(period: DailyDrivingPeriod): DrivingStamp {
  if (period.result !== 'up_to_9h' && period.result !== 'over_9h_up_to_10h' && period.result !== 'over_10h') return unknownStamp()
  return lengthStamp(period.result, !period.closed && period.result === 'up_to_9h')
}

function lengthStamp(band: LengthBand, openUnderNine: boolean): DrivingStamp {
  if (band === 'up_to_9h') {
    return openUnderNine
      ? { text: 'Běžná', tone: 'clear', mark: 'open' }
      : { text: 'Běžná', tone: 'clear', mark: 'check' }
  }
  if (band === 'over_9h_up_to_10h') return { text: 'Prodloužená', tone: 'caution', mark: 'alarm' }
  return { text: 'Překročení', tone: 'exceeded', mark: 'alert' }
}

function unknownStamp(): DrivingStamp {
  return { text: UNKNOWN_PERIOD, tone: 'undecided', mark: 'unknown' }
}

function bandPhrase(band: LengthBand): string {
  if (band === 'up_to_9h') return 'do 9 h včetně'
  if (band === 'over_9h_up_to_10h') return 'nad 9 h a do 10 h včetně'
  return 'nad 10 h'
}

function lengthBand(durationMs: number): 'up_to_9h' | 'over_9h_up_to_10h' | 'over_10h' {
  if (durationMs <= NINE_HOURS) return 'up_to_9h'
  if (durationMs <= TEN_HOURS) return 'over_9h_up_to_10h'
  return 'over_10h'
}

const UNKNOWN_PERIOD = 'Nelze určit'

function undecidedDailyRow(label: string): DayDrivingRow {
  return {
    label,
    primary: '—',
    detail: null,
    value: `—. ${UNKNOWN_PERIOD}`,
    tone: 'undecided',
    statusText: UNKNOWN_PERIOD,
    mark: 'unknown',
    rule: 'article_6',
    presentation: 'status',
  }
}

function dailyDrivingPeriods(activities: readonly DayDrivingActivity[]): DailyDrivingPeriod[] {
  const mapped = activities.map(toActivity)
  const unknownIntervals = mapped
    .filter((activity) => activity.kind === 'unknown')
    .map((activity) => ({ startUtc: activity.startUtc, endUtc: activity.endUtc }))
  const candidates = classifyRestCandidates(findRestIntervals(mapped))
  const anchorUtc = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= ELEVEN_HOURS)
    .filter((candidate) => !unknownIntervals.some((interval) => overlaps(candidate.startUtc, candidate.endUtc, interval.startUtc, interval.endUtc)))
    .sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)[0]?.endUtc
  if (anchorUtc == null) return []
  const recordEndUtc = recordSpan(activities)?.endUtc ?? null
  const chain = buildDailyRestChain(anchorUtc, candidates, unknownIntervals, recordEndUtc)
  return assessDailyDrivingTime({ activities: mapped, candidates, chains: [chain] })
}

function toActivity(activity: DayDrivingActivity): Activity {
  return {
    id: activity.id,
    kind: activity.kind,
    startUtc: activity.startUtc,
    endUtc: activity.endUtc,
    durationMinutes: Math.round((activity.endUtc - activity.startUtc) / 60_000),
    isCrew: activity.isCrew === true,
    slot: 1,
  }
}

function recordSpan(activities: readonly DayDrivingActivity[]): { startUtc: number; endUtc: number } | null {
  if (activities.length === 0) return null
  return {
    startUtc: Math.min(...activities.map((activity) => activity.startUtc)),
    endUtc: Math.max(...activities.map((activity) => activity.endUtc)),
  }
}

function lengthText(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}

function overlaps(startUtc: number, endUtc: number, otherStartUtc: number, otherEndUtc: number): boolean {
  return startUtc < otherEndUtc && otherStartUtc < endUtc
}
