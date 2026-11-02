import { useMemo } from 'react'
import {
  addDays,
  clockParts,
  weekStartMs,
  type ClockMode,
} from '../lib/clock'
import type { DayData } from '../workWeekTxtParser'

const MONTH_NAMES = [
  'leden',
  'únor',
  'březen',
  'duben',
  'květen',
  'červen',
  'červenec',
  'srpen',
  'září',
  'říjen',
  'listopad',
  'prosinec',
]

type CardCalendarProps = {
  days: DayData[]
  clockMode: ClockMode
  dayNames: string[]
  currentWeekStartMs: number
  onSelectWeek: (weekStartMs: number) => void
}

function monthStartMs(ms: number, mode: ClockMode): number {
  const parts = clockParts(ms, mode)
  if (mode === 'utc') return Date.UTC(parts.year, parts.month - 1, 1)
  return new Date(parts.year, parts.month - 1, 1).getTime()
}

function nextMonthStartMs(ms: number, mode: ClockMode): number {
  const parts = clockParts(ms, mode)
  if (mode === 'utc') return Date.UTC(parts.year, parts.month, 1)
  return new Date(parts.year, parts.month, 1).getTime()
}

function weekdayHeaders(dayNames: string[]): string[] {
  return [1, 2, 3, 4, 5, 6, 0].map((index) => (dayNames[index] ?? '').slice(0, 2))
}

export function CardCalendar({
  days,
  clockMode,
  dayNames,
  currentWeekStartMs,
  onSelectWeek,
}: CardCalendarProps) {
  const recordedDays = useMemo(() => {
    const set = new Set<number>()
    for (const day of days) {
      if (day.activities.some((act) => act.type === 'řízení')) set.add(day.dateUtc)
    }
    return set
  }, [days])

  const months = useMemo(() => {
    if (days.length === 0) return []
    let first = days[0]!.dateUtc
    let last = days[0]!.dateUtc
    for (const day of days) {
      if (day.dateUtc < first) first = day.dateUtc
      if (day.dateUtc > last) last = day.dateUtc
    }

    const result: Array<{
      key: string
      title: string
      weeks: Array<{ startMs: number; cells: Array<{ ms: number; day: number; inMonth: boolean; hasRecord: boolean }> }>
    }> = []

    let cursor = monthStartMs(first, clockMode)
    const lastMonth = monthStartMs(last, clockMode)
    while (cursor <= lastMonth) {
      const parts = clockParts(cursor, clockMode)
      const monthEnd = addDays(nextMonthStartMs(cursor, clockMode), -1, clockMode)
      const weeks: Array<{
        startMs: number
        cells: Array<{ ms: number; day: number; inMonth: boolean; hasRecord: boolean }>
      }> = []
      let weekStart = weekStartMs(cursor, clockMode)
      const lastWeek = weekStartMs(monthEnd, clockMode)
      while (weekStart <= lastWeek) {
        const cells = []
        for (let i = 0; i < 7; i++) {
          const ms = addDays(weekStart, i, clockMode)
          const cell = clockParts(ms, clockMode)
          cells.push({
            ms,
            day: cell.day,
            inMonth: cell.month === parts.month && cell.year === parts.year,
            hasRecord: recordedDays.has(ms),
          })
        }
        weeks.push({ startMs: weekStart, cells })
        weekStart = addDays(weekStart, 7, clockMode)
      }
      result.push({
        key: `${parts.year}-${parts.month}`,
        title: `${MONTH_NAMES[parts.month - 1] ?? ''} ${parts.year}`,
        weeks: weeks.reverse(),
      })
      cursor = nextMonthStartMs(cursor, clockMode)
    }
    return result.reverse()
  }, [clockMode, days, recordedDays])

  const headers = weekdayHeaders(dayNames)

  return (
    <section className="card-calendar" aria-label="Kalendář záznamů karty">
      <p className="card-calendar-hint">Zelený kroužek označuje den s řízením. Klepněte na řádek týdne.</p>
      {months.map((month) => (
        <div key={month.key} className="card-calendar-month">
          <h3 className="card-calendar-month-title">{month.title}</h3>
          <div className="card-calendar-grid">
            <div className="card-calendar-week card-calendar-week--head" aria-hidden="true">
              {headers.map((label) => (
                <span key={label} className="card-calendar-dow">
                  {label}
                </span>
              ))}
            </div>
            {month.weeks.map((week) => (
              <button
                key={week.startMs}
                type="button"
                className={
                  week.startMs === currentWeekStartMs
                    ? 'card-calendar-week is-current'
                    : 'card-calendar-week'
                }
                onClick={() => onSelectWeek(week.startMs)}
                aria-label={`Otevřít týden od ${week.cells[0]!.day}.`}
              >
                {week.cells.map((cell) => (
                  <span
                    key={cell.ms}
                    className={[
                      'card-calendar-day',
                      cell.inMonth ? '' : 'is-outside',
                      cell.hasRecord ? 'has-record' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {cell.day}
                  </span>
                ))}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}
