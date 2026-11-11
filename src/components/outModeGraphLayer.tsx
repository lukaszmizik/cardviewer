import type { ReactNode } from 'react'
import type { ClockMode } from '../lib/clock'
import { formatClockDateTime } from '../lib/clock'
import { clipChartX } from '../lib/graphGeometry'
import {
  OUT_MODE_BAR_HEIGHT,
  OUT_MODE_GRAPH_COLOR,
  OUT_MODE_LABEL_MIN_WIDTH,
  OUT_MODE_TOUCH_MIN_HEIGHT,
  formatOutModeTooltip,
  isTimestampOnDay,
  sliceOutRangeForDay,
  type OutModeGraphModel,
} from '../lib/outModeGraph'

export type OutModeGraphLayerParams = {
  model: OutModeGraphModel
  dayStart: number
  yBase: number
  rowH: number
  labelW: number
  chartRight: number
  chartW: number
  clockMode: ClockMode
  lx: (n: number) => number
  sx: (n: number) => number
  xAt: (dayStart: number, ms: number) => number
}

function outBarGeometry(yBase: number, rowH: number, sx: (n: number) => number, lx: (n: number) => number) {
  const maxStrokeHalf = sx(8)
  const rowCenter = yBase + rowH / 2
  const activityTop = rowCenter - maxStrokeHalf
  const outBarH = lx(OUT_MODE_BAR_HEIGHT)
  const outBarY = activityTop - outBarH - lx(2)
  return { outBarH, outBarY }
}

/** Jednotné vykreslení pásu režimu OUT v denním i týdenním grafu. */
export function renderOutModeGraphLayer(params: OutModeGraphLayerParams): ReactNode[] {
  const { model, dayStart, yBase, rowH, labelW, chartRight, chartW, clockMode, lx, sx, xAt } = params
  const { outBarH, outBarY } = outBarGeometry(yBase, rowH, sx, lx)
  const touchH = Math.max(lx(OUT_MODE_TOUCH_MIN_HEIGHT), outBarH)
  const touchPadY = outBarY - (touchH - outBarH) / 2
  const labelMinW = lx(OUT_MODE_LABEL_MIN_WIDTH)
  const markerW = lx(2)
  const markerStem = lx(4)

  const nodes: ReactNode[] = []

  model.ranges.forEach((range, ri) => {
    const slice = sliceOutRangeForDay(range, dayStart, clockMode)
    if (!slice) return

    const span = clipChartX(xAt(dayStart, slice.startMs), xAt(dayStart, slice.endMs), chartW, labelW)
    if (!span) return

    const barW = Math.max(1, span.x2 - span.x1)
    const rangeTooltip = formatOutModeTooltip(range.startMs, range.endMs, clockMode, range.incomplete, range.uncertain)

    nodes.push(
      <g key={`out-bar-${ri}`} className="work-week-graph-out-mode">
        <title>{rangeTooltip}</title>
        <rect
          className="work-week-graph-out-mode-hit"
          x={span.x1}
          y={touchPadY}
          width={barW}
          height={touchH}
          fill="transparent"
        />
        <rect x={span.x1} y={outBarY} width={barW} height={outBarH} fill={OUT_MODE_GRAPH_COLOR} pointerEvents="none" />
        {barW >= labelMinW && (
          <text
            x={span.x1 + barW / 2}
            y={outBarY + outBarH / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#fff"
            fontSize={lx(7)}
            fontFamily="sans-serif"
            fontWeight={700}
            pointerEvents="none"
          >
            OUT
          </text>
        )}
      </g>,
    )

    if (isTimestampOnDay(range.startMs, dayStart, clockMode)) {
      const x = xAt(dayStart, range.startMs)
      if (x >= labelW && x <= chartRight) {
        nodes.push(
          <g key={`out-start-${ri}`} pointerEvents="none">
            <title>{rangeTooltip}</title>
            <line
              x1={x}
              y1={outBarY - markerStem}
              x2={x}
              y2={outBarY + outBarH}
              stroke={OUT_MODE_GRAPH_COLOR}
              strokeWidth={markerW}
              strokeLinecap="round"
            />
          </g>,
        )
      }
    }

    if (!range.incomplete && isTimestampOnDay(range.endMs, dayStart, clockMode)) {
      const x = xAt(dayStart, range.endMs)
      if (x >= labelW && x <= chartRight) {
        nodes.push(
          <g key={`out-end-${ri}`} pointerEvents="none">
            <title>{rangeTooltip}</title>
            <line
              x1={x - lx(3)}
              y1={outBarY + outBarH / 2}
              x2={x}
              y2={outBarY + outBarH / 2}
              stroke={OUT_MODE_GRAPH_COLOR}
              strokeWidth={markerW}
              strokeLinecap="round"
            />
            <line
              x1={x}
              y1={outBarY}
              x2={x}
              y2={outBarY + outBarH}
              stroke={OUT_MODE_GRAPH_COLOR}
              strokeWidth={markerW}
              strokeLinecap="round"
            />
          </g>,
        )
      }
    }
  })

  model.orphanEnds.forEach((orphan, oi) => {
    if (!isTimestampOnDay(orphan.endMs, dayStart, clockMode)) return
    const x = xAt(dayStart, orphan.endMs)
    if (x < labelW || x > chartRight) return
    const orphanTooltip = [
      'Režim OUT',
      '',
      `${formatClockDateTime(orphan.endMs, clockMode)} (konec bez známého začátku)`,
      '',
      'Tachograf byl v režimu mimo působnost.',
      '',
      'Oprávněnost použití OUT nelze ověřit jen z dat karty.',
    ].join('\n')
    nodes.push(
      <g key={`out-orphan-${oi}`} className="work-week-graph-out-mode">
        <title>{orphanTooltip}</title>
        <rect
          className="work-week-graph-out-mode-hit"
          x={x - lx(6)}
          y={touchPadY}
          width={lx(12)}
          height={touchH}
          fill="transparent"
        />
        <line
          x1={x - lx(3)}
          y1={outBarY + outBarH / 2}
          x2={x}
          y2={outBarY + outBarH / 2}
          stroke={OUT_MODE_GRAPH_COLOR}
          strokeWidth={markerW}
          strokeLinecap="round"
        />
        <line
          x1={x}
          y1={outBarY}
          x2={x}
          y2={outBarY + outBarH}
          stroke={OUT_MODE_GRAPH_COLOR}
          strokeWidth={markerW}
          strokeLinecap="round"
        />
      </g>,
    )
  })

  return nodes
}
