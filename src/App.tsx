import { useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { Layout } from './components/Layout'
import { CompliancePage } from './pages/CompliancePage'
import { GraphPage } from './pages/GraphPage'
import type { DriverCardData } from './types/tacho'
import type { AppTab } from './types/navigation'
import { loadRecentFiles, rememberRecentFile, type RecentCardFile } from './lib/recentFiles'

function App() {
  const [currentTab, setCurrentTab] = useState<AppTab>('dashboard')
  const [card, setCard] = useState<DriverCardData | null>(null)
  const [recentFiles, setRecentFiles] = useState<RecentCardFile[]>(() => loadRecentFiles())

  function openCard(next: DriverCardData) {
    setCard(next)
    setCurrentTab('graph')
  }

  return (
    <Layout currentTab={currentTab} onTabChange={setCurrentTab} card={card}>
      {currentTab === 'dashboard' && (
        <Dashboard
          card={card}
          recentFiles={recentFiles}
          onDataLoaded={(parsedJson, fileName) => {
            setRecentFiles((current) => rememberRecentFile(current, fileName, parsedJson))
            openCard(parsedJson)
          }}
          onOpenRecent={(file) => openCard(file.card)}
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
