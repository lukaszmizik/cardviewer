import { useState } from 'react'
import type { DriverCardData } from '../types/tacho'
import { WorkWeekGraphView } from '../WorkWeekGraphView'
import { cardToGraph } from '../utils/cardToGraph'
import type { ClockMode } from '../lib/clock'
import { TACHO_SYMBOLS } from '../TachoTypes'

type GraphViewProps = {
  data: DriverCardData | null
  onUploadCard: () => void
  focusedDayUtc?: number | null
}

export function GraphView({ data, onUploadCard, focusedDayUtc = null }: GraphViewProps) {
  const [clockMode, setClockMode] = useState<ClockMode>('local')

  if (!data) {
    return (
      <section className="app-content-card page-placeholder graph-empty">
        <h1>Graf aktivit</h1>
        <p>Nejdřív nahrajte výpis z karty řidiče. Pak se zde zobrazí směny, řízení, jiná práce, pohotovost, přestávky a manuální záznamy.</p>
        <button type="button" className="app-nav-btn is-active" onClick={onUploadCard}>
          Nahrát kartu
        </button>
      </section>
    )
  }

  const graph = cardToGraph(data, clockMode)

  return (
    <div className="graph-view">
      <WorkWeekGraphView
        days={graph.days}
        countryMarkers={graph.countryMarkers}
        manualEntryBuffer={graph.manualEntryBuffer}
        lastWithdrawalUtc={graph.lastWithdrawalUtc}
        loadUnloadEvents={graph.loadUnloadEvents}
        ferryTrainEvents={graph.ferryTrainEvents}
        outModeEvents={graph.outModeEvents}
        symbolMap={TACHO_SYMBOLS}
        recordedGpsLocations={graph.recordedGpsLocations}
        faultsAndEvents={graph.faultsAndEvents}
        embedded
        onClose={onUploadCard}
        clockMode={clockMode}
        onClockModeChange={setClockMode}
        card={data}
        initialFocusedDayUtc={focusedDayUtc}
      />
    </div>
  )
}
