import { useRef, type ReactNode } from 'react'
import {
  DAY_WINDOW_MINUTES,
  formatMinuteClock,
  maxDayPanStart,
} from '../lib/graphGeometry'

type DayGraphPanProps = {
  panStartMinute: number
  onPanStartChange: (minute: number) => void
  children: ReactNode
}

function clampPan(value: number): number {
  return Math.max(0, Math.min(maxDayPanStart(), Math.round(value)))
}

export function DayGraphPan({ panStartMinute, onPanStartChange, children }: DayGraphPanProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerX: number; panStart: number; chartPx: number } | null>(null)

  function chartPixelWidth(): number {
    const viewport = viewportRef.current
    if (!viewport) return 540
    const svg = viewport.querySelector('svg')
    if (!svg) return viewport.clientWidth
    const rect = svg.getBoundingClientRect()
    return Math.max(120, rect.width * (540 / 702))
  }

  return (
    <div className="day-graph-pan">
      <div
        ref={viewportRef}
        className="day-graph-pan-viewport"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const target = event.target as HTMLElement
          if (target.closest('.graph-day-row-hit')) return
          dragRef.current = {
            pointerX: event.clientX,
            panStart: panStartMinute,
            chartPx: chartPixelWidth(),
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag) return
          const deltaMinutes = ((event.clientX - drag.pointerX) / drag.chartPx) * DAY_WINDOW_MINUTES
          onPanStartChange(clampPan(drag.panStart - deltaMinutes))
        }}
        onPointerUp={(event) => {
          if (dragRef.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          dragRef.current = null
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          dragRef.current = null
        }}
      >
        {children}
      </div>
      <label className="day-graph-pan-scrubber">
        <span className="day-graph-pan-scrubber-label">Posun v čase</span>
        <input
          type="range"
          className="day-graph-pan-range"
          min={0}
          max={maxDayPanStart()}
          step={5}
          value={panStartMinute}
          onChange={(event) => onPanStartChange(clampPan(Number(event.target.value)))}
          aria-valuetext={`${formatMinuteClock(panStartMinute)} až ${formatMinuteClock(panStartMinute + DAY_WINDOW_MINUTES)}`}
        />
        <span className="day-graph-pan-range-label">
          {formatMinuteClock(panStartMinute)} – {formatMinuteClock(panStartMinute + DAY_WINDOW_MINUTES)}
        </span>
      </label>
    </div>
  )
}
