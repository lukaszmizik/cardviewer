import { useMemo, useState } from 'react'
import { analyzeDriverActivities } from '../analysis/analyzeDriverActivities.ts'
import {
  buildDiagnosticExport,
  deriveDiagnosticCases,
  derivePeriodDiagnostics,
  type DiagnosticCase,
  type DiagnosticStatus,
  type PeriodBlocker,
  type PeriodDiagnostic,
} from '../analysis/diagnosticCases.ts'
import type { ConsecutiveWeeksResult } from '../analysis/consecutiveWeeks.ts'
import type { WeeklyAutomaticAssignment } from '../analysis/weeklyRestAssignment.ts'
import type { DriverCardData } from '../types/tacho.ts'

const STATUS_LABEL: Record<DiagnosticStatus, string> = {
  recorded_fact: 'Zaznamenaný údaj',
  multiple_interpretations: 'Více interpretací',
  insufficient_data: 'Nelze rozhodnout',
  not_implemented: 'Není implementováno',
}

const BLOCKER_LABEL: Record<PeriodBlocker, string> = {
  missing_implementation: 'Chybí implementace',
  missing_input: 'Chybí vstup',
  multiple_interpretations: 'Více interpretací',
  source_uncertainty: 'Nejistota dat',
}

type DiagnosticReviewProps = {
  card: DriverCardData | null
}

