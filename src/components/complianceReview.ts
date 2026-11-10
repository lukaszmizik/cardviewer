import { analyzeDriverActivities } from '../analysis/analyzeDriverActivities.ts'
import { assessConsecutiveWeeks, type ConsecutiveWeekPeriod } from '../analysis/consecutiveWeeks.ts'
import { assessDailyDrivingTime, assessWeeklyDrivingExtensions, utcWeekStart, WEEKLY_EXTENSION_LIMIT, type DailyDrivingPeriod } from '../analysis/dailyDrivingTime.ts'
import { buildDailyRestChain, type DailyChainNode } from '../analysis/dailyRestChain.ts'
import { buildGn7ControlPeriods, type Gn7ControlPeriod } from '../analysis/gn7ControlPeriods.ts'
import { buildGn7DiagnosticFeed } from '../analysis/gn7DiagnosticFeed.ts'
import { findFerryRestCandidates, type FerryRestCandidate } from '../analysis/ferryRestCandidates.ts'
import { buildDiagnosticExport, deriveDiagnosticCases, derivePeriodDiagnostics } from '../analysis/diagnosticCases.ts'
import { assessDrivingBreaks, DRIVING_LIMIT_MS, type DrivingBreakPeriod } from '../analysis/drivingBreaks.ts'
import { assessAdjacentFortnightDrivingTimes, assessFortnightDrivingTime, FORTNIGHT_DRIVING_LIMIT_MS } from '../analysis/fortnightDrivingTime.ts'
import { classifyRestCandidates, type RestCandidate } from '../analysis/restCandidates.ts'
import { findRestIntervals } from '../analysis/restIntervals.ts'
import { assessWeeklyDrivingTime, WEEKLY_DRIVING_LIMIT_MS, type WeeklyDrivingStatus } from '../analysis/weeklyDrivingTime.ts'
import { classifyWeeklyRestCandidates } from '../analysis/weeklyRest.ts'
import { buildWeeklyRestAssignment } from '../analysis/weeklyRestAssignment.ts'
import { assessWeeklyRestCompensationTaken } from '../analysis/weeklyRestCompensationTaken.ts'
import { addDays, dayStartMs, formatClockDate, formatClockDateTime, formatWeekRange, weekStartMs, type ClockMode } from '../lib/clock.ts'
import type { Activity, DriverCardData, SpecificConditionEntry } from '../types/tacho.ts'

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS
const NINE_HOURS = 9 * HOUR_MS
const ELEVEN_HOURS = 11 * HOUR_MS
const TEN_HOURS = 10 * HOUR_MS
const PERIOD_DAYS = 57

export type ComplianceSeverity = 'violation' | 'uncertain' | 'incomplete' | 'clear'

export type ComplianceFinding = {
  id: string
  severity: 'violation' | 'uncertain'
  title: string
  intervalText: string
  startUtc: number
  endUtc: number
  mapDayUtc: number
  actualText: string
  limitText: string
  deltaText: string
  explanation: string
  technicalText: string
  /** Podíl vůči limitu v procentech, nejvýše 100. Null, když graf nedává smysl. */
  meterPercent: number | null
  meterOver: boolean
  /** gn7 je metodika nedostatečného denního odpočinku. standard je dosavadní okno řetězce. */
  methodology?: 'gn7' | 'standard'
  /** possible znamená, že trajektová výjimka může výsledek změnit a není potvrzená. */
  ferryException?: 'none' | 'possible'
  /** needs_verification se nepočítá mezi prokázaná porušení. */
  reviewStatus?: 'proven' | 'needs_verification'
}


export type ComplianceDay = {
  dayStartUtc: number
  label: string
  severity: ComplianceSeverity
  findingIds: string[]
  /** Proč den není zelený. Null jen u dne, jehož spuštěné kontroly vyšly bez porušení. */
  note: string | null
}

export type ComplianceWatch = {
  id: string
  title: string
  detail: string
  deadlineText: string | null
}

export type CompliancePeriodMode = 'recent' | 'history' | 'custom'

/** Období zobrazení. Výpočty dál používají celou historii aktivit. */
export type CompliancePeriodRequest =
  | { mode: 'recent' }
  | { mode: 'history' }
  | { mode: 'custom'; fromUtc: number; toUtc: number }

export type ComplianceMapMode = 'days' | 'weeks' | 'months'

export type ComplianceBucket = {
  id: string
  label: string
  startUtc: number
  endUtc: number
  severity: ComplianceSeverity
  dayStarts: number[]
}

export type ComplianceReview = {
  periodMode: CompliancePeriodMode
  periodStartUtc: number
  periodEndUtc: number
  periodText: string
  /** Dny po dnešku nebo neplatný rozsah. Není to porušení. */
  rangeNote: string | null
  mapMode: ComplianceMapMode
  buckets: ComplianceBucket[]
  violationCount: number
  uncertaintyCount: number
  dataComplete: boolean
  completenessText: string
  /** Věta o výsledku. Nikdy netvrdí „bez přestupků“, když kontrola nebo data nejsou uzavřené. */
  summaryText: string
  /** Kontroly, které stávající analytika záměrně neuzavírá. Nejsou to porušení. */
  unevaluatedNotes: string[]
  /** Skutečně použitá denní okna osádky v zobrazeném období. Nejsou to přestupky. */
  dailyWindowNotes: string[]
  days: ComplianceDay[]
  findings: ComplianceFinding[]
  watches: ComplianceWatch[]
}

type DaySlot = { startUtc: number; endUtc: number }

/**
 * Přehled pro řidiče za 57 kalendářních dnů.
 * Starší data vstupují do výpočtů, do karet se dostane jen zjištění zasahující do období.
 * Nový právní závěr z technické hodnoty nevytváří.
 */
