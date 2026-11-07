import { useMemo, useState } from 'react'
import { buildComplianceReview, type ComplianceFinding, type ComplianceSeverity } from './complianceReview.ts'
import type { ClockMode } from '../lib/clock.ts'
import type { Activity } from '../types/tacho.ts'

type Filter = 'all' | 'violation' | 'uncertain'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Vše' },
  { id: 'violation', label: 'Porušení' },
  { id: 'uncertain', label: 'Nejasnosti' },
]

export function ComplianceReviewView({
  activities,
  nowUtc,
  onOpenDay,
}: {
  activities: readonly Activity[]
  nowUtc: number
  onOpenDay?: (atUtc: number) => void
}) {
  const [clockMode, setClockMode] = useState<ClockMode>('local')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const review = useMemo(
    () => buildComplianceReview({ activities, nowUtc, clockMode }),
    [activities, nowUtc, clockMode],
  )
  const visible = review.findings.filter((finding) => {
    if (filter === 'violation' && finding.severity !== 'violation') return false
    if (filter === 'uncertain' && finding.severity !== 'uncertain') return false
    if (selectedDay != null && finding.mapDayUtc !== selectedDay) return false
    return true
  })

  return (
    <div className="compliance-review">
      <div className="compliance-toolbar">
        <p className="compliance-period">{review.periodText}</p>
        <label className="compliance-clock">
          Časy
          <select value={clockMode} onChange={(event) => setClockMode(event.target.value as ClockMode)}>
            <option value="local">Místní čas</option>
            <option value="utc">UTC</option>
          </select>
        </label>
      </div>
      <div className="compliance-stats">
        <p><strong>{review.violationCount}</strong> prokázaných porušení</p>
        <p><strong>{review.uncertaintyCount}</strong> nejasností</p>
        <p>{review.completenessText}</p>
      </div>
      <p className="compliance-summary">{review.summaryText}</p>
      <div className="compliance-map" role="list" aria-label="Mapa 57 dnů">
        {review.days.map((day) => (
          <button
            key={day.dayStartUtc}
            type="button"
            role="listitem"
            className={`compliance-day compliance-day-${day.severity}${selectedDay === day.dayStartUtc ? ' is-selected' : ''}`}
            aria-pressed={selectedDay === day.dayStartUtc}
            title={`${day.label}: ${severityLabel(day.severity)}`}
            onClick={() => setSelectedDay((current) => (current === day.dayStartUtc ? null : day.dayStartUtc))}
          >
            <span>{day.label.slice(0, 2)}</span>
          </button>
        ))}
      </div>
      <div className="compliance-filters" role="tablist" aria-label="Filtr zjištění">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filter === item.id ? 'is-active' : undefined}
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? <p className="compliance-empty">Ve zvoleném filtru není žádné zjištění.</p> : null}
      <div className="compliance-cards">
        {visible.map((finding) => (
          <FindingCard key={finding.id} finding={finding} onOpenDay={onOpenDay} />
        ))}
      </div>
      <section className="compliance-watch" aria-label="Co si musím hlídat">
        <h2>Co si musím hlídat</h2>
        <p>Jde o povinnosti, jejichž termín teprve nastane, nebo o průběžný počet. Není to plán další směny.</p>
        {review.watches.length === 0 ? <p>Z otevřených náhrad a prodloužení teď nic nezbývá.</p> : null}
        {review.watches.map((item) => (
          <article key={item.id} className="compliance-watch-card">
            <h3>{item.title}</h3>
            {item.deadlineText != null ? <p>{item.deadlineText}</p> : null}
            <p>{item.detail}</p>
          </article>
        ))}
      </section>
    </div>
  )
}

function FindingCard({ finding, onOpenDay }: { finding: ComplianceFinding; onOpenDay?: (atUtc: number) => void }) {
  return (
    <article className={`compliance-card compliance-card-${finding.severity}`}>
      <header>
        <span className={`compliance-dot compliance-dot-${finding.severity}`} aria-hidden="true" />
        <h3>{finding.title}</h3>
      </header>
      <p>{finding.intervalText}</p>
      <p className="compliance-values">
        {finding.actualText} / {finding.limitText}
      </p>
      {finding.meterPercent != null ? (
        <div className={`compliance-meter${finding.meterOver ? ' is-over' : ''}`} aria-hidden="true">
          <div style={{ width: `${finding.meterPercent}%` }} />
        </div>
      ) : null}
      <p>{finding.deltaText}</p>
      <p>{finding.explanation}</p>
      {onOpenDay != null ? (
        <button type="button" className="compliance-open-day" onClick={() => onOpenDay(finding.mapDayUtc)}>
          Otevřít den v grafu
        </button>
      ) : null}
      <details>
        <summary>Technický údaj</summary>
        <p>{finding.technicalText}</p>
      </details>
    </article>
  )
}

function severityLabel(severity: ComplianceSeverity): string {
  if (severity === 'violation') return 'prokázané porušení'
  if (severity === 'uncertain') return 'nejistota'
  if (severity === 'incomplete') return 'neúplné nebo neuzavřené'
  return 'bez prokázaného porušení'
}
