/**
 * Parser TXT souboru vygenerovaného exportem pracovního týdne.
 * Formát: ----CZ---- HH:MM DD.MM.RRRR, (typ) HH:MM - HH:MM (součet)
 */

import { addDays, type ClockMode } from './lib/clock'

export type ActivityType = 'řízení' | 'práce' | 'pohotovost' | 'odpočinek' | 'odpočinek>24h' | 'odpočinek>45h' | 'neznámá'

export type ParsedActivity = {
  type: ActivityType
  startMs: number
  endMs: number
  durationMinutes: number
  /** Původní délka aktivity před rozdělením (pro detekci týdenního odpočinku >24h01m) */
  originalDurationMinutes?: number
  /** Pravda, pokud aktivita pochází z manuálního zadání průvodcem. */
  isManualEntry?: boolean
  /** Příznak režimu osádky z karty. */
  isCrew?: boolean
  /** 1 = slot řidiče, 2 = slot spolujezdce. */
  slot?: 1 | 2
  /** Registrační značka vozidla z doby této činnosti. */
  registration?: string
  /** GPS pozice (např. název města) – z activityHistory */
  gpsLocation?: string
}

export type DayData = {
  dayLabel: string
  dateStr: string
  dateUtc: number
  activities: ParsedActivity[]
}

const LABEL_TO_TYPE: Record<string, ActivityType> = {
  řízení: 'řízení',
  práce: 'práce',
  'jiná práce': 'práce',
  pohotovost: 'pohotovost',
  odpočinek: 'odpočinek',
  'odpočinek>24h': 'odpočinek>24h',
  'odpočinek>45h': 'odpočinek>45h',
  neznámá: 'neznámá',
  'neznámá činnost': 'neznámá',
}

export function parseTimeAndDate(timeStr: string, dateStr: string): number {
  const [hh, mm] = timeStr.split(':').map(Number)
  const [d, m, y] = dateStr.split('.').map(Number)
  return Date.UTC(y, m - 1, d, hh ?? 0, mm ?? 0)
}

/** Podporuje ---CZ---- i ----CZ---- (3 nebo 4 pomlčky) */
const SHIFT_HEADER = /^-{3,4}([A-Z]{2})-{3,4}\s+(\d{1,2}:\d{2})\s+(\d{1,2}\.\d{1,2}\.\d{4})\s*$/
/** Značka překročení půlnoci: ----*---- 00:00 DD.MM.RRRR */
const MIDNIGHT_HEADER = /^-{3,4}\*-{3,4}\s+(\d{1,2}:\d{2})\s+(\d{1,2}\.\d{1,2}\.\d{4})\s*$/
const ACTIVITY_LINE = /^\(([^)]+)\)\s+(\d{1,2}:\d{2})\s+-\s+(\d{1,2}:\d{2})\s+\((\d{1,2}:\d{2})\)\s*$/

export type CountryMarker = {
  activityId: 'START_COUNTRY' | 'END_COUNTRY'
  countryCode: string
  timeStr: string
  dateStr: string
}

export type ParseWorkWeekResult = {
  activities: ParsedActivity[]
  countryMarkers: CountryMarker[]
}

/**
 * Rozparsuje TXT soubor a vrátí seznam aktivit a značek zemí.
 * Aktivity mezi START a END patří ke směně; datum bere z řádku ----CZ----.
 */
