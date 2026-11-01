import { useRef, type PointerEvent, type ReactNode } from 'react'

type GraphSwipeNavProps = {
  children: ReactNode
  className?: string
  onPrev: () => void
  onNext: () => void
  canPrev?: boolean
  canNext?: boolean
  label?: string
}

const THRESHOLD_PX = 56
const LOCK_PX = 12

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, label, .day-graph-pan-viewport, .day-graph-pan-range',
    ),
  )
}

export function GraphSwipeNav({
  children,
  className,
  onPrev,
  onNext,
  canPrev = true,
  canNext = true,
  label,
}: GraphSwipeNavProps) {
  const startRef = useRef<{
    id: number
    x: number
    y: number
    axis: 'h' | 'v' | null
  } | null>(null)

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' || event.button !== 0) return
    if (isInteractive(event.target)) return
    startRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = startRef.current
    if (!start || event.pointerId !== start.id) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (start.axis == null) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return
      start.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v'
    }
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const start = startRef.current
    startRef.current = null
    if (!start || event.pointerId !== start.id || start.axis !== 'h') return
    const dx = event.clientX - start.x
    if (dx <= -THRESHOLD_PX && canNext) onNext()
    else if (dx >= THRESHOLD_PX && canPrev) onPrev()
  }

  return (
    <div
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => {
        startRef.current = null
      }}
      aria-label={label}
    >
      {children}
    </div>
  )
}
