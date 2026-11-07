import { assessDailyDrivingTime, assessWeeklyDrivingExtensions, utcWeekStart, type DailyDrivingPeriod } from '../analysis/dailyDrivingTime.ts'
import { buildDailyRestChain, type DailyChainNode } from '../analysis/dailyRestChain.ts'
import { assessDrivingBreaks, DRIVING_LIMIT_MS, type DrivingBreakPeriod } from '../analysis/drivingBreaks.ts'
import { assessAdjacentFortnightDrivingTimes, assessFortnightDrivingTime, FORTNIGHT_DRIVING_LIMIT_MS } from '../analysis/fortnightDrivingTime.ts'
import { classifyRestCandidates } from '../analysis/restCandidates.ts'
import { findRestIntervals } from '../analysis/restIntervals.ts'
import { assessWeeklyDrivingTime, WEEKLY_DRIVING_LIMIT_MS } from '../analysis/weeklyDrivingTime.ts'
import { classifyWeeklyRestCandidates } from '../analysis/weeklyRest.ts'
import { assessWeeklyRestCompensationTaken } from '../analysis/weeklyRestCompensationTaken.ts'
import { addDays, dayStartMs, formatClockDate, formatClockDateTime, type ClockMode } from '../lib/clock.ts'
import type { Activity } from '../types/tacho.ts'

const HOUR_MS = 60 * 60 * 1000
const WEEK_MS = 7 * 24 * HOUR_MS
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
}

export type ComplianceDay = {
  dayStartUtc: number
  label: string
  severity: ComplianceSeverity
  findingIds: string[]
}

export type ComplianceWatch = {
  id: string
  title: string
  detail: string
  deadlineText: string | null
}

export type ComplianceReview = {
  periodStartUtc: number
  periodEndUtc: number
  periodText: string
  violationCount: number
  uncertaintyCount: number
  dataComplete: boolean
  completenessText: string
  /** Věta o výsledku. Nikdy netvrdí „bez přestupků“, když kontrola nebo data nejsou uzavřené. */
  summaryText: string
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
}): ComplianceReview {
  const clockMode = input.clockMode ?? 'local'
  const todayStart = dayStartMs(input.nowUtc, clockMode)
  const periodStartUtc = addDays(todayStart, -(PERIOD_DAYS - 1), clockMode)
  const periodEndUtc = addDays(todayStart, 1, clockMode)
  const days = daySlots(periodStartUtc, clockMode)
  const activities = input.activities.filter((activity) => activity.endUtc > activity.startUtc)
  const record = recordSpan(activities)
  const dataComplete = record != null && record.startUtc <= periodStartUtc && record.endUtc >= input.nowUtc && !hasUnknown(activities, periodStartUtc, periodEndUtc)
  const prepared = prepare(activities)
  const findings: ComplianceFinding[] = []
  const uncertainDays = new Set<number>()
  const incompleteDays = new Set<number>()

  collectBreaks(prepared.breaks, days, periodStartUtc, periodEndUtc, clockMode, findings)
  collectDailyDriving(prepared.daily, days, periodStartUtc, periodEndUtc, clockMode, findings)
  collectWeekly(activities, days, periodStartUtc, periodEndUtc, findings)
  collectFortnight(activities, days, periodStartUtc, periodEndUtc, findings)
  collectDailyWindows(prepared.nodes, days, periodStartUtc, periodEndUtc, clockMode, findings)
  const compensation = compensationReport(prepared)
  collectCompensation(compensation, days, periodStartUtc, periodEndUtc, input.nowUtc, clockMode, findings)
  const watches = watchItems(compensation, prepared.daily, activities, input.nowUtc)

  for (const day of days) {
    if (!dayCovered(day, activities, record)) incompleteDays.add(day.startUtc)
  }
  markOpenToday(prepared, todayStart, periodEndUtc, incompleteDays)

  const dayFindings = new Map<number, ComplianceFinding[]>()
  for (const finding of findings) {
    const list = dayFindings.get(finding.mapDayUtc) ?? []
    list.push(finding)
    dayFindings.set(finding.mapDayUtc, list)
    if (finding.severity === 'uncertain') uncertainDays.add(finding.mapDayUtc)
  }

  const reviewDays = days.map((day) => {
    const related = dayFindings.get(day.startUtc) ?? []
    const severity = daySeverity(related, incompleteDays.has(day.startUtc))
    return {
      dayStartUtc: day.startUtc,
      label: formatClockDate(day.startUtc, clockMode),
      severity,
      findingIds: related.map((finding) => finding.id),
    }
  })

  const violationCount = findings.filter((finding) => finding.severity === 'violation').length
  const uncertaintyCount = findings.filter((finding) => finding.severity === 'uncertain').length
  const periodOpen = reviewDays.some((day) => day.severity === 'incomplete' || day.severity === 'uncertain')
  return {
    periodStartUtc,
    periodEndUtc,
    periodText: `${formatClockDate(periodStartUtc, clockMode)} – ${formatClockDate(input.nowUtc, clockMode)}`,
    violationCount,
    uncertaintyCount,
    dataComplete,
    completenessText: dataComplete
      ? 'Karta pokrývá celé kontrolované období.'
      : 'Karta nepokrývá celé kontrolované období. Chybějící dny nejsou vyhodnocené.',
    summaryText: summaryText(violationCount, uncertaintyCount, dataComplete, periodOpen),
    days: reviewDays,
    findings,
    watches,
  }
}