export function buildComplianceReview(input: {
  activities: readonly Activity[]
  nowUtc: number
  clockMode?: ClockMode
  /** Bez hodnoty zůstává posledních 56 dnů a dnešek. */
  period?: CompliancePeriodRequest
  specificConditions?: readonly SpecificConditionEntry[]
}): ComplianceReview {
  const clockMode = input.clockMode ?? 'local'
  const todayStart = dayStartMs(input.nowUtc, clockMode)
  const activitiesForSpan = input.activities.filter((activity) => activity.endUtc > activity.startUtc)
  const requested = resolveDisplayPeriod(input.period ?? { mode: 'recent' }, clockMode, input.nowUtc, recordSpan(activitiesForSpan))
  const periodStartUtc = requested.startUtc
  const periodEndUtc = requested.endUtc
  const days = daySlots(periodStartUtc, periodEndUtc, clockMode)
  const activities = activitiesForSpan
  const record = recordSpan(activities)
  const coveredThrough = Math.min(input.nowUtc, periodEndUtc)
  const dataComplete = days.length > 0 && record != null && record.startUtc <= periodStartUtc && record.endUtc >= coveredThrough && !hasUnknown(activities, periodStartUtc, periodEndUtc)
  const prepared = prepare(activities, input.activities)
  const findings: ComplianceFinding[] = []
  const weekDriving = weekDrivingStatuses(activities, periodStartUtc, periodEndUtc)
  const consecutive = consecutivePeriods(prepared, record)

  collectBreaks(prepared.breaks, days, periodStartUtc, periodEndUtc, clockMode, findings)
  collectDailyDriving(prepared.daily, days, periodStartUtc, periodEndUtc, clockMode, findings)
  collectWeekly(weekDriving, days, periodStartUtc, periodEndUtc, findings)
  collectFortnight(activities, days, periodStartUtc, periodEndUtc, findings)
  collectExtensions(prepared.daily, activities, days, periodStartUtc, periodEndUtc, findings)
  const gn7Starts = collectGn7DailyRests(
    resolveGn7Anchor(prepared.anchorUtc, prepared.candidates, prepared.unknownIntervals),
    activities,
    input.specificConditions ?? [],
    prepared.recordEndUtc,
    days,
    periodStartUtc,
    periodEndUtc,
    clockMode,
    findings,
  )
  collectDailyWindows(prepared.nodes, gn7Starts, days, periodStartUtc, periodEndUtc, clockMode, findings)
  collectWeeklyRests(consecutive, record?.endUtc ?? null, days, periodStartUtc, periodEndUtc, findings)
  const compensation = compensationReport(prepared)
  collectCompensation(compensation, days, periodStartUtc, periodEndUtc, input.nowUtc, clockMode, findings)
  const watches = watchItems(compensation, prepared.daily, activities, input.nowUtc)
  const notes = explainDays(days, activities, record, prepared, todayStart, periodEndUtc, weekDriving, consecutive)
  const unevaluatedNotes = [
    'Limit tří zkrácených denních odpočinků se neposuzuje. Analytika ho uzavře až z vybraných týdenních odpočinků a ten výběr karta neobsahuje.',
  ]

  const dayFindings = new Map<number, ComplianceFinding[]>()
  for (const finding of findings) {
    const list = dayFindings.get(finding.mapDayUtc) ?? []
    list.push(finding)
    dayFindings.set(finding.mapDayUtc, list)
  }

  const reviewDays = days.map((day) => {
    const related = dayFindings.get(day.startUtc) ?? []
    const note = notes.get(day.startUtc) ?? null
    const severity = daySeverity(related, note != null)
    return {
      dayStartUtc: day.startUtc,
      label: formatClockDate(day.startUtc, clockMode),
      severity,
      findingIds: related.map((finding) => finding.id),
      note: severity === 'clear' ? null : note,
    }
  })

  const violationCount = findings.filter((finding) => finding.severity === 'violation').length
  const uncertaintyCount = findings.filter((finding) => finding.severity === 'uncertain').length
  const periodOpen = reviewDays.some((day) => day.severity === 'incomplete' || day.severity === 'uncertain')
  const mapMode = mapModeOf(reviewDays.length)
  const lastDay = reviewDays[reviewDays.length - 1]
  return {
    periodMode: requested.mode,
    periodStartUtc,
    periodEndUtc,
    periodText: reviewDays.length === 0
      ? 'Bez zobrazených dnů'
      : `${reviewDays[0]!.label} – ${lastDay!.label}`,
    rangeNote: requested.note,
    mapMode,
    buckets: mapMode === 'days' ? [] : buildBuckets(reviewDays, mapMode, clockMode),
    violationCount,
    uncertaintyCount,
    dataComplete,
    completenessText: completenessText(dataComplete, requested.note, reviewDays.length === 0),
    summaryText: summaryText(violationCount, uncertaintyCount, dataComplete, periodOpen),
    unevaluatedNotes,
    dailyWindowNotes: dailyWindowNotes(prepared.nodes, periodStartUtc, periodEndUtc, clockMode),
    days: reviewDays,
    findings,
    watches,
  }
}

function completenessText(dataComplete: boolean, rangeNote: string | null, empty: boolean): string {
  if (empty && rangeNote != null) return rangeNote
  const base = dataComplete
    ? 'Karta pokrývá celé kontrolované období.'
    : 'Karta nepokrývá celé kontrolované období. Chybějící dny nejsou vyhodnocené.'
  return rangeNote == null ? base : `${base} ${rangeNote}`
}

function resolveDisplayPeriod(
  request: CompliancePeriodRequest,
  clockMode: ClockMode,
  nowUtc: number,
  record: { startUtc: number; endUtc: number } | null,
): { mode: CompliancePeriodMode; startUtc: number; endUtc: number; note: string | null } {
  const todayStart = dayStartMs(nowUtc, clockMode)
  const tomorrow = addDays(todayStart, 1, clockMode)
  if (request.mode === 'history') {
    if (record == null) return { mode: 'history', startUtc: todayStart, endUtc: tomorrow, note: 'V datech není žádný záznam.' }
    return { mode: 'history', startUtc: dayStartMs(record.startUtc, clockMode), endUtc: tomorrow, note: null }
  }
  if (request.mode === 'custom') {
    if (!Number.isFinite(request.fromUtc) || !Number.isFinite(request.toUtc)) {
      return { mode: 'custom', startUtc: tomorrow, endUtc: tomorrow, note: 'Vlastní období potřebuje platné datum od a do.' }
    }
    let startUtc = dayStartMs(request.fromUtc, clockMode)
    let lastDay = dayStartMs(request.toUtc, clockMode)
    if (lastDay < startUtc) {
      const swap = startUtc
      startUtc = lastDay
      lastDay = swap
    }
    if (startUtc >= tomorrow) {
      return { mode: 'custom', startUtc: tomorrow, endUtc: tomorrow, note: 'Vybrané období je až po dnešku. Budoucí dny se nehodnotí.' }
    }
    const clipped = lastDay >= tomorrow
    if (clipped) lastDay = todayStart
    return {
      mode: 'custom',
      startUtc,
      endUtc: addDays(lastDay, 1, clockMode),
      note: clipped ? 'Dny po dnešku se nehodnotí.' : null,
    }
  }
  return {
    mode: 'recent',
    startUtc: addDays(todayStart, -(PERIOD_DAYS - 1), clockMode),
    endUtc: tomorrow,
    note: null,
  }
}

function mapModeOf(dayCount: number): ComplianceMapMode {
  if (dayCount <= 62) return 'days'
  if (dayCount <= 366) return 'weeks'
  return 'months'
}

function buildBuckets(days: readonly ComplianceDay[], mode: Exclude<ComplianceMapMode, 'days'>, clockMode: ClockMode): ComplianceBucket[] {
  const groups = new Map<string, ComplianceDay[]>()
  for (const day of days) {
    const id = mode === 'weeks' ? `week:${weekStartMs(day.dayStartUtc, clockMode)}` : monthId(day.dayStartUtc, clockMode)
    const list = groups.get(id) ?? []
    list.push(day)
    groups.set(id, list)
  }
  return [...groups].map(([id, group]) => {
    const first = group[0]!
    const last = group[group.length - 1]!
    return {
      id,
      label: mode === 'weeks' ? formatWeekRange(weekStartMs(first.dayStartUtc, clockMode), clockMode) : monthLabel(first.dayStartUtc, clockMode),
      startUtc: first.dayStartUtc,
      endUtc: addDays(last.dayStartUtc, 1, clockMode),
      severity: group.reduce<ComplianceSeverity>((worst, day) => (severityRank(day.severity) > severityRank(worst) ? day.severity : worst), 'clear'),
      dayStarts: group.map((day) => day.dayStartUtc),
    }
  })
}

