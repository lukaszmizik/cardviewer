import type { DriverCardData } from '../types/tacho'
import type { ClockMode } from '../lib/clock'
import { formatClockDateTime } from '../lib/clock'
import { driverDisplayName } from '../lib/placeholderCard'

type CardInfoTableProps = {
  card: DriverCardData
  clockMode: ClockMode
}

function cell(value: string | null | undefined): string {
  const text = value?.trim()
  return text ? text : '—'
}

function instant(ms: number | null | undefined, mode: ClockMode): string {
  if (ms == null) return '—'
  return formatClockDateTime(ms, mode)
}

export function CardInfoTable({ card, clockMode }: CardInfoTableProps) {
  const rows: Array<[string, string]> = [
    ['Držitel', cell(driverDisplayName(card))],
    ['Datum narození', cell(card.dateOfBirth)],
    ['Jazyk', cell(card.preferredLanguage)],
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
    <details className="work-week-graph-table-wrapper card-info-table-wrapper" open>
      <summary className="card-info-summary">Karta řidiče</summary>
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
