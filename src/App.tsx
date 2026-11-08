import { useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { Layout } from './components/Layout'
import { CompliancePage } from './pages/CompliancePage'
import { GraphPage } from './pages/GraphPage'
import type { DriverCardData } from './types/tacho'
import type { AppTab } from './types/navigation'
import { forgetStoredCards, type LoadedCardFile } from './lib/recentFiles'
import { dayStartMs } from './lib/clock'

function App() {
  const [currentTab, setCurrentTab] = useState<AppTab>('dashboard')
  const [graphDayUtc, setGraphDayUtc] = useState<number | null>(null)
  const [card, setCard] = useState<DriverCardData | null>(null)
  const [loadedFile, setLoadedFile] = useState<LoadedCardFile | null>(null)
  const loadEpoch = useRef(0)

  function openCard(next: DriverCardData) {
    setCard(next)
    setGraphDayUtc(null)
    setCurrentTab('graph')
  }

  function dropLoadedCard() {
    loadEpoch.current += 1
    forgetStoredCards()
    setCard(null)
    setLoadedFile(null)
  }

  function clearBrowsingHistory() {
    dropLoadedCard()
    setCurrentTab('dashboard')
  }

  function commitLoadedCard(
    parsedJson: DriverCardData,
    fileName: string,
    raw: { bytes: Uint8Array; missingFiles: string[] },
  ) {
    setLoadedFile({
      fileName,
      loadedAt: Date.now(),
      bytes: raw.bytes.slice(),
      missingFiles: raw.missingFiles.slice(),
    })
  }

  function openGraphOnDay(atUtc: number) {
    setGraphDayUtc(dayStartMs(atUtc, 'local'))
    setCurrentTab('graph')
  }

  function changeTab(tab: AppTab) {
    if (tab === 'graph') setGraphDayUtc(null)
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
            openCard(parsedJson)
          }}
        />
      </div>
      {currentTab === 'graph' && (
        <GraphPage data={card} onUploadCard={() => setCurrentTab('dashboard')} focusedDayUtc={graphDayUtc} />
      )}
      {currentTab === 'compliance' && <CompliancePage card={card} onOpenDay={openGraphOnDay} />}
    </Layout>
  )
}

export default App
