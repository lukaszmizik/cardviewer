import { useState } from 'react'
import type { DriverCardData } from '../types/tacho'
import { driverDisplayName } from '../lib/placeholderCard'
import type { RecentCardFile } from '../lib/recentFiles'
import { CardFileError, validateCardBytes } from '../lib/cardFile'
import { CardReaderError } from '../lib/cardReader/errors'
import { downloadDriverCard } from '../lib/cardReader/tachographDownload'
import { saveDownloadedDdd, type DownloadedCardFile } from '../lib/saveDownloadedDdd'
import { mapDddParserJson } from '../utils/dddMapper'
import { parseDddBinary } from '../utils/dddParser'
import { FileUploader } from './FileUploader'

type DashboardProps = {
  card: DriverCardData | null
  recentFiles: RecentCardFile[]
  downloadedCard: DownloadedCardFile | null
  onDataLoaded: (
    parsedJson: DriverCardData,
    fileName: string,
    raw: { bytes: Uint8Array; missingFiles: string[] } | undefined,
    epoch: number,
  ) => void
  onOpenRecent: (file: RecentCardFile) => void
  loadEpoch: () => number
  onClearBrowsingHistory: () => void
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

export function Dashboard({
  card,
  recentFiles,
  downloadedCard,
  onDataLoaded,
  onOpenRecent,
  loadEpoch,
  onClearBrowsingHistory,
}: DashboardProps) {
  const [usbDialogOpen, setUsbDialogOpen] = useState(false)
  const [usbReading, setUsbReading] = useState(false)
  const [usbStatus, setUsbStatus] = useState<string | null>(null)
  const [usbError, setUsbError] = useState<{ title: string; message: string } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearedMessage, setClearedMessage] = useState<string | null>(null)

  async function readFromReader() {
    if (usbReading) return
    setUsbReading(true)
    setUsbError(null)
    setUsbStatus('Připravuji komunikaci se čtečkou…')
    const epoch = loadEpoch()
    try {
      const missingFiles: string[] = []
      const bytes = await downloadDriverCard((message) => setUsbStatus(message), missingFiles)
      validateCardBytes(bytes)
      setUsbStatus('Dekóduji výpis karty…')
      const parsed = mapDddParserJson(await parseDddBinary(bytes))
      if (epoch !== loadEpoch()) return
      const stamp = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const fileName = `C_ctecka_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.ddd`
      onDataLoaded(parsed, fileName, { bytes, missingFiles }, epoch)
      setUsbDialogOpen(false)
      setUsbStatus(null)
    } catch (cause) {
      if (epoch !== loadEpoch()) return
      const message =
        cause instanceof CardReaderError || cause instanceof CardFileError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Kartu se nepodařilo načíst.'
      const title =
        cause instanceof CardReaderError && cause.code === 'blocked'
          ? 'Čtečku drží ovladač nebo jiný program'
          : cause instanceof CardReaderError && cause.code === 'no_card'
            ? 'Karta není ve čtečce'
            : cause instanceof CardReaderError && cause.code === 'no_reader'
              ? 'Čtečka nenalezena'
              : 'Kartu nelze načíst'
      const diagnostic = cause instanceof CardReaderError ? cause.diagnostic : undefined
      setUsbError({
        title,
        message: diagnostic ? `${message}\n\nDiagnostika WebUSB\n${diagnostic}` : message,
      })
      setUsbStatus(null)
    } finally {
      setUsbReading(false)
    }
  }

  return (
    <section className="app-content-card dashboard">
      <header className="dashboard-header">
        <h1>Import dat</h1>
        <p>Nahrajte soubor z karty řidiče (.ddd, .esm, .561) a pokračujte na graf aktivit nebo kontrolu přestupků.</p>
      </header>

      <div className="import-grid">
        <div className="import-panel import-panel--upload">
          <FileUploader
            loadEpoch={loadEpoch}
            onDataLoaded={(parsedJson, fileName, epoch) => onDataLoaded(parsedJson, fileName, undefined, epoch)}
          />
          <div className="dashboard-actions">
            <button type="button" className="btn-accent" onClick={() => setUsbDialogOpen(true)}>
              Načíst ze čtečky USB
            </button>
            <button
              type="button"
              className="btn-accent"
              disabled={!downloadedCard}
              onClick={() => {
                if (!downloadedCard) return
                setSaveError(null)
                setSaveMessage(null)
                void saveDownloadedDdd(downloadedCard)
                  .then((fileName) => {
                    if (fileName) setSaveMessage(`Soubor ${fileName} byl uložen.`)
                  })
                  .catch((cause: unknown) => {
                    setSaveError(cause instanceof Error ? cause.message : 'Soubor se nepodařilo uložit.')
                  })
              }}
            >
              Exportovat .DDD
            </button>
          </div>
          {saveMessage && <p className="file-uploader-status">{saveMessage}</p>}
          {saveError && <p className="file-uploader-error-text">{saveError}</p>}
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
          <button type="button" className="recent-files-clear" onClick={() => setClearDialogOpen(true)}>
            Vymazat historii prohlížení
          </button>
          {clearedMessage && <p className="file-uploader-status">{clearedMessage}</p>}
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

      {clearDialogOpen && (
        <div
          className="work-week-graph-overlay"
          onClick={() => setClearDialogOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-history-title"
        >
          <div className="usb-dialog" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="work-week-graph-close"
              onClick={() => setClearDialogOpen(false)}
              aria-label="Zavřít"
            >
              ×
            </button>
            <h2 id="clear-history-title" className="work-week-graph-title">
              Vymazat historii prohlížení
            </h2>
            <p className="usb-dialog-text">
              Opravdu chcete vymazat všechna lokálně uložená data karet? Tato akce odstraní historii načtených karet i aktuálně zobrazenou kartu.
            </p>
            <div className="dashboard-actions">
              <button
                type="button"
                className="btn-accent"
                onClick={() => {
                  onClearBrowsingHistory()
                  setClearDialogOpen(false)
                  setUsbDialogOpen(false)
                  setSaveError(null)
                  setSaveMessage(null)
                  setClearedMessage('Lokálně uložená data karet byla vymazána.')
                }}
              >
                Vymazat
              </button>
              <button type="button" className="work-week-graph-nav-btn" onClick={() => setClearDialogOpen(false)}>
                Zrušit
              </button>
            </div>
          </div>
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
              Připojte kartu s čipem
            </p>
            {usbStatus && <p className="file-uploader-status">{usbStatus}</p>}
            {usbError && (
              <div className="work-week-warnings-panel file-uploader-error" role="alert">
                <h3 className="work-week-warnings-title">{usbError.title}</h3>
                <p className="file-uploader-error-text">{usbError.message}</p>
              </div>
            )}
            <div className="dashboard-actions">
              <button type="button" className="btn-accent" disabled={usbReading} onClick={() => void readFromReader()}>
                {usbReading ? 'Načítám…' : 'Stažení dat'}
              </button>
              <button type="button" className="work-week-graph-nav-btn" disabled={usbReading} onClick={() => setUsbDialogOpen(false)}>
                Zavřít
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
