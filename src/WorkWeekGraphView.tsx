/**
 * Graf pracovního týdne – SVG zobrazení načtených dat z TXT.
 * Každý den = řádek, hodiny 0–24, aktivity jako barevné segmenty.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { useLanguage } from './translations'
import type { DayData, ParsedActivity, ActivityType, CountryMarker } from './workWeekTxtParser'
import {
  TACHO_SYMBOLS,
  type FerryTrainEvent,
  type FaultOrEvent,
  type ManualEntrySegment,
  type OutModeEvent,
  type RecordedGpsLocation,
  type SymbolMap,
  type VehicleLoadUnloadEvent,
} from './TachoTypes'
import { DRIVING_SYMBOL } from './CardLogic'
import type { ClockMode } from './lib/clock'
import {
  addDays,
  clockParts,
  dayStartMs,
  formatClockDate,
  formatClockDateTime,
  formatWeekRange,
  parseClockDateTime,
  weekStartMs,
} from './lib/clock'
import {
  CHART_WIDTH,
  DAYS_PER_WEEK,
  DAY_DETAIL_CHART_WIDTH,
  DAY_DETAIL_LABEL_SCALE,
  DAY_DETAIL_MARGIN_BOTTOM,
  DAY_DETAIL_MARGIN_TOP,
  DAY_DETAIL_ROW_HEIGHT,
  DAY_DETAIL_STROKE_SCALE,
  DEFAULT_ZOOM,
  HOUR_TICK_LEN,
  DAY_DETAIL_LABEL_WIDTH,
  LABEL_WIDTH,
  SVG_RIGHT_GUTTER,
  MARGIN_BOTTOM,
  MARGIN_TOP,
  QUARTER_TICK_LEN,
  ROW_HEIGHT,
  TICK_LEN,
  chartX,
  clipChartX,
  dayWindowZoom,
  majorTicks,
  minuteToSvgX,
  minorTicks,
  formatMinuteTick,
  type ZoomDomain,
} from './lib/graphGeometry'
import { TimeScaleSelect } from './components/TimeScaleSelect'
import { CardInfoTable } from './components/CardInfoTable'
import { CardHistoryTables } from './components/CardHistoryTables'
import { bestDailyDistance, type DailyDistanceRecord } from './utils/weekDistance'
import { GraphStage } from './components/GraphStage'
import { DayGraphPan } from './components/DayGraphPan'
import { GraphSwipeNav } from './components/GraphSwipeNav'
import { CardCalendar } from './components/CardCalendar'
import { googleMapsUrl } from './lib/mapsLink'
import type { DriverCardData } from './types/tacho'

function markerTimeMs(
  marker: { timeStr: string; dateStr: string; recordedAtUtc?: number },
  mode: ClockMode,
): number {
  if (marker.recordedAtUtc != null) return marker.recordedAtUtc
  return parseClockDateTime(marker.timeStr, marker.dateStr, mode)
}

function manualSegmentMs(
  segment: { day: number; month: number; year: number; hour: number; minute: number; recordedAtUtc?: number },
  mode: ClockMode,
): number {
  if (segment.recordedAtUtc != null) return segment.recordedAtUtc
  const pad = (n: number) => String(n).padStart(2, '0')
  return parseClockDateTime(`${pad(segment.hour)}:${pad(segment.minute)}`, `${pad(segment.day)}.${pad(segment.month)}.${segment.year}`, mode)
}

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
const LABEL_COLOR = '#334155'
const GRAPH_AXIS_COLOR = '#334155'
/** Popisky kalendářního dne v levém sloupci grafu (SVG user units, nemění se s výškou řádku). */
const GRAPH_DAY_NAME_FONT_SIZE = 10
const GRAPH_DAY_DATE_FONT_SIZE = 9
const GRAPH_DAY_LABEL_FONT_WEIGHT = 500
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
  DRIVING: 'řízení',
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
  initialFocusedDayUtc?: number | null
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
  dayUtc: number,
  clockMode: ClockMode,
): Array<{ startMs: number; endMs: number }> {
  const dayEnd = addDays(dayUtc, 1, clockMode)
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
  const dayEndMs = addDays(dayUtcMs, 1, clockMode)
  return markers.filter((m) => {
    const ms = markerTimeMs(m, clockMode)
    return ms >= dayUtcMs && ms < dayEndMs
  })
}