function summaryText(violations: number, uncertainties: number, dataComplete: boolean, periodOpen: boolean): string {
  if (!dataComplete || periodOpen || uncertainties > 0) return 'Období nelze uzavřít jako bez porušení.'
  if (violations === 0) return 'Dokončené kontroly neukázaly prokázané porušení.'
  return 'Jsou tu prokázaná porušení z dokončených kontrol.'
}

function prepare(activities: readonly Activity[]) {
  const unknownIntervals = activities
    .filter((activity) => activity.kind === 'unknown')
    .map((activity) => ({ startUtc: activity.startUtc, endUtc: activity.endUtc }))
  const candidates = classifyRestCandidates(findRestIntervals(activities))
  const recordEndUtc = recordSpan(activities)?.endUtc ?? null
  const anchor = candidates
    .filter((candidate) => candidate.established && candidate.durationMs >= ELEVEN_HOURS)
    .filter((candidate) => !unknownIntervals.some((interval) => overlaps(candidate.startUtc, candidate.endUtc, interval.startUtc, interval.endUtc)))
    .sort((left, right) => left.endUtc - right.endUtc)[0]?.endUtc
  const chain = anchor == null ? null : buildDailyRestChain(anchor, candidates, unknownIntervals, recordEndUtc)
  const daily = chain == null ? [] : assessDailyDrivingTime({ activities, candidates, chains: [chain] })
  return {
    candidates,
    unknownIntervals,
    recordEndUtc,
    breaks: assessDrivingBreaks(activities),
    daily,
    nodes: chain?.nodes ?? [],
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
    if (period.status !== 'exceeded' && period.status !== 'crew_break_unconfirmed') continue
    const violation = period.status === 'exceeded'
    const anchor = period.limitReachedUtc ?? period.startUtc
    const mapDayUtc = placeDay(anchor, period.startUtc, period.endUtc, days)
    if (mapDayUtc == null) continue
    findings.push({
      id: `break:${period.startUtc}`,
      severity: violation ? 'violation' : 'uncertain',
      title: violation ? 'Přestávka v řízení' : 'Přestávka v režimu osádky',
      intervalText: formatRange(period.startUtc, period.endUtc, clockMode),
      startUtc: period.startUtc,
      endUtc: period.endUtc,
      mapDayUtc,
      actualText: durationText(period.drivingMs),
      limitText: '4 h 30 min',
      deltaText: violation ? overText(period.drivingMs, DRIVING_LIMIT_MS) : 'Záleží na uznání přestávky v osádce',
      explanation: violation
        ? 'Souvislé řízení překročilo 4 hodiny 30 minut bez prokázané přestávky.'
        : 'Karta nedokládá, že vozidlo řídil jiný řidič a že šlo o přestávku. Není to prokázané porušení.',
      technicalText: `status ${period.status}`,
      meterPercent: meter(period.drivingMs, DRIVING_LIMIT_MS),
      meterOver: violation,
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

function collectWeekly(
  activities: readonly Activity[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  findings: ComplianceFinding[],
) {
  if (activities.length === 0) return
  const first = utcWeekStart(Math.min(...activities.map((activity) => activity.startUtc)))
  const last = utcWeekStart(periodEndUtc - 1)
  for (let week = first; week <= last; week += WEEK_MS) {
    const result = assessWeeklyDrivingTime({ activities, weekStartUtc: week })
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

function collectDailyWindows(
  nodes: readonly DailyChainNode[],
  days: readonly DaySlot[],
  periodStartUtc: number,
  periodEndUtc: number,
  clockMode: ClockMode,
  findings: ComplianceFinding[],
) {
  for (const node of nodes) {
    if (node.status !== 'window_unsatisfied') continue
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
      actualText: 'Odpočinek v okně není prokázaný',
      limitText: '11 h nebo uznané zkrácení',
      deltaText: 'Nelze určit nedostatek',
      explanation: '24hodinové okno nesplnil prokázaný odpočinek. Samo o sobě to není označené jako přestupek.',
      technicalText: `status ${node.status}`,
      meterPercent: null,
      meterOver: false,
    })
  }
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

function markOpenToday(prepared: ReturnType<typeof prepare>, todayStart: number, todayEnd: number, incompleteDays: Set<number>) {
  const openBreak = prepared.breaks.some(
    (period) => period.status === 'within_limit' && period.qualifyingBreak == null && overlaps(period.startUtc, period.endUtc, todayStart, todayEnd),
  )
  const openDriving = prepared.daily.some((period) => !period.closed && period.endUtc != null && overlaps(period.startUtc, period.endUtc, todayStart, todayEnd) && period.result !== 'over_10h')
  if (openBreak || openDriving) incompleteDays.add(todayStart)
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

function daySlots(periodStartUtc: number, clockMode: ClockMode): DaySlot[] {
  const days: DaySlot[] = []
  for (let index = 0; index < PERIOD_DAYS; index += 1) {
    const startUtc = addDays(periodStartUtc, index, clockMode)
    days.push({ startUtc, endUtc: addDays(startUtc, 1, clockMode) })
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
