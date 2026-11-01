/**
 * Graf pracovního týdne – SVG zobrazení načtených dat z TXT.
 * Každý den = řádek, hodiny 0–24, aktivity jako barevné segmenty.
 */

import { useState, useEffect } from 'react'
import { useLanguage } from './translations'
import type { DayData, ParsedActivity, ActivityType, CountryMarker } from './workWeekTxtParser'
import type { ManualEntrySegment, VehicleLoadUnloadEvent, FerryTrainEvent, OutModeEvent, FaultOrEvent, RecordedGpsLocation } from './TachoTypes'
import type { SymbolMap } from './TachoTypes'
import { DRIVING_SYMBOL } from './CardLogic'
import type { ClockMode } from './lib/clock'
import {
  addDays,
  clockParts,
  formatClockDate,
  formatClockDateTime,
  formatWeekRange,
  parseClockDateTime,
  timeToX,
  weekStartMs,
} from './lib/clock'
import { TimeScaleSelect } from './components/TimeScaleSelect'
import { CardInfoTable } from './components/CardInfoTable'
import type { DriverCardData } from './types/tacho'

function markerTimeMs(marker: { timeStr: string; dateStr: string }, mode: ClockMode): number {
  return parseClockDateTime(marker.timeStr, marker.dateStr, mode)
}

function manualSegmentMs(segment: { day: number; month: number; year: number; hour: number; minute: number }, mode: ClockMode): number {
  const pad = (n: number) => String(n).padStart(2, '0')
  return parseClockDateTime(`${pad(segment.hour)}:${pad(segment.minute)}`, `${pad(segment.day)}.${pad(segment.month)}.${segment.year}`, mode)
}

const DAYS_PER_WEEK = 7

const ROW_HEIGHT = 40
const LABEL_WIDTH = 126
const CHART_WIDTH = 540
const MARGIN_TOP = 25
const MARGIN_BOTTOM = 18
const TICK_LEN = 2
const HOUR_TICK_LEN = 4
const QUARTER_TICK_LEN = 3
const HOURS = 25
const QUARTERS_PER_DAY = 24 * 4

const LONG_REST_MIN = 24 * 60
const WEEKLY_REST_MIN = 45 * 60
const REGULAR_TDO_MIN = 45 * 60

const ACTIVITY_SYMBOL: Record<ActivityType, string> = {
  řízení: DRIVING_SYMBOL,
  práce: '\u005a',
  pohotovost: '\u0058',
  odpočinek: '\u0059',
  'odpočinek>24h': '\u0059',
  'odpočinek>45h': '\u0059',
  neznámá: '?',
}

const ACTIVITY_STYLE: Record<ActivityType, { color: string; strokeWidth: number }> = {
  řízení: { color: '#c41e3a', strokeWidth: 13 },
  práce: { color: '#c9a227', strokeWidth: 9 },
  pohotovost: { color: '#d4738a', strokeWidth: 5 },
  odpočinek: { color: '#2d7d3e', strokeWidth: 16 },
  'odpočinek>24h': { color: '#60a5fa', strokeWidth: 16 },
  'odpočinek>45h': { color: '#2563eb', strokeWidth: 16 },
  neznámá: { color: '#888', strokeWidth: 5 },
}

const TICK_COLOR = '#999'
const LABEL_COLOR = '#666'
const ANCHOR_COLOR = '#000'
const ANCHOR_STROKE = '#000'
function getActivityColor(act: ParsedActivity): string {
  if (act.type === 'řízení') return '#c41e3a'
  if (act.type === 'práce') return '#c9a227'
  if (act.type === 'pohotovost') return '#d4738a'
  if (act.type === 'odpočinek' || act.type === 'odpočinek>24h' || act.type === 'odpočinek>45h') {
    const minutes = act.originalDurationMinutes ?? act.durationMinutes
    if (minutes >= WEEKLY_REST_MIN) return '#2563eb'
    if (minutes >= LONG_REST_MIN) return '#60a5fa'
    return '#2d7d3e'
  }
  return ACTIVITY_STYLE[act.type]?.color ?? '#888'
}

function createEmptyDay(dayStartMs: number, dayNames: string[], mode: ClockMode): DayData {
  const parts = clockParts(dayStartMs, mode)
  return {
    dayLabel: dayNames[parts.weekday] ?? '',
    dateStr: formatClockDate(dayStartMs, mode),
    dateUtc: dayStartMs,
    activities: [],
  }
}

const ACTIVITY_LABELS: Record<string, string> = {
  REST: 'odpočinek',
  WORK: 'práce',
  AVAILABILITY: 'pohotovost',
  UNKNOWN: 'neznámá činnost',
  START_COUNTRY: 'výchozí země',
  END_COUNTRY: 'cílová země',
}

const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  řízení: 'řízení',
  práce: 'práce',
  pohotovost: 'pohotovost',
  odpočinek: 'odpočinek',
  'odpočinek>24h': 'odpoč. 24h–45h',
  'odpočinek>45h': 'odpoč. ≥45h',
  neznámá: 'neznámá',
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

export type Card2GraphData = {
  days: DayData[]
  countryMarkers: CountryMarker[]
  manualEntryBuffer?: ManualEntrySegment[]
  lastWithdrawalUtc?: number | null
}