function getLoadUnloadOnDay(events: VehicleLoadUnloadEvent[], dayUtcMs: number, clockMode: ClockMode): VehicleLoadUnloadEvent[] {
  const dayEndMs = addDays(dayUtcMs, 1, clockMode)
  return events.filter((e) => e.minuteStartUtc >= dayUtcMs && e.minuteStartUtc < dayEndMs)
}

const FERRY_TRAIN_SYMBOL_ID = 49

function getFerryTrainOnDay(events: FerryTrainEvent[], dayUtcMs: number, clockMode: ClockMode): FerryTrainEvent[] {
  const dayEndMs = addDays(dayUtcMs, 1, clockMode)
  return events.filter((e) => e.minuteStartUtc >= dayUtcMs && e.minuteStartUtc < dayEndMs)
}

function getOutModeOnDay(events: OutModeEvent[], dayUtcMs: number, clockMode: ClockMode): OutModeEvent[] {
  const dayEndMs = addDays(dayUtcMs, 1, clockMode)
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

function tachoSymbol(symbolMap: SymbolMap | null | undefined, id: number): string {
  return symbolMap?.[id] || TACHO_SYMBOLS[id] || ''
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

function WorkWeekGraphLegend({
  t,
  distanceRecord,
  clockMode,
}: {
  t: { workWeek: { legendRest45h: string; legendRest24h: string; manualEntryLabel: string } }
  distanceRecord: DailyDistanceRecord | null
  clockMode: ClockMode
}) {
  return (
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
        },
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
      <span className="work-week-graph-legend-item">
        <span className="work-week-graph-legend-trophy" aria-hidden="true">🏆</span>
        <span className="work-week-graph-legend-label">
          Nejvíce km/den:{' '}
          {distanceRecord
            ? `${formatClockDate(distanceRecord.dayStartMs, clockMode)} · ${new Intl.NumberFormat('cs-CZ').format(distanceRecord.kilometers)} km`
            : '—'}
        </span>
      </span>
    </div>
  )
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
  detailActive: boolean
  chartWidth?: number
  rowHeight?: number
  singleDayUtc?: number
  zoomDomain?: ZoomDomain
  onDayOpen?: (dateUtc: number) => void
  showFooter?: boolean
  /** Týdenní graf na úzkém displeji — 2× výška řádku, čar i popisků. */
  narrowViewport?: boolean
}

const NARROW_VIEWPORT_QUERY = '(max-width: 720px)'
const MOBILE_WEEK_SCALE = 2

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(NARROW_VIEWPORT_QUERY).matches : false,
  )
  useEffect(() => {
    const media = window.matchMedia(NARROW_VIEWPORT_QUERY)
    const onChange = () => setNarrow(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function GraphBlock({
  days,
  countryMarkers,
  manualEntryBuffer,
  lastWithdrawalUtc,
  loadUnloadEvents = [],
  ferryTrainEvents = [],
  outModeEvents = [],
  symbolMap,
  displayWeekStartMs,
  blockId,
  title,
  dayNames,
  t,
  clockMode,
  card,
  detailActive,
  chartWidth: chartWidthProp,
  rowHeight: rowHeightProp,
  singleDayUtc,
  zoomDomain: zoomDomainProp,
  onDayOpen,
  showFooter = true,
  narrowViewport = false,
}: GraphBlockProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const rowPressRef = useRef<{ x: number; y: number } | null>(null)
  const isDayDetail = singleDayUtc != null
  const mobileWeek = narrowViewport && !isDayDetail
  const strokeScale = isDayDetail ? DAY_DETAIL_STROKE_SCALE : mobileWeek ? MOBILE_WEEK_SCALE : 1
  const labelScale = isDayDetail ? DAY_DETAIL_LABEL_SCALE : mobileWeek ? MOBILE_WEEK_SCALE : 1
  const sx = (n: number) => n * strokeScale
  const lx = (n: number) => n * labelScale
  const marginTop = isDayDetail ? DAY_DETAIL_MARGIN_TOP : MARGIN_TOP
  const marginBottom = isDayDetail ? DAY_DETAIL_MARGIN_BOTTOM : MARGIN_BOTTOM
  const tickLen = lx(TICK_LEN)
  const hourTickLen = lx(HOUR_TICK_LEN)
  const quarterTickLen = lx(QUARTER_TICK_LEN)
  const axisFontSize = lx(11)
  const chartW = chartWidthProp ?? CHART_WIDTH
  const labelW = isDayDetail ? DAY_DETAIL_LABEL_WIDTH : LABEL_WIDTH
  const rowH = rowHeightProp ?? (mobileWeek ? ROW_HEIGHT * MOBILE_WEEK_SCALE : ROW_HEIGHT)
  const zoomDomain = zoomDomainProp ?? DEFAULT_ZOOM
  const dayMap = new Map<number, DayData>()
  for (const day of days) {
    dayMap.set(day.dateUtc, day)
  }

  const visibleDays: DayData[] = []
  if (singleDayUtc != null) {
    visibleDays.push(dayMap.get(singleDayUtc) ?? createEmptyDay(singleDayUtc, dayNames, clockMode))
  } else {
    for (let i = 0; i < DAYS_PER_WEEK; i++) {
      const dayStart = addDays(displayWeekStartMs, i, clockMode)
      visibleDays.push(dayMap.get(dayStart) ?? createEmptyDay(dayStart, dayNames, clockMode))
    }
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

  const height = marginTop + visibleDays.length * rowH + marginBottom
  const width = labelW + chartW + SVG_RIGHT_GUTTER
  const axisMajors = majorTicks(zoomDomain)
  const axisMinors = minorTicks(zoomDomain)
  const xAt = (dayStart: number, ms: number) => chartX(dayStart, ms, clockMode, zoomDomain, chartW, labelW)
  const xMinute = (minute: number) => minuteToSvgX(minute, zoomDomain, chartW, labelW)
  const chartRight = labelW + chartW

  return (
    <div className="work-week-graph-block">
      {title != null && <h3 className="work-week-graph-block-title">{title}</h3>}
      <GraphStage
        svgRef={svgRef}
        detailActive={detailActive}
        visibleDays={visibleDays}
        clockMode={clockMode}
        chartWidth={chartW}
        labelWidth={labelW}
        rowHeight={rowH}
        marginTop={marginTop}
        zoomDomain={zoomDomain}
      >
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="work-week-graph-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id={`crew-mode-hatch-${blockId}`} patternUnits="userSpaceOnUse" width={lx(6)} height={lx(6)}>
            <line x1="0" y1="0" x2={lx(6)} y2={lx(6)} stroke="rgba(100, 149, 237, 0.18)" strokeWidth={lx(1)} />
          </pattern>
          <pattern id={`out-driving-hatch-${blockId}`} patternUnits="userSpaceOnUse" width={lx(4)} height={lx(4)}>
            <line x1="0" y1="0" x2={lx(4)} y2={lx(4)} stroke="#c62828" strokeWidth={lx(2.2)} />
          </pattern>
          <clipPath id={`chart-clip-${blockId}`}>
            <rect x={labelW} y={marginTop} width={chartW} height={visibleDays.length * rowH} />
          </clipPath>
        </defs>
        <g id={`day-separators-${blockId}`}>
          {visibleDays.slice(0, -1).map((_, i) => {
            const y = marginTop + (i + 1) * rowH
            return (
              <line key={i} x1={0} y1={y} x2={width} y2={y} stroke="#e0e0e0" strokeWidth={lx(0.5)} opacity={0.7} />
            )
          })}
        </g>
        <g id={`quarter-ticks-top-${blockId}`}>
          {axisMinors.map((minute) => {
            const x = xMinute(minute)
            return (
              <line key={`top-q-${minute}`} x1={x} y1={marginTop - quarterTickLen} x2={x} y2={marginTop} stroke="#bbb" strokeWidth={lx(0.5)} opacity={0.7} />
            )
          })}
        </g>
        <g id={`hour-ticks-top-${blockId}`}>
          {axisMajors.map((minute) => {
            const x = xMinute(minute)
            return (
              <g key={`top-${minute}`}>
                <line x1={x} y1={marginTop - hourTickLen} x2={x} y2={marginTop} stroke="#333" strokeWidth={lx(1)} />
                {!mobileWeek && (
                  <text x={x} y={axisFontSize} textAnchor="middle" fill={GRAPH_AXIS_COLOR} fontSize={axisFontSize} fontFamily="sans-serif" fontWeight={600}>{formatMinuteTick(minute)}</text>
                )}
              </g>
            )
          })}
        </g>
        {visibleDays.map((day, rowIndex) => {
          const yBase = marginTop + rowIndex * rowH
          const dayStart = day.dateUtc
          return (
            <g key={day.dateUtc} className="graph-day-row">
              {axisMajors.map((minute) => {
                const x = xMinute(minute)
                const rowTop = yBase + lx(3)
                return (
                  <g key={`tick-${minute}`}>
                    <line x1={x} y1={rowTop} x2={x} y2={rowTop + tickLen} stroke={TICK_COLOR} strokeWidth={lx(0.5)} opacity={0.4} />
                    <line x1={x} y1={yBase + rowH - lx(3) - tickLen} x2={x} y2={yBase + rowH - lx(3)} stroke={TICK_COLOR} strokeWidth={lx(0.5)} opacity={0.4} />
                  </g>
                )
              })}
              {!isDayDetail && (
                <>
              <text
                x={6}
                y={yBase + rowH / 2 - lx(1)}
                className="work-week-graph-day-name"
                fill={GRAPH_AXIS_COLOR}
                fontSize={lx(GRAPH_DAY_NAME_FONT_SIZE)}
                fontFamily="sans-serif"
                fontWeight={GRAPH_DAY_LABEL_FONT_WEIGHT}
              >
                {dayNames[new Date(day.dateUtc).getDay()]}
              </text>
              <text
                x={6}
                y={yBase + rowH / 2 + lx(9)}
                className="work-week-graph-day-date"
                fill={LABEL_COLOR}
                fontSize={lx(GRAPH_DAY_DATE_FONT_SIZE)}
                fontFamily="sans-serif"
                fontWeight={GRAPH_DAY_LABEL_FONT_WEIGHT}
              >
                {day.dateStr}
              </text>
                </>
              )}
              <g clipPath={`url(#chart-clip-${blockId})`}>
              {getWorkShiftRangesForDay(workShiftRanges, day.dateUtc, clockMode).map((range, ri) => {
                const span = clipChartX(xAt(dayStart, range.startMs), xAt(dayStart, range.endMs), chartW, labelW)
                if (!span) return null
                const rowTop = yBase + 2
                const rowBarH = rowH - 4
                return (
                  <rect
                    key={`crew-${ri}`}
                    x={span.x1}
                    y={rowTop}
                    width={Math.max(1, span.x2 - span.x1)}
                    height={rowBarH}
                    fill={`url(#crew-mode-hatch-${blockId})`}
                    className="work-week-graph-crew-mode-bg"
                  />
                )
              })}
              {(() => {
                const maxStrokeHalf = sx(8)
                const rowCenter = yBase + rowH / 2
                const sortedActivities = [...day.activities].sort((a, b) => a.startMs - b.startMs)
                const MANUAL_UNDERLINE_WIDTH = sx(3)
                const CREW_UNDERLINE = '#25D366'
                const CREW_UNDERLINE_WIDTH = sx(3)
                return sortedActivities.map((act, i) => {
                  const style = ACTIVITY_STYLE[act.type]
                  const baseColor = getActivityColor(act)
                  const dur = act.originalDurationMinutes ?? act.durationMinutes
                  const strokeW = sx(
                    (act.type === 'odpočinek' && dur >= LONG_REST_MIN) || act.type === 'odpočinek>24h' || act.type === 'odpočinek>45h'
                      ? 16
                      : (style?.strokeWidth ?? 5),
                  )
                  const span = clipChartX(xAt(dayStart, act.startMs), xAt(dayStart, act.endMs), chartW, labelW)
                  if (!span) return null
                  const { x1, x2 } = span
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
                const x = xAt(dayStart, ms)
                if (x < labelW || x > chartRight) return null
                const code = marker.countryCode ?? 'CZ'
                const isStart = marker.activityId === 'START_COUNTRY'
                const label = isStart ? `${code} ►` : `◄ ${code}`
                const dx = isStart ? lx(7) : -lx(7)
                const textAnchor = isStart ? 'start' : 'end'
                const anchorBottom = yBase + rowH / 2 + lx(7)
                return (
                  <g key={`anchor-${dayStart}-${i}`}>
                    <text x={x} y={yBase + lx(8)} dx={dx} textAnchor={textAnchor} fill={ANCHOR_STROKE} fontSize={lx(8)} fontFamily="sans-serif" fontWeight={600}>{label}</text>
                    <line x1={x} y1={yBase + lx(3)} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={lx(1.5)} strokeLinecap="round" />
                    <circle cx={x} cy={yBase + lx(3)} r={lx(2.5)} fill={ANCHOR_COLOR} />
                  </g>
                )
              })}
              {getLoadUnloadOnDay(visibleLoadUnload, day.dateUtc, clockMode).map((ev, i) => {
                const x = xAt(dayStart, ev.minuteStartUtc)
                if (x < labelW || x > chartRight) return null
                const symbolId = LOAD_UNLOAD_SYMBOL_ID[ev.type]
                const symbolChar = tachoSymbol(symbolMap, symbolId)
                const anchorBottom = yBase + rowH / 2 + lx(7)
                return (
                  <g key={`loadunload-${dayStart}-${ev.minuteStartUtc}-${i}`}>
                    <text x={x} y={yBase + lx(10)} textAnchor="middle" fill={ANCHOR_STROKE} fontSize={lx(12)} fontFamily="SymbolTacho1">{symbolChar}</text>
                    <line x1={x} y1={yBase + lx(14)} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={lx(1.5)} strokeLinecap="round" />
                  </g>
                )
              })}
              {getFerryTrainOnDay(visibleFerryTrain, day.dateUtc, clockMode).map((ev, i) => {
                const x = xAt(dayStart, ev.minuteStartUtc)
                if (x < labelW || x > chartRight) return null
                const symbolChar = tachoSymbol(symbolMap, FERRY_TRAIN_SYMBOL_ID)
                const anchorBottom = yBase + rowH / 2 + lx(7)
                return (
                  <g key={`ferrytrain-${dayStart}-${ev.minuteStartUtc}-${i}`}>
                    <text x={x} y={yBase + lx(10)} textAnchor="middle" fill={ANCHOR_STROKE} fontSize={lx(12)} fontFamily="SymbolTacho1">{symbolChar}</text>
                    <line x1={x} y1={yBase + lx(14)} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={lx(1.5)} strokeLinecap="round" />
                  </g>
                )
              })}
              {getOutModeOnDay(visibleOutMode, day.dateUtc, clockMode).map((ev, i) => {
                const x = xAt(dayStart, ev.minuteStartUtc)
                if (x < labelW || x > chartRight) return null
                const label = ev.type === 'activation' ? 'OUT►' : '◄OUT'
                const dx = ev.type === 'activation' ? lx(3) : -lx(3)
                const textAnchor = ev.type === 'activation' ? 'start' : 'end'
                const rowCenter = yBase + rowH / 2
                const anchorTop = rowCenter + lx(4)
                const anchorBottom = yBase + rowH - lx(4)
                const textY = ev.type === 'activation' ? anchorBottom + lx(4) : anchorBottom - lx(2)
                return (
                  <g key={`outmode-${dayStart}-${ev.minuteStartUtc}-${ev.type}-${i}`}>
                    <line x1={x} y1={anchorTop} x2={x} y2={anchorBottom} stroke={ANCHOR_STROKE} strokeWidth={lx(1)} strokeLinecap="round" />
                    <circle cx={x} cy={anchorBottom} r={lx(1.5)} fill={ANCHOR_COLOR} />
                    <text x={x} y={textY} dx={dx} textAnchor={textAnchor} fill={ANCHOR_STROKE} fontSize={lx(7)} fontFamily="sans-serif" fontWeight={600}>{label}</text>
                  </g>
                )
              })}
              </g>
              {onDayOpen && (
                <rect
                  x={0}
                  y={yBase}
                  width={width}
                  height={rowH}
                  fill="transparent"
                  className="graph-day-row-hit"
                  role="button"
                  tabIndex={0}
                  aria-label={`Otevřít den ${day.dateStr}`}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    rowPressRef.current = { x: event.clientX, y: event.clientY }
                  }}
                  onClick={(event) => {
                    const press = rowPressRef.current
                    rowPressRef.current = null
                    if (
                      press != null &&
                      Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12
                    ) {
                      return
                    }
                    onDayOpen(day.dateUtc)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onDayOpen(day.dateUtc)
                    }
                  }}
                />
              )}
            </g>
          )
        })}
        <g id={`quarter-ticks-bottom-${blockId}`} transform={`translate(0, ${height - marginBottom})`}>
          {axisMinors.map((minute) => {
            const x = xMinute(minute)
            return <line key={`bot-q-${minute}`} x1={x} y1={0} x2={x} y2={quarterTickLen} stroke="#bbb" strokeWidth={lx(0.5)} opacity={0.7} />
          })}
        </g>
        <g id={`hour-ticks-bottom-${blockId}`} transform={`translate(0, ${height - marginBottom})`}>
          {axisMajors.map((minute) => {
            const x = xMinute(minute)
            return (
              <g key={`bot-${minute}`}>
                <line x1={x} y1={0} x2={x} y2={tickLen} stroke="#333" strokeWidth={lx(1)} />
                {!mobileWeek && (
                  <text x={x} y={lx(12)} textAnchor="middle" fill={GRAPH_AXIS_COLOR} fontSize={axisFontSize} fontFamily="sans-serif" fontWeight={600}>{formatMinuteTick(minute)}</text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
      </GraphStage>
      {showFooter && card && <CardInfoTable card={card} clockMode={clockMode} />}
      {showFooter &&
      (visibleDays.some((d) => d.activities.some((a) => !a.isManualEntry)) ||
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
                          const label = ev.type === 'load' ? t.manualEntry.load : ev.type === 'unload' ? t.manualEntry.unload : t.manualEntry.loadUnload
                          const symbol = tachoSymbol(symbolMap, LOAD_UNLOAD_SYMBOL_ID[ev.type])
                          return (
                            <div key={i} className="work-week-graph-manual-item">
                              {formatTimestamp(ev.minuteStartUtc, clockMode)} |{' '}
                              {symbol ? <span className="tacho-icon">{symbol}</span> : null} <em>{label}</em>
                              {ev.gpsLocation ? ` (${ev.gpsLocation})` : ''}
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
                          const label = ev.type === 'activation' ? 'trajekt' : 'konec trajektu'
                          const symbol = tachoSymbol(symbolMap, FERRY_TRAIN_SYMBOL_ID)
                          return (
                            <div key={i} className="work-week-graph-manual-item">
                              {formatTimestamp(ev.minuteStartUtc, clockMode)} |{' '}
                              {symbol ? <span className="tacho-icon">{symbol}</span> : null} <em>{label}</em>
                              {ev.gpsLocation ? ` (${ev.gpsLocation})` : ''}
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
                          const label = ev.type === 'activation' ? t.workWeek.activation : t.workWeek.deactivation
                          return (
                            <div key={i} className="work-week-graph-manual-item">
                              {formatTimestamp(ev.minuteStartUtc, clockMode)} | <em>{label}</em>{ev.gpsLocation ? ` (${ev.gpsLocation})` : ''}
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
      {showFooter && card && (
        <CardHistoryTables card={card} weekStartMs={displayWeekStartMs} clockMode={clockMode} />
      )}
    </div>
  )
}

function formatFaultTime(ms: number, mode: ClockMode): string {
  return formatClockDateTime(ms, mode)
}

export function WorkWeekGraphView({ days, countryMarkers, manualEntryBuffer, lastWithdrawalUtc, card2Data, loadUnloadEvents = [], ferryTrainEvents = [], outModeEvents = [], recordedGpsLocations = [], faultsAndEvents = [], symbolMap, onResetLoadUnload, embedded = false, onClose, clockMode = 'local', onClockModeChange, card, initialFocusedDayUtc = null }: WorkWeekGraphViewProps) {
  const { t } = useLanguage()
  const narrowViewport = useNarrowViewport()
  const dayNames = t.workWeek.dayNames
  const getInitialWeekStart = () => {
    if (days.length > 0) return weekStartMs(days[days.length - 1]!.dateUtc, clockMode)
    return weekStartMs(Date.now(), clockMode)
  }
  const [displayWeekStartMs, setDisplayWeekStartMs] = useState(() =>
    initialFocusedDayUtc != null ? weekStartMs(initialFocusedDayUtc, clockMode) : getInitialWeekStart(),
  )
  const [detailActive, setDetailActive] = useState(false)
  const [focusedDayUtc, setFocusedDayUtc] = useState<number | null>(initialFocusedDayUtc)
  const [dayPanStart, setDayPanStart] = useState(0)
  const [cardOverviewOpen, setCardOverviewOpen] = useState(false)
  const inspectActive = detailActive && !narrowViewport
  const distanceRecord = useMemo(
    () => bestDailyDistance(card?.vehicleUses ?? [], displayWeekStartMs, clockMode),
    [card, displayWeekStartMs, clockMode],
  )

  const focusedDayRef = useRef(focusedDayUtc)
  focusedDayRef.current = focusedDayUtc

  useEffect(() => {
    const current = focusedDayRef.current
    if (current != null) {
      const day = dayStartMs(current, clockMode)
      if (day !== current) setFocusedDayUtc(day)
      setDisplayWeekStartMs(weekStartMs(day, clockMode))
      return
    }
    setDisplayWeekStartMs(getInitialWeekStart())
  }, [days, clockMode])

  useEffect(() => {
    setDayPanStart(0)
  }, [focusedDayUtc])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (cardOverviewOpen) {
        setCardOverviewOpen(false)
        event.preventDefault()
        return
      }
      if (focusedDayUtc != null) {
        setFocusedDayUtc(null)
        event.preventDefault()
        return
      }
      setDetailActive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cardOverviewOpen, focusedDayUtc])

  const goPrevWeek = () => setDisplayWeekStartMs((ms) => addDays(ms, -7, clockMode))
  const goNextWeek = () => setDisplayWeekStartMs((ms) => addDays(ms, 7, clockMode))
  const goToday = () => setDisplayWeekStartMs(weekStartMs(Date.now(), clockMode))

  const dayBounds = useMemo(() => {
    if (days.length === 0) return null
    let first = days[0]!.dateUtc
    let last = days[0]!.dateUtc
    for (const day of days) {
      if (day.dateUtc < first) first = day.dateUtc
      if (day.dateUtc > last) last = day.dateUtc
    }
    return { first, last }
  }, [days])

  function focusDay(dateUtc: number) {
    setFocusedDayUtc(dateUtc)
    setDisplayWeekStartMs(weekStartMs(dateUtc, clockMode))
  }

  const dayZoom = dayWindowZoom(dayPanStart)

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
        <div className={focusedDayUtc != null ? 'work-week-graph-header is-day-focus' : 'work-week-graph-header'}>
          <h2 className="work-week-graph-title">
            {cardOverviewOpen
              ? 'Celý obsah karty'
              : focusedDayUtc != null
                ? `${dayNames[clockParts(focusedDayUtc, clockMode).weekday] ?? ''} ${formatClockDate(focusedDayUtc, clockMode)}`
                : t.workWeek.weekGraphTitle}
          </h2>
          <div className="work-week-graph-nav">
            {cardOverviewOpen ? (
              <button
                type="button"
                className="work-week-graph-nav-btn graph-nav-back"
                onClick={() => setCardOverviewOpen(false)}
              >
                ← Zpět na týden
              </button>
            ) : focusedDayUtc != null ? (
              <>
                <button
                  type="button"
                  className="work-week-graph-nav-btn graph-nav-back"
                  onClick={() => setFocusedDayUtc(null)}
                >
                  ← Zpět na týden
                </button>
                <button
                  type="button"
                  className="work-week-graph-nav-btn graph-nav-step"
                  disabled={dayBounds != null && focusedDayUtc <= dayBounds.first}
                  onClick={() => focusDay(addDays(focusedDayUtc, -1, clockMode))}
                  title="Předchozí den"
                >
                  ‹ Předchozí den
                </button>
                <GraphSwipeNav
                  className="graph-period-strip graph-period-strip--day"
                  onPrev={() => focusDay(addDays(focusedDayUtc, -1, clockMode))}
                  onNext={() => focusDay(addDays(focusedDayUtc, 1, clockMode))}
                  canPrev={dayBounds == null || focusedDayUtc > dayBounds.first}
                  canNext={dayBounds == null || focusedDayUtc < dayBounds.last}
                  label="Přejeďte do stran na jiný den"
                >
                  <span className="graph-period-edge" aria-hidden="true">‹</span>
                  <span className="work-week-graph-nav-calendar">
                    {`${dayNames[clockParts(focusedDayUtc, clockMode).weekday] ?? ''} ${formatClockDate(focusedDayUtc, clockMode)}`}
                  </span>
                  <span className="graph-period-edge" aria-hidden="true">›</span>
                </GraphSwipeNav>
                <button
                  type="button"
                  className="work-week-graph-nav-btn graph-nav-step"
                  disabled={dayBounds != null && focusedDayUtc >= dayBounds.last}
                  onClick={() => focusDay(addDays(focusedDayUtc, 1, clockMode))}
                  title="Následující den"
                >
                  Následující den ›
                </button>
                <p className="graph-period-caption">Přejeďte do stran na jiný den</p>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="work-week-graph-nav-btn graph-nav-step"
                  onClick={goPrevWeek}
                  title={t.workWeek.prevWeek}
                >
                  ‹
                </button>
                <GraphSwipeNav
                  className="graph-period-strip"
                  onPrev={goPrevWeek}
                  onNext={goNextWeek}
                  label="Přejeďte do stran na jiný týden"
                >
                  <span className="graph-period-edge" aria-hidden="true">‹</span>
                  <span className="work-week-graph-nav-calendar">
                    {formatWeekRange(displayWeekStartMs, clockMode)}
                  </span>
                  <span className="graph-period-edge" aria-hidden="true">›</span>
                </GraphSwipeNav>
                <button
                  type="button"
                  className="work-week-graph-nav-btn graph-nav-step"
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
                <button
                  type="button"
                  className="work-week-graph-nav-btn"
                  onClick={() => {
                    setFocusedDayUtc(null)
                    setCardOverviewOpen(true)
                  }}
                >
                  Celý obsah karty
                </button>
                <p className="graph-period-caption">Přejeďte do stran na jiný týden</p>
              </>
            )}
            {focusedDayUtc != null ? (
              <span className="graph-clock-mode-info" role="status">
                {clockMode === 'utc' ? 'Graf zobrazen v UTC' : 'Graf zobrazen v místním čase'}
              </span>
            ) : (
              <TimeScaleSelect
                value={clockMode}
                onChange={onClockModeChange ?? (() => undefined)}
              />
            )}
            {!narrowViewport && !cardOverviewOpen && (
            <div className="graph-toolbar" role="toolbar" aria-label="Nástroje grafu">
              <button
                type="button"
                className={detailActive ? 'work-week-graph-nav-btn is-tool-active' : 'work-week-graph-nav-btn'}
                aria-pressed={detailActive}
                onClick={() => setDetailActive((on) => !on)}
                title="Zobrazit druh aktivity a trvání nad segmentem"
              >
                Zobrazit detail
              </button>
            </div>
            )}
          </div>
          {focusedDayUtc == null && !cardOverviewOpen && (
            <WorkWeekGraphLegend t={t} distanceRecord={distanceRecord} clockMode={clockMode} />
          )}
        </div>

        {cardOverviewOpen ? (
          <CardCalendar
            days={days}
            clockMode={clockMode}
            dayNames={dayNames}
            currentWeekStartMs={displayWeekStartMs}
            onSelectWeek={(weekStart) => {
              setDisplayWeekStartMs(weekStart)
              setFocusedDayUtc(null)
              setCardOverviewOpen(false)
            }}
          />
        ) : focusedDayUtc != null ? (
          <section className="day-view-card">
            <WorkWeekGraphLegend t={t} distanceRecord={distanceRecord} clockMode={clockMode} />
            <DayGraphPan panStartMinute={dayPanStart} onPanStartChange={setDayPanStart}>
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
                blockId="day-focus"
                dayNames={dayNames}
                t={t}
                clockMode={clockMode}
                detailActive={inspectActive}
                singleDayUtc={focusedDayUtc}
                zoomDomain={dayZoom}
                chartWidth={DAY_DETAIL_CHART_WIDTH}
                rowHeight={DAY_DETAIL_ROW_HEIGHT}
                showFooter={false}
              />
            </DayGraphPan>
          </section>
        ) : (
          <GraphSwipeNav
            className="graph-week-swipe"
            onPrev={goPrevWeek}
            onNext={goNextWeek}
            label="Přejeďte do stran na jiný týden"
          >
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
          detailActive={inspectActive}
          narrowViewport={narrowViewport}
          onDayOpen={focusDay}
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
                        {merged.map((r, i) => {
                          const mapsUrl = googleMapsUrl({
                            latitude: r.latitude,
                            longitude: r.longitude,
                            countryCode: r.countryCode,
                            label: r.gpsLocation,
                          })
                          return (
                            <div key={i} className="work-week-graph-manual-item recorded-location-row">
                              {mapsUrl && (
                                <a
                                  className="recorded-location-map-link"
                                  href={mapsUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Otevřít v Google Maps"
                                  aria-label={`Otevřít lokaci ${r.gpsLocation} v Google Maps`}
                                >
                                  📍
                                </a>
                              )}
                              <span className="recorded-location-text">
                                {formatTimestamp(r.minuteStartUtc, clockMode)} | {r.gpsLocation} |{' '}
                                {r.recordType ? (t.workWeek.recordedLocationTypes[r.recordType] ?? r.recordType) : '—'}
                              </span>
                            </div>
                          )
                        })}
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
            detailActive={inspectActive}
            narrowViewport={narrowViewport}
            onDayOpen={focusDay}
          />
        )}
          </GraphSwipeNav>
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
 