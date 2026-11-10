import { useMemo, useState } from 'react'
import {
  ComplianceCalendarPicker,
  buildCalendarBuckets,
  daySlotsBetween,
  workPeriodCalendarMode,
  type CalendarDay,
} from '../components/complianceCalendar.tsx'
import type { ComplianceSeverity } from '../components/complianceReview.ts'
import { formatActivityDuration } from '../lib/activityPresentation'
import { addDays, dayStartMs, formatClockDate, formatClockDateTime, type ClockMode } from '../lib/clock'
import type { DriverCardData } from '../types/tacho'
import {
  buildWorkPeriodOverview,
  type BoundaryReliability,
  type SeparatingRestPartView,
  type SeparatingRestSummary,
  type WorkPeriodOverviewModel,
  type WorkPeriodPresentationItem,
} from '../presentation/workPeriodOverview'
import { useCardSession } from '../context/CardSessionContext'

const KIND_LABEL: Record<string, string> = {
  driving: 'Řízení',
  work: 'Jiná práce',
  availability: 'Pohotovost',
  rest: 'Odpočinek',
  unknown: 'Neznámé',
}

type WorkPeriodsPageProps = {
  card: DriverCardData | null
}

function boundaryLabel(reliability: BoundaryReliability): string {
  if (reliability === 'confirmed') return 'Vyšší spolehlivost (zaznamenaný odpočinek)'
  if (reliability === 'preliminary') return 'Předběžná'
  return 'Otevřená (konec obálky práce)'
}

const EVIDENCE_LABEL: Record<string, string> = {
  activity_recorded: 'Zaznamenané REST aktivity',
  card_absence_hint: 'Doplněk přes card_present',
  coverage_gap: 'Překryv s mezerou v denních záznamech',
  unknown_affected: 'Unknown v intervalu odpočinku',
}

function restPartLine(part: SeparatingRestPartView, index: number, many: boolean): string {
  const label = many ? `část ${index + 1}: ` : ''
  return `${label}${formatClockDateTime(part.startUtc, 'local')} – ${formatClockDateTime(part.endUtc, 'local')}`
}

function SeparatingRestDetails({ rest }: { rest: SeparatingRestSummary }) {
  const split = rest.variant === 'split_regular' || rest.parts.length > 1
  return (
    <div>
      <dt>Odpočinek oddělující další období</dt>
      <dd>
        {split ? (
          <>
            {rest.parts.map((part, index) => (
              <span key={`${part.startUtc}-${part.endUtc}`}>
                {index > 0 ? '; ' : ''}
                {restPartLine(part, index, true)}
              </span>
            ))}
          </>
        ) : (
          restPartLine(rest.parts[0] ?? { startUtc: rest.startUtc, endUtc: rest.endUtc, durationMs: rest.durationMs }, 0, false)
        )}{' '}
        ({rest.durationCategoryText}
        ){rest.slot != null ? `, slot ${rest.slot}` : ''}.{' '}
        {EVIDENCE_LABEL[rest.evidenceBasis] ?? rest.evidenceBasis}
        {rest.cardPresentSupport !== 'none' ? ` · card_present: ${rest.cardPresentSupport}` : ''}
        {rest.alternatives.length > 0 && (
          <span className="work-period-alternatives">
            {' '}
            Další kandidátní výklady, nejsou právní potvrzení:{' '}
            {rest.alternatives.map((alternative, index) => (
              <span key={`${alternative.variant}-${index}`}>
                {index > 0 ? '; ' : ''}
                {alternative.label}
                {' ('}
                {alternative.parts.map((part, partIndex) => (
                  <span key={`${part.startUtc}-${part.endUtc}`}>
                    {partIndex > 0 ? '; ' : ''}
                    {restPartLine(part, partIndex, alternative.parts.length > 1)}
                  </span>
                ))}
                {')'}
              </span>
            ))}
            .
          </span>
        )}
      </dd>
    </div>
  )
}

function periodEvidenceLabel(period: WorkPeriodPresentationItem): string {
  if (
    period.startBoundaryReliability === 'preliminary' ||
    period.endBoundaryReliability === 'preliminary' ||
    period.preliminaryBoundaryNotes.length > 0
  ) {
    return 'Předběžné — nedostatečné důkazy nebo nejistota u odpočinku'
  }
  if (period.startBoundaryReliability === 'confirmed' && period.endBoundaryReliability === 'confirmed') {
    return 'Hranice odděleny kvalifikovaným odpočinkem ze záznamu aktivit'
  }
  return 'Otevřené hranice obálky práce'
}