function monthId(ms: number, clockMode: ClockMode): string {
  const date = new Date(ms)
  const year = clockMode === 'utc' ? date.getUTCFullYear() : date.getFullYear()
  const month = (clockMode === 'utc' ? date.getUTCMonth() : date.getMonth()) + 1
  return `month:${year}-${month}`
}

function monthLabel(ms: number, clockMode: ClockMode): string {
  const date = new Date(ms)
  const year = clockMode === 'utc' ? date.getUTCFullYear() : date.getFullYear()
  const month = (clockMode === 'utc' ? date.getUTCMonth() : date.getMonth()) + 1
  return `${String(month).padStart(2, '0')}.${year}`
}

function severityRank(severity: ComplianceSeverity): number {
  if (severity === 'violation') return 4
  if (severity === 'uncertain') return 3
  if (severity === 'incomplete') return 2
  return 1
}

function summaryText(violations: number, uncertainties: number, dataComplete: boolean, periodOpen: boolean): string {
  if (!dataComplete || periodOpen || uncertainties > 0) return 'Období nelze uzavřít jako bez porušení.'
  if (violations === 0) return 'Dokončené kontroly neukázaly prokázané porušení.'
  return 'Jsou tu prokázaná porušení z dokončených kontrol.'
}

function prepare(
  activities: readonly Activity[],
  /** Včetně nulové délky. Značka výměny karet se do odpočinku nepočítá, pro osádku ano. */
  crewActivities: readonly Activity[] = activities,
) {
  const unknownIntervals = activities
    .filter((activity) => activity.kind === 'unknown')
    .map((activity) => ({ startUtc: activity.startUtc, endUtc: activity.endUtc }))
  const candidates = classifyRestCandidates(findRestIntervals(activities))
  const recordEndUtc = recordSpan(activities)?.endUtc ?? null
  const anchor = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= ELEVEN_HOURS)
    .filter((candidate) => !unknownIntervals.some((interval) => overlaps(candidate.startUtc, candidate.endUtc, interval.startUtc, interval.endUtc)))
    .sort((left, right) => left.endUtc - right.endUtc)[0]?.endUtc
  const chain = anchor == null ? null : buildDailyRestChain(anchor, candidates, unknownIntervals, recordEndUtc, crewActivities)
  const daily = chain == null ? [] : assessDailyDrivingTime({ activities, candidates, chains: [chain] })
  return {
    candidates,
    unknownIntervals,
    recordEndUtc,
    breaks: assessDrivingBreaks(activities),
    daily,
    nodes: chain?.nodes ?? [],
    anchorUtc: anchor ?? null,
  }
}

function compensationReport(prepared: ReturnType<typeof prepare>) {
  const visible = prepared.candidates.filter((candidate) => prepared.recordEndUtc == null || candidate.endUtc < prepared.recordEndUtc)
  return assessWeeklyRestCompensationTaken({
    candidates: classifyWeeklyRestCandidates(visible),
    rests: visible,
    unknownIntervals: prepared.unknownIntervals,
    recordEndUtc: prepared.recordEndUtc,
  })
}

const CREW_BREAK_WARNING = 'Přestávka je uznatelná za předpokladu, že vozidlo řídil druhý řidič a odpočívající řidič mu během této doby nepomáhal při řízení.'

function collectBreaks(
  periods: readonly DrivingBreakPeriod[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  clockMode: ClockMode,
  findings: ComplianceFinding[],
) {
  for (const period of periods) {
    if (!overlaps(period.startUtc, period.endUtc, periodStartUtc, periodEndUtc)) continue
    if (period.status === 'crew_break_conditional') {
      const mapDayUtc = placeDay(period.qualifyingBreak?.completedAtUtc ?? period.startUtc, period.startUtc, period.endUtc, days)
      if (mapDayUtc == null) continue
      findings.push({
        id: `break-conditional:${period.startUtc}`,
        severity: 'uncertain',
        title: 'Přestávka v režimu osádky',
        intervalText: formatRange(period.startUtc, period.endUtc, clockMode),
        startUtc: period.startUtc,
        endUtc: period.endUtc,
        mapDayUtc,
        actualText: 'Podmíněně uznáno',
        limitText: '4 h 30 min',
        deltaText: '',
        explanation: CREW_BREAK_WARNING,
        technicalText: `status ${period.status}, evidence ${period.evidence}`,
        meterPercent: meter(period.drivingMs, DRIVING_LIMIT_MS),
        meterOver: false,
      })
      continue
    }
    if (period.status !== 'exceeded') continue
    const anchor = period.limitReachedUtc ?? period.startUtc
    const mapDayUtc = placeDay(anchor, period.startUtc, period.endUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `break:${period.startUtc}`,
      severity: 'violation',
      title: 'Přestávka v řízení',
      intervalText: formatRange(period.startUtc, period.endUtc, clockMode),
      startUtc: period.startUtc,
      endUtc: period.endUtc,
      mapDayUtc,
      actualText: durationText(period.drivingMs),
      limitText: '4 h 30 min',
      deltaText: overText(period.drivingMs, DRIVING_LIMIT_MS),
      explanation: 'Souvislé řízení překročilo 4 hodiny 30 minut bez prokázané přestávky.',
      technicalText: `status ${period.status}, evidence ${period.evidence}`,
      meterPercent: meter(period.drivingMs, DRIVING_LIMIT_MS),
      meterOver: true,
    })
  }
}