export function parseWorkWeekTxt(content: string): ParseWorkWeekResult {
  const activities: ParsedActivity[] = []
  const countryMarkers: CountryMarker[] = []
  let currentDateStr = ''
  let markerIndex = 0
  const lines = content.split(/\r?\n/)

  for (const line of lines) {
    const midnightMatch = line.match(MIDNIGHT_HEADER)
    if (midnightMatch) {
      const [, , dateStr] = midnightMatch
      if (dateStr) currentDateStr = dateStr
      continue
    }

    const shiftMatch = line.match(SHIFT_HEADER)
    if (shiftMatch) {
      const [, code, timeStr, dateStr] = shiftMatch
      const isStart = markerIndex % 2 === 0
      currentDateStr = dateStr!
      countryMarkers.push({
        activityId: isStart ? 'START_COUNTRY' : 'END_COUNTRY',
        countryCode: code ?? 'CZ',
        timeStr: timeStr ?? '',
        dateStr: dateStr!,
      })
      markerIndex++
      continue
    }

    const activityMatch = line.match(ACTIVITY_LINE)
    if (activityMatch && currentDateStr) {
      const [, typeLabel, startTime, endTime] = activityMatch
      const type = LABEL_TO_TYPE[typeLabel ?? '']
      if (!type) continue

      const startMs = parseTimeAndDate(startTime!, currentDateStr)
      let endDateStr = currentDateStr
      const [sh, sm] = startTime!.split(':').map(Number)
      const [eh, em] = endTime!.split(':').map(Number)
      if (eh! < sh! || (eh === sh && em! < sm!)) {
        const [d, m, y] = currentDateStr.split('.').map(Number)
        const nextDay = new Date(Date.UTC(y, m - 1, d + 1))
        endDateStr = `${String(nextDay.getUTCDate()).padStart(2, '0')}.${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}.${nextDay.getUTCFullYear()}`
      }
      const endMs = parseTimeAndDate(endTime!, endDateStr)
      const durationMinutes = Math.round((endMs - startMs) / 60000)

      const last = activities[activities.length - 1]
      const isContinuation =
        last &&
        last.type === type &&
        last.endMs === startMs

      if (isContinuation) {
        last.endMs = endMs
        last.durationMinutes = Math.round((endMs - last.startMs) / 60000)
        if (last.originalDurationMinutes != null) {
          last.originalDurationMinutes = last.durationMinutes
        }
      } else {
        activities.push({
          type,
          startMs,
          endMs,
          durationMinutes,
          originalDurationMinutes: durationMinutes,
        })
      }
    }
  }

  return { activities, countryMarkers }
}

/** UTC vs. místní čas: data na kartě jsou v UTC, graf zobrazuje v místním čase řidiče. */
export type ActivitiesByDayOptions = { useLocalTime?: boolean }

