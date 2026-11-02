import type { ReactNode } from 'react'
import type { ClockMode } from '../lib/clock'
import { addDays, formatClockDateTime } from '../lib/clock'
import type { CardIncident, DriverCardData, LoadUnloadEntry, VehicleUse } from '../types/tacho'

type CardHistoryTablesProps = {
  card: DriverCardData
  weekStartMs: number
  clockMode: ClockMode
}

const LOAD_LABEL: Record<LoadUnloadEntry['kind'], string> = {
  load: 'Nakládka',
  unload: 'Vykládka',
  both: 'Nakládka a vykládka',
}

function formatKm(value: number | null): string {
  if (value == null) return '—'
  return `${new Intl.NumberFormat('cs-CZ').format(value)} km`
}

function overlapsWeek(fromUtc: number, toUtc: number, weekStart: number, weekEnd: number): boolean {
  return fromUtc < weekEnd && toUtc > weekStart
}

function HistoryTable({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card-history">
      <h3 className="card-history-title">{title}</h3>
      <div className="work-week-graph-table-wrapper">
        <table className="work-week-graph-table card-history-table">{children}</table>
      </div>
    </section>
  )
}

function emptyRow(columns: number) {
  return (
    <tr>
      <td colSpan={columns}>V tomto týdnu žádný záznam</td>
    </tr>
  )
}

function vehicleRows(uses: VehicleUse[], weekStart: number, weekEnd: number, mode: ClockMode) {
  return uses
    .filter((use) => overlapsWeek(use.fromUtc, use.toUtc, weekStart, weekEnd))
    .sort((a, b) => b.fromUtc - a.fromUtc)
    .map((use) => (
      <tr key={`${use.registration}-${use.fromUtc}`}>
        <td>{use.registration}</td>
        <td>{formatClockDateTime(use.fromUtc, mode)}</td>
        <td>{formatClockDateTime(use.toUtc, mode)}</td>
        <td>{formatKm(use.kilometers)}</td>
      </tr>
    ))
}

function incidentRows(items: CardIncident[], weekStart: number, weekEnd: number, mode: ClockMode) {
  return items
    .filter((item) => overlapsWeek(item.fromUtc, item.toUtc ?? item.fromUtc, weekStart, weekEnd))
    .sort((a, b) => b.fromUtc - a.fromUtc)
    .map((item) => (
      <tr key={`${item.typeLabel}-${item.fromUtc}-${item.registration ?? ''}`}>
        <td>{formatClockDateTime(item.fromUtc, mode)}</td>
        <td>{item.toUtc != null ? formatClockDateTime(item.toUtc, mode) : '—'}</td>
        <td>{item.registration ?? '—'}</td>
        <td>{item.typeLabel}</td>
      </tr>
    ))
}

export function CardHistoryTables({ card, weekStartMs, clockMode }: CardHistoryTablesProps) {
  const weekEnd = addDays(weekStartMs, 7, clockMode)
  const vehicles = vehicleRows(card.vehicleUses ?? [], weekStartMs, weekEnd, clockMode)
  const events = incidentRows(card.events ?? [], weekStartMs, weekEnd, clockMode)
  const faults = incidentRows(card.faults ?? [], weekStartMs, weekEnd, clockMode)
  const loads = (card.loadUnloadEntries ?? [])
    .filter((entry) => entry.atUtc >= weekStartMs && entry.atUtc < weekEnd)
    .sort((a, b) => b.atUtc - a.atUtc)
    .map((entry) => (
      <tr key={`${entry.kind}-${entry.atUtc}`}>
        <td>{formatClockDateTime(entry.atUtc, clockMode)}</td>
        <td>{LOAD_LABEL[entry.kind]}</td>
        <td>{formatKm(entry.odometerKm)}</td>
        <td>{entry.location ?? '—'}</td>
      </tr>
    ))

  return (
    <div className="card-history-group">
      <HistoryTable title="Historie použitých vozidel">
        <thead>
          <tr>
            <th>Vozidlo</th>
            <th>Od</th>
            <th>Do</th>
            <th>Najel km</th>
          </tr>
        </thead>
        <tbody>{vehicles.length > 0 ? vehicles : emptyRow(4)}</tbody>
      </HistoryTable>
      <HistoryTable title="Události">
        <thead>
          <tr>
            <th>Od</th>
            <th>Do</th>
            <th>Vozidlo</th>
            <th>Typ</th>
          </tr>
        </thead>
        <tbody>{events.length > 0 ? events : emptyRow(4)}</tbody>
      </HistoryTable>
      <HistoryTable title="Závady">
        <thead>
          <tr>
            <th>Od</th>
            <th>Do</th>
            <th>Vozidlo</th>
            <th>Typ</th>
          </tr>
        </thead>
        <tbody>{faults.length > 0 ? faults : emptyRow(4)}</tbody>
      </HistoryTable>
      <HistoryTable title="Zadané nakládky a vykládky">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Typ</th>
            <th>Stav km</th>
            <th>Lokace</th>
          </tr>
        </thead>
        <tbody>{loads.length > 0 ? loads : emptyRow(4)}</tbody>
      </HistoryTable>
    </div>
  )
}