function collectDailyDriving(
  periods: readonly DailyDrivingPeriod[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  clockMode: ClockMode,
  findings: ComplianceFinding[],
) {
  for (const period of periods) {
    const endUtc = period.endUtc ?? period.startUtc
    if (!overlaps(period.startUtc, endUtc, periodStartUtc, periodEndUtc)) continue
    if (period.result === 'over_10h' && period.drivingMs != null) {
      const crossed = period.startUtc + TEN_HOURS
      const mapDayUtc = placeDay(crossed, period.startUtc, endUtc, days)
      if (mapDayUtc == null) continue
      findings.push({
        id: `daily-driving:${period.startUtc}`,
        severity: 'violation',
        title: 'Denní doba řízení',
        intervalText: formatRange(period.startUtc, endUtc, clockMode),
        startUtc: period.startUtc,
        endUtc,
        mapDayUtc,
        actualText: durationText(period.drivingMs),
        limitText: '10 h',
        deltaText: overText(period.drivingMs, TEN_HOURS),
        explanation: 'Doba řízení mezi odpočinky je nad 10 hodin. Počet prodloužení mezi 9 a 10 hodinami se tím neuzavírá.',
        technicalText: `result ${period.result}, closed ${period.closed}`,
        meterPercent: meter(period.drivingMs, TEN_HOURS),
        meterOver: true,
      })
      continue
    }
    if (period.result === 'ambiguous_boundaries') {
      const mapDayUtc = placeDay(period.startUtc, period.startUtc, endUtc, days)
      if (mapDayUtc == null) continue
      findings.push({
        id: `daily-driving-uncertain:${period.startUtc}`,
        severity: 'uncertain',
        title: 'Denní doba řízení není jednoznačná',
        intervalText: formatRange(period.startUtc, endUtc, clockMode),
        startUtc: period.startUtc,
        endUtc,
        mapDayUtc,
        actualText: period.drivingMs == null ? 'Nelze určit' : durationText(period.drivingMs),
        limitText: '10 h',
        deltaText: 'Hranice odpočinku není jediná',
        explanation: 'Existuje víc hranic období. Žádná z nich není vybraný závěr a není to prokázané porušení.',
        technicalText: `result ${period.result}`,
        meterPercent: null,
        meterOver: false,
      })
    }
  }
}

type WeekDrivingRow = {
  weekStartUtc: number
  weekEndUtc: number
  status: WeeklyDrivingStatus
  drivingMs: number
}

function weekDrivingStatuses(activities: readonly Activity[], periodStartUtc: number, periodEndUtc: number): WeekDrivingRow[] {
  if (activities.length === 0) return []
  const first = utcWeekStart(Math.min(...activities.map((activity) => activity.startUtc)))
  const last = utcWeekStart(periodEndUtc - 1)
  const rows: WeekDrivingRow[] = []
  for (let week = first; week <= last; week += WEEK_MS) {
    const result = assessWeeklyDrivingTime({ activities, weekStartUtc: week })
    rows.push({
      weekStartUtc: result.weekStartUtc,
      weekEndUtc: result.weekEndUtc,
      status: result.status,
      drivingMs: result.drivingMs,
    })
  }
  return rows.filter((row) => overlaps(row.weekStartUtc, row.weekEndUtc, periodStartUtc, periodEndUtc))
}

function collectWeekly(
  rows: readonly WeekDrivingRow[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  findings: ComplianceFinding[],
) {
  for (const result of rows) {
    if (!overlaps(result.weekStartUtc, result.weekEndUtc, periodStartUtc, periodEndUtc)) continue
    if (result.status !== 'over_56h') continue
    const mapDayUtc = placeDay(result.weekStartUtc, result.weekStartUtc, result.weekEndUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `weekly-driving:${result.weekStartUtc}`,
      severity: 'violation',
      title: 'Týdenní doba řízení',
      intervalText: `${formatClockDateTime(result.weekStartUtc, 'utc')} – ${formatClockDateTime(result.weekEndUtc, 'utc')} UTC`,
      startUtc: result.weekStartUtc,
      endUtc: result.weekEndUtc,
      mapDayUtc,
      actualText: durationText(result.drivingMs),
      limitText: '56 h',
      deltaText: overText(result.drivingMs, WEEKLY_DRIVING_LIMIT_MS),
      explanation: 'Součet řízení v týdnu od pondělí 00:00 UTC je nad 56 hodin.',
      technicalText: `status ${result.status}`,
      meterPercent: meter(result.drivingMs, WEEKLY_DRIVING_LIMIT_MS),
      meterOver: true,
    })
  }
}

function collectExtensions(
  periods: readonly DailyDrivingPeriod[],
  activities: readonly Activity[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  findings: ComplianceFinding[],
) {
  const record = recordSpan(activities)
  if (record == null) return
  const first = utcWeekStart(record.startUtc)
  const last = utcWeekStart(periodEndUtc - 1)
  for (let week = first; week <= last; week += WEEK_MS) {
    const result = assessWeeklyDrivingExtensions({
      periods,
      weekStartUtc: week,
      recordStartUtc: record.startUtc,
      recordEndUtc: record.endUtc,
    })
    if (!overlaps(result.weekStartUtc, result.weekEndUtc, periodStartUtc, periodEndUtc)) continue
    if (result.status !== 'counted' || result.used == null || result.used <= WEEKLY_EXTENSION_LIMIT) continue
    const mapDayUtc = placeDay(result.weekStartUtc, result.weekStartUtc, result.weekEndUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `extensions:${result.weekStartUtc}`,
      severity: 'violation',
      title: 'Prodloužení denní doby řízení',
      intervalText: `${formatClockDateTime(result.weekStartUtc, 'utc')} – ${formatClockDateTime(result.weekEndUtc, 'utc')} UTC`,
      startUtc: result.weekStartUtc,
      endUtc: result.weekEndUtc,
      mapDayUtc,
      actualText: `${result.used} nad 9 hodin`,
      limitText: `${WEEKLY_EXTENSION_LIMIT}`,
      deltaText: `O ${result.used - WEEKLY_EXTENSION_LIMIT} víc`,
      explanation: 'V týdnu od pondělí 00:00 UTC jsou víc než dvě vyhodnocené doby řízení nad 9 hodin. Neuzavřený počet se sem nepočítá.',
      technicalText: `status ${result.status}, used ${result.used}`,
      meterPercent: meter(result.used, WEEKLY_EXTENSION_LIMIT),
      meterOver: true,
    })
  }
}

function consecutivePeriods(prepared: ReturnType<typeof prepare>, record: { startUtc: number; endUtc: number } | null): ConsecutiveWeekPeriod[] {
  const visible = prepared.candidates.filter((candidate) => prepared.recordEndUtc == null || candidate.endUtc < prepared.recordEndUtc)
  const assignment = buildWeeklyRestAssignment({
    candidates: classifyWeeklyRestCandidates(visible),
    unknownIntervals: prepared.unknownIntervals,
    recordEndUtc: prepared.recordEndUtc,
  })
  return assessConsecutiveWeeks({
    assignment,
    unknownIntervals: prepared.unknownIntervals,
    recordSpan: record,
  }).periods
}

function collectWeeklyRests(
  periods: readonly ConsecutiveWeekPeriod[],
  recordEndUtc: number | null,
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  findings: ComplianceFinding[],
) {
  for (const period of periods) {
    if (!overlaps(period.earlierWeek.startUtc, period.laterWeek.endUtc, periodStartUtc, periodEndUtc)) continue
    const closed = recordEndUtc != null && recordEndUtc >= period.laterWeek.endUtc
    const failed = period.status === 'not_satisfied_basic_rule' && closed
    const ambiguous = period.status === 'ambiguous'
    if (!failed && !ambiguous) continue
    const mapDayUtc = placeDay(period.laterWeek.startUtc, period.earlierWeek.startUtc, period.laterWeek.endUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `weekly-rest:${period.earlierWeek.startUtc}`,
      severity: 'uncertain',
      title: failed ? 'Týdenní odpočinky dvou týdnů' : 'Týdenní odpočinky dvou týdnů nejsou jednoznačné',
      intervalText: `${formatClockDateTime(period.earlierWeek.startUtc, 'utc')} – ${formatClockDateTime(period.laterWeek.endUtc, 'utc')} UTC`,
      startUtc: period.earlierWeek.startUtc,
      endUtc: period.laterWeek.endUtc,
      mapDayUtc,
      actualText: failed ? 'Základní pravidlo nevyšlo' : 'Víc přiřazení',
      limitText: 'Dva běžné, nebo jeden běžný a jeden zkrácený',
      deltaText: 'Není to prokázané porušení',
      explanation: failed
        ? 'Základní pravidlo dvou sousedních týdnů nevyšlo. Modul z toho nedělá prokázané porušení a zvláštní režim se neposuzuje.'
        : 'Přiřazení odpočinků ke týdnům se liší. Není to prokázané porušení.',
      technicalText: `status ${period.status}`,
      meterPercent: null,
      meterOver: false,
    })
  }
}

