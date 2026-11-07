import { useMemo, useState } from 'react'
import { acceptCrewBreakConfirmation, type CrewBreakConfirmation } from '../analysis/drivingBreaks.ts'
import { DiagnosticReview } from './DiagnosticReview.tsx'
import { buildComplianceDiagnostic, buildComplianceReview, type ComplianceCrewInterval, type ComplianceFinding, type CompliancePeriodMode, type CompliancePeriodRequest, type ComplianceSeverity } from './complianceReview.ts'
import type { ClockMode } from '../lib/clock.ts'
import type { Activity, DriverCardData } from '../types/tacho.ts'

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
  const [periodMode, setPeriodMode] = useState<CompliancePeriodMode>('recent')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [openBucket, setOpenBucket] = useState<string | null>(null)
  const [technical, setTechnical] = useState<{ key: string; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmations, setConfirmations] = useState<CrewBreakConfirmation[]>([])
  const period = useMemo(() => periodRequest(periodMode, fromDate, toDate, clockMode), [periodMode, fromDate, toDate, clockMode])
  const review = useMemo(
    () => buildComplianceReview({ activities, nowUtc, clockMode, period, confirmedCrewBreaks: confirmations }),
    [activities, nowUtc, clockMode, period, confirmations],
  )
  const bucket = review.buckets.find((item) => item.id === openBucket) ?? null
  const visible = review.findings.filter((finding) => {
    if (filter === 'violation' && finding.severity !== 'violation') return false
    if (filter === 'uncertain' && finding.severity !== 'uncertain') return false
    if (selectedDay != null && finding.mapDayUtc !== selectedDay) return false
    if (selectedDay == null && bucket != null && !bucket.dayStarts.includes(finding.mapDayUtc)) return false
    return true
  })
  const selected = review.days.find((day) => day.dayStartUtc === selectedDay) ?? null
  const technicalKey = `${clockMode}:${nowUtc}:${activities.length}:${review.periodMode}:${review.periodStartUtc}:${review.periodEndUtc}`
  const technicalText = technical?.key === technicalKey ? technical.text : null
  const diagnosticSource = useMemo(
    () => (technicalText == null ? null : diagnosticCard(activities)),
    [technicalText, activities],
  )

  return (
    <div className="compliance-review">
      <div className="compliance-toolbar">
        <div className="compliance-filters" role="tablist" aria-label="Období kontroly">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={periodMode === item.id ? 'is-active' : undefined}
              aria-pressed={periodMode === item.id}
              onClick={() => {
                setPeriodMode(item.id)
                setSelectedDay(null)
                setOpenBucket(null)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {periodMode === 'custom' ? (
          <div className="compliance-filters">
            <label className="compliance-clock">
              Od
              <input type="date" value={fromDate} onChange={(event) => { setFromDate(event.target.value); setSelectedDay(null); setOpenBucket(null) }} />
            </label>
            <label className="compliance-clock">
              Do
              <input type="date" value={toDate} onChange={(event) => { setToDate(event.target.value); setSelectedDay(null); setOpenBucket(null) }} />
            </label>
          </div>
        ) : null}
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
      {review.rangeNote != null && review.days.length > 0 ? <p className="compliance-note">{review.rangeNote}</p> : null}
      {review.unevaluatedNotes.map((note) => (
        <p key={note} className="compliance-note">{note}</p>
      ))}
      {review.dailyWindowNotes.length > 0 ? (
        <details className="compliance-technical">
          <summary>Použitá 30hodinová okna ({review.dailyWindowNotes.length})</summary>
          {review.dailyWindowNotes.map((note) => (
            <p key={note} className="compliance-note">{note}</p>
          ))}
        </details>
      ) : null}
      {review.mapMode === 'days' ? (
        <DayMap days={review.days} selectedDay={selectedDay} onSelect={setSelectedDay} />
      ) : (
        <div className="compliance-map compliance-map-buckets" role="list" aria-label={review.mapMode === 'weeks' ? 'Mapa týdnů' : 'Mapa měsíců'}>
          {review.buckets.map((item) => (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className={`compliance-day compliance-bucket compliance-day-${item.severity}${openBucket === item.id ? ' is-selected' : ''}`}
              aria-pressed={openBucket === item.id}
              title={`${item.label}: ${severityLabel(item.severity)}`}
              onClick={() => {
                setOpenBucket((current) => (current === item.id ? null : item.id))
                setSelectedDay(null)
              }}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
      {bucket != null ? (
        <DayMap
          days={review.days.filter((day) => bucket.dayStarts.includes(day.dayStartUtc))}
          selectedDay={selectedDay}
          onSelect={setSelectedDay}
        />
      ) : null}
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
      {selected?.note != null ? <p className="compliance-note">{selected.label}: {selected.note}</p> : null}
      {visible.length === 0 ? <p className="compliance-empty">Ve zvoleném filtru není žádné zjištění.</p> : null}
      <div className="compliance-cards">
        {visible.map((finding) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            onOpenDay={onOpenDay}
            onConfirm={(confirmation) => {
              setConfirmations((current) => current.some((item) => sameConfirmation(item, confirmation)) ? current : [...current, confirmation])
            }}
            onRevoke={(interval) => {
              setConfirmations((current) => current.filter((item) => !sameConfirmation(item, interval)))
            }}
          />
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
      <section className="compliance-diagnostic">
        <button
          type="button"
          onClick={() => {
            const payload = buildComplianceDiagnostic({ activities, nowUtc, clockMode, period })
            setCopied(false)
            setTechnical({ key: technicalKey, text: JSON.stringify(payload, null, 2) })
          }}
        >
          Generovat technická data
        </button>
        {technicalText == null ? null : (
          <details className="compliance-technical" open>
            <summary>Technická data</summary>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(technicalText).then(() => setCopied(true))
              }}
            >
              {copied ? 'Zkopírováno' : 'Kopírovat JSON'}
            </button>
            <pre>{technicalText}</pre>
            <DiagnosticReview card={diagnosticSource} onOpenDay={onOpenDay} />
          </details>
        )}
      </section>
    </div>
  )
}

const PERIODS: { id: CompliancePeriodMode; label: string }[] = [
  { id: 'recent', label: '56 dnů a dnešek' },
  { id: 'history', label: 'Celá historie' },
  { id: 'custom', label: 'Vlastní období' },
]

function periodRequest(mode: CompliancePeriodMode, fromDate: string, toDate: string, clockMode: ClockMode): CompliancePeriodRequest {
  if (mode === 'history') return { mode: 'history' }
  if (mode === 'custom') {
    return { mode: 'custom', fromUtc: dateInputUtc(fromDate, clockMode) ?? Number.NaN, toUtc: dateInputUtc(toDate, clockMode) ?? Number.NaN }
  }
  return { mode: 'recent' }
}

function dateInputUtc(value: string, clockMode: ClockMode): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match == null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  if (clockMode === 'utc') return Date.UTC(year, month - 1, day)
  return new Date(year, month - 1, day).getTime()
}

function DayMap({
  days,
  selectedDay,
  onSelect,
}: {
  days: { dayStartUtc: number; label: string; severity: ComplianceSeverity; note: string | null }[]
  selectedDay: number | null
  onSelect: (dayStartUtc: number | null) => void
}) {
  return (
    <div className="compliance-map" role="list" aria-label="Mapa dnů">
      {days.map((day) => (
        <button
          key={day.dayStartUtc}
          type="button"
          role="listitem"
          className={`compliance-day compliance-day-${day.severity}${selectedDay === day.dayStartUtc ? ' is-selected' : ''}`}
          aria-pressed={selectedDay === day.dayStartUtc}
          title={`${day.label}: ${severityLabel(day.severity)}${day.note == null ? '' : `. ${day.note}`}`}
          onClick={() => onSelect(selectedDay === day.dayStartUtc ? null : day.dayStartUtc)}
        >
          <span>{day.label.slice(0, 2)}</span>
        </button>
      ))}
    </div>
  )
}

function diagnosticCard(activities: readonly Activity[]): DriverCardData {
  return {
    cardNumber: '',
    firstName: '',
    surname: '',
    lastWithdrawalUtc: null,
    activities: activities.map((activity) => ({ ...activity, registration: undefined })),
    locations: [],
    violations: [],
  }
}

function sameConfirmation(
  left: { startUtc: number; endUtc: number; sourceActivityIds: readonly string[] },
  right: { startUtc: number; endUtc: number; sourceActivityIds: readonly string[] },
): boolean {
  return left.startUtc === right.startUtc
    && left.endUtc === right.endUtc
    && left.sourceActivityIds.join(',') === right.sourceActivityIds.join(',')
}

function FindingCard({
  finding,
  onOpenDay,
  onConfirm,
  onRevoke,
}: {
  finding: ComplianceFinding
  onOpenDay?: (atUtc: number) => void
  onConfirm: (confirmation: CrewBreakConfirmation) => void
  onRevoke: (interval: ComplianceCrewInterval) => void
}) {
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
      {finding.crewBreakIntervals?.map((interval) => {
        const key = `${interval.startUtc}:${interval.endUtc}:${interval.sourceActivityIds.join(',')}`
        return (
          <fieldset key={key} className="compliance-confirm">
            <legend>{interval.intervalText}</legend>
            <label>
              <input
                type="checkbox"
                checked={interval.confirmed}
                onChange={(event) => {
                  if (event.target.checked) {
                    const accepted = acceptCrewBreakConfirmation(interval, { secondDriverDrove: true, didNotAssist: true })
                    if (accepted != null) onConfirm(accepted)
                    return
                  }
                  onRevoke(interval)
                }}
              />
              Potvrzuji přestávku v režimu osádky.
            </label>
            <p>Vozidlo řídil druhý řidič a během přestávky jsem mu nepomáhal při řízení.</p>
          </fieldset>
        )
      })}
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
  return 'vyhodnoceno bez porušení'
}
