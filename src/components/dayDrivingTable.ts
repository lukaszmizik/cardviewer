import { assessDailyDrivingTime, assessWeeklyDrivingExtensions, utcWeekStart, type DailyDrivingPeriod } from '../analysis/dailyDrivingTime.ts'
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
export type DayDrivingTone = 'clear' | 'caution' | 'exceeded' | 'undecided' | 'neutral'

export type ExtensionSlot = 'available' | 'used' | 'unknown'

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
  rule: 'article_6' | 'article_7' | null
  presentation: 'metric' | 'note' | 'status' | 'extensions'
  extensionSlots: ExtensionSlot[] | null
}

const UNRELIABLE = 'Nelze spolehlivě vyhodnotit.'
const EXTENSION_UNKNOWN = 'Nelze určit'
/** Delší odpočinek se v tabulce nevypisuje jako přestávka. Není to denní ani týdenní kategorie. */
const CYCLE_REST_MS = 24 * 60 * 60 * 1000
const ELEVEN_HOURS = 11 * 60 * 60 * 1000
const CYCLE_ENDED = 'Cyklus řízení ukončen odpočinkem.'

/**
 * Řádky pod denní graf. Kalendářní den jen vybírá, která už spočítaná období se ukážou.
 * Denní doba řízení se nepočítá od půlnoci do půlnoci.
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
    extensionRow(daily, input.activities, input.dayStartUtc),
    {
      label: 'Bezpečnostní přestávky',
      primary: shownBreaks.lengths.length > 0 ? shownBreaks.lengths.join(', ') : '—',
      detail: shownBreaks.ranges.length > 0 ? shownBreaks.ranges.join(', ') : null,
      value: shownBreaks.breaks.length > 0 ? shownBreaks.breaks.join(', ') : '—',
      tone: null,
      statusText: null,
      rule: null,
      presentation: 'metric',
      extensionSlots: null,
    },
  ]
  if (shownBreaks.cycleEndedByRest) {
    rows.push({
      label: 'Ukončení cyklu řízení',
      primary: CYCLE_ENDED,
      detail: null,
      value: CYCLE_ENDED,
      tone: null,
      statusText: null,
      rule: null,
      presentation: 'note',
      extensionSlots: null,
    })
  }
  const tone = resultTone(relevant, input.activities)
  const result = resultText(relevant, input.activities)
  rows.push({
    label: 'Výsledek přestávek v řízení',
    primary: result,
    detail: tone === 'caution' ? 'Cyklus řízení není uzavřen.' : null,
    value: result,
    tone,
    statusText: result,
    rule: 'article_7',
    presentation: 'status',
    extensionSlots: null,
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
      rule: null,
      presentation: 'metric',
      extensionSlots: null,
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
): { breaks: string[]; lengths: string[]; ranges: string[]; cycleEndedByRest: boolean } {
  const breaks: string[] = []
  const lengths: string[] = []
  const ranges: string[] = []
  let cycleEndedByRest = false
  for (const period of periods) {
    if (period.qualifyingBreak == null) continue
    for (const [startUtc, endUtc] of breakSpans(period.qualifyingBreak, activities)) {
      if (endUtc - startUtc > CYCLE_REST_MS) {
        cycleEndedByRest = true
        continue
      }
      const length = lengthText(endUtc - startUtc)
      const range = rangeText(startUtc, endUtc, clockMode)
      lengths.push(length)
      ranges.push(range)
      breaks.push(`${length} (${range})`)
    }
  }
  return { breaks, lengths, ranges, cycleEndedByRest }
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
    return [undecidedDailyRow('Denní doba řízení')]
  }
  return overlapping.map((period, index) => {
    const label = overlapping.length === 1 ? 'Denní doba řízení' : `Denní doba řízení ${index + 1}`
    const status = dailyStatus(period)
    const duration = period.drivingMs == null ? '—' : lengthText(period.drivingMs)
    const endUtc = period.endUtc
    const detail = endUtc == null ? null : rangeText(period.startUtc, endUtc, clockMode)
    return {
      label,
      primary: duration,
      detail,
      value: `${duration}. ${status.text}`,
      tone: status.tone,
      statusText: status.text,
      rule: 'article_6' as const,
      presentation: 'status' as const,
      extensionSlots: null,
    }
  })
}

function undecidedDailyRow(label: string): DayDrivingRow {
  return {
    label,
    primary: UNRELIABLE,
    detail: null,
    value: UNRELIABLE,
    tone: 'undecided',
    statusText: UNRELIABLE,
    rule: 'article_6',
    presentation: 'status',
    extensionSlots: null,
  }
}

function dailyStatus(period: DailyDrivingPeriod): { text: string; tone: DayDrivingTone } {
  if (period.result === 'up_to_9h') return { text: 'Do 9 hodin.', tone: 'clear' }
  if (period.result === 'over_9h_up_to_10h') return { text: 'Mezi 9 a 10 hodinami.', tone: 'caution' }
  if (period.result === 'over_10h') return { text: 'Nad 10 hodin.', tone: 'exceeded' }
  return { text: UNRELIABLE, tone: 'undecided' }
}

function extensionRow(periods: readonly DailyDrivingPeriod[], activities: readonly DayDrivingActivity[], dayStartUtc: number): DayDrivingRow {
  const record = recordSpan(activities)
  const count = assessWeeklyDrivingExtensions({
    periods,
    weekStartUtc: utcWeekStart(dayStartUtc),
    recordStartUtc: record?.startUtc ?? null,
    recordEndUtc: record?.endUtc ?? null,
  })
  const text =
    count.status === 'undecided' || count.used == null || count.remaining == null
      ? EXTENSION_UNKNOWN
      : count.used > count.limit
        ? `Využito ${count.used} ze ${count.limit}`
        : remainingText(count.remaining)
  const tone: DayDrivingTone =
    count.status === 'undecided' || count.used == null
      ? 'undecided'
      : count.used > count.limit
        ? 'exceeded'
        : count.remaining === 0
          ? 'neutral'
          : 'clear'
  const slots: ExtensionSlot[] =
    tone === 'undecided'
      ? ['unknown', 'unknown']
      : [0, 1].map((index) => (index < Math.min(count.used ?? 0, 2) ? 'used' : 'available'))
  const week = `${formatClockDateTime(count.weekStartUtc, 'utc')}–${formatClockDateTime(count.weekEndUtc, 'utc')} UTC`
  return {
    label: 'Prodloužení denní doby řízení',
    primary: text,
    detail: week,
    value: text,
    tone,
    statusText: text,
    rule: 'article_6',
    presentation: 'extensions',
    extensionSlots: slots,
  }
}

function remainingText(remaining: number): string {
  if (remaining === 0 || remaining === 1) return `Zbývá ${remaining} ze 2`
  return `Zbývají ${remaining} ze 2`
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