export type WorkWeekGraphViewProps = {
  days: DayData[]
  countryMarkers: CountryMarker[]
  manualEntryBuffer?: ManualEntrySegment[]
  lastWithdrawalUtc?: number | null
  card2Data?: Card2GraphData
  loadUnloadEvents?: VehicleLoadUnloadEvent[]
  ferryTrainEvents?: FerryTrainEvent[]
  outModeEvents?: OutModeEvent[]
  recordedGpsLocations?: RecordedGpsLocation[]
  faultsAndEvents?: FaultOrEvent[]
  symbolMap?: SymbolMap | null
  onResetLoadUnload?: () => void
  embedded?: boolean
  onClose: () => void
  clockMode?: ClockMode
  onClockModeChange?: (mode: ClockMode) => void
  card?: DriverCardData | null
}

/**
 * Pracovní směna = od zadání výchozí země (START_COUNTRY) do zadání cílové země (END_COUNTRY).
 * Režim osádky / podkreslení šrafou platí pro tuto periodu.
 */
function getWorkShiftRanges(markers: CountryMarker[], clockMode: ClockMode): Array<{ startMs: number; endMs: number }> {
  const withMs = markers
    .map((m) => ({ ...m, ms: markerTimeMs(m, clockMode) }))
    .sort((a, b) => a.ms - b.ms)
  const ranges: Array<{ startMs: number; endMs: number }> = []
  for (let i = 0; i < withMs.length; i++) {
    if (withMs[i]!.activityId !== 'START_COUNTRY') continue
    const startMs = withMs[i]!.ms
    for (let j = i + 1; j < withMs.length; j++) {
      if (withMs[j]!.activityId === 'END_COUNTRY') {
        ranges.push({ startMs, endMs: withMs[j]!.ms })
        break
      }
    }
  }
  return ranges
}

/** Průnik pracovních směn s daným dnem – vrací segmenty pro vykreslení v řádku dne. */
function getWorkShiftRangesForDay(
  workShiftRanges: Array<{ startMs: number; endMs: number }>,
  dayUtc: number
): Array<{ startMs: number; endMs: number }> {
  const dayEnd = dayUtc + 24 * 3600 * 1000
  const result: Array<{ startMs: number; endMs: number }> = []
  for (const r of workShiftRanges) {
    if (r.endMs <= dayUtc || r.startMs >= dayEnd) continue
    result.push({
      startMs: Math.max(r.startMs, dayUtc),
      endMs: Math.min(r.endMs, dayEnd),
    })
  }
  return result
}

function getMarkersOnDay(markers: CountryMarker[], dayUtcMs: number, clockMode: ClockMode): CountryMarker[] {
  const dayEndMs = dayUtcMs + 24 * 3600 * 1000
  return markers.filter((m) => {
    const ms = markerTimeMs(m, clockMode)
    return ms >= dayUtcMs && ms < dayEndMs
  })
}

function getLoadUnloadOnDay(events: VehicleLoadUnloadEvent[], dayUtcMs: number): VehicleLoadUnloadEvent[] {
  const dayEndMs = dayUtcMs + 24 * 3600 * 1000
  return events.filter((e) => e.minuteStartUtc >= dayUtcMs && e.minuteStartUtc < dayEndMs)
}

const FERRY_TRAIN_SYMBOL_ID = 49

function getFerryTrainOnDay(events: FerryTrainEvent[], dayUtcMs: number): FerryTrainEvent[] {
  const dayEndMs = dayUtcMs + 24 * 3600 * 1000
  return events.filter((e) => e.minuteStartUtc >= dayUtcMs && e.minuteStartUtc < dayEndMs)
}

function getOutModeOnDay(events: OutModeEvent[], dayUtcMs: number): OutModeEvent[] {
  const dayEndMs = dayUtcMs + 24 * 3600 * 1000
  return events.filter((e) => e.minuteStartUtc >= dayUtcMs && e.minuteStartUtc < dayEndMs)
}

/** Vrací období OUT (startMs, endMs) z párování activation–deactivation */
function getOutModeRanges(events: OutModeEvent[]): Array<{ startMs: number; endMs: number }> {
  const sorted = [...events].sort((a, b) => a.minuteStartUtc - b.minuteStartUtc)
  const ranges: Array<{ startMs: number; endMs: number }> = []
  let pendingStart: number | null = null
  for (const e of sorted) {
    if (e.type === 'activation') {
      pendingStart = e.minuteStartUtc
    } else if (e.type === 'deactivation' && pendingStart != null) {
      ranges.push({ startMs: pendingStart, endMs: e.minuteStartUtc })
      pendingStart = null
    }
  }
  return ranges
}

/** Zda aktivita řízení (startMs, endMs) překrývá nějaké OUT období */
function drivingOverlapsOutPeriod(actStartMs: number, actEndMs: number, outRanges: Array<{ startMs: number; endMs: number }>): boolean {
  for (const r of outRanges) {
    if (actStartMs < r.endMs && actEndMs > r.startMs) return true
  }
  return false
}

const LOAD_UNLOAD_SYMBOL_ID: Record<VehicleLoadUnloadEvent['type'], number> = {
  load: 52,
  unload: 53,
  both: 54,
}

function formatTimestamp(ms: number, mode: ClockMode): string {
  return formatClockDateTime(ms, mode)
}

function formatSlot(act: ParsedActivity): string {
  return act.slot === 2 ? ' | slot 2' : ''
}

function formatRegistration(act: ParsedActivity): string {
  return act.registration ? ` | RZ ${act.registration}` : ''
}

function formatTimeRange(startMs: number, endMs: number, mode: ClockMode): string {
  const a = clockParts(startMs, mode)
  const b = clockParts(endMs, mode)
  const sameDay = a.day === b.day && a.month === b.month && a.year === b.year
  if (sameDay) {
    return `${formatClockDateTime(startMs, mode)}–${formatClockDateTime(endMs, mode).slice(-5)}`
  }
  return `${formatTimestamp(startMs, mode)}–${formatTimestamp(endMs, mode)}`
}

