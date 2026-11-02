import type { ReactNode } from 'react'
import type { AppTab } from '../types/navigation'
import type { DriverCardData } from '../types/tacho'
import { driverDisplayName } from '../lib/placeholderCard'

const TABS: { id: AppTab; label: string }[] = [
  { id: 'dashboard', label: 'Import dat' },
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
    ? `Karta načtena · ${driverDisplayName(card)}`
    : 'Žádná karta načtena'

  return (
    <div className="app-shell">
      <header className="app-header">
        <img src="/logo.png" alt="" className="app-logo" width={96} height={54} />
        <div className="app-identity">
          <h1 className="app-title">Čtečka karet v 1.0</h1>
        </div>
        <div className="app-tools">
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
            {card && <span className="app-status-dot" aria-hidden="true" />}
            {statusText}
          </p>
        </div>
      </header>

      <main className="app-main">{children}</main>
    </div>
  )
}
