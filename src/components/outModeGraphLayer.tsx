import type { ReactNode } from 'react'
import type { ClockMode } from '../lib/clock'
import { formatClockDateTime } from '../lib/clock'
import { clipChartX, MANUAL_ENTRY_UNDERLINE_WIDTH } from '../lib/graphGeometry'
import type { ParsedActivity } from '../workWeekTxtParser'
import {
  OUT_MODE_HATCH_STROKE,
  OUT_MODE_LABEL_COLOR,
  OUT_MODE_TOUCH_MIN_HEIGHT,
  dayNeedsDualOutTrack,
  formatOutModeTooltip,
  isTimestampOnDay,
  partitionOutSliceByManualOverlap,
  sliceOutRangeForDay,
  type OutModeGraphModel,
} from '../lib/outModeGraph'

export type OutModeGraphLayerParams = {
  blockId: string
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
  /** Časové osy dalších značek (např. stát), kvůli kolizím popisků OUT. */
  markerXs?: readonly number[]
}

type LabelSlot = {
  key: string
  x: number
  kind: 'start' | 'end'
  text: string
  anchor: 'start' | 'end'
  baseY: number
  tooltip: string
}

function resolveLabelCollisions(labels: LabelSlot[], lx: (n: number) => number): Map<string, number> {
  const yOffsets = new Map<string, number>()
  const minDx = lx(26)
  const sorted = [...labels].sort((a, b) => a.x - b.x)
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!
    let stack = 0
    for (let j = 0; j < i; j++) {
      const other = sorted[j]!
      if (Math.abs(other.x - current.x) < minDx && other.kind === current.kind) {
        stack++
      }
    }
    const delta = stack * lx(9) * (current.kind === 'start' ? -1 : 1)
    yOffsets.set(current.key, delta)
  }
  return yOffsets
}

function outTrackGeometry(
  yBase: number,
  rowH: number,
  sx: (n: number) => number,
  lx: (n: number) => number,
  dualTrack: boolean,
) {
  const maxStrokeHalf = sx(8)
  const rowCenter = yBase + rowH / 2
  const activityBottom = rowCenter + maxStrokeHalf
  const bandH = sx(MANUAL_ENTRY_UNDERLINE_WIDTH)
  const gap = lx(2)
  const track0Y = activityBottom + gap
  const track1Y = track0Y + bandH + lx(1)
  const labelFont = lx(8)
  return { bandH, track0Y, track1Y, dualTrack, labelFont }
}

