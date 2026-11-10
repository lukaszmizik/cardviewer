import {
  addDays,
  formatClockDate,
  formatWeekRange,
  weekStartMs,
  type ClockMode,
} from '../lib/clock.ts'
import type { ComplianceSeverity } from './complianceReview.ts'

export type CalendarMapMode = 'days' | 'weeks' | 'months'

export type CalendarDay = {
  dayStartUtc: number
  label: string
  severity: ComplianceSeverity
  note: string | null
}

export type CalendarBucket = {
  id: string
  label: string
  startUtc: number
  endUtc: number
  severity: ComplianceSeverity
  dayStarts: number[]
}

export function calendarMapMode(dayCount: number): CalendarMapMode {
  if (dayCount <= 62) return 'days'
  if (dayCount <= 366) return 'weeks'
  return 'months'
}

/** Pro dlouhé karty: výchozí měsíční mřížka místo seznamu jednotlivých dnů. */
export function workPeriodCalendarMode(dayCount: number): CalendarMapMode {
  if (dayCount <= 7) return 'days'
  if (dayCount <= 31) return 'weeks'
  return 'months'
}

export function buildCalendarBuckets(
  days: readonly CalendarDay[],
  mode: Exclude<CalendarMapMode, 'days'>,
  clockMode: ClockMode,
): CalendarBucket[] {
  const groups = new Map<string, CalendarDay[]>()
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

export function calendarSeverityLabel(severity: ComplianceSeverity): string {
  if (severity === 'violation') return 'prokázané porušení'
  if (severity === 'uncertain') return 'nejistota'
  if (severity === 'incomplete') return 'neúplné nebo neuzavřené'
  return 'vyhodnoceno bez porušení'
}

export function ComplianceDayMap({
  days,
  selectedDay,
  onSelect,
}: {
  days: readonly CalendarDay[]
  selectedDay: number | null
  onSelect: (dayStartUtc: number | null) => void
}) {
  return (
    <div className="compliance-map" role="list" aria-label="Mapa dnů">
      {days.map((day) => (
        <button
          key={day.dayStartUtc}
          type="button"
          role="listitem"
          className={`compliance-day compliance-day-${day.severity}${selectedDay === day.dayStartUtc ? ' is-selected' : ''}`}
          aria-pressed={selectedDay === day.dayStartUtc}
          title={`${day.label}: ${calendarSeverityLabel(day.severity)}${day.note == null ? '' : `. ${day.note}`}`}
          onClick={() => onSelect(selectedDay === day.dayStartUtc ? null : day.dayStartUtc)}
        >
          <span>{day.label.slice(0, 2)}</span>
        </button>
      ))}
    </div>
  )
}

export function ComplianceBucketMap({
  buckets,
  mapMode,
  openBucket,
  onSelectBucket,
}: {
  buckets: readonly CalendarBucket[]
  mapMode: Exclude<CalendarMapMode, 'days'>
  openBucket: string | null
  onSelectBucket: (bucketId: string | null) => void
}) {
  return (
    <div className="compliance-map compliance-map-buckets" role="list" aria-label={mapMode === 'weeks' ? 'Mapa týdnů' : 'Mapa měsíců'}>
      {buckets.map((item) => (
        <button
          key={item.id}
          type="button"
          role="listitem"
          className={`compliance-day compliance-bucket compliance-day-${item.severity}${openBucket === item.id ? ' is-selected' : ''}`}
          aria-pressed={openBucket === item.id}
          title={`${item.label}: ${calendarSeverityLabel(item.severity)}`}
          onClick={() => onSelectBucket(openBucket === item.id ? null : item.id)}
        >
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

export function ComplianceCalendarPicker({
  days,
  mapMode,
  buckets,
  selectedDay,
  openBucket,
  onSelectDay,
  onSelectBucket,
}: {
  days: readonly CalendarDay[]
  mapMode: CalendarMapMode
  buckets: readonly CalendarBucket[]
  selectedDay: number | null
  openBucket: string | null
  onSelectDay: (dayStartUtc: number | null) => void
  onSelectBucket: (bucketId: string | null) => void
}) {
  const bucket = buckets.find((item) => item.id === openBucket) ?? null
  return (
    <>
      {mapMode === 'days' ? (
        <ComplianceDayMap days={days} selectedDay={selectedDay} onSelect={onSelectDay} />
      ) : (
        <ComplianceBucketMap
          buckets={buckets}
          mapMode={mapMode}
          openBucket={openBucket}
          onSelectBucket={onSelectBucket}
        />
      )}
      {bucket != null ? (
        <ComplianceDayMap
          days={days.filter((day) => bucket.dayStarts.includes(day.dayStartUtc))}
          selectedDay={selectedDay}
          onSelect={onSelectDay}
        />
      ) : null}
    </>
  )
}

export function daySlotsBetween(startUtc: number, endUtc: number, clockMode: ClockMode): number[] {
  const slots: number[] = []
  let cursor = startUtc
  const last = endUtc
  while (cursor <= last && slots.length < 4000) {
    slots.push(cursor)
    const next = addDays(cursor, 1, clockMode)
    if (next <= cursor) break
    cursor = next
  }
  return slots
}

export function calendarDayLabels(dayStarts: readonly number[], clockMode: ClockMode): CalendarDay[] {
  return dayStarts.map((dayStartUtc) => ({
    dayStartUtc,
    label: formatClockDate(dayStartUtc, clockMode),
    severity: 'incomplete' as const,
    note: null,
  }))
}
