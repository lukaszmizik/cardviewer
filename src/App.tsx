import { useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { Layout } from './components/Layout'
import { CompliancePage } from './pages/CompliancePage'
import { GraphPage } from './pages/GraphPage'
import { WorkPeriodsPage } from './pages/WorkPeriodsPage'
import type { DriverCardData } from './types/tacho'
import type { AppTab } from './types/navigation'
import { forgetStoredCards, type LoadedCardFile } from './lib/recentFiles'
import { dayStartMs } from './lib/clock'
import { CardSessionProvider, useCardSession } from './context/CardSessionContext'

function AppShell() {
  const { card, ingestLoadedCard, clearSessions } = useCardSession()
  const [currentTab, setCurrentTab] = useState<AppTab>('dashboard')
  const [graphDayUtc, setGraphDayUtc] = useState<number | null>(null)
  const [loadedFile, setLoadedFile] = useState<LoadedCardFile | null>(null)
  const loadEpoch = useRef(0)

  function dropLoadedCard() {
    loadEpoch.current += 1
    forgetStoredCards()
    clearSessions()
    setLoadedFile(null)
  }

  function clearBrowsingHistory() {
    dropLoadedCard()
    setCurrentTab('dashboard')
  }

  function commitLoadedCard(
    parsedJson: DriverCardData,
    fileName: string,
    raw: { bytes: Uint8Array; missingFiles: string[]; parserJson?: unknown },
  ) {
    const { session } = ingestLoadedCard(parsedJson, fileName, raw)
    setLoadedFile({
      fileName,
      loadedAt: session.loadedAt,
      bytes: raw.bytes.slice(),
      missingFiles: raw.missingFiles.slice(),
    })
    setGraphDayUtc(null)
    setCurrentTab('graph')
  }

  function openGraphOnDay(atUtc: number) {
    setGraphDayUtc(dayStartMs(atUtc, 'local'))
    setCurrentTab('graph')
  }

  function changeTab(tab: AppTab) {
    setCurrentTab(tab)
  }

  return (
    <Layout currentTab={currentTab} onTabChange={changeTab} card={card}>
      <div hidden={currentTab !== 'dashboard'}>
        <Dashboard
          card={card}
          loadedFile={loadedFile}
          loadEpoch={() => loadEpoch.current}
          onClearBrowsingHistory={clearBrowsingHistory}
          onDropLoadedCard={dropLoadedCard}
          onDataLoaded={(parsedJson, fileName, raw, epoch) => {
            if (epoch !== loadEpoch.current) return
            commitLoadedCard(parsedJson, fileName, raw)
          }}
        />
      </div>
      <div hidden={currentTab !== 'graph'}>
        <GraphPage data={card} onUploadCard={() => setCurrentTab('dashboard')} focusedDayUtc={graphDayUtc} />
      </div>
      <div hidden={currentTab !== 'work-periods'}>
        <WorkPeriodsPage card={card} />
      </div>
      <div hidden={currentTab !== 'compliance'}>
        <CompliancePage card={card} onOpenDay={openGraphOnDay} />
      </div>
    </Layout>
  )
}

export default function App() {
  return (
    <CardSessionProvider>
      <AppShell />
    </CardSessionProvider>
  )
}
