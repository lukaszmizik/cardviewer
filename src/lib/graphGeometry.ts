import type { ClockMode } from './clock'
import { timeToX } from './clock'

export const DAYS_PER_WEEK = 7
export const ROW_HEIGHT = 40
/** Prostor pod aktivitami pro OUT pás, popisky a případný druhý řádek při překryvu s manuálním zadáním. */
export const OUT_GRAPH_ROW_EXTRA = 14
export const OUT_GRAPH_DUAL_TRACK_EXTRA = 5
/** Stejná tloušťka jako fialové podtržení manuálního zadání ve grafu. */
export const MANUAL_ENTRY_UNDERLINE_WIDTH = 3
/** Tloušťka odpočinku v týdenním grafu (SVG jednotky). */
export const WEEK_REST_STROKE = 16
/** Tloušťka zelené čáry odpočinku v denním detailu. */
export const DAY_DETAIL_REST_STROKE = 100
export const DAY_DETAIL_STROKE_SCALE = DAY_DETAIL_REST_STROKE / WEEK_REST_STROKE
export const DAY_DETAIL_LABEL_SCALE = 2
/** Jeden den — řádek musí pojmout 100px odpočinek + podtržení. */
export const DAY_DETAIL_ROW_HEIGHT = 200
export const LABEL_WIDTH = 126
/** Denní graf bez sloupce dne — jen malý okraj pro popisky hodin. */
export const DAY_DETAIL_LABEL_WIDTH = 32
export const CHART_WIDTH = 540
/** Šířka časové osy v denním detailu (4 h okno), včetně prostoru po sloupci dne. */
export const DAY_DETAIL_CHART_WIDTH = 1074
export const SVG_RIGHT_GUTTER = 36

export function svgLayoutWidth(chartWidth = CHART_WIDTH, labelWidth = LABEL_WIDTH): number {
  return labelWidth + chartWidth + SVG_RIGHT_GUTTER
}

export function chartPixelWidthFromSvgRect(
  svgRectWidth: number,
  chartWidth = CHART_WIDTH,
  labelWidth = LABEL_WIDTH,
): number {
  const layoutW = svgLayoutWidth(chartWidth, labelWidth)
  return Math.max(120, svgRectWidth * (chartWidth / layoutW))
}
export const MARGIN_TOP = 25
export const MARGIN_BOTTOM = 18
export const DAY_DETAIL_MARGIN_TOP = 40
export const DAY_DETAIL_MARGIN_BOTTOM = 34
export const TICK_LEN = 2
export const HOUR_TICK_LEN = 4
export const QUARTER_TICK_LEN = 3

export const FULL_DAY_MINUTES = 24 * 60
export const DAY_WINDOW_MINUTES = 4 * 60

export function maxDayPanStart(): number {
  return FULL_DAY_MINUTES - DAY_WINDOW_MINUTES
}

export function dayWindowZoom(panStartMinute: number): ZoomDomain {
  const start = Math.max(0, Math.min(maxDayPanStart(), panStartMinute))
  return { startMinute: start, endMinute: start + DAY_WINDOW_MINUTES }
}

export function formatMinuteClock(minute: number): string {
  if (Math.round(minute) >= FULL_DAY_MINUTES) return '24:00'
  const m = Math.max(0, Math.round(minute))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export type ZoomDomain = {
  startMinute: number
  endMinute: number
}

export const DEFAULT_ZOOM: ZoomDomain = {
  startMinute: 0,
  endMinute: FULL_DAY_MINUTES,
}

export function zoomSpan(zoom: ZoomDomain): number {
  return Math.max(1, zoom.endMinute - zoom.startMinute)
}

export function zoomedFraction(dayStartMs: number, ms: number, mode: ClockMode, zoom: ZoomDomain): number {
  const minute = timeToX(dayStartMs, ms, mode) * FULL_DAY_MINUTES
  return (minute - zoom.startMinute) / zoomSpan(zoom)
}

export function chartX(
  dayStartMs: number,
  ms: number,
  mode: ClockMode,
  zoom: ZoomDomain,
  chartWidth = CHART_WIDTH,
  labelWidth = LABEL_WIDTH,
): number {
  return labelWidth + zoomedFraction(dayStartMs, ms, mode, zoom) * chartWidth
}

export function svgXToMinute(
  svgX: number,
  zoom: ZoomDomain,
  chartWidth = CHART_WIDTH,
  labelWidth = LABEL_WIDTH,
): number {
  const t = (svgX - labelWidth) / chartWidth
  return zoom.startMinute + t * zoomSpan(zoom)
}

export function minuteToSvgX(
  minute: number,
  zoom: ZoomDomain,
  chartWidth = CHART_WIDTH,
  labelWidth = LABEL_WIDTH,
): number {
  return labelWidth + ((minute - zoom.startMinute) / zoomSpan(zoom)) * chartWidth
}

export function isChartX(svgX: number, chartWidth = CHART_WIDTH, labelWidth = LABEL_WIDTH): boolean {
  return svgX >= labelWidth && svgX <= labelWidth + chartWidth
}

export function rowFromSvgY(
  svgY: number,
  dayCount = DAYS_PER_WEEK,
  rowHeight = ROW_HEIGHT,
  marginTop = MARGIN_TOP,
): number | null {
  if (svgY < marginTop) return null
  const row = Math.floor((svgY - marginTop) / rowHeight)
  if (row < 0 || row >= dayCount) return null
  return row
}

export function clipChartX(
  x1: number,
  x2: number,
  chartWidth = CHART_WIDTH,
  labelWidth = LABEL_WIDTH,
): { x1: number; x2: number } | null {
  const left = labelWidth
  const right = labelWidth + chartWidth
  const a = Math.max(left, Math.min(x1, x2))
  const b = Math.min(right, Math.max(x1, x2))
  if (b - a < 0.4) return null
  return { x1: a, x2: b }
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
  const first = Math.ceil((zoom.startMinute - 1e-6) / step) * step
  for (let m = first; m <= zoom.endMinute + 1e-6; m += step) {
    if (m < zoom.startMinute - 1e-6 || m > zoom.endMinute + 1e-6) continue
    ticks.push(m)
  }
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