/** Rozdělí aktivity po kalendářních dnech. Aktivity přes půlnoc se rozdělí. */
export function activitiesByDay(activities: ParsedActivity[], options?: ActivitiesByDayOptions): DayData[] {
  const useLocal = options?.useLocalTime ?? true
  const dayMap = new Map<number, ParsedActivity[]>()
  const dayOrder: number[] = []

  const getDayStart = (ms: number) => {
    const d = new Date(ms)
    if (useLocal) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }

  const getNextMidnight = (ms: number) => {
    const d = new Date(ms)
    if (useLocal) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    }
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    return dayStart + 24 * 3600 * 1000
  }

  const addToDay = (dayStart: number, segment: ParsedActivity) => {
    if (!dayMap.has(dayStart)) {
      dayMap.set(dayStart, [])
      dayOrder.push(dayStart)
    }
    dayMap.get(dayStart)!.push(segment)
  }

  for (const act of activities) {
    let cursor = act.startMs
    const end = act.endMs

    while (cursor < end) {
      const dayStart = getDayStart(cursor)
      const nextMidnight = getNextMidnight(cursor)
      const segEnd = Math.min(end, nextMidnight)
      const durationMinutes = Math.round((segEnd - cursor) / 60000)

      addToDay(dayStart, {
        type: act.type,
        startMs: cursor,
        endMs: segEnd,
        durationMinutes,
        originalDurationMinutes: act.originalDurationMinutes ?? act.durationMinutes,
        isManualEntry: act.isManualEntry,
        isCrew: act.isCrew,
        slot: act.slot,
        registration: act.registration,
        gpsLocation: act.gpsLocation,
      })
      cursor = segEnd
    }
  }

  dayOrder.sort((a, b) => a - b)

  return dayOrder.map((dayStart) => {
    const d = new Date(dayStart)
    const dayName = DAY_NAMES[useLocal ? d.getDay() : d.getUTCDay()]
    const dateStr = useLocal
      ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
      : `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
    const dayActivities = dayMap.get(dayStart)!
    dayActivities.sort((a, b) => a.startMs - b.startMs)
    return {
      dayLabel: dayName,
      dateStr,
      dateUtc: dayStart,
      activities: dayActivities,
    }
  })
}

const DAY_NAMES = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota']

export const DAY_MS = 24 * 3600 * 1000

export function getWeekStartMs(ms: number): number {
  const d = new Date(ms)
  const dayOfWeek = d.getUTCDay()
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const mondayDate = new Date(d)
  mondayDate.setUTCDate(mondayDate.getUTCDate() - mondayOffset)
  return Date.UTC(mondayDate.getUTCFullYear(), mondayDate.getUTCMonth(), mondayDate.getUTCDate())
}

/** Pondělí 00:00 místního času (pro zobrazení grafu v místním čase). */
export function getWeekStartMsLocal(ms: number): number {
  const d = new Date(ms)
  const dayOfWeek = d.getDay()
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const localMon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - mondayOffset)
  return localMon.getTime()
}

/**
 * Rozšíří dny na celý aktuální týden (pondělí–neděle).
 * Dny bez záznamů dostanou prázdný seznam aktivit.
 * Pro graf používá místní čas (pondělí 00:00 místního času).
 */
function expandMode(useLocalTime: boolean): ClockMode {
  return useLocalTime ? 'local' : 'utc'
}

export function expandToFullWeek(days: DayData[], referenceMs: number, useLocalTime = true): DayData[] {
  const mode = expandMode(useLocalTime)
  const weekStartMs = useLocalTime ? getWeekStartMsLocal(referenceMs) : getWeekStartMs(referenceMs)

  const dayMap = new Map<number, DayData>()
  for (const day of days) {
    dayMap.set(day.dateUtc, day)
  }

  const result: DayData[] = []
  for (let i = 0; i < 7; i++) {
    const dayStart = addDays(weekStartMs, i, mode)
    const existing = dayMap.get(dayStart)
    if (existing) {
      result.push(existing)
    } else {
      const dayDate = new Date(dayStart)
      result.push({
        dayLabel: DAY_NAMES[useLocalTime ? dayDate.getDay() : dayDate.getUTCDay()],
        dateStr: useLocalTime
          ? `${String(dayDate.getDate()).padStart(2, '0')}.${String(dayDate.getMonth() + 1).padStart(2, '0')}.${dayDate.getFullYear()}`
          : `${String(dayDate.getUTCDate()).padStart(2, '0')}.${String(dayDate.getUTCMonth() + 1).padStart(2, '0')}.${dayDate.getUTCFullYear()}`,
        dateUtc: dayStart,
        activities: [],
      })
    }
  }
  return result
}

/**
 * Rozšíří dny na všechny týdny, které obsahují data.
 * Když data sahají např. od pátku 7.2. do soboty 14.2., zobrazí oba týdny (2.–8.2. a 9.–15.2.).
 * Pro graf používá místní čas.
 */
export function expandToWeeksContainingData(days: DayData[], referenceMs: number, useLocalTime = true): DayData[] {
  if (days.length === 0) {
    return expandToFullWeek(days, referenceMs, useLocalTime)
  }
  const mode = expandMode(useLocalTime)
  const minMs = Math.min(...days.map((d) => d.dateUtc))
  const maxMs = Math.max(...days.map((d) => d.dateUtc), ...days.flatMap((d) => d.activities.map((a) => a.endMs - 1)))
  const weekStartMin = useLocalTime ? getWeekStartMsLocal(minMs) : getWeekStartMs(minMs)
  const weekStartMax = useLocalTime ? getWeekStartMsLocal(maxMs) : getWeekStartMs(maxMs)

  const dayMap = new Map<number, DayData>()
  for (const day of days) {
    dayMap.set(day.dateUtc, day)
  }

  const result: DayData[] = []
  for (let weekStart = weekStartMin; weekStart <= weekStartMax; weekStart = addDays(weekStart, 7, mode)) {
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(weekStart, i, mode)
      const existing = dayMap.get(dayStart)
      if (existing) {
        result.push(existing)
      } else {
        const dayDate = new Date(dayStart)
        result.push({
          dayLabel: DAY_NAMES[useLocalTime ? dayDate.getDay() : dayDate.getUTCDay()],
          dateStr: useLocalTime
            ? `${String(dayDate.getDate()).padStart(2, '0')}.${String(dayDate.getMonth() + 1).padStart(2, '0')}.${dayDate.getFullYear()}`
            : `${String(dayDate.getUTCDate()).padStart(2, '0')}.${String(dayDate.getUTCMonth() + 1).padStart(2, '0')}.${dayDate.getUTCFullYear()}`,
          dateUtc: dayStart,
          activities: [],
        })
      }
    }
  }
  return result
}