function PeriodCard({ period }: { period: WorkPeriodPresentationItem }) {
  const [open, setOpen] = useState(false)
  const s = period.summary

  return (
    <article className="work-period-card">
      <header className="work-period-card__header">
        <h3 className="work-period-card__title">
          Pracovní období #{period.index}
          {(period.startBoundaryReliability === 'preliminary' ||
            period.endBoundaryReliability === 'preliminary') && (
            <span className="work-period-badge work-period-badge--preliminary"> předběžné hranice</span>
          )}
        </h3>
        <p className="work-period-card__range">
          {formatClockDateTime(period.startUtc, 'local')} – {formatClockDateTime(period.endUtc, 'local')}
        </p>
        <p className="work-period-card__duration">
          Délka: {formatActivityDuration(Math.round(period.durationMs / 60_000))}
        </p>
      </header>

      <dl className="work-period-dl">
        <div>
          <dt>Souhrn činností (překryv s obdobím)</dt>
          <dd>
            řízení {formatActivityDuration(s.drivingMinutes)}, práce {formatActivityDuration(s.workMinutes)},
            pohotovost {formatActivityDuration(s.availabilityMinutes)}, odpočinek{' '}
            {formatActivityDuration(s.restMinutes)}
            {s.unknownMinutes > 0 ? `, neznámé ${formatActivityDuration(s.unknownMinutes)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Důkazní spolehlivost</dt>
          <dd>{periodEvidenceLabel(period)}</dd>
        </div>
        <div>
          <dt>Počáteční hranice</dt>
          <dd>{boundaryLabel(period.startBoundaryReliability)}</dd>
        </div>
        <div>
          <dt>Koncová hranice</dt>
          <dd>{boundaryLabel(period.endBoundaryReliability)}</dd>
        </div>
        {period.overlappingCoverageGaps.length > 0 && (
          <div>
            <dt>Chybějící denní záznamy v období</dt>
            <dd className="work-period-gap-list">
              {period.overlappingCoverageGaps.map((gap) => (
                <span key={gap.id} className="work-period-gap-chip">
                  {gap.id}: {gap.calendarDaysBetween} dní (
                  {formatClockDateTime(gap.startUtc, 'local')} – {formatClockDateTime(gap.endUtc, 'local')})
                </span>
              ))}
            </dd>
          </div>
        )}
        {period.preliminaryBoundaryNotes.length > 0 && (
          <div>
            <dt>Poznámky k hranicím</dt>
            <dd>{period.preliminaryBoundaryNotes.join(' · ')}</dd>
          </div>
        )}
        {period.separatingRest && <SeparatingRestDetails rest={period.separatingRest} />}
      </dl>

      <button type="button" className="btn-accent work-period-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? 'Skrýt činnosti' : `Zobrazit činnosti (${period.activities.length})`}
      </button>

      {open && (
        <table className="work-period-activities">
          <thead>
            <tr>
              <th>Od</th>
              <th>Do</th>
              <th>Druh</th>
              <th>Slot</th>
              <th>Délka</th>
            </tr>
          </thead>
          <tbody>
            {period.activities.map((activity) => (
              <tr key={activity.id}>
                <td>{formatClockDateTime(activity.startUtc, 'local')}</td>
                <td>{formatClockDateTime(activity.endUtc, 'local')}</td>
                <td>{KIND_LABEL[activity.kind] ?? activity.kind}</td>
                <td>{activity.slot ?? '—'}</td>
                <td>{formatActivityDuration(activity.durationMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  )
}

function periodOverlapsDay(period: WorkPeriodPresentationItem, dayStartUtc: number, clockMode: ClockMode): boolean {
  const dayEndUtc = addDays(dayStartUtc, 1, clockMode)
  return period.startUtc < dayEndUtc && period.endUtc > dayStartUtc
}

function periodDaySeverity(periods: readonly WorkPeriodPresentationItem[]): ComplianceSeverity {
  if (periods.length === 0) return 'incomplete'
  const preliminary = periods.some(
    (period) =>
      period.startBoundaryReliability === 'preliminary'
      || period.endBoundaryReliability === 'preliminary'
      || period.preliminaryBoundaryNotes.length > 0
      || period.overlappingCoverageGaps.length > 0,
  )
  if (preliminary) return 'uncertain'
  const open = periods.some(
    (period) => period.startBoundaryReliability === 'open' || period.endBoundaryReliability === 'open',
  )
  if (open) return 'incomplete'
  return 'clear'
}

function buildWorkPeriodCalendarDays(
  overview: WorkPeriodOverviewModel,
  clockMode: ClockMode,
): CalendarDay[] {
  const envelopeStart = overview.envelopeStartUtc
  const envelopeEnd = overview.envelopeEndUtc
  if (envelopeStart == null || envelopeEnd == null) return []
  const rangeStart = dayStartMs(envelopeStart, clockMode)
  const rangeEnd = dayStartMs(envelopeEnd, clockMode)
  const slots = daySlotsBetween(rangeStart, rangeEnd, clockMode)
  return slots.map((dayStartUtc) => {
    const periods = overview.periods.filter((period) => periodOverlapsDay(period, dayStartUtc, clockMode))
    const count = periods.length
    return {
      dayStartUtc,
      label: formatClockDate(dayStartUtc, clockMode),
      severity: periodDaySeverity(periods),
      note: count === 0 ? 'Žádné pracovní období' : `${count} období`,
    }
  })
}

export function WorkPeriodsPage({ card }: WorkPeriodsPageProps) {
  const { getAnalytics, session } = useCardSession()
  const [clockMode] = useState<ClockMode>('local')
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [openBucket, setOpenBucket] = useState<string | null>(null)
  const overview = useMemo(() => {
    if (!card) return null
    const settingsKey = session == null ? 'no-session' : `rev-${session.revision}`
    return getAnalytics('workPeriodOverview', settingsKey, () => buildWorkPeriodOverview(card))
  }, [card, getAnalytics, session])

  const calendarDays = useMemo(
    () => (overview == null ? [] : buildWorkPeriodCalendarDays(overview, clockMode)),
    [overview, clockMode],
  )
  const mapMode = useMemo(() => workPeriodCalendarMode(calendarDays.length), [calendarDays.length])
  const buckets = useMemo(
    () => (mapMode === 'days' ? [] : buildCalendarBuckets(calendarDays, mapMode, clockMode)),
    [calendarDays, mapMode, clockMode],
  )
  const activeBucket = buckets.find((item) => item.id === openBucket) ?? null
  const visiblePeriods = useMemo(() => {
    if (overview == null) return []
    return overview.periods.filter((period) => {
      if (selectedDay != null) return periodOverlapsDay(period, selectedDay, clockMode)
      if (activeBucket != null) {
        return activeBucket.dayStarts.some((dayStartUtc) => periodOverlapsDay(period, dayStartUtc, clockMode))
      }
      return true
    })
  }, [overview, selectedDay, activeBucket, clockMode])

  return (
    <section className="app-content-card work-periods-page">
      <p className="work-period-debug-notice" role="note">
        Upozornění: Tato stránka zobrazuje technická diagnostická data určená pro ladění aplikace.
        Texty nejsou uživatelsky srozumitelné a neslouží jako právní hodnocení tachografu.
      </p>
      <header className="dashboard-header">
        <h1>Přehled pracovních období</h1>
        <p>
          Období vycházejí z obálky práce a kvalifikovaných odpočinků (≥9 h ze záznamu REST). Nejisté hranice
          (mezery v zápisech, unknown, ruční záznam) jsou předběžné — ne jde o automatické právní potvrzení.
        </p>
      </header>

      {card == null ? (
        <p>Nejdřív nahrajte kartu řidiče.</p>
      ) : overview == null || overview.periods.length === 0 ? (
        <p>
          Pro tuto kartu nebylo možné sestavit pracovní období (chybí obálka práce nebo v ní nejsou použitelné
          úseky).
        </p>
      ) : (
        <>
          <p className="work-period-meta">
            Obálka: {formatClockDateTime(overview.envelopeStartUtc!, clockMode)} –{' '}
            {formatClockDateTime(overview.envelopeEndUtc!, clockMode)} · hranic z odpočinků:{' '}
            {overview.restBoundaryCount} · dataComplete={String(overview.dataComplete)}
          </p>
          <div className="compliance-review work-period-calendar">
            <p className="compliance-note">
              Vyberte měsíc nebo den v kalendáři. Zeleně jsou období s potvrzenými hranicemi, oranžově předběžná,
              šedě dny bez období nebo s otevřenou obálkou.
            </p>
            <ComplianceCalendarPicker
              days={calendarDays}
              mapMode={mapMode}
              buckets={buckets}
              selectedDay={selectedDay}
              openBucket={openBucket}
              onSelectDay={setSelectedDay}
              onSelectBucket={(id) => {
                setOpenBucket(id)
                setSelectedDay(null)
              }}
            />
          </div>
          {selectedDay != null || activeBucket != null ? (
            <p className="compliance-note">
              Zobrazeno {visiblePeriods.length} z {overview.periods.length} pracovních období.
            </p>
          ) : null}
          {visiblePeriods.length === 0 ? (
            <p className="compliance-empty">Ve zvoleném dni nebo měsíci není žádné pracovní období.</p>
          ) : null}
          <ol className="work-period-list">
            {visiblePeriods.map((period) => (
              <li key={period.id}>
                <PeriodCard period={period} />
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
