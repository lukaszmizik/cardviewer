import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import type { ClockMode } from '../lib/clock'
import { parseClockDateTime } from '../lib/clock'
import {
  CHART_WIDTH,
  DEFAULT_ZOOM,
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
import type { DayData, ParsedActivity } from '../workWeekTxtParser'

type GraphStageProps = {
  children: ReactNode
  svgRef: RefObject<SVGSVGElement | null>
  detailActive: boolean
  visibleDays: DayData[]
  clockMode: ClockMode
  chartWidth?: number
  rowHeight?: number
  zoomDomain?: ZoomDomain
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

function fillInspectPanel(
  swatch: HTMLSpanElement,
  typeEl: HTMLSpanElement,
  durationEl: HTMLSpanElement,
  flagsEl: HTMLDivElement,
  crewFlag: HTMLSpanElement,
  manualFlag: HTMLSpanElement,
  act: ParsedActivity,
) {
  typeEl.textContent = ACTIVITY_TYPE_LABELS[act.type] ?? act.type
  durationEl.textContent = formatActivityDuration(act.originalDurationMinutes ?? act.durationMinutes)
  swatch.style.background = getActivityDisplayColor(act)
  swatch.textContent = ACTIVITY_SYMBOL[act.type] ?? ''
  swatch.className =
    act.type === 'neznámá' ? 'graph-inspect-swatch tacho-icon tacho-icon-smaller' : 'graph-inspect-swatch tacho-icon'

  const showCrew = act.isCrew === true && !act.isManualEntry
  const showManual = act.isManualEntry === true
  if (!showCrew && !showManual) {
    flagsEl.hidden = true
  } else {
    flagsEl.hidden = false
    crewFlag.hidden = !showCrew
    manualFlag.hidden = !showManual
  }
}

export function GraphStage({
  children,
  svgRef,
  detailActive,
  visibleDays,
  clockMode,
  chartWidth = CHART_WIDTH,
  rowHeight,
  zoomDomain = DEFAULT_ZOOM,
}: GraphStageProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const inspectRef = useRef<HTMLDivElement>(null)
  const inspectSwatchRef = useRef<HTMLSpanElement>(null)
  const inspectTypeRef = useRef<HTMLSpanElement>(null)
  const inspectDurationRef = useRef<HTMLSpanElement>(null)
  const inspectFlagsRef = useRef<HTMLDivElement>(null)
  const inspectCrewFlagRef = useRef<HTMLSpanElement>(null)
  const inspectManualFlagRef = useRef<HTMLSpanElement>(null)
  const detailRef = useRef(detailActive)
  const daysRef = useRef(visibleDays)
  const clockRef = useRef(clockMode)
  const chartWidthRef = useRef(chartWidth)
  const rowHeightRef = useRef(rowHeight)
  const zoomRef = useRef(zoomDomain)
  const rafRef = useRef(0)
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  detailRef.current = detailActive
  daysRef.current = visibleDays
  clockRef.current = clockMode
  chartWidthRef.current = chartWidth
  rowHeightRef.current = rowHeight
  zoomRef.current = zoomDomain

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
    const rowH = rowHeightRef.current
    const dayCount = daysRef.current.length
    const onGraph =
      svgPt != null &&
      isChartX(svgPt.x, chartW) &&
      rowFromSvgY(svgPt.y, dayCount, rowH) != null

    if (!onGraph) {
      hideInspect()
      return
    }

    const minute = svgXToMinute(svgPt!.x, zoomRef.current, chartW)
    const row = rowFromSvgY(svgPt!.y, dayCount, rowH)!
    const day = daysRef.current[row]
    const ms = minuteToMs(day, minute, clockRef.current)
    const act = findTopActivityAt(day, ms)
    if (!act) {
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
    const flagsEl = inspectFlagsRef.current
    const crewFlag = inspectCrewFlagRef.current
    const manualFlag = inspectManualFlagRef.current
    if (inspect && swatch && typeEl && durationEl && flagsEl && crewFlag && manualFlag) {
      inspect.classList.add('is-visible')
      fillInspectPanel(swatch, typeEl, durationEl, flagsEl, crewFlag, manualFlag, act)
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
          <div ref={inspectFlagsRef} className="graph-inspect-flags" hidden>
            <span ref={inspectCrewFlagRef} className="graph-inspect-flag graph-inspect-flag--crew">
              režim osádky
            </span>
            <span ref={inspectManualFlagRef} className="graph-inspect-flag graph-inspect-flag--manual">
              manuální záznam
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