function collectFortnight(
  activities: readonly Activity[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  findings: ComplianceFinding[],
) {
  const rows = activities.length === 0 ? [] : assessAdjacentFortnightDrivingTimes({ activities })
  for (const result of rows) {
    if (!overlaps(result.periodStartUtc, result.periodEndUtc, periodStartUtc, periodEndUtc)) continue
    if (result.status !== 'over_90h') continue
    const shown = assessFortnightDrivingTime({ activities, laterWeekStartUtc: result.laterWeekStartUtc })
    const mapDayUtc = placeDay(shown.laterWeekStartUtc, shown.periodStartUtc, shown.periodEndUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `fortnight-driving:${shown.laterWeekStartUtc}`,
      severity: 'violation',
      title: 'Doba řízení za dva týdny',
      intervalText: `${formatClockDateTime(shown.periodStartUtc, 'utc')} – ${formatClockDateTime(shown.periodEndUtc, 'utc')} UTC`,
      startUtc: shown.periodStartUtc,
      endUtc: shown.periodEndUtc,
      mapDayUtc,
      actualText: durationText(shown.drivingMs),
      limitText: '90 h',
      deltaText: overText(shown.drivingMs, FORTNIGHT_DRIVING_LIMIT_MS),
      explanation: 'Součet řízení ve dvou sousedních týdnech od pondělí 00:00 UTC je nad 90 hodin.',
      technicalText: `status ${shown.status}`,
      meterPercent: meter(shown.drivingMs, FORTNIGHT_DRIVING_LIMIT_MS),
      meterOver: true,
    })
  }
}

const NINE_MINUTES = 9 * 60
const GN7_NOTE = 'Použita metodika GN7 pro vyhodnocení nedostatečného denního odpočinku.'
const FERRY_NOTE = 'Možná výjimka podle čl. 9 odst. 1 může změnit kvalifikaci odpočinku v tomto období. Splnění výjimky záznam nepotvrzuje.'
const FERRY_ANCHOR_NOTE = 'Předchozí trajektový kandidát může posunout kotvu. Alternativní řetězec GN7 se nepřepočítává, proto toto období není potvrzený přestupek.'

type Gn7Anchor = {
  anchorUtc: number
  /** Souvislých 9 h bez prokázané přípustnosti zkrácení. Navazující období se nepotvrzují, dokud řetězec nenarazí na běžný odpočinek. */
  openingReducedUnverified: boolean
}

/**
 * Kotva jen pro GN7. Řetězec denních oken dál používá výhradně ustavených 11 h.
 * Zkrácených 9 h se použije, jen když 11 h v datech není. Přípustnost zkrácení se nepočítá.
 * Dělený 3+9 bez předchozí prokázané kotvy nelze odlišit od zkráceného 9 h, proto se jako potvrzená kotva nebere.
 */
function resolveGn7Anchor(
  regularAnchorUtc: number | null,
  candidates: readonly RestCandidate[],
  unknownIntervals: readonly { startUtc: number; endUtc: number }[],
): Gn7Anchor | null {
  if (regularAnchorUtc != null) return { anchorUtc: regularAnchorUtc, openingReducedUnverified: false }
  const reduced = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= NINE_HOURS && candidate.durationMs < ELEVEN_HOURS)
    .filter((candidate) => !unknownIntervals.some((interval) => overlaps(candidate.startUtc, candidate.endUtc, interval.startUtc, interval.endUtc)))
    .sort((left, right) => left.endUtc - right.endUtc)[0]
  if (reduced == null) return null
  return { anchorUtc: reduced.endUtc, openingReducedUnverified: true }
}

function ferryMayRemove(candidate: FerryRestCandidate, startUtc: number, endUtc: number): boolean {
  if (candidate.legalApplicability !== 'conditional' || !candidate.timeConditionsMet) return false
  if (candidate.qualification !== 'regular_daily' && candidate.qualification !== 'reduced_weekly' && candidate.qualification !== 'regular_weekly') return false
  return overlaps(candidate.startUtc, candidate.endUtc, startUtc, endUtc)
}

/** Trajekt může změnit další kotvu jen tehdy, když jeho konec není už zvolený konec kvalifikovaného odpočinku. */
function ferryMayMoveNextAnchor(period: Gn7ControlPeriod, hits: readonly FerryRestCandidate[]): boolean {
  const chosen = period.nextAnchorUtc
  const alreadyQualifying = period.status === 'qualifying_rest' || period.status === 'crossing_rest_becomes_qualifying'
  return hits.some((candidate) => {
    if (chosen != null && candidate.endUtc === chosen) return false
    if (alreadyQualifying && chosen != null && candidate.endUtc >= chosen) return false
    return true
  })
}

function firmRegularAnchor(period: Gn7ControlPeriod): boolean {
  if (!period.confirmedForEnforcement || period.nextAnchorUtc == null) return false
  if (period.reducedRestPermitted !== 'not_required') return false
  const variant = period.qualifying[0]?.variant
  return variant === 'continuous_regular' || variant === 'split_regular'
}

