import type { DriverCardData } from '../types/tacho'
import type { ClockMode } from '../lib/clock'
import { formatClockDateTime } from '../lib/clock'
import { driverDisplayName } from '../lib/placeholderCard'

type CardInfoTableProps = {
  card: DriverCardData
  clockMode: ClockMode
}

const LANGUAGE_NAMES: Record<string, string> = {
  bg: 'bulharština',
  cs: 'čeština',
  da: 'dánština',
  de: 'němčina',
  el: 'řečtina',
  en: 'angličtina',
  es: 'španělština',
  et: 'estonština',
  fi: 'finština',
  fr: 'francouzština',
  hr: 'chorvatština',
  hu: 'maďarština',
  it: 'italština',
  lt: 'litevština',
  lv: 'lotyština',
  nl: 'nizozemština',
  pl: 'polština',
  pt: 'portugalština',
  ro: 'rumunština',
  sk: 'slovenština',
  sl: 'slovinština',
  sv: 'švédština',
}

function cell(value: string | null | undefined): string {
  const text = value?.trim()
  return text ? text : '—'
}

function languageCell(value: string | null | undefined): string {
  const text = value?.trim()
  if (!text) return '—'
  return LANGUAGE_NAMES[text.toLowerCase()] ?? text
}

function instant(ms: number | null | undefined, mode: ClockMode): string {
  if (ms == null) return '—'
  return formatClockDateTime(ms, mode)
}

export function CardInfoTable({ card, clockMode }: CardInfoTableProps) {
  const rows: Array<[string, string]> = [
    ['Držitel', cell(driverDisplayName(card))],
    ['Datum narození', cell(card.dateOfBirth)],
    ['Preferovaný jazyk', languageCell(card.preferredLanguage)],
    ['Číslo karty', cell(card.cardNumber)],
    ['Vydávající stát', cell(card.issuingCountry)],
    ['Vydávající úřad', cell(card.issuingAuthority)],
    ['Datum vydání', cell(card.dateOfIssue)],
    ['Platnost od', cell(card.validityBegin)],
    ['Platnost do', cell(card.dateOfExpiry)],
    ['Řidičský průkaz', cell(card.drivingLicenseNumber)],
    ['Průkaz vydal', cell(card.licenceIssuingAuthority)],
    ['Stát průkazu', cell(card.licenceIssuingCountry ?? card.nationality)],
    ['Poslední stažení', instant(card.lastCardDownloadUtc, clockMode)],
    ['Poslední vyjmutí', instant(card.lastWithdrawalUtc, clockMode)],
  ]

  return (
    <details className="work-week-graph-table-wrapper card-info-table-wrapper">
      <summary className="card-info-summary">
        <span className="card-info-summary-chevron" aria-hidden="true" />
        <span className="card-info-summary-text">
          <span className="card-info-summary-title">Karta řidiče</span>
          <span className="card-info-summary-meta">
            {driverDisplayName(card)}
            {card.cardNumber ? ` · ${card.cardNumber}` : ''}
          </span>
        </span>
      </summary>
      <table className="work-week-graph-table card-info-table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
