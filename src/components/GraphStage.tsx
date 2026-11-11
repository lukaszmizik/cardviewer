import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import type { ClockMode } from '../lib/clock'
import { formatClockDateTime, formatClockTime, parseClockDateTime } from '../lib/clock'
import {
  CHART_WIDTH,
  DEFAULT_ZOOM,
  LABEL_WIDTH,
  MARGIN_TOP,
  clientToSvgPoint,
  isChartX,
  rowFromSvgY,
  svgXToMinute,
  type ZoomDomain,
} from '../lib/graphGeometry'
import {
  ACTIVITY_SYMBOL,
  ACTIVITY_TYPE_LABELS,
  findTopActivityAt,
  formatActivityDuration,
  getActivityDisplayColor,
} from '../lib/activityPresentation'
import { OUT_MODE_GRAPH_COLOR, findActiveOutRange, type OutModeGraphRange } from '../lib/outModeGraph'
import type { DayData, ParsedActivity } from '../workWeekTxtParser'

type GraphStageProps = {
  children: ReactNode
  svgRef: RefObject<SVGSVGElement | null>
  detailActive: boolean
  visibleDays: DayData[]
  clockMode: ClockMode
  chartWidth?: number
  labelWidth?: number
  rowHeight?: number
  marginTop?: number
  zoomDomain?: ZoomDomain
  outModeRanges?: readonly OutModeGraphRange[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function minuteToMs(day: DayData, minute: number, clockMode: ClockMode): number {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, minute))
  const h = Math.floor(clamped / 60)
  const m = Math.floor(clamped % 60)
  return parseClockDateTime(`${pad(h)}:${pad(m)}`, day.dateStr, clockMode)
}

function formatActivityClockRange(act: ParsedActivity, mode: ClockMode): string {
  const range = `${formatClockTime(act.startMs, mode)} - ${formatClockTime(act.endMs, mode)}`
  return mode === 'utc' ? `${range} UTC` : range
}

function fillInspectPanel(
  swatch: HTMLSpanElement,
  typeEl: HTMLSpanElement,
  durationEl: HTMLSpanElement,
  rangeEl: HTMLSpanElement,
  registrationEl: HTMLSpanElement,
  flagsEl: HTMLDivElement,
  crewFlag: HTMLSpanElement,
  manualFlag: HTMLSpanElement,
  act: ParsedActivity,
  clockMode: ClockMode,
) {
  typeEl.textContent = ACTIVITY_TYPE_LABELS[act.type] ?? act.type
  durationEl.textContent = formatActivityDuration(act.originalDurationMinutes ?? act.durationMinutes)
  rangeEl.textContent = formatActivityClockRange(act, clockMode)
  swatch.style.background = getActivityDisplayColor(act)
  swatch.textContent = ACTIVITY_SYMBOL[act.type] ?? ''
  swatch.className =
    act.type === 'neznámá' ? 'graph-inspect-swatch tacho-icon tacho-icon-smaller' : 'graph-inspect-swatch tacho-icon'

  const plate = act.registration?.replace(/\0/g, '').trim()
  if (plate) {
    registrationEl.hidden = false
    registrationEl.textContent = `vozidlo ${plate}`
  } else {
    registrationEl.hidden = true
    registrationEl.textContent = ''
  }

  const showCrew = act.isCrew === true && act.isManualEntry !== true
  const showManual = act.isManualEntry === true
  crewFlag.hidden = !showCrew
  manualFlag.hidden = !showManual
  flagsEl.hidden = !showCrew && !showManual
}

function fillOutOnlyPanel(
  swatch: HTMLSpanElement,
  typeEl: HTMLSpanElement,
  durationEl: HTMLSpanElement,
  rangeEl: HTMLSpanElement,
  registrationEl: HTMLSpanElement,
  flagsEl: HTMLDivElement,
  range: OutModeGraphRange,
) {
  typeEl.textContent = 'režim OUT'
  const minutes = Math.max(0, Math.round((range.endMs - range.startMs) / 60_000))
  durationEl.textContent = formatActivityDuration(minutes)
  rangeEl.textContent = ''
  swatch.style.background = OUT_MODE_GRAPH_COLOR
  swatch.textContent = ''
  swatch.className = 'graph-inspect-swatch'
  registrationEl.hidden = true
  registrationEl.textContent = ''
  flagsEl.hidden = true
}

