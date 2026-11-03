import { useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { Layout } from './components/Layout'
import { CompliancePage } from './pages/CompliancePage'
import { GraphPage } from './pages/GraphPage'
import type { DriverCardData } from './types/tacho'
import type { AppTab } from './types/navigation'
import { clearStoredRecentFiles, loadRecentFiles, rememberRecentFile, type RecentCardFile } from './lib/recentFiles'
import type { DownloadedCardFile } from './lib/saveDownloadedDdd'

function App() {
  const [currentTab, setCurrentTab] = useState<AppTab>('dashboard')
  const [card, setCard] = useState<DriverCardData | null>(null)
  const [recentFiles, setRecentFiles] = useState<RecentCardFile[]>(() => loadRecentFiles())
  const [downloadedCard, setDownloadedCard] = useState<DownloadedCardFile | null>(null)
  const loadEpoch = useRef(0)

  function openCard(next: DriverCardData) {
    setCard(next)
    setCurrentTab('graph')
  }

  function clearBrowsingHistory() {
    loadEpoch.current += 1
    clearStoredRecentFiles()
    setCard(null)
    setRecentFiles([])
    setDownloadedCard(null)
    setCurrentTab('dashboard')
  }

  return (
    <Layout currentTab={currentTab} onTabChange={setCurrentTab} card={card}>
      {currentTab === 'dashboard' && (
        <Dashboard
          card={card}
          recentFiles={recentFiles}
          downloadedCard={downloadedCard}
          loadEpoch={() => loadEpoch.current}
          onClearBrowsingHistory={clearBrowsingHistory}
          onDataLoaded={(parsedJson, fileName, raw, epoch) => {
            if (epoch !== loadEpoch.current) return
            setRecentFiles((current) => rememberRecentFile(current, fileName, parsedJson))
            setDownloadedCard(
              raw ? { bytes: raw.bytes, missingFiles: raw.missingFiles, cardNumber: parsedJson.cardNumber } : null,
            )
            openCard(parsedJson)
          }}
          onOpenRecent={(file) => {
            setDownloadedCard(null)
            openCard(file.card)
          }}
        />
      )}
      {currentTab === 'graph' && (
        <GraphPage data={card} onUploadCard={() => setCurrentTab('dashboard')} />
      )}
      {currentTab === 'compliance' && <CompliancePage />}
    </Layout>
  )
}

export default App