/** Jednotné vykreslení OUT – černý šrafovaný pás pod aktivitami. */
export function renderOutModeGraphLayer(params: OutModeGraphLayerParams): ReactNode[] {
  const {
    blockId,
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
    markerXs = [],
  } = params

  const manuals = dayActivities
    .filter((a) => a.isManualEntry)
    .map((a) => ({ startMs: a.startMs, endMs: a.endMs }))
  const dualTrack = dayNeedsDualOutTrack(model, dayStart, dayActivities, clockMode)
  const { bandH, track0Y, track1Y, labelFont } = outTrackGeometry(yBase, rowH, sx, lx, dualTrack)
  const patternId = `out-mode-hatch-${blockId}`
  const touchH = Math.max(lx(OUT_MODE_TOUCH_MIN_HEIGHT), bandH)
  const nodes: ReactNode[] = []
  const labelSlots: LabelSlot[] = []

  const trackY = (manualRow: boolean) => (manualRow && dualTrack ? track1Y : track0Y)

  model.ranges.forEach((range, ri) => {
    const slice = sliceOutRangeForDay(range, dayStart, clockMode)
    if (!slice) return

    const rangeTooltip = formatOutModeTooltip(range.startMs, range.endMs, clockMode, range.incomplete, range.uncertain)
    const parts = partitionOutSliceByManualOverlap(slice.startMs, slice.endMs, manuals)

    parts.forEach((part, pi) => {
      const span = clipChartX(xAt(dayStart, part.startMs), xAt(dayStart, part.endMs), chartW, labelW)
      if (!span) return
      const barW = Math.max(1, span.x2 - span.x1)
      const outBarY = trackY(part.manualRow)
      const touchPadY = outBarY - (touchH - bandH) / 2

      nodes.push(
        <g key={`out-bar-${ri}-${pi}`} className="work-week-graph-out-mode">
          <title>{rangeTooltip}</title>
          <rect
            className="work-week-graph-out-mode-hit"
            x={span.x1}
            y={touchPadY}
            width={barW}
            height={touchH}
            fill="transparent"
          />
          <rect
            x={span.x1}
            y={outBarY}
            width={barW}
            height={bandH}
            fill={`url(#${patternId})`}
            stroke={OUT_MODE_HATCH_STROKE}
            strokeWidth={lx(0.35)}
            pointerEvents="none"
          />
        </g>,
      )
    })

    if (isTimestampOnDay(range.startMs, dayStart, clockMode)) {
      const x = xAt(dayStart, range.startMs)
      if (x >= labelW && x <= chartRight) {
        const bandY = trackY(
          partitionOutSliceByManualOverlap(slice.startMs, slice.endMs, manuals).find(
            (p) => range.startMs >= p.startMs && range.startMs < p.endMs,
          )?.manualRow ?? false,
        )
        labelSlots.push({
          key: `out-start-${ri}`,
          x,
          kind: 'start',
          text: '▶ OUT',
          anchor: 'start',
          baseY: bandY - lx(3),
          tooltip: rangeTooltip,
        })
      }
    }

    if (!range.incomplete && isTimestampOnDay(range.endMs, dayStart, clockMode)) {
      const x = xAt(dayStart, range.endMs)
      if (x >= labelW && x <= chartRight) {
        const bandY = trackY(
          [...partitionOutSliceByManualOverlap(slice.startMs, slice.endMs, manuals)]
            .reverse()
            .find((p) => range.endMs > p.startMs && range.endMs <= p.endMs)?.manualRow ?? false,
        )
        labelSlots.push({
          key: `out-end-${ri}`,
          x,
          kind: 'end',
          text: '◀ OUT',
          anchor: 'end',
          baseY: bandY + bandH + lx(9),
          tooltip: rangeTooltip,
        })
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
    labelSlots.push({
      key: `out-orphan-${oi}`,
      x,
      kind: 'end',
      text: '◀ OUT',
      anchor: 'end',
      baseY: track0Y + bandH + lx(9),
      tooltip: orphanTooltip,
    })
  })

  const yOffsets = resolveLabelCollisions(labelSlots, lx)
  for (const slot of labelSlots) {
    let y = slot.baseY + (yOffsets.get(slot.key) ?? 0)
    const dx = slot.kind === 'start' ? lx(2) : -lx(2)
    for (const mx of markerXs) {
      if (Math.abs(mx - slot.x) < lx(22)) {
        y += slot.kind === 'start' ? -lx(9) : lx(9)
      }
    }
    nodes.push(
      <g key={slot.key} className="work-week-graph-out-mode-label">
        <title>{slot.tooltip}</title>
        <text
          x={slot.x}
          y={y}
          dx={dx}
          textAnchor={slot.anchor}
          fill={OUT_MODE_LABEL_COLOR}
          fontSize={labelFont}
          fontFamily="sans-serif"
          fontWeight={600}
        >
          {slot.text}
        </text>
      </g>,
    )
  }

  return nodes
}

/** SVG `<defs>` šrafování pro OUT – vložit do `<defs>` grafu. */
export function outModeHatchPatternDef(blockId: string, lx: (n: number) => number): ReactNode {
  const patternId = `out-mode-hatch-${blockId}`
  const cell = lx(4)
  return (
    <pattern id={patternId} patternUnits="userSpaceOnUse" width={cell} height={cell}>
      <line x1="0" y1="0" x2={cell} y2={cell} stroke={OUT_MODE_HATCH_STROKE} strokeWidth={lx(0.75)} />
    </pattern>
  )
}
