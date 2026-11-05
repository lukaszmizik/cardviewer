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
        <button type="button" onClick={() => downloadCases(cases, periods, notes)} disabled={cases.length === 0}>
          Exportovat JSON
        </button>
      </div>
      {anchorInvalid ? <p className="diagnostic-hint">Kotva musí být čas v UTC, například 2026-03-02T06:00:00Z.</p> : null}
      <p className="diagnostic-hint">
        Délka odpočinku není právně potvrzený odpočinek. Přestupky se zde nevytvářejí.
      </p>
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

function downloadCases(
  cases: readonly DiagnosticCase[],
  periods: readonly PeriodDiagnostic[],
  notes: Readonly<Record<string, string>>,
): void {
  const payload = buildDiagnosticExport(cases, periods, notes, new Date().toISOString())
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'diagnostika-pripadu.json'
  link.click()
  URL.revokeObjectURL(url)
}
