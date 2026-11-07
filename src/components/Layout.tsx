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
        <img
          src="/logo.png"
          alt="Čtečka karet"
          className="app-logo"
          width={160}
          height={87}
        />
        <div className="app-identity">
          <h1 className="app-title">Čtečka karet verze 1.0</h1>
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
      <footer className="app-footer">
        <aside className="app-author">
          <div className="app-author-note">
            <p className="app-author-note-title">Ochrana dat a upozornění</p>
            <p>Data z karty řidiče nahráváte dobrovolně. Jejich zpracování probíhá lokálně ve vašem prohlížeči. Data nejsou odesílána na server ani ukládána do databáze provozovatele aplikace.</p>
            <p>Čtečka karet slouží jako informativní a analytická pomůcka. Výsledky vycházejí z dostupných záznamů tachografu a nemusí zohledňovat všechny okolnosti konkrétní přepravy. Nejedná se o úřední kontrolu ani závazné právní posouzení.</p>
            <p>Za správnost vstupních údajů a jejich oprávněné použití odpovídá uživatel.</p>
          </div>
          <div className="app-author-contact">
            <p className="app-author-name">Lukáš Mizera</p>
            <a className="app-author-mail" href="mailto:lukas@zmizik.com">lukas@zmizik.com</a>
          </div>
        </aside>
      </footer>
    </div>
  )
}
