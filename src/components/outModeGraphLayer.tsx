import type { ReactNode } from 'react'
import type { ClockMode } from '../lib/clock'
import { formatClockDateTime } from '../lib/clock'
import { clipChartX } from '../lib/graphGeometry'
import type { ParsedActivity } from '../workWeekTxtParser'
import {
  OUT_MODE_BAR_HEIGHT,
  OUT_MODE_GRAPH_COLOR,
  OUT_MODE_LABEL_MIN_WIDTH,
  OUT_MODE_TEXT_COLOR,
  OUT_MODE_TOUCH_MIN_HEIGHT,
  dayNeedsDualOutTrack,
  formatOutModeTooltip,
  isTimestampOnDay,
  partitionOutSliceByManualOverlap,
  sliceOutRangeForDay,
  type OutModeGraphModel,
} from '../lib/outModeGraph'

export type OutModeGraphLayerParams = {
  model: OutModeGraphModel
  dayStart: number
  dayActivities: readonly ParsedActivity[]
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

function outTrackGeometry(yBase: number, rowH: number, sx: (n: number) => number, lx: (n: number) => number, dualTrack: boolean) {
  const maxStrokeHalf = sx(8)
  const rowCenter = yBase + rowH / 2
  const bandH = lx(OUT_MODE_BAR_HEIGHT)
  const activityBottom = rowCenter + maxStrokeHalf
  const track0Center = activityBottom + bandH / 2
  const track1Center = track0Center + bandH
  return { bandH, track0Center, track1Center, dualTrack }
}

/** Souvislá oranžová čára OUT pod aktivitami, nápis uvnitř čáry. */
export function renderOutModeGraphLayer(params: OutModeGraphLayerParams): ReactNode[] {
  const {
    model,
    dayStart,
    dayActivities,
    yBase,
    rowH,
    labelW,
    chartRight,
    chartW,
    clockMode,
    lx,
    sx,
    xAt,
  } = params

  const manuals = dayActivities
    .filter((a) => a.isManualEntry)
    .map((a) => ({ startMs: a.startMs, endMs: a.endMs }))
  const dualTrack = dayNeedsDualOutTrack(model, dayStart, dayActivities, clockMode)
  const { bandH, track0Center, track1Center } = outTrackGeometry(yBase, rowH, sx, lx, dualTrack)
  const labelFont = lx(8)
  const labelMinW = lx(OUT_MODE_LABEL_MIN_WIDTH)
  const touchH = Math.max(lx(OUT_MODE_TOUCH_MIN_HEIGHT), bandH)
  const nodes: ReactNode[] = []

  const trackCenter = (manualRow: boolean) => (manualRow && dualTrack ? track1Center : track0Center)

  model.ranges.forEach((range, ri) => {
    const slice = sliceOutRangeForDay(range, dayStart, clockMode)
    if (!slice) return

    const rangeTooltip = formatOutModeTooltip(range.startMs, range.endMs, clockMode, range.incomplete, range.uncertain)
    const parts = partitionOutSliceByManualOverlap(slice.startMs, slice.endMs, manuals)

    parts.forEach((part, pi) => {
      const span = clipChartX(xAt(dayStart, part.startMs), xAt(dayStart, part.endMs), chartW, labelW)
      if (!span) return
      const barW = Math.max(1, span.x2 - span.x1)
      const centerY = trackCenter(part.manualRow)
      const top = centerY - bandH / 2

      nodes.push(
        <g key={`out-bar-${ri}-${pi}`} className="work-week-graph-out-mode">
          <title>{rangeTooltip}</title>
          <rect
            className="work-week-graph-out-mode-hit"
            x={span.x1}
            y={centerY - touchH / 2}
            width={barW}
            height={touchH}
            fill="transparent"
          />
          <rect x={span.x1} y={top} width={barW} height={bandH} fill={OUT_MODE_GRAPH_COLOR} pointerEvents="none" />
          {barW >= labelMinW && (
            <text
              x={span.x1 + barW / 2}
              y={centerY}
              textAnchor="middle"
              dominantBaseline="central"
              fill={OUT_MODE_TEXT_COLOR}
              fontSize={labelFont}
              fontFamily="sans-serif"
              fontWeight={700}
              pointerEvents="none"
            >
              OUT
            </text>
          )}
        </g>,
      )
    })
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
    const markW = lx(3)
    nodes.push(
      <g key={`out-orphan-${oi}`} className="work-week-graph-out-mode">
        <title>{orphanTooltip}</title>
        <rect
          x={x - markW / 2}
          y={track0Center - bandH / 2}
          width={markW}
          height={bandH}
          fill={OUT_MODE_GRAPH_COLOR}
        />
      </g>,
    )
  })

  return nodes
}
