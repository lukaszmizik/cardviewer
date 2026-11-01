import type { ClockMode } from './clock'
import { timeToX } from './clock'

export const DAYS_PER_WEEK = 7
export const ROW_HEIGHT = 40
export const LABEL_WIDTH = 126
export const CHART_WIDTH = 540
export const MARGIN_TOP = 25
export const MARGIN_BOTTOM = 18
export const TICK_LEN = 2
export const HOUR_TICK_LEN = 4
export const QUARTER_TICK_LEN = 3

export const FULL_DAY_MINUTES = 24 * 60
export const MIN_ZOOM_SPAN_MINUTES = 5

export type GraphTool = 'none' | 'lens' | 'select'

export type ZoomDomain = {
  startMinute: number
  endMinute: number
}

export const DEFAULT_ZOOM: ZoomDomain = {
  startMinute: 0,
  endMinute: FULL_DAY_MINUTES,
}

export function isFullDayZoom(zoom: ZoomDomain): boolean {
  return zoom.startMinute <= 0 && zoom.endMinute >= FULL_DAY_MINUTES
}

export function clampZoom(domain: ZoomDomain): ZoomDomain {
  const lo = Math.min(domain.startMinute, domain.endMinute)
  const hi = Math.max(domain.startMinute, domain.endMinute)
  let start = Math.max(0, Math.min(FULL_DAY_MINUTES, lo))
  let end = Math.max(0, Math.min(FULL_DAY_MINUTES, hi))
  if (end - start < MIN_ZOOM_SPAN_MINUTES) {
    const mid = (start + end) / 2
    start = Math.max(0, mid - MIN_ZOOM_SPAN_MINUTES / 2)
    end = Math.min(FULL_DAY_MINUTES, start + MIN_ZOOM_SPAN_MINUTES)
    start = Math.max(0, end - MIN_ZOOM_SPAN_MINUTES)
  }
  return { startMinute: start, endMinute: end }
}

export function zoomSpan(zoom: ZoomDomain): number {
  return Math.max(1, zoom.endMinute - zoom.startMinute)
}

/** 0–1 along the visible zoom window (may fall outside if the time is clipped). */
export function zoomedFraction(dayStartMs: number, ms: number, mode: ClockMode, zoom: ZoomDomain): number {
  const minute = timeToX(dayStartMs, ms, mode) * FULL_DAY_MINUTES
  return (minute - zoom.startMinute) / zoomSpan(zoom)
}

export function chartX(dayStartMs: number, ms: number, mode: ClockMode, zoom: ZoomDomain): number {
  return LABEL_WIDTH + zoomedFraction(dayStartMs, ms, mode, zoom) * CHART_WIDTH
}

export function svgXToMinute(svgX: number, zoom: ZoomDomain): number {
  const t = (svgX - LABEL_WIDTH) / CHART_WIDTH
  return zoom.startMinute + t * zoomSpan(zoom)
}

export function minuteToSvgX(minute: number, zoom: ZoomDomain): number {
  return LABEL_WIDTH + ((minute - zoom.startMinute) / zoomSpan(zoom)) * CHART_WIDTH
}

export function isChartX(svgX: number): boolean {
  return svgX >= LABEL_WIDTH && svgX <= LABEL_WIDTH + CHART_WIDTH
}

export function rowFromSvgY(svgY: number, dayCount = DAYS_PER_WEEK): number | null {
  if (svgY < MARGIN_TOP) return null
  const row = Math.floor((svgY - MARGIN_TOP) / ROW_HEIGHT)
  if (row < 0 || row >= dayCount) return null
  return row
}

export function clipChartX(x1: number, x2: number): { x1: number; x2: number } | null {
  const left = LABEL_WIDTH
  const right = LABEL_WIDTH + CHART_WIDTH
  const a = Math.max(left, Math.min(x1, x2))
  const b = Math.min(right, Math.max(x1, x2))
  if (b - a < 0.4) return null
  return { x1: a, x2: b }
}

export function formatMinuteClock(minute: number): string {
  if (Math.round(minute) >= FULL_DAY_MINUTES) return '24:00'
  const m = Math.max(0, Math.round(minute))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function formatMinuteTick(minute: number): string {
  const m = Math.round(minute)
  if (m === FULL_DAY_MINUTES) return '24'
  const wrapped = ((m % FULL_DAY_MINUTES) + FULL_DAY_MINUTES) % FULL_DAY_MINUTES
  const h = Math.floor(wrapped / 60)
  const mm = wrapped % 60
  if (mm === 0) return String(h)
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function majorTicks(zoom: ZoomDomain): number[] {
  const span = zoomSpan(zoom)
  let step = 60
  if (span <= 20) step = 1
  else if (span <= 60) step = 5
  else if (span <= 180) step = 15
  else if (span <= 360) step = 30
  const ticks: number[] = []
  const first = Math.ceil(zoom.startMinute / step) * step
  for (let m = first; m <= zoom.endMinute + 1e-6; m += step) ticks.push(m)
  if (ticks[0] !== zoom.startMinute) ticks.unshift(zoom.startMinute)
  if (ticks[ticks.length - 1] !== zoom.endMinute) ticks.push(zoom.endMinute)
  return ticks
}

export function minorTicks(zoom: ZoomDomain): number[] {
  const span = zoomSpan(zoom)
  let step = 15
  if (span <= 20) step = 1
  else if (span <= 60) step = 1
  else if (span <= 180) step = 5
  else if (span <= 720) step = 15
  const majors = new Set(majorTicks(zoom).map((m) => Math.round(m * 100) / 100))
  const ticks: number[] = []
  const first = Math.ceil(zoom.startMinute / step) * step
  for (let m = first; m <= zoom.endMinute + 1e-6; m += step) {
    if (!majors.has(Math.round(m * 100) / 100)) ticks.push(m)
  }
  return ticks
}

export function clientToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const mapped = pt.matrixTransform(ctm.inverse())
  return { x: mapped.x, y: mapped.y }
}