type GraphBlockProps = {
  days: DayData[]
  countryMarkers: CountryMarker[]
  manualEntryBuffer?: ManualEntrySegment[]
  lastWithdrawalUtc?: number | null
  loadUnloadEvents?: VehicleLoadUnloadEvent[]
  ferryTrainEvents?: FerryTrainEvent[]
  outModeEvents?: OutModeEvent[]
  symbolMap?: SymbolMap | null
  displayWeekStartMs: number
  blockId: string
  title?: string
  dayNames: string[]
  t: {
    workWeek: {
      activityLabels: Record<string, string>
      activityTypes: Record<string, string>
      workShiftDuration: string
      workShiftRest: string
      manualRecordsTitle: string
      tachographRecordsTitle: string
      lastWithdrawalLabel: string
      manualDataLabel: string
      shiftMarkerLabel: string
      loadUnloadSection: string
      ferryTrainSection: string
      outModeSection: string
      activation: string
      deactivation: string
      outModeStartMark: string
      outModeEndMark: string
    }
    manualEntry: { load: string; unload: string; loadUnload: string }
  }
  clockMode: ClockMode
  card?: DriverCardData | null
}

function GraphBlock({ days, countryMarkers, manualEntryBuffer, lastWithdrawalUtc, loadUnloadEvents = [], ferryTrainEvents = [], outModeEvents = [], symbolMap, displayWeekStartMs, blockId, title, dayNames, t, clockMode, card }: GraphBlockProps) {
  const dayMap = new Map<number, DayData>()
  for (const day of days) {
    dayMap.set(day.dateUtc, day)
  }

  const visibleDays: DayData[] = []
  for (let i = 0; i < DAYS_PER_WEEK; i++) {
    const dayStart = addDays(displayWeekStartMs, i, clockMode)
    visibleDays.push(dayMap.get(dayStart) ?? createEmptyDay(dayStart, dayNames, clockMode))
  }

  const visibleFirstDate = visibleDays[0]!.dateUtc
  const visibleLastDate = visibleDays[visibleDays.length - 1]!.dateUtc
  const visibleLastEnd = addDays(visibleLastDate, 1, clockMode)
  const visibleMarkers = countryMarkers.filter((m) => {
    const ms = markerTimeMs(m, clockMode)
    return ms >= visibleFirstDate && ms < visibleLastEnd
  })
  const visibleLoadUnload = loadUnloadEvents.filter(
    (e) => e.minuteStartUtc >= visibleFirstDate && e.minuteStartUtc < visibleLastEnd
  )
  const visibleFerryTrain = ferryTrainEvents.filter(
    (e) => e.type === 'activation' && e.minuteStartUtc >= visibleFirstDate && e.minuteStartUtc < visibleLastEnd
  )
  const visibleOutMode = outModeEvents.filter(
    (e) => e.minuteStartUtc >= visibleFirstDate && e.minuteStartUtc < visibleLastEnd
  )
  const outModeRanges = getOutModeRanges(outModeEvents)

  const workShiftRanges = getWorkShiftRanges(countryMarkers, clockMode)

  const height = MARGIN_TOP + visibleDays.length * ROW_HEIGHT + MARGIN_BOTTOM
  const width = LABEL_WIDTH + CHART_WIDTH + 36

  return (
    <div className="work-week-graph-block">
      {title != null && <h3 className="work-week-graph-block-title">{title}</h3>}
      <svg viewBox={`0 0 ${width} ${height}`} className="work-week-graph-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id={`crew-mode-hatch-${blockId}`} patternUnits="userSpaceOnUse" width="6" height="6">
            <line x1="0" y1="0" x2="6" y2="6" stroke="rgba(100, 149, 237, 0.18)" strokeWidth="1" />
          </pattern>
          <pattern id={`out-driving-hatch-${blockId}`} patternUnits="userSpaceOnUse" width="4" height="4">
            <line x1="0" y1="0" x2="4" y2="4" stroke="#c62828" strokeWidth="2.2" />
          </pattern>
        </defs>
        <g id={`day-separators-${blockId}`}>
          {visibleDays.slice(0, -1).map((_, i) => {
            const y = MARGIN_TOP + (i + 1) * ROW_HEIGHT
            return (
              <line key={i} x1={0} y1={y} x2={width} y2={y} stroke="#e0e0e0" strokeWidth={0.5} opacity={0.7} />
            )
          })}
        </g>
        <g id={`quarter-ticks-top-${blockId}`}>
          {Array.from({ length: QUARTERS_PER_DAY }, (_, q) => {
            if (q % 4 === 0) return null
            const x = LABEL_WIDTH + (q / QUARTERS_PER_DAY) * CHART_WIDTH
            return (
              <line key={`top-q-${q}`} x1={x} y1={MARGIN_TOP - QUARTER_TICK_LEN} x2={x} y2={MARGIN_TOP} stroke="#bbb" strokeWidth={0.5} opacity={0.7} />
            )
          })}
        </g>
        <g id={`hour-ticks-top-${blockId}`}>
          {Array.from({ length: HOURS }, (_, i) => {
            const x = LABEL_WIDTH + (i / 24) * CHART_WIDTH
            return (
              <g key={`top-${i}`}>
                <line x1={x} y1={MARGIN_TOP - HOUR_TICK_LEN} x2={x} y2={MARGIN_TOP} stroke="#333" strokeWidth={1} />
                <text x={x} y={11} textAnchor="middle" fill="#222" fontSize={8} fontFamily="sans-serif" fontWeight={600}>{i}</text>
              </g>
            )
          })}
        </g>
        {visibleDays.map((day, rowIndex) => {
          const yBase = MARGIN_TOP + rowIndex * ROW_HEIGHT
          const dayStart = day.dateUtc
          return (
            <g key={day.dateUtc}>
              {Array.from({ length: HOURS }, (_, i) => {
                const x = LABEL_WIDTH + (i / 24) * CHART_WIDTH
                const rowTop = yBase + 3
                return (
                  <g key={`tick-${i}`}>
                    <line x1={x} y1={rowTop} x2={x} y2={rowTop + TICK_LEN} stroke={TICK_COLOR} strokeWidth="0.5" opacity={0.4} />
                    <line x1={x} y1={yBase + ROW_HEIGHT - 3 - TICK_LEN} x2={x} y2={yBase + ROW_HEIGHT - 3} stroke={TICK_COLOR} strokeWidth="0.5" opacity={0.4} />
                  </g>
                )
              })}
              <text x={6} y={yBase + ROW_HEIGHT / 2 + 4} fill="#333" fontSize={11} fontFamily="sans-serif" fontWeight={500}>{dayNames[new Date(day.dateUtc).getDay()]}</text>
              <text x={6} y={yBase + ROW_HEIGHT / 2 + 14} fill={LABEL_COLOR} fontSize={9} fontFamily="sans-serif">{day.dateStr}</text>
              {getWorkShiftRangesForDay(workShiftRanges, day.dateUtc).map((range, ri) => {
                const x1 = LABEL_WIDTH + timeToX(dayStart, range.startMs, clockMode) * CHART_WIDTH
                const x2 = LABEL_WIDTH + timeToX(dayStart, range.endMs, clockMode) * CHART_WIDTH
                const rowTop = yBase + 2
                const rowH = ROW_HEIGHT - 4
                return (
                  <rect
                    key={`crew-${ri}`}
                    x={x1}
                    y={rowTop}
                    width={Math.max(1, x2 - x1)}
                    height={rowH}
                    fill={`url(#crew-mode-hatch-${blockId})`}
                    className="work-week-graph-crew-mode-bg"
                  />
                )
              })}
              {(() => {
                const maxStrokeHalf = 8
                const rowCenter = yBase + ROW_HEIGHT / 2
                const sortedActivities = [...day.activities].sort((a, b) => {
                  const layer = (act: ParsedActivity) => (act.isManualEntry || act.type === 'neznámá' ? 0 : act.slot ?? 1)
                  return layer(a) - layer(b) || a.startMs - b.startMs
                })
                const MANUAL_UNDERLINE_WIDTH = 3
                const CREW_UNDERLINE = '#25D366'
                const CREW_UNDERLINE_WIDTH = 3
                return sortedActivities.map((act, i) => {
                  const style = ACTIVITY_STYLE[act.type]
                  const baseColor = getActivityColor(act)
                  const dur = act.originalDurationMinutes ?? act.durationMinutes
                  const strokeW =
                    (act.type === 'odpočinek' && dur >= LONG_REST_MIN) || act.type === 'odpočinek>24h' || act.type === 'odpočinek>45h'
                      ? 16
                      : (style?.strokeWidth ?? 5)
                  const x1 = LABEL_WIDTH + timeToX(dayStart, act.startMs, clockMode) * CHART_WIDTH
                  const x2 = LABEL_WIDTH + timeToX(dayStart, act.endMs, clockMode) * CHART_WIDTH
                  const y = rowCenter + maxStrokeHalf - strokeW / 2
                  const bottomY = y + strokeW / 2 + MANUAL_UNDERLINE_WIDTH / 2
                  const crewY = bottomY + (act.isManualEntry ? MANUAL_UNDERLINE_WIDTH : 0)
                  const isDrivingInOut =
                    act.type === 'řízení' && drivingOverlapsOutPeriod(act.startMs, act.endMs, outModeRanges)
                  return (
                    <g key={i}>
                      {isDrivingInOut ? (
                        <rect
                          x={x1}
                          y={y - strokeW / 2}
                          width={Math.max(1, x2 - x1)}
                          height={strokeW}
                          fill={`url(#out-driving-hatch-${blockId})`}
                        />
                      ) : (
                        <line
                          x1={x1}
                          y1={y}
                          x2={x2}
                          y2={y}
                          stroke={baseColor}
                          strokeWidth={strokeW}
                          strokeLinecap="butt"
                        />
                      )}
                      {act.isManualEntry && (
                        <line x1={x1} y1={bottomY} x2={x2} y2={bottomY} stroke="#8b5cf6" strokeWidth={MANUAL_UNDERLINE_WIDTH} strokeLinecap="butt" />
                      )}
                      {act.isCrew && !act.isManualEntry && (
                        <line x1={x1} y1={crewY} x2={x2} y2={crewY} stroke={CREW_UNDERLINE} strokeWidth={CREW_UNDERLINE_WIDTH} strokeLinecap="butt" />
                      )}
                    </g>
                  )
                })
              })()}
              {getMarkersOnDay(visibleMarkers, day.dateUtc, clockMode).map((marker, i) => {
                const ms = markerTimeMs(marker, clockMode)
                const x = LABEL_WIDTH + timeToX(dayStart, ms, clockMode) * CHART_WIDTH
                const code = marker.countryCode ?? 'CZ'
                const isStart = marker.activityId === 'START_COUNTRY'
                const label = isStart ? `${code} ►` : `◄ ${code}`
                const dx = isStart ? 7 : -7
                const textAnchor = isStart ? 'start' : 'end'
                const anchorBottom = yBase + ROW_HEIGHT / 2 + 7
                return (
                  <g key={`anchor-${dayStart}-${i}`}>
                    <text x={x} y={yBase + 8} dx={dx} textAnchor={textAnchor} fill={ANCHOR_STROKE} fontSize={8} fontFamily="sans-serif" fontWeight={600}>{label}</text>
                    <line x1={x} y1={yBase + 3} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={1.5} strokeLinecap="round" />
                    <circle cx={x} cy={yBase + 3} r={2.5} fill={ANCHOR_COLOR} />
                  </g>
                )
              })}
              {getLoadUnloadOnDay(visibleLoadUnload, day.dateUtc).map((ev, i) => {
                const x = LABEL_WIDTH + timeToX(dayStart, ev.minuteStartUtc, clockMode) * CHART_WIDTH
                const symbolId = LOAD_UNLOAD_SYMBOL_ID[ev.type]
                const symbolChar = symbolMap?.[symbolId] ?? ''
                const anchorBottom = yBase + ROW_HEIGHT / 2 + 7
                return (
                  <g key={`loadunload-${dayStart}-${ev.minuteStartUtc}-${i}`}>
                    <text x={x} y={yBase + 10} textAnchor="middle" fill={ANCHOR_STROKE} fontSize={12} fontFamily="SymbolTacho1">{symbolChar}</text>
                    <line x1={x} y1={yBase + 14} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={1.5} strokeLinecap="round" />
                  </g>
                )
              })}
              {getFerryTrainOnDay(visibleFerryTrain, day.dateUtc).map((ev, i) => {
                const x = LABEL_WIDTH + timeToX(dayStart, ev.minuteStartUtc, clockMode) * CHART_WIDTH
                const symbolChar = symbolMap?.[FERRY_TRAIN_SYMBOL_ID] ?? ''
                const anchorBottom = yBase + ROW_HEIGHT / 2 + 7
                return (
                  <g key={`ferrytrain-${dayStart}-${ev.minuteStartUtc}-${i}`}>
                    <text x={x} y={yBase + 10} textAnchor="middle" fill={ANCHOR_STROKE} fontSize={12} fontFamily="SymbolTacho1">{symbolChar}</text>
                    <line x1={x} y1={yBase + 14} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={1.5} strokeLinecap="round" />
                  </g>
                )
              })}
              {getOutModeOnDay(visibleOutMode, day.dateUtc).map((ev, i) => {
                const x = LABEL_WIDTH + timeToX(dayStart, ev.minuteStartUtc, clockMode) * CHART_WIDTH
                const label = ev.type === 'activation' ? 'OUT►' : '◄OUT'
                const dx = ev.type === 'activation' ? 3 : -3
                const textAnchor = ev.type === 'activation' ? 'start' : 'end'
                const rowCenter = yBase + ROW_HEIGHT / 2
                const anchorTop = rowCenter + 4
                const anchorBottom = yBase + ROW_HEIGHT - 4
                const textY = ev.type === 'activation' ? anchorBottom + 4 : anchorBottom - 2
                return (
                  <g key={`outmode-${dayStart}-${ev.minuteStartUtc}-${ev.type}-${i}`}>
                    <line x1={x} y1={anchorTop} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={1} strokeLinecap="round" />
                    <circle cx={x} cy={anchorBottom} r={1.5} fill={ANCHOR_COLOR} />
                    <text x={x} y={textY} dx={dx} textAnchor={textAnchor} fill={ANCHOR_STROKE} fontSize={7} fontFamily="sans-serif" fontWeight={600}>{label}</text>
                  </g>
                )
              })}
            </g>
          )
        })}
        <g id={`quarter-ticks-bottom-${blockId}`} transform={`translate(0, ${height - MARGIN_BOTTOM})`}>
          {Array.from({ length: QUARTERS_PER_DAY }, (_, q) => {
            if (q % 4 === 0) return null
            const x = LABEL_WIDTH + (q / QUARTERS_PER_DAY) * CHART_WIDTH
            return <line key={`bot-q-${q}`} x1={x} y1={0} x2={x} y2={QUARTER_TICK_LEN} stroke="#bbb" strokeWidth={0.5} opacity={0.7} />
          })}
        </g>
        <g id={`hour-ticks-bottom-${blockId}`} transform={`translate(0, ${height - MARGIN_BOTTOM})`}>
          {Array.from({ length: HOURS }, (_, i) => {
            const x = LABEL_WIDTH + (i / 24) * CHART_WIDTH
            return (
              <g key={`bot-${i}`}>
                <line x1={x} y1={0} x2={x} y2={TICK_LEN} stroke="#333" strokeWidth={1} />
                <text x={x} y={12} textAnchor="middle" fill="#222" fontSize={8} fontFamily="sans-serif" fontWeight={600}>{i}</text>
              </g>
            )
          })}
        </g>
      </svg>
      {card && <CardInfoTable card={card} clockMode={clockMode} />}
      {(visibleDays.some((d) => d.activities.some((a) => !a.isManualEntry)) ||
        (manualEntryBuffer ?? []).some((seg) => {
          const ms = manualSegmentMs(seg, clockMode)
          return ms >= visibleFirstDate && ms < visibleLastEnd
        }) ||
        (lastWithdrawalUtc != null && lastWithdrawalUtc >= visibleFirstDate && lastWithdrawalUtc < visibleLastEnd) ||
        visibleLoadUnload.length > 0 ||
        ferryTrainEvents.some((ev) => ev.minuteStartUtc >= visibleFirstDate && ev.minuteStartUtc < visibleLastEnd) ||
        visibleOutMode.length > 0) && (
        <div className="work-week-graph-table-wrapper">
          <table className="work-week-graph-table">
            <thead>
              <tr>
                <th>{t.workWeek.manualRecordsTitle}</th>
                <th>{t.workWeek.tachographRecordsTitle}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="work-week-graph-table-cell">
                  {lastWithdrawalUtc != null && lastWithdrawalUtc >= visibleFirstDate && lastWithdrawalUtc < visibleLastEnd && (
                    <div className="work-week-graph-manual-item">
                      <strong>{t.workWeek.lastWithdrawalLabel}</strong>{' '}
                      {formatTimestamp(lastWithdrawalUtc, clockMode)}
                    </div>
                  )}
                  {manualEntryBuffer != null && manualEntryBuffer.some((seg) => {
                    const ms = manualSegmentMs(seg, clockMode)
                    return ms >= visibleFirstDate && ms < visibleLastEnd
                  }) && (
                    <>
                      <strong>{t.workWeek.manualDataLabel}</strong>
                      <div className="work-week-graph-manual-list">
                        {(() => {
                          type ManualRow =
                            | { kind: 'country'; ms: number; seg: ManualEntrySegment }
                            | { kind: 'activity'; ms: number; act: ParsedActivity }
                          const rows: ManualRow[] = []
                          for (const seg of manualEntryBuffer) {
                            if (seg.activityId !== 'START_COUNTRY' && seg.activityId !== 'END_COUNTRY') continue
                            const ms = manualSegmentMs(seg, clockMode)
                            if (ms < visibleFirstDate || ms >= visibleLastEnd) continue
                            rows.push({ kind: 'country', ms, seg })
                          }
                          for (const act of visibleDays.flatMap((day) => day.activities)) {
                            if (!act.isManualEntry) continue
                            if (act.endMs <= visibleFirstDate || act.startMs >= visibleLastEnd) continue
                            rows.push({ kind: 'activity', ms: act.startMs, act })
                          }
                          rows.sort((a, b) => a.ms - b.ms || (a.kind === 'country' ? 0 : 1) - (b.kind === 'country' ? 0 : 1))
                          return rows.map((row, index) => {
                            if (row.kind === 'country') {
                              const label = t.workWeek.activityLabels[row.seg.activityId] ?? ACTIVITY_LABELS[row.seg.activityId] ?? row.seg.activityId
                              return (
                                <div key={`country-${row.ms}-${index}`} className="work-week-graph-manual-item">
                                  {formatTimestamp(row.ms, clockMode)} | <em>{label}</em> {t.workWeek.shiftMarkerLabel}{row.seg.countryCode && ` ${row.seg.countryCode}`}{row.seg.isManualEntry && ' [M]'}
                                </div>
                              )
                            }
                            const label = (t.workWeek.activityTypes as Record<string, string>)[row.act.type] ?? ACTIVITY_TYPE_LABELS[row.act.type] ?? row.act.type
                            return (
                              <div key={`act-${row.act.startMs}-${row.act.endMs}-${index}`} className="work-week-graph-manual-item">
                                {formatTimeRange(row.act.startMs, row.act.endMs, clockMode)} | {label} ({formatDuration(row.act.durationMinutes)}){formatRegistration(row.act)}{formatSlot(row.act)} [M]
                              </div>
                            )
                          })
                        })()}
                      </div>
                    </>
                  )}
                  {visibleLoadUnload.length > 0 && (
                    <>
                      <strong>{t.workWeek.loadUnloadSection}</strong>
                      <div className="work-week-graph-manual-list">
                        {visibleLoadUnload.map((ev, i) => {
                          const d = new Date(ev.minuteStartUtc)
                          const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
                          const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
                          const label = ev.type === 'load' ? t.manualEntry.load : ev.type === 'unload' ? t.manualEntry.unload : t.manualEntry.loadUnload
                          return (
                            <div key={i} className="work-week-graph-manual-item">
                              {dateStr} {timeStr} | <em>{label}</em>{ev.gpsLocation ? ` (${ev.gpsLocation})` : ''}
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                  {ferryTrainEvents.some((ev) => ev.minuteStartUtc >= visibleFirstDate && ev.minuteStartUtc < visibleLastEnd) && (
                    <>
                      <strong>{t.workWeek.ferryTrainSection}</strong>
                      <div className="work-week-graph-manual-list">
                        {ferryTrainEvents.filter((ev) => ev.minuteStartUtc >= visibleFirstDate && ev.minuteStartUtc < visibleLastEnd).map((ev, i) => {
                          const d = new Date(ev.minuteStartUtc)
                          const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
                          const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
                          const label = ev.type === 'activation' ? t.workWeek.activation : t.workWeek.deactivation
                          return (
                            <div key={i} className="work-week-graph-manual-item">
                              {dateStr} {timeStr} | <em>{label}</em>{ev.gpsLocation ? ` (${ev.gpsLocation})` : ''}
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                  {visibleOutMode.length > 0 && (
                    <>
                      <strong>{t.workWeek.outModeSection}</strong>
                      <div className="work-week-graph-manual-list">
                        {visibleOutMode.map((ev, i) => {
                          const d = new Date(ev.minuteStartUtc)
                          const timeStr = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
                          const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`
                          const label = ev.type === 'activation' ? t.workWeek.activation : t.workWeek.deactivation
                          return (
                            <div key={i} className="work-week-graph-manual-item">
                              {dateStr} {timeStr} | <em>{label}</em>{ev.gpsLocation ? ` (${ev.gpsLocation})` : ''}
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                  {!(manualEntryBuffer ?? []).some((seg) => {
                    const ms = manualSegmentMs(seg, clockMode)
                    return ms >= visibleFirstDate && ms < visibleLastEnd
                  }) &&
                    !(lastWithdrawalUtc != null && lastWithdrawalUtc >= visibleFirstDate && lastWithdrawalUtc < visibleLastEnd) &&
                    visibleLoadUnload.length === 0 &&
                    !ferryTrainEvents.some((ev) => ev.minuteStartUtc >= visibleFirstDate && ev.minuteStartUtc < visibleLastEnd) &&
                    visibleOutMode.length === 0 && (
                    <span className="work-week-graph-table-empty">—</span>
                  )}
                </td>
                <td className="work-week-graph-table-cell">
                  {(() => {
                    const tachoActivities = visibleDays
                      .flatMap((d) => d.activities.filter((a) => !a.isManualEntry))
                      .sort((a, b) => a.startMs - b.startMs)
                    if (tachoActivities.length === 0) {
                      return <span className="work-week-graph-table-empty">—</span>
                    }
                    return (
                      <div className="work-week-graph-manual-list">
                        {tachoActivities.map((act, index) => {
                          const label = (t.workWeek.activityTypes as Record<string, string>)[act.type] ?? ACTIVITY_TYPE_LABELS[act.type] ?? act.type
                          return (
                            <div key={`${act.startMs}-${act.endMs}-${index}`} className="work-week-graph-manual-item">
                              {formatTimeRange(act.startMs, act.endMs, clockMode)} | {label} ({formatDuration(act.durationMinutes)}){formatRegistration(act)}{formatSlot(act)}
                              {act.isCrew && !act.isManualEntry && (
                                <span className="crew-mode-dot" title="režim osádky" aria-label="režim osádky" />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function formatFaultTime(ms: number, mode: ClockMode): string {
  return formatClockDateTime(ms, mode)
}

export function WorkWeekGraphView({ days, countryMarkers, manualEntryBuffer, lastWithdrawalUtc, card2Data, loadUnloadEvents = [], ferryTrainEvents = [], outModeEvents = [], recordedGpsLocations = [], faultsAndEvents = [], symbolMap, onResetLoadUnload, embedded = false, onClose, clockMode = 'local', onClockModeChange, card }: WorkWeekGraphViewProps) {
  const { t } = useLanguage()
  const dayNames = t.workWeek.dayNames
  const getInitialWeekStart = () => {
    if (days.length > 0) return weekStartMs(days[days.length - 1]!.dateUtc, clockMode)
    return weekStartMs(Date.now(), clockMode)
  }
  const [displayWeekStartMs, setDisplayWeekStartMs] = useState(getInitialWeekStart)

  useEffect(() => {
    setDisplayWeekStartMs(getInitialWeekStart())
  }, [days, clockMode])

  const goPrevWeek = () => setDisplayWeekStartMs((ms) => addDays(ms, -7, clockMode))
  const goNextWeek = () => setDisplayWeekStartMs((ms) => addDays(ms, 7, clockMode))
  const goToday = () => setDisplayWeekStartMs(weekStartMs(Date.now(), clockMode))

  const overlayClass = embedded ? 'work-week-graph-overlay is-embedded' : 'work-week-graph-overlay'

  if (days.length === 0) {
    return (
      <div className={overlayClass} onClick={embedded ? undefined : onClose}>
        <div className="work-week-graph-window" onClick={(e) => e.stopPropagation()}>
          {!embedded && <button type="button" className="work-week-graph-close" onClick={onClose}>×</button>}
          {loadUnloadEvents.length > 0 && onResetLoadUnload && (
            <button type="button" className="work-week-graph-reset" onClick={onResetLoadUnload} title={t.workWeek.resetLoadUnloadTitle}>
              {t.workWeek.resetLoadUnload}
            </button>
          )}
          <div className="work-week-graph-empty">{t.workWeek.noData}</div>
        </div>
      </div>
    )
  }

  return (
    <div className={overlayClass} onClick={embedded ? undefined : onClose}>
      <div className="work-week-graph-window" onClick={(e) => e.stopPropagation()}>
        {!embedded && (
          <button type="button" className="work-week-graph-close" onClick={onClose} aria-label={t.workWeek.close}>×</button>
        )}
        {loadUnloadEvents.length > 0 && onResetLoadUnload && (
          <button type="button" className="work-week-graph-reset" onClick={onResetLoadUnload} title={t.workWeek.resetLoadUnloadTitle}>
            {t.workWeek.resetLoadUnload}
          </button>
        )}
        <div className="work-week-graph-header">
          <h2 className="work-week-graph-title">{t.workWeek.weekGraphTitle}</h2>
          <div className="work-week-graph-nav">
            <button
              type="button"
              className="work-week-graph-nav-btn"
              onClick={goPrevWeek}
              title={t.workWeek.prevWeek}
            >
              ‹
            </button>
            <span className="work-week-graph-nav-calendar">
              {formatWeekRange(displayWeekStartMs, clockMode)}
            </span>
            <button
              type="button"
              className="work-week-graph-nav-btn"
              onClick={goNextWeek}
              title={t.workWeek.nextWeek}
            >
              ›
            </button>
            <button
              type="button"
              className="work-week-graph-nav-btn work-week-graph-nav-today"
              onClick={goToday}
              title="Přejít na aktuální týden"
            >
              Dnes
            </button>
            <TimeScaleSelect
              value={clockMode}
              onChange={onClockModeChange ?? (() => undefined)}
            />
          </div>
          <div className="work-week-graph-legend">
            {(Object.entries(ACTIVITY_STYLE) as [ActivityType, { color: string; strokeWidth: number }][]).map(
              ([type, { color, strokeWidth }]) => {
                const legendStroke =
                  type === 'odpočinek>45h' ? '#2563eb' : type === 'odpočinek>24h' ? '#60a5fa' : color
                const legendLabel =
                  type === 'odpočinek>45h'
                    ? t.workWeek.legendRest45h
                    : type === 'odpočinek>24h'
                      ? t.workWeek.legendRest24h
                      : null
                return (
                  <span key={type} className="work-week-graph-legend-item">
                    <svg width={38} height={18} className="work-week-graph-legend-sample" viewBox="0 0 22 11" preserveAspectRatio="xMidYMid meet">
                      <line
                        x1={0}
                        y1={5.5}
                        x2={22}
                        y2={5.5}
                        stroke={legendStroke}
                        strokeWidth={Math.min(strokeWidth, 11)}
                        strokeLinecap="butt"
                      />
                    </svg>
                    <span className="work-week-graph-legend-label">
                      <span className={`tacho-icon${type === 'neznámá' ? ' tacho-icon-smaller' : ''}`}>{ACTIVITY_SYMBOL[type]}</span>
                      {legendLabel && <span> {legendLabel}</span>}
                    </span>
                  </span>
                )
              }
            )}
            <span className="work-week-graph-legend-item">
              <svg width={38} height={18} className="work-week-graph-legend-sample" viewBox="0 0 22 11" preserveAspectRatio="xMidYMid meet">
                <line x1={0} y1={5.5} x2={22} y2={5.5} stroke="#8b5cf6" strokeWidth={8} strokeLinecap="butt" />
              </svg>
              <span className="work-week-graph-legend-label">{t.workWeek.manualEntryLabel}</span>
            </span>
            <span className="work-week-graph-legend-item">
              <svg width={38} height={18} className="work-week-graph-legend-sample" viewBox="0 0 22 11" preserveAspectRatio="xMidYMid meet">
                <line x1={0} y1={5.5} x2={22} y2={5.5} stroke="#25D366" strokeWidth={8} strokeLinecap="butt" />
              </svg>
              <span className="work-week-graph-legend-label">režim osádky</span>
            </span>
          </div>
        </div>

        <GraphBlock
          days={days}
          countryMarkers={countryMarkers}
          manualEntryBuffer={manualEntryBuffer}
          lastWithdrawalUtc={lastWithdrawalUtc}
          loadUnloadEvents={loadUnloadEvents}
          ferryTrainEvents={ferryTrainEvents}
          outModeEvents={outModeEvents ?? []}
          symbolMap={symbolMap}
          displayWeekStartMs={displayWeekStartMs}
          blockId="card1"
          title={card2Data != null ? t.workWeek.card1 : undefined}
          dayNames={dayNames}
          t={t}
          clockMode={clockMode}
          card={card}
        />

        {(() => {
          const visibleFirstDate = displayWeekStartMs
          const visibleLastEnd = addDays(displayWeekStartMs, 7, clockMode)
          const merged = (recordedGpsLocations ?? [])
            .filter((r) => r.minuteStartUtc >= visibleFirstDate && r.minuteStartUtc < visibleLastEnd)
            .sort((a, b) => a.minuteStartUtc - b.minuteStartUtc)
          return merged.length > 0 ? (
            <div className="work-week-graph-table-wrapper">
              <table className="work-week-graph-table">
                <thead>
                  <tr>
                    <th colSpan={2}>{t.workWeek.recordedLocationsTitle}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={2} className="work-week-graph-table-cell">
                      <div className="work-week-graph-manual-list">
                        {merged.map((r, i) => (
                          <div key={i} className="work-week-graph-manual-item">
                            {formatTimestamp(r.minuteStartUtc, clockMode)} | {r.gpsLocation} | {r.recordType ? (t.workWeek.recordedLocationTypes[r.recordType] ?? r.recordType) : '—'}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null
        })()}

        {card2Data != null && (
          <GraphBlock
            days={card2Data.days}
            countryMarkers={card2Data.countryMarkers}
            manualEntryBuffer={card2Data.manualEntryBuffer}
            lastWithdrawalUtc={card2Data.lastWithdrawalUtc}
            loadUnloadEvents={[]}
            ferryTrainEvents={[]}
            outModeEvents={[]}
            symbolMap={symbolMap}
            displayWeekStartMs={displayWeekStartMs}
            blockId="card2"
            title={t.workWeek.card2}
            dayNames={dayNames}
            t={t}
            clockMode={clockMode}
          />
        )}

        {faultsAndEvents.length > 0 && (
          <div className="work-week-graph-table-wrapper work-week-graph-warnings-wrapper">
            <div className="work-week-warnings-panel">
              <h3 className="work-week-warnings-title">{t.workWeek.warningsPanelTitle}</h3>
              <ul className="work-week-warnings-list">
              {faultsAndEvents.map((f) => (
                <li key={f.id} className="work-week-warnings-item">
                  <span className="work-week-warnings-time">{formatFaultTime(f.timestampUtc, clockMode)}</span>
                  <span className="work-week-warnings-label">
                    {(f.type === 'DRIVING_WITHOUT_CARD_WARNING' ? t.workWeek.faultDrivingWithoutCard : f.type === 'DRIVING_WITHOUT_VALID_CARD_WARNING' ? t.workWeek.faultDrivingWithoutValidCard : f.type === 'EXCESS_SPEED_WARNING' ? t.workWeek.faultExcessSpeed : null) ?? f.type}
                  </span>
                </li>
              ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
