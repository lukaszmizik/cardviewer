import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import type { ClockMode } from '../lib/clock'
import { parseClockDateTime } from '../lib/clock'
import {
  CHART_WIDTH,
  LABEL_WIDTH,
  MARGIN_TOP,
  ROW_HEIGHT,
  clampZoom,
  clientToSvgPoint,
  formatMinuteClock,
  isChartX,
  rowFromSvgY,
  svgXToMinute,
  type GraphTool,
  type ZoomDomain,
} from '../lib/graphGeometry'
import type { DayData, ParsedActivity } from '../workWeekTxtParser'

const INSPECT_TYPE_LABELS: Record<string, string> = {
  řízení: 'řízení',
  práce: 'práce',
  pohotovost: 'pohotovost',
  odpočinek: 'odpočinek',
  'odpočinek>24h': 'odpoč. 24h–45h',
  'odpočinek>45h': 'odpoč. ≥45h',
  neznámá: 'neznámá',
}

const LENS_CSS_W = 220
const LENS_CSS_H = 120
const LENS_ZOOM = 3.5
const LENS_OFFSET = 18

type GraphStageProps = {
  children: ReactNode
  svgRef: RefObject<SVGSVGElement | null>
  activeTool: GraphTool
  zoomDomain: ZoomDomain
  onZoomDomainChange: (zoom: ZoomDomain) => void
  visibleDays: DayData[]
  clockMode: ClockMode
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

function activityAt(day: DayData, ms: number): ParsedActivity | undefined {
  return day.activities.find((act) => ms >= act.startMs && ms < act.endMs)
}

function describeInspect(day: DayData | undefined, minute: number, clockMode: ClockMode): string {
  if (!day) return ''
  const ms = minuteToMs(day, minute, clockMode)
  const act = activityAt(day, ms)
  const time = formatMinuteClock(minute)
  const type = act ? INSPECT_TYPE_LABELS[act.type] ?? act.type : '—'
  return `${day.dayLabel} ${day.dateStr}  ${time}  ·  ${type}`
}

export function GraphStage({
  children,
  svgRef,
  activeTool,
  zoomDomain,
  onZoomDomainChange,
  visibleDays,
  clockMode,
}: GraphStageProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const lensRef = useRef<HTMLCanvasElement>(null)
  const sourceRef = useRef<HTMLCanvasElement | null>(null)
  const inspectRef = useRef<HTMLDivElement>(null)
  const selectBoxRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const zoomRef = useRef(zoomDomain)
  const toolRef = useRef(activeTool)
  const daysRef = useRef(visibleDays)
  const clockRef = useRef(clockMode)
  const rafRef = useRef(0)
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)

  zoomRef.current = zoomDomain
  toolRef.current = activeTool
  daysRef.current = visibleDays
  clockRef.current = clockMode

  const hideOverlays = useCallback(() => {
    pointerRef.current = null
    const lens = lensRef.current
    if (lens) lens.style.opacity = '0'
    const inspect = inspectRef.current
    if (inspect) inspect.hidden = true
  }, [])

  const rasterize = useCallback(async () => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(rect.width))
    clone.setAttribute('height', String(rect.height))
    const xml = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('svg rasterize'))
        img.src = url
      })
      const dpr = window.devicePixelRatio || 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      sourceRef.current = canvas
    } catch {
      /* lupa se vykreslí až po dalším snímku */
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [svgRef])

  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (!cancelled) void rasterize()
    }
    const id = requestAnimationFrame(run)
    const svg = svgRef.current
    const ro = svg ? new ResizeObserver(run) : null
    if (svg && ro) ro.observe(svg)
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
      ro?.disconnect()
    }
  }, [rasterize, zoomDomain, visibleDays, clockMode, activeTool])

  const paintFrame = useCallback(() => {
    rafRef.current = 0
    const pointer = pointerRef.current
    const stage = stageRef.current
    const svg = svgRef.current
    if (!pointer || !stage || !svg) return

    const svgPt = clientToSvgPoint(svg, pointer.clientX, pointer.clientY)
    const stageBox = stage.getBoundingClientRect()
    const localX = pointer.clientX - stageBox.left
    const localY = pointer.clientY - stageBox.top

    if (svgPt && isChartX(svgPt.x)) {
      const minute = svgXToMinute(svgPt.x, zoomRef.current)
      const row = rowFromSvgY(svgPt.y, daysRef.current.length)
      const day = row == null ? undefined : daysRef.current[row]
      const inspect = inspectRef.current
      if (inspect) {
        inspect.hidden = false
        inspect.textContent = describeInspect(day, minute, clockRef.current)
        const tipW = inspect.offsetWidth
        const tipH = inspect.offsetHeight
        let tx = localX + 12
        let ty = localY - tipH - 10
        if (tx + tipW > stageBox.width - 4) tx = localX - tipW - 12
        if (ty < 4) ty = localY + 16
        inspect.style.transform = `translate(${Math.max(4, tx)}px, ${Math.max(4, ty)}px)`
      }
    } else if (inspectRef.current) {
      inspectRef.current.hidden = true
    }

    const lens = lensRef.current
    const source = sourceRef.current
    if (lens && toolRef.current === 'lens' && source && svgPt && isChartX(svgPt.x) && rowFromSvgY(svgPt.y, daysRef.current.length) != null) {
      const dpr = window.devicePixelRatio || 1
      const cssW = LENS_CSS_W
      const cssH = LENS_CSS_H
      if (lens.width !== Math.round(cssW * dpr) || lens.height !== Math.round(cssH * dpr)) {
        lens.width = Math.round(cssW * dpr)
        lens.height = Math.round(cssH * dpr)
      }
      const svgBox = svg.getBoundingClientRect()
      const srcX = ((pointer.clientX - svgBox.left) / svgBox.width) * source.width
      const srcY = ((pointer.clientY - svgBox.top) / svgBox.height) * source.height
      const srcW = (cssW / LENS_ZOOM) * (source.width / svgBox.width)
      const srcH = (cssH / LENS_ZOOM) * (source.height / svgBox.height)
      const ctx = lens.getContext('2d')
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.clearRect(0, 0, cssW, cssH)
        ctx.drawImage(source, srcX - srcW / 2, srcY - srcH / 2, srcW, srcH, 0, 0, cssW, cssH)
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)'
        ctx.lineWidth = 1.5
        ctx.strokeRect(0.75, 0.75, cssW - 1.5, cssH - 1.5)
        ctx.beginPath()
        ctx.moveTo(cssW / 2 - 6, cssH / 2)
        ctx.lineTo(cssW / 2 + 6, cssH / 2)
        ctx.moveTo(cssW / 2, cssH / 2 - 6)
        ctx.lineTo(cssW / 2, cssH / 2 + 6)
        ctx.strokeStyle = 'rgba(79, 70, 229, 0.7)'
        ctx.stroke()
      }
      let lx = localX + LENS_OFFSET
      let ly = localY + LENS_OFFSET
      if (lx + cssW > stageBox.width) lx = localX - cssW - LENS_OFFSET
      if (ly + cssH > stageBox.height) ly = localY - cssH - LENS_OFFSET
      lx = Math.max(0, Math.min(lx, stageBox.width - cssW))
      ly = Math.max(0, Math.min(ly, stageBox.height - cssH))
      lens.style.opacity = '1'
      lens.style.transform = `translate(${lx}px, ${ly}px)`
    } else if (lens) {
      lens.style.opacity = '0'
    }

    const drag = dragRef.current
    const box = selectBoxRef.current
    if (drag && box && svg) {
      const svgBox = svg.getBoundingClientRect()
      const vbW = svg.viewBox.baseVal.width || svgBox.width
      const vbH = svg.viewBox.baseVal.height || svgBox.height
      const scaleX = svgBox.width / vbW
      const scaleY = svgBox.height / vbH
      const left = LABEL_WIDTH * scaleX
      const width = CHART_WIDTH * scaleX
      const top = MARGIN_TOP * scaleY
      const height = daysRef.current.length * ROW_HEIGHT * scaleY
      const ax = Math.max(left, Math.min(drag.x1, drag.x2) * scaleX)
      const bx = Math.min(left + width, Math.max(drag.x1, drag.x2) * scaleX)
      box.hidden = false
      box.style.left = `${ax}px`
      box.style.top = `${top}px`
      box.style.width = `${Math.max(1, bx - ax)}px`
      box.style.height = `${height}px`
    }
  }, [svgRef])

  const schedulePaint = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(paintFrame)
  }, [paintFrame])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (dragRef.current) {
        dragRef.current = null
        const box = selectBoxRef.current
        if (box) box.hidden = true
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    pointerRef.current = { clientX: event.clientX, clientY: event.clientY }
    const svg = svgRef.current
    const pt = svg ? clientToSvgPoint(svg, event.clientX, event.clientY) : null
    if (dragRef.current && pt) {
      dragRef.current.x2 = Math.max(LABEL_WIDTH, Math.min(LABEL_WIDTH + CHART_WIDTH, pt.x))
      dragRef.current.y2 = pt.y
    }
    schedulePaint()
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (toolRef.current !== 'select' || event.button !== 0) return
    const svg = svgRef.current
    if (!svg) return
    const pt = clientToSvgPoint(svg, event.clientX, event.clientY)
    if (!pt || !isChartX(pt.x) || rowFromSvgY(pt.y, daysRef.current.length) == null) return
    event.preventDefault()
    dragRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y }
    event.currentTarget.setPointerCapture(event.pointerId)
    schedulePaint()
  }

  function finishSelect() {
    const drag = dragRef.current
    dragRef.current = null
    const box = selectBoxRef.current
    if (box) box.hidden = true
    if (!drag) return
    const a = svgXToMinute(drag.x1, zoomRef.current)
    const b = svgXToMinute(drag.x2, zoomRef.current)
    if (Math.abs(b - a) < 2) return
    onZoomDomainChange(clampZoom({ startMinute: a, endMinute: b }))
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current) {
      finishSelect()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
  }

  function onPointerLeave() {
    if (dragRef.current) return
    hideOverlays()
  }

  const cursor =
    activeTool === 'select' ? 'crosshair' : activeTool === 'lens' ? 'none' : 'default'

  return (
    <div
      ref={stageRef}
      className={`graph-stage${activeTool !== 'none' ? ` is-tool-${activeTool}` : ''}`}
      style={{ cursor }}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      {children}
      <div ref={selectBoxRef} className="graph-select-box" hidden />
      <canvas ref={lensRef} className="graph-lens" width={LENS_CSS_W} height={LENS_CSS_H} aria-hidden="true" />
      <div ref={inspectRef} className="graph-inspect" hidden />
    </div>
  )
}