export function GraphStage({
  children,
  svgRef,
  detailActive,
  visibleDays,
  clockMode,
  chartWidth = CHART_WIDTH,
  labelWidth = LABEL_WIDTH,
  rowHeight,
  marginTop = MARGIN_TOP,
  zoomDomain = DEFAULT_ZOOM,
  outModeRanges = [],
}: GraphStageProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const inspectRef = useRef<HTMLDivElement>(null)
  const inspectSwatchRef = useRef<HTMLSpanElement>(null)
  const inspectTypeRef = useRef<HTMLSpanElement>(null)
  const inspectDurationRef = useRef<HTMLSpanElement>(null)
  const inspectRangeRef = useRef<HTMLSpanElement>(null)
  const inspectRegistrationRef = useRef<HTMLSpanElement>(null)
  const inspectFlagsRef = useRef<HTMLDivElement>(null)
  const inspectCrewFlagRef = useRef<HTMLSpanElement>(null)
  const inspectManualFlagRef = useRef<HTMLSpanElement>(null)
  const inspectOutRef = useRef<HTMLDivElement>(null)
  const inspectOutTitleRef = useRef<HTMLSpanElement>(null)
  const inspectOutStartRef = useRef<HTMLSpanElement>(null)
  const inspectOutEndRef = useRef<HTMLSpanElement>(null)
  const detailRef = useRef(detailActive)
  const daysRef = useRef(visibleDays)
  const clockRef = useRef(clockMode)
  const chartWidthRef = useRef(chartWidth)
  const labelWidthRef = useRef(labelWidth)
  const rowHeightRef = useRef(rowHeight)
  const marginTopRef = useRef(marginTop)
  const zoomRef = useRef(zoomDomain)
  const outRangesRef = useRef(outModeRanges)
  const rafRef = useRef(0)
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  detailRef.current = detailActive
  daysRef.current = visibleDays
  clockRef.current = clockMode
  chartWidthRef.current = chartWidth
  labelWidthRef.current = labelWidth
  rowHeightRef.current = rowHeight
  marginTopRef.current = marginTop
  zoomRef.current = zoomDomain
  outRangesRef.current = outModeRanges

  const hideInspect = useCallback(() => {
    pointerRef.current = null
    const inspect = inspectRef.current
    if (inspect) inspect.classList.remove('is-visible')
  }, [])

  const paintFrame = useCallback(() => {
    rafRef.current = 0
    const pointer = pointerRef.current
    const stage = stageRef.current
    const svg = svgRef.current
    if (!pointer || !stage || !svg || !detailRef.current) {
      hideInspect()
      return
    }

    const svgPt = clientToSvgPoint(svg, pointer.clientX, pointer.clientY)
    const chartW = chartWidthRef.current
    const labelW = labelWidthRef.current
    const rowH = rowHeightRef.current
    const marginT = marginTopRef.current
    const dayCount = daysRef.current.length
    const onGraph =
      svgPt != null &&
      isChartX(svgPt.x, chartW, labelW) &&
      rowFromSvgY(svgPt.y, dayCount, rowH, marginT) != null

    if (!onGraph) {
      hideInspect()
      return
    }

    const minute = svgXToMinute(svgPt!.x, zoomRef.current, chartW, labelW)
    const row = rowFromSvgY(svgPt!.y, dayCount, rowH, marginT)!
    const day = daysRef.current[row]
    const ms = minuteToMs(day, minute, clockRef.current)
    const act = findTopActivityAt(day, ms)
    const outRange = findActiveOutRange(outRangesRef.current, ms)
    if (!act && !outRange) {
      hideInspect()
      return
    }

    const stageBox = stage.getBoundingClientRect()
    const localX = pointer.clientX - stageBox.left
    const localY = pointer.clientY - stageBox.top

    const inspect = inspectRef.current
    const swatch = inspectSwatchRef.current
    const typeEl = inspectTypeRef.current
    const durationEl = inspectDurationRef.current
    const rangeEl = inspectRangeRef.current
    const registrationEl = inspectRegistrationRef.current
    const flagsEl = inspectFlagsRef.current
    const crewFlag = inspectCrewFlagRef.current
    const manualFlag = inspectManualFlagRef.current
    const outEl = inspectOutRef.current
    const outTitle = inspectOutTitleRef.current
    const outStart = inspectOutStartRef.current
    const outEnd = inspectOutEndRef.current
    if (inspect && swatch && typeEl && durationEl && rangeEl && registrationEl && flagsEl && crewFlag && manualFlag && outEl && outTitle && outStart && outEnd) {
      inspect.classList.add('is-visible')
      if (act) {
        fillInspectPanel(
          swatch,
          typeEl,
          durationEl,
          rangeEl,
          registrationEl,
          flagsEl,
          crewFlag,
          manualFlag,
          act,
          clockRef.current,
        )
      } else if (outRange) {
        fillOutOnlyPanel(swatch, typeEl, durationEl, rangeEl, registrationEl, flagsEl, outRange)
      }
      if (outRange) {
        outEl.hidden = false
        outTitle.hidden = !act
        outStart.textContent = `aktivace ${formatClockDateTime(outRange.startMs, clockRef.current)}`
        outEnd.textContent = outRange.incomplete
          ? 'deaktivace nezaznamenána'
          : `deaktivace ${formatClockDateTime(outRange.endMs, clockRef.current)}`
      } else {
        outEl.hidden = true
        outStart.textContent = ''
        outEnd.textContent = ''
      }
      const tipW = inspect.offsetWidth
      const tipH = inspect.offsetHeight
      let tx = localX + 12
      let ty = localY - tipH - 10
      if (tx + tipW > stageBox.width - 4) tx = localX - tipW - 12
      if (ty < 4) ty = localY + 16
      inspect.style.transform = `translate(${Math.max(4, tx)}px, ${Math.max(4, ty)}px)`
    }
  }, [hideInspect, svgRef])

  const schedulePaint = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(paintFrame)
  }, [paintFrame])

  useEffect(() => {
    if (!detailActive) hideInspect()
  }, [detailActive, hideInspect])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!detailRef.current) {
      hideInspect()
      return
    }
    pointerRef.current = { clientX: event.clientX, clientY: event.clientY }
    schedulePaint()
  }

  function onPointerLeave() {
    hideInspect()
  }

  return (
    <div
      ref={stageRef}
      className={`graph-stage${detailActive ? ' is-detail-active' : ''}`}
      style={{ cursor: detailActive ? 'help' : 'default' }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {children}
      <div ref={inspectRef} className="graph-inspect">
        <span ref={inspectSwatchRef} className="graph-inspect-swatch" aria-hidden="true" />
        <div className="graph-inspect-body">
          <span ref={inspectTypeRef} className="graph-inspect-type" />
          <span ref={inspectDurationRef} className="graph-inspect-duration" />
          <span ref={inspectRangeRef} className="graph-inspect-range" />
          <span ref={inspectRegistrationRef} className="graph-inspect-registration" hidden />
          <div ref={inspectFlagsRef} className="graph-inspect-flags" hidden>
            <span ref={inspectCrewFlagRef} className="graph-inspect-flag graph-inspect-flag--crew" hidden>
              režim osádky
            </span>
            <span ref={inspectManualFlagRef} className="graph-inspect-flag graph-inspect-flag--manual" hidden>
              manuální záznam
            </span>
          </div>
          <div ref={inspectOutRef} className="graph-inspect-out" hidden>
            <span ref={inspectOutTitleRef} className="graph-inspect-out-title">režim OUT</span>
            <span ref={inspectOutStartRef} />
            <span ref={inspectOutEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
