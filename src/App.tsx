import { useRef, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { Layout } from './components/Layout'
import { CompliancePage } from './pages/CompliancePage'
import { GraphPage } from './pages/GraphPage'
import type { DriverCardData } from './types/tacho'
import type { AppTab } from './types/navigation'
import { clearStoredRecentFiles, loadRecentFiles, rememberRecentFile, type RecentCardFile } from './lib/recentFiles'

function App() {
  const [currentTab, setCurrentTab] = useState<AppTab>('dashboard')
  const [card, setCard] = useState<DriverCardData | null>(null)
  const [recentFiles, setRecentFiles] = useState<RecentCardFile[]>(() => loadRecentFiles())
  const recentRef = useRef(recentFiles)
  recentRef.current = recentFiles
  const loadEpoch = useRef(0)

  function openCard(next: DriverCardData) {
    setCard(next)
    setCurrentTab('graph')
  }

  function clearBrowsingHistory() {
    loadEpoch.current += 1
    clearStoredRecentFiles()
    recentRef.current = []
    setCard(null)
    setRecentFiles([])
    setCurrentTab('dashboard')
  }

  function commitRecentCard(
    parsedJson: DriverCardData,
    fileName: string,
    raw: { bytes: Uint8Array; missingFiles: string[] } | undefined,
  ) {
    const next = rememberRecentFile(recentRef.current, fileName, parsedJson, raw, Date.now())
    recentRef.current = next
    setRecentFiles(next)
  }

  return (
    <Layout currentTab={currentTab} onTabChange={setCurrentTab} card={card}>
      <div hidden={currentTab !== 'dashboard'}>
        <Dashboard
          card={card}
          recentFiles={recentFiles}
          loadEpoch={() => loadEpoch.current}
          onClearBrowsingHistory={clearBrowsingHistory}
          onDataLoaded={(parsedJson, fileName, raw, epoch) => {
            if (epoch !== loadEpoch.current) return
            commitRecentCard(parsedJson, fileName, raw)
            openCard(parsedJson)
          }}
          onOpenRecent={(file) => {
            openCard(file.card)
          }}
        />
      </div>
      {currentTab === 'graph' && (
        <GraphPage data={card} onUploadCard={() => setCurrentTab('dashboard')} />
      )}
      {currentTab === 'compliance' && <CompliancePage />}
    </Layout>
  )
}

export default App
