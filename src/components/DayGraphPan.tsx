import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import {
  chartPixelWidthFromSvgRect,
  DAY_DETAIL_CHART_WIDTH,
  DAY_DETAIL_LABEL_WIDTH,
  DAY_WINDOW_MINUTES,
  formatMinuteClock,
  maxDayPanStart,
} from '../lib/graphGeometry'

type DayGraphPanProps = {
  panStartMinute: number
  onPanStartChange: (minute: number) => void
  children: ReactNode
}

type DragState = {
  pointerId: number
  pointerX: number
  panStart: number
  chartPx: number
}

type PanSample = {
  t: number
  pan: number
}

const SAMPLE_WINDOW_MS = 90
const INERTIA_FRICTION = 0.0052
const INERTIA_MIN_VELOCITY = 0.012
const INERTIA_STOP_VELOCITY = 0.00035

function clampPan(value: number): number {
  return Math.max(0, Math.min(maxDayPanStart(), value))
}

function velocityFromSamples(samples: PanSample[]): number {
  if (samples.length < 2) return 0
  const newest = samples[samples.length - 1]!
  const cutoff = newest.t - SAMPLE_WINDOW_MS
  let oldest = samples[0]!
  for (const sample of samples) {
    if (sample.t >= cutoff) {
      oldest = sample
      break
    }
  }
  const dt = newest.t - oldest.t
  if (dt < 16) return 0
  return (newest.pan - oldest.pan) / dt
}

export function DayGraphPan({ panStartMinute, onPanStartChange, children }: DayGraphPanProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const samplesRef = useRef<PanSample[]>([])
  const panRef = useRef(panStartMinute)
  const onPanRef = useRef(onPanStartChange)
  const inertiaRafRef = useRef(0)

  panRef.current = panStartMinute
  onPanRef.current = onPanStartChange

  function chartPixelWidth(): number {
    const viewport = viewportRef.current
    if (!viewport) return DAY_DETAIL_CHART_WIDTH
    const svg = viewport.querySelector('svg')
    if (!svg) return viewport.clientWidth
    const rect = svg.getBoundingClientRect()
    return chartPixelWidthFromSvgRect(rect.width, DAY_DETAIL_CHART_WIDTH, DAY_DETAIL_LABEL_WIDTH)
  }

  function stopInertia() {
    if (inertiaRafRef.current) {
      cancelAnimationFrame(inertiaRafRef.current)
      inertiaRafRef.current = 0
    }
  }

  function commitPan(value: number): number {
    const next = clampPan(value)
    if (next !== panRef.current) onPanRef.current(next)
    return next
  }

  function startInertia(velocity: number) {
    stopInertia()
    let v = velocity
    let pos = panRef.current
    let last = performance.now()

    const frame = (now: number) => {
      const dt = Math.min(32, now - last)
      last = now
      v *= Math.exp(-INERTIA_FRICTION * dt)
      const unclamped = pos + v * dt
      const next = clampPan(unclamped)
      pos = next
      onPanRef.current(Math.round(next))
      if (next !== unclamped || Math.abs(v) < INERTIA_STOP_VELOCITY) {
        inertiaRafRef.current = 0
        onPanRef.current(clampPan(Math.round(next)))
        return
      }
      inertiaRafRef.current = requestAnimationFrame(frame)
    }

    inertiaRafRef.current = requestAnimationFrame(frame)
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const velocity = velocityFromSamples(samplesRef.current)
    dragRef.current = null
    samplesRef.current = []
    if (Math.abs(velocity) >= INERTIA_MIN_VELOCITY) startInertia(velocity)
  }

  useEffect(() => () => stopInertia(), [])

  return (
    <div className="day-graph-pan">
      <div
        ref={viewportRef}
        className="day-graph-pan-viewport"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const target = event.target as HTMLElement
          if (target.closest('.graph-day-row-hit')) return
          stopInertia()
          const now = performance.now()
          dragRef.current = {
            pointerId: event.pointerId,
            pointerX: event.clientX,
            panStart: panRef.current,
            chartPx: chartPixelWidth(),
          }
          samplesRef.current = [{ t: now, pan: panRef.current }]
          event.currentTarget.setPointerCapture(event.pointerId)
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || event.pointerId !== drag.pointerId) return
          const deltaMinutes = ((event.clientX - drag.pointerX) / drag.chartPx) * DAY_WINDOW_MINUTES
          const pan = commitPan(drag.panStart - deltaMinutes)
          const now = performance.now()
          samplesRef.current.push({ t: now, pan })
          samplesRef.current = samplesRef.current.filter((sample) => sample.t >= now - SAMPLE_WINDOW_MS)
        }}
        onPointerUp={endDrag}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          dragRef.current = null
          samplesRef.current = []
          stopInertia()
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
          onChange={(event) => {
            stopInertia()
            onPanStartChange(clampPan(Number(event.target.value)))
          }}
          aria-valuetext={`${formatMinuteClock(panStartMinute)} až ${formatMinuteClock(panStartMinute + DAY_WINDOW_MINUTES)}`}
        />
        <span className="day-graph-pan-range-label">
          {formatMinuteClock(panStartMinute)} – {formatMinuteClock(panStartMinute + DAY_WINDOW_MINUTES)}
        </span>
      </label>
    </div>
  )
}
