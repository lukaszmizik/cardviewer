import type { ReactNode } from 'react'
import type { AppTab } from '../types/navigation'
import type { DriverCardData } from '../types/tacho'
import { driverDisplayName } from '../lib/placeholderCard'

const TABS: { id: AppTab; label: string }[] = [
  { id: 'dashboard', label: 'Úvod' },
  { id: 'graph', label: 'Graf aktivit' },
  { id: 'compliance', label: 'Kontrola přestupků' },
]

type LayoutProps = {
  currentTab: AppTab
  onTabChange: (tab: AppTab) => void
  card: DriverCardData | null
  children: ReactNode
}

export function Layout({ currentTab, onTabChange, card, children }: LayoutProps) {
  const statusText = card
    ? `Karta nahrána: ${driverDisplayName(card)}`
    : 'Žádná karta načtena'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <img src="/favicon.svg" alt="" className="app-logo" width={28} height={27} />
          <span className="app-title">TachoCard Viewer</span>
        </div>

        <nav className="app-nav" aria-label="Hlavní navigace">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={currentTab === tab.id ? 'app-nav-btn is-active' : 'app-nav-btn'}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <p
          className={card ? 'app-status app-status--ok' : 'app-status'}
          role="status"
        >
          {statusText}
        </p>
      </header>

      <main className="app-main">{children}</main>
    </div>
  )
}
