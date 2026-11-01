import { useState } from 'react'
import type { DriverCardData } from '../types/tacho'
import { driverDisplayName } from '../lib/placeholderCard'
import type { RecentCardFile } from '../lib/recentFiles'
import { FileUploader } from './FileUploader'

type DashboardProps = {
  card: DriverCardData | null
  recentFiles: RecentCardFile[]
  onDataLoaded: (parsedJson: DriverCardData, fileName: string) => void
  onOpenRecent: (file: RecentCardFile) => void
}

function formatLoadedAt(ms: number): string {
  return new Date(ms).toLocaleString('cs-CZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function Dashboard({ card, recentFiles, onDataLoaded, onOpenRecent }: DashboardProps) {
  const [usbDialogOpen, setUsbDialogOpen] = useState(false)

  return (
    <section className="app-content-card dashboard">
      <header className="dashboard-header">
        <h1>Import dat</h1>
        <p>Nahrajte soubor z karty řidiče (.ddd, .esm, .561) a pokračujte na graf aktivit nebo kontrolu přestupků.</p>
      </header>

      <div className="import-grid">
        <div className="import-panel import-panel--upload">
          <FileUploader onDataLoaded={onDataLoaded} />
          <button type="button" className="btn-accent" onClick={() => setUsbDialogOpen(true)}>
            Načíst ze čtečky USB
          </button>
        </div>

        <aside className="import-panel import-panel--recent" aria-label="Poslední načtené soubory">
          <h2 className="recent-files-title">Poslední načtené soubory</h2>
          {recentFiles.length === 0 ? (
            <p className="recent-files-empty">Zatím není načtený žádný soubor.</p>
          ) : (
            <ul className="recent-files-list">
              {recentFiles.map((file) => (
                <li key={file.id}>
                  <button type="button" className="recent-file-button" onClick={() => onOpenRecent(file)}>
                    <span className="recent-file-name">{file.fileName}</span>
                    <span className="recent-file-meta">
                      {[file.driverName, file.cardNumber].filter(Boolean).join(' · ') || 'Karta řidiče'}
                    </span>
                    <time className="recent-file-time" dateTime={new Date(file.loadedAt).toISOString()}>
                      {formatLoadedAt(file.loadedAt)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {card && (
        <div className="work-week-graph-table-wrapper dashboard-card-info">
          <table className="work-week-graph-table">
            <thead>
              <tr>
                <th colSpan={2}>Aktuálně načtená karta</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="work-week-graph-table-cell">Jméno</td>
                <td className="work-week-graph-table-cell">{driverDisplayName(card)}</td>
              </tr>
              <tr>
                <td className="work-week-graph-table-cell">Číslo karty</td>
                <td className="work-week-graph-table-cell">{card.cardNumber}</td>
              </tr>
              <tr>
                <td className="work-week-graph-table-cell">Platnost</td>
                <td className="work-week-graph-table-cell">{card.dateOfExpiry ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {usbDialogOpen && (
        <div
          className="work-week-graph-overlay"
          onClick={() => setUsbDialogOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="usb-reader-title"
        >
          <div className="usb-dialog" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="work-week-graph-close"
              onClick={() => setUsbDialogOpen(false)}
              aria-label="Zavřít"
            >
              ×
            </button>
            <h2 id="usb-reader-title" className="work-week-graph-title">
              Čtečka USB
            </h2>
            <p className="usb-dialog-text">
              Připojte čtečku karet, vložte kartu řidiče a potvrďte čtení. Přímé čtení ze zařízení doplníme později.
            </p>
            <div className="dashboard-actions">
              <button type="button" className="work-week-graph-nav-btn" onClick={() => setUsbDialogOpen(false)}>
                Zrušit
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