function collectGn7DailyRests(
  anchor: Gn7Anchor | null,
  activities: readonly Activity[],
  specificConditions: readonly SpecificConditionEntry[],
  recordEndUtc: number | null,
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  clockMode: ClockMode,
  findings: ComplianceFinding[],
): Set<number> {
  const covered = new Set<number>()
  if (anchor == null) return covered
  const input = { anchorUtc: anchor.anchorUtc, activities, recordEndUtc }
  const periods = buildGn7ControlPeriods(input)
  const feed = buildGn7DiagnosticFeed(input)
  const ferries = findFerryRestCandidates({ activities, specificConditions })
  const emitted: Array<{ startUtc: number; endUtc: number }> = []
  let ferryAnchorOpen = false
  let reductionCause: 'opening' | 'chain' | null = anchor.openingReducedUnverified ? 'opening' : null

  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index]!
    const diagnostic = feed.periods[index]
    if (diagnostic == null) continue
    covered.add(period.startUtc)
    const ownHits = ferries.filter((candidate) => ferryMayRemove(candidate, period.startUtc, period.endUtc))
    const ownFerry = ownHits.length > 0
    const inheritedFerry = ferryAnchorOpen
    const causeNow = reductionCause
    const previous = index > 0 ? periods[index - 1]! : null
    const substitute = previous?.status === 'consecutive_reference' || previous?.status === 'crossing_rest_remains_insufficient'
    const skipKind = period.status === 'qualifying_rest' || period.status === 'crossing_rest_becomes_qualifying' || period.status === 'history_incomplete'
    const inView = overlaps(period.startUtc, period.endUtc, periodStartUtc, periodEndUtc)
    const duplicate = emitted.some((item) => overlaps(item.startUtc, item.endUtc, period.startUtc, period.endUtc))

    if (!skipKind && inView && !duplicate) {
      const longestInside = period.rests
        .filter((rest) => rest.established)
        .reduce((best, rest) => Math.max(best, rest.minutesInsideWindow), 0)
      const shortRest = longestInside < NINE_MINUTES
        && (period.status === 'consecutive_reference' || period.status === 'crossing_rest_remains_insufficient')
      const crewConditional = period.crewBasis === 'conditional'
      const blocked = causeNow != null
        || ownFerry
        || inheritedFerry
        || crewConditional
        || period.analysisTruncated
        || period.dataCompleteness !== 'complete'
        || diagnostic.confirmation !== 'confirmed'
        || !diagnostic.usableForGn7Diagnostics
      const provenShort = !blocked && shortRest
      const mapDayUtc = placeDay(period.startUtc, period.startUtc, period.endUtc, days)
      if (mapDayUtc != null) {
        emitted.push({ startUtc: period.startUtc, endUtc: period.endUtc })
        const reasons = [GN7_NOTE]
        if (substitute) reasons.push('Toto je náhradní referenční období GN7: předchozí okno nemělo kvalifikovaný odpočinek, takže toto období navazuje na hranici okna.')
        if (shortRest) reasons.push('V tomto referenčním období není odpočinek, který by dosáhl 9 h ani 11 h.')
        if (causeNow === 'opening') reasons.push('Výchozí kotva je zkrácený denní odpočinek a přípustnost zkrácení není z dat ověřená.')
        if (causeNow === 'chain') reasons.push('Předchozí kotva vychází ze zkráceného odpočinku, jehož přípustnost není ověřená.')
        if (crewConditional) reasons.push('Podmíněná osádka není potvrzená vícečlenná osádka.')
        if (period.analysisTruncated) reasons.push('Výpočet GN7 je ořezaný a nepokrývá další dostupnou historii.')
        if (period.dataCompleteness !== 'complete' && !crewConditional) reasons.push(period.assessmentBasis)
        if (ownFerry) reasons.push(FERRY_NOTE)
        if (inheritedFerry) reasons.push(FERRY_ANCHOR_NOTE)
        findings.push({
          id: `gn7-daily:${period.startUtc}`,
          severity: provenShort ? 'violation' : 'uncertain',
          title: provenShort ? 'Nedostatečný denní odpočinek' : 'Denní odpočinek vyžaduje ověření',
          intervalText: formatRange(period.startUtc, period.endUtc, clockMode),
          startUtc: period.startUtc,
          endUtc: period.endUtc,
          mapDayUtc,
          actualText: longestInside === 0 ? 'Bez prokázaného REST v okně' : `Nejdelší REST v okně ${longestInside} min`,
          limitText: period.windowMinutes === 30 * 60 ? '9 h v okně 30 h' : '11 h nebo 9 h v okně 24 h',
          deltaText: provenShort ? 'Pod oběma délkami denního odpočinku' : 'Není prokázané porušení',
          explanation: reasons.join(' '),
          technicalText: `methodology gn7, status ${period.status}, review ${provenShort ? 'proven' : 'needs_verification'}, ferry ${ownFerry || inheritedFerry ? 'possible' : 'none'}, anchor ${causeNow ?? 'verified'}`,
          meterPercent: null,
          meterOver: provenShort,
          methodology: 'gn7',
          ferryException: ownFerry || inheritedFerry ? 'possible' : 'none',
          reviewStatus: provenShort ? 'proven' : 'needs_verification',
        })
      }
    }

    if (ferryMayMoveNextAnchor(period, ownHits)) ferryAnchorOpen = true
    if (firmRegularAnchor(period) && !ferryAnchorOpen) reductionCause = null
    else if (period.reducedRestPermitted === 'not_assessed') reductionCause = 'chain'
  }
  return covered
}

function collectDailyWindows(
  nodes: readonly DailyChainNode[],
  gn7Starts: ReadonlySet<number>,
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  clockMode: ClockMode,
  findings: ComplianceFinding[],
) {
  for (const node of nodes) {
    const conditional = node.crewBasis === 'conditional' && node.status === 'evaluated'
    if (node.status !== 'window_unsatisfied' && !conditional) continue
    if (node.status === 'window_unsatisfied' && gn7Starts.has(node.windowStartUtc)) continue
    if (!overlaps(node.windowStartUtc, node.windowEndUtc, periodStartUtc, periodEndUtc)) continue
    const mapDayUtc = placeDay(node.windowStartUtc, node.windowStartUtc, node.windowEndUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `daily-window:${node.windowStartUtc}`,
      severity: 'uncertain',
      title: 'Denní odpočinek v okně',
      intervalText: formatRange(node.windowStartUtc, node.windowEndUtc, clockMode),
      startUtc: node.windowStartUtc,
      endUtc: node.windowEndUtc,
      mapDayUtc,
      actualText: conditional ? 'Podmíněně uznáno' : 'Odpočinek v okně není prokázaný',
      limitText: node.windowMode === 'crew_30h' ? '9 h v okně 30 h' : '11 h nebo uznané zkrácení v okně 24 h',
      deltaText: conditional ? 'Předpoklad přítomnosti druhého řidiče' : 'Nelze určit nedostatek',
      explanation: windowExplanation(node),
      technicalText: `status ${node.status}, window ${node.windowMode}${conditional ? ', crew basis conditional' : ''}`,
      meterPercent: null,
      meterOver: false,
    })
  }
}