export function DiagnosticReview({ card }: DiagnosticReviewProps) {
  const [anchorText, setAnchorText] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})

  const anchorUtc = parseUtcAnchor(anchorText)
  const anchorInvalid = anchorText.trim() !== '' && anchorUtc == null
  const analysis = useMemo(() => {
    if (card == null) return null
    return analyzeDriverActivities({ card, dailyAnchorUtc: anchorUtc })
  }, [card, anchorUtc])
  const cases = useMemo(() => (analysis == null ? [] : deriveDiagnosticCases(analysis)), [analysis])
  const periods = useMemo(() => (analysis == null ? [] : derivePeriodDiagnostics(analysis)), [analysis])

  if (card == null) {
    return <p>Není načtená karta. Případy se odvozují až z jejích aktivit.</p>
  }

  return (
    <div className="diagnostic-review">
      <div className="diagnostic-toolbar">
        <label className="diagnostic-anchor">
          Kotva UTC
          <input
            value={anchorText}
            onChange={(event) => setAnchorText(event.target.value)}
            placeholder="2026-03-02T06:00:00Z"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          onClick={() => downloadCases(cases, periods, notes, analysis?.weeklyAssignment ?? null, analysis?.consecutiveWeeks ?? null)}
          disabled={cases.length === 0}
        >
          Exportovat JSON
        </button>
      </div>
      {anchorInvalid ? <p className="diagnostic-hint">Kotva musí být čas v UTC, například 2026-03-02T06:00:00Z.</p> : null}
      {analysis?.assessed.daily.status === 'assessed' ? (
        <p className="diagnostic-hint">
          {analysis.assessed.daily.anchorOrigin === 'explicit'
            ? `Denní řetězec používá zadanou kotvu ${new Date(analysis.assessed.daily.anchorUtc).toISOString()}.`
            : `Denní řetězec začíná v ${new Date(analysis.assessed.daily.anchorUtc).toISOString()}, na konci prvního odpočinku dlouhého alespoň 11 hodin.`}{' '}
          Dosažený stav řetězce neznamená, že je vyhodnocená celá historie.
        </p>
      ) : null}
      <p className="diagnostic-hint">
        Délka odpočinku není právně potvrzený odpočinek. Přestupky se zde nevytvářejí.
      </p>
      {analysis != null ? <WeeklyOverview assignment={analysis.weeklyAssignment} consecutive={analysis.consecutiveWeeks} /> : null}
      <h3>Konkrétní odpočinky a období</h3>
      <ol className="diagnostic-list">
        {periods.map((item) => (
          <li key={item.id} className="diagnostic-case">
            <div className="diagnostic-case-head">
              <span className={`diagnostic-status diagnostic-status-${item.blocker}`}>{BLOCKER_LABEL[item.blocker]}</span>
              <span className="diagnostic-module">{item.module}</span>
            </div>
            <p>{formatInterval(item)}</p>
            {item.sourceActivityIds.length > 0 ? <p>Zdroje: {item.sourceActivityIds.join(', ')}</p> : null}
            <p>Jistě: {item.established.join(' ')}</p>
            <p>Varianty: {item.variants.length === 0 ? 'Modul žádné varianty nevrátil.' : item.variants.join(' | ')}</p>
            <p>{item.blockedBy}</p>
            <p>Další krok: {item.nextStep}</p>
            <label className="diagnostic-note">
              Poznámka
              <textarea
                value={notes[item.id] ?? ''}
                onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
                rows={2}
              />
            </label>
          </li>
        ))}
      </ol>
      <h3>Souhrn modulů</h3>
      <ol className="diagnostic-list">
        {cases.map((item) => (
          <li key={item.id} className="diagnostic-case">
            <div className="diagnostic-case-head">
              <span className={`diagnostic-status diagnostic-status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
              <span className="diagnostic-module">{item.module}</span>
            </div>
            <p className="diagnostic-summary">{item.summary}</p>
            <p>{formatInterval(item)}</p>
            {item.sourceActivityIds.length > 0 ? <p>Zdroje: {item.sourceActivityIds.join(', ')}</p> : null}
            <p>{item.reason}</p>
            <p>Potřeba: {item.needed}</p>
            <label className="diagnostic-note">
              Poznámka
              <textarea
                value={notes[item.id] ?? ''}
                onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
                rows={2}
              />
            </label>
          </li>
        ))}
      </ol>
    </div>
  )
}

function parseUtcAnchor(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(trimmed)) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function formatInterval(item: Pick<DiagnosticCase, 'startUtc' | 'endUtc'>): string {
  if (item.startUtc == null || item.endUtc == null) return 'Bez konkrétního intervalu'
  return `${new Date(item.startUtc).toISOString()} – ${new Date(item.endUtc).toISOString()}`
}

function WeeklyOverview({
  assignment,
  consecutive,
}: {
  assignment: WeeklyAutomaticAssignment
  consecutive: ConsecutiveWeeksResult
}) {
  const suggested = assignment.recommendation.status === 'suggested' ? assignment.recommendation.nodeIds : []
  const branches = assignment.nodes.filter((node) => node.nextOnTime.length > 1)
  const longRests = assignment.nodes.filter((node) => node.weekChoice === 'continuous_cover')
  return (
    <section className="diagnostic-review">
      <h3>Týdenní odpočinky</h3>
      <p>
        {assignment.recommendation.status === 'suggested' ? 'Doporučení k zobrazení' : 'Nerozhodnuto'}: {assignment.recommendation.reason}
      </p>
      <p>
        Kandidátů {assignment.nodes.length}, z toho nepřerušených přes více týdnů {longRests.length}. Začátků bez
        předchozí návaznosti {assignment.rootIds.length}, kroků s více včasnými pokračováními {branches.length}. Právní
        závěr to není.
      </p>
      <p>
        Dva sousední týdny, pondělí 00:00 UTC: splněno {consecutive.counts.satisfied}, základní pravidlo nesplněno{' '}
        {consecutive.counts.not_satisfied_basic_rule}, závisí na výkladu {consecutive.counts.ambiguous}, chybí údaje{' '}
        {consecutive.counts.insufficient_data}, nevyhodnoceno {consecutive.counts.not_evaluated}, nepřetržitě odpočívá{' '}
        {consecutive.counts.resting_throughout}. Nepřetržitý odpočinek není splnění čl. 8 odst. 6. Přestupek se neposuzuje.
      </p>
      {consecutive.periods
        .filter((period) => period.status === 'resting_throughout')
        .map((period) => (
          <p key={`${period.earlierWeek.startUtc}-${period.laterWeek.startUtc}`}>
            {new Date(period.earlierWeek.startUtc).toISOString()} – {new Date(period.laterWeek.endUtc).toISOString()}: pokrývá{' '}
            {new Date(period.cover.startUtc).toISOString()} – {new Date(period.cover.endUtc).toISOString()}. Rezerva před{' '}
            {formatMargin(period.cover.marginBeforeMs)}, po {formatMargin(period.cover.marginAfterMs)}. Skladba se neposuzuje.
          </p>
        ))}
      {consecutive.periods
        .filter((period) => period.needsController)
        .slice(0, 3)
        .map((period) => (
          <p key={`${period.earlierWeek.startUtc}-${period.laterWeek.startUtc}`}>
            {new Date(period.earlierWeek.startUtc).toISOString()} – {new Date(period.laterWeek.endUtc).toISOString()}:{' '}
            {period.reason}
          </p>
        ))}
      {suggested.length > 0 ? (
        <p>
          Konce doporučené větve:{' '}
          {assignment.suggestedBoundaryEndsUtc.slice(0, 8).map((utc) => new Date(utc).toISOString()).join(', ')}
          {assignment.suggestedBoundaryEndsUtc.length > 8 ? ` a dalších ${assignment.suggestedBoundaryEndsUtc.length - 8}` : ''}
        </p>
      ) : null}
    </section>
  )
}

function formatMargin(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
}

function downloadCases(
  cases: readonly DiagnosticCase[],
  periods: readonly PeriodDiagnostic[],
  notes: Readonly<Record<string, string>>,
  weeklyAssignment: WeeklyAutomaticAssignment | null,
  consecutiveWeeks: ConsecutiveWeeksResult | null,
): void {
  const payload = buildDiagnosticExport(cases, periods, notes, new Date().toISOString(), weeklyAssignment, consecutiveWeeks)
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'diagnostika-pripadu.json'
  link.click()
  URL.revokeObjectURL(url)
}