function formatPrague(ms: number): string {
  const parts = new Intl.DateTimeFormat('cs-CZ', {
    timeZone: 'Europe/Prague',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('day')}. ${pick('month')}. ${pick('year')} ${pick('hour')}:${pick('minute')}`
}

function windowExplanation(node: DailyChainNode): string {
  const anchor = node.anchorEstablished ? '' : ' Kotva tohoto okna nepochází z prokázaného odpočinku.'
  if (node.windowMode === 'crew_30h' && node.crewBasis === 'conditional') {
    const intervals = node.uncertainIntervals
      .map((interval) => `${formatPrague(interval.startUtc)} – ${formatPrague(interval.endUtc)} (Europe/Prague)`)
      .join('; ')
    return `Podmíněně uznáno. 30hodinové okno vychází z předpokladu, že druhý řidič byl přítomen v úsecích ${intervals}. Záznam osádku neprokázal. Není to prokázaná osádka, prokázaný přestupek ani uznání bezpečnostní přestávky.${anchor}`
  }
  if (node.windowMode === 'crew_30h') {
    return `Použito 30hodinové okno. Záznam příznaku osádky pokrývá pracovní úsek po první hodině, proto se posuzuje souvislý odpočinek alespoň 9 hodin. Samo o sobě to není označené jako přestupek.${anchor}`
  }
  const withheld = node.crewRefusal != null
    ? ` 30hodinové okno se nepoužilo. ${node.crewRefusal}`
    : node.crewRecord === 'crew_record_uncertain'
      ? ' 30hodinové okno se nepoužilo, protože průběh osádky nelze z dostupných údajů podmíněně uznat.'
      : ''
  return `Použito 24hodinové okno pro jednoho řidiče. Požadavek je běžný nebo uznaný zkrácený denní odpočinek. Samo o sobě to není označené jako přestupek.${withheld}${anchor}`
}

function dailyWindowNotes(
  nodes: readonly DailyChainNode[],
  periodStartUtc: number,
  periodEndUtc: number,
  clockMode: ClockMode,
): string[] {
  return nodes
    .filter((node) => node.windowMode === 'crew_30h' && overlaps(node.windowStartUtc, node.windowEndUtc, periodStartUtc, periodEndUtc))
    .map((node) => {
      const ambiguous = node.interpretations.some((item) => item.qualifiesWindow && !item.established)
      const doubt = ambiguous ? ' Nejednoznačný odpočinek zůstává neprokázaný.' : ''
      if (node.crewBasis === 'conditional') {
        return `${formatRange(node.windowStartUtc, node.windowEndUtc, clockMode)}: Podmíněně uznáno. 30hodinové okno vychází z předpokladu přítomnosti druhého řidiče v neprokázaných úsecích.${doubt}`
      }
      return `${formatRange(node.windowStartUtc, node.windowEndUtc, clockMode)}: použito okno 30 h. Záznam osádky pokrývá pracovní úsek po první hodině, proto platí souvislý odpočinek alespoň 9 hodin.${doubt}`
    })
}

function collectCompensation(
  report: ReturnType<typeof compensationReport>,
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  nowUtc: number,
  clockMode: ClockMode,
  findings: ComplianceFinding[],
) {
  for (const obligation of report.compensation.obligations) {
    const fulfillment = report.fulfillments.find((item) => item.obligationId === obligation.id)
    if (fulfillment == null) continue
    if (fulfillment.status !== 'missed' && fulfillment.status !== 'undecided') continue
    if (fulfillment.status === 'undecided' && fulfillment.reason === 'record_incomplete') continue
    const endUtc = obligation.deadlineUtc ?? obligation.restEndUtc
    if (!overlaps(obligation.restStartUtc, endUtc, periodStartUtc, periodEndUtc) && !(obligation.deadlineUtc != null && obligation.deadlineUtc <= nowUtc && obligation.deadlineUtc >= periodStartUtc)) continue
    const mapDayUtc = placeDay(obligation.deadlineUtc ?? obligation.restStartUtc, obligation.restStartUtc, endUtc, days)
    if (mapDayUtc == null) continue
    const missed = fulfillment.status === 'missed'
    findings.push({
      id: `compensation:${obligation.id}`,
      severity: missed ? 'violation' : 'uncertain',
      title: missed ? 'Náhrada týdenního odpočinku' : 'Náhrada týdenního odpočinku není jistá',
      intervalText: formatRange(obligation.restStartUtc, obligation.restEndUtc, clockMode),
      startUtc: obligation.restStartUtc,
      endUtc: obligation.restEndUtc,
      mapDayUtc,
      actualText: missed ? 'Náhrada v termínu není' : 'Výsledek se liší podle rozdělení',
      limitText: durationText(obligation.compensationMs),
      deltaText: missed ? `Chybí ${durationText(obligation.compensationMs)}` : 'Termín nebo čerpání není jediné',
      explanation: missed
        ? 'Termín náhrady uplynul a v úplném záznamu do něj náhrada není.'
        : 'Analytika nenašla jediný výsledek. Není to prokázané porušení.',
      technicalText: `status ${fulfillment.status}, reason ${fulfillment.reason}`,
      meterPercent: missed ? 0 : null,
      meterOver: missed,
    })
  }
}

function watchItems(
  report: ReturnType<typeof compensationReport>,
  periods: readonly DailyDrivingPeriod[],
  activities: readonly Activity[],
  nowUtc: number,
): ComplianceWatch[] {
  const watches: ComplianceWatch[] = []
  for (const obligation of report.compensation.obligations) {
    const fulfillment = report.fulfillments.find((item) => item.obligationId === obligation.id)
    if (fulfillment?.status !== 'open' || obligation.deadlineUtc == null || obligation.deadlineUtc <= nowUtc) continue
    watches.push({
      id: `watch:${obligation.id}`,
      title: `Nahradit ${durationText(obligation.compensationMs)} zkráceného týdenního odpočinku`,
      detail: 'Náhrada má být vcelku a připojená k jinému odpočinku nejméně 9 hodin. Zobrazený termín nepotvrzuje, že je konkrétní budoucí směna právně přípustná.',
      deadlineText: `${formatClockDateTime(obligation.deadlineUtc, 'utc')} UTC`,
    })
  }
  const record = recordSpan(activities)
  const weekStart = utcWeekStart(nowUtc)
  const extensions = assessWeeklyDrivingExtensions({
    periods,
    weekStartUtc: weekStart,
    recordStartUtc: record?.startUtc ?? null,
    recordEndUtc: record?.endUtc ?? null,
  })
  if (extensions.status === 'counted' && extensions.used != null && extensions.remaining != null) {
    watches.push({
      id: `watch:extensions:${weekStart}`,
      title: `Prodloužení denní doby řízení: ${extensions.used} z ${extensions.limit}`,
      detail: 'Jde o počet už vyhodnocených dob řízení nad 9 hodin v tomto týdnu. Není to potvrzení, že další směna limit splní.',
      deadlineText: `Týden do ${formatClockDateTime(extensions.weekEndUtc, 'utc')} UTC`,
    })
  }
  return watches
}

function explainDays(
  days: readonly DaySlot[],
  activities: readonly Activity[],
  record: { startUtc: number; endUtc: number } | null,
  prepared: ReturnType<typeof prepare>,
  todayStart: number,
  todayEnd: number,
  weekDriving: readonly WeekDrivingRow[],
  consecutive: readonly ConsecutiveWeekPeriod[],
): Map<number, string> {
  const notes = new Map<number, string[]>()
  const add = (dayStartUtc: number, text: string) => {
    const list = notes.get(dayStartUtc) ?? []
    if (!list.includes(text)) list.push(text)
    notes.set(dayStartUtc, list)
  }
  const periodStartUtc = days[0]?.startUtc ?? todayStart
  const extensions = extensionRows(prepared.daily, activities, periodStartUtc, todayEnd)
  for (const day of days) {
    if (!dayCovered(day, activities, record)) add(day.startUtc, 'Den není celý v záznamu.')
    if (day.startUtc === todayStart && todayIsOpen(prepared, todayStart, todayEnd)) add(day.startUtc, 'Dnešní kontrola ještě není uzavřená.')
    const weekStarts = new Set([utcWeekStart(day.startUtc), utcWeekStart(day.endUtc - 1)])
    for (const weekStart of weekStarts) {
      const driving = weekDriving.find((row) => row.weekStartUtc === weekStart)
      if (driving?.status === 'incomplete') add(day.startUtc, 'Týdenní doba řízení tohoto týdne není uzavřená.')
      if (driving?.status === 'insufficient_data') add(day.startUtc, 'Týdenní doba řízení tohoto týdne nemá úplná data.')
      const extension = extensions.find((row) => row.weekStartUtc === weekStart)
      if (extension?.status === 'undecided') add(day.startUtc, 'Počet prodloužení nad 9 hodin v tomto týdnu není uzavřený.')
    }
    const covering = consecutive.filter((period) => overlaps(period.earlierWeek.startUtc, period.laterWeek.endUtc, day.startUtc, day.endUtc))
    if (dayCovered(day, activities, record) && covering.length === 0) add(day.startUtc, 'Kontrola týdenních odpočinků se tohoto dne nedotkla.')
    for (const period of covering) {
      if (period.status === 'satisfied' || period.status === 'ambiguous') continue
      if (period.status === 'not_satisfied_basic_rule' && record != null && record.endUtc >= period.laterWeek.endUtc) continue
      if (period.status === 'insufficient_data') add(day.startUtc, 'Kontrola dvou sousedních týdnů pro tento den nemá dost údajů.')
      else if (period.status === 'not_satisfied_basic_rule') add(day.startUtc, 'Kontrola dvou sousedních týdnů pro tento den není uzavřená.')
      else add(day.startUtc, 'Skladba týdenních odpočinků se pro tento den neuzavřela.')
    }
    for (const node of prepared.nodes) {
      if (!overlaps(node.windowStartUtc, node.windowEndUtc, day.startUtc, day.endUtc)) continue
      if (node.status === 'history_incomplete') add(day.startUtc, 'Denní odpočinek tohoto dne není uzavřený.')
      if (node.status === 'insufficient_data') add(day.startUtc, 'Denní odpočinek tohoto dne nemá úplná data.')
    }
    if (prepared.breaks.some((period) => period.status === 'insufficient_data' && overlaps(period.startUtc, period.endUtc, day.startUtc, day.endUtc))) {
      add(day.startUtc, 'Přestávky v řízení tohoto dne nemají úplná data.')
    }
    if (prepared.daily.some((period) => period.result === 'insufficient_data' && overlaps(period.startUtc, period.endUtc ?? period.startUtc, day.startUtc, day.endUtc))) {
      add(day.startUtc, 'Denní doba řízení tohoto dne nemá úplná data.')
    }
  }
  return new Map([...notes].map(([dayStartUtc, list]) => [dayStartUtc, list.slice(0, 3).join(' ')]))
}

function extensionRows(periods: readonly DailyDrivingPeriod[], activities: readonly Activity[], periodStartUtc: number, periodEndUtc: number) {
  const record = recordSpan(activities)
  if (record == null) return []
  const first = utcWeekStart(Math.min(record.startUtc, periodStartUtc))
  const last = utcWeekStart(periodEndUtc - 1)
  const rows = []
  for (let week = first; week <= last; week += WEEK_MS) {
    rows.push(assessWeeklyDrivingExtensions({
      periods,
      weekStartUtc: week,
      recordStartUtc: record.startUtc,
      recordEndUtc: record.endUtc,
    }))
  }
  return rows
}

function todayIsOpen(prepared: ReturnType<typeof prepare>, todayStart: number, todayEnd: number): boolean {
  const openBreak = prepared.breaks.some(
    (period) => period.status === 'within_limit' && period.qualifyingBreak == null && overlaps(period.startUtc, period.endUtc, todayStart, todayEnd),
  )
  const openDriving = prepared.daily.some(
    (period) => !period.closed && period.endUtc != null && overlaps(period.startUtc, period.endUtc, todayStart, todayEnd) && period.result !== 'over_10h',
  )
  return openBreak || openDriving
}

function dayCovered(day: DaySlot, activities: readonly Activity[], record: { startUtc: number; endUtc: number } | null): boolean {
  if (record == null || day.endUtc <= record.startUtc || day.startUtc >= record.endUtc) return false
  if (activities.some((activity) => activity.kind === 'unknown' && overlaps(activity.startUtc, activity.endUtc, day.startUtc, day.endUtc))) return false
  const inside = activities.filter((activity) => overlaps(activity.startUtc, activity.endUtc, day.startUtc, day.endUtc))
  if (inside.length === 0) return false
  const sorted = [...inside].sort((left, right) => left.startUtc - right.startUtc)
  let cursor = Math.max(day.startUtc, record.startUtc)
  const end = Math.min(day.endUtc, record.endUtc)
  for (const activity of sorted) {
    if (activity.startUtc > cursor) return false
    cursor = Math.max(cursor, activity.endUtc)
    if (cursor >= end) return true
  }
  return cursor >= end
}

function daySeverity(findings: readonly ComplianceFinding[], incomplete: boolean): ComplianceSeverity {
  if (findings.some((finding) => finding.severity === 'violation')) return 'violation'
  if (findings.some((finding) => finding.severity === 'uncertain')) return 'uncertain'
  if (incomplete) return 'incomplete'
  return 'clear'
}

function placeDay(preferredUtc: number, startUtc: number, endUtc: number, days: readonly DaySlot[]): number | null {
  const preferred = days.find((day) => preferredUtc >= day.startUtc && preferredUtc < day.endUtc)
  if (preferred) return preferred.startUtc
  const overlap = days.find((day) => overlaps(startUtc, endUtc, day.startUtc, day.endUtc))
  return overlap?.startUtc ?? null
}

function daySlots(periodStartUtc: number, periodEndUtc: number, clockMode: ClockMode): DaySlot[] {
  const days: DaySlot[] = []
  let cursor = periodStartUtc
  while (cursor < periodEndUtc && days.length < 4000) {
    const endUtc = addDays(cursor, 1, clockMode)
    if (endUtc <= cursor) break
    days.push({ startUtc: cursor, endUtc })
    cursor = endUtc
  }
  return days
}

function recordSpan(activities: readonly Activity[]): { startUtc: number; endUtc: number } | null {
  if (activities.length === 0) return null
  return {
    startUtc: Math.min(...activities.map((activity) => activity.startUtc)),
    endUtc: Math.max(...activities.map((activity) => activity.endUtc)),
  }
}

function hasUnknown(activities: readonly Activity[], startUtc: number, endUtc: number): boolean {
  return activities.some((activity) => activity.kind === 'unknown' && overlaps(activity.startUtc, activity.endUtc, startUtc, endUtc))
}

function overlaps(startUtc: number, endUtc: number, otherStart: number, otherEnd: number): boolean {
  return startUtc < otherEnd && otherStart < endUtc
}

function meter(actualMs: number, limitMs: number): number {
  if (limitMs <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((actualMs / limitMs) * 100)))
}

function overText(actualMs: number, limitMs: number): string {
  return `O ${durationText(Math.max(0, actualMs - limitMs))} víc`
}

function durationText(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}

function formatRange(startUtc: number, endUtc: number, clockMode: ClockMode): string {
  return `${formatClockDateTime(startUtc, clockMode)} – ${formatClockDateTime(endUtc, clockMode)}`
}

/** Technický výstup až na vyžádání. Neobsahuje jméno ani číslo karty. */
export function buildComplianceDiagnostic(input: {
  activities: readonly Activity[]
  nowUtc: number
  clockMode?: ClockMode
  period?: CompliancePeriodRequest
}) {
  const review = buildComplianceReview(input)
  const card: DriverCardData = {
    cardNumber: '',
    firstName: '',
    surname: '',
    lastWithdrawalUtc: null,
    activities: input.activities.map((activity) => ({ ...activity, registration: undefined })),
    locations: [],
    violations: [],
  }
  const analysis = analyzeDriverActivities({ card })
  return {
    period: {
      startUtc: review.periodStartUtc,
      endUtc: review.periodEndUtc,
      mode: review.periodMode,
      text: review.periodText,
      clockMode: input.clockMode ?? 'local',
      legalWeekClock: 'monday_00_00_utc' as const,
      rangeNote: review.rangeNote,
      mapMode: review.mapMode,
    },
    evaluation: {
      dataComplete: review.dataComplete,
      completenessText: review.completenessText,
      summaryText: review.summaryText,
      violationCount: review.violationCount,
      uncertaintyCount: review.uncertaintyCount,
      unevaluatedNotes: review.unevaluatedNotes,
      days: review.days.map((day) => ({ dayStartUtc: day.dayStartUtc, severity: day.severity, note: day.note })),
      findings: review.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        technicalText: finding.technicalText,
        explanation: finding.explanation,
      })),
    },
    diagnostic: buildDiagnosticExport(
      deriveDiagnosticCases(analysis),
      derivePeriodDiagnostics(analysis),
      {},
      new Date(input.nowUtc).toISOString(),
      analysis.weeklyAssignment,
      analysis.consecutiveWeeks,
    ),
  }
}
