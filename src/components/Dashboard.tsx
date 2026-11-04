import { useState } from 'react'
import type { LoadedCardFile } from '../lib/recentFiles'
import type { DriverCardData } from '../types/tacho'
import { driverDisplayName } from '../lib/placeholderCard'
import { CardFileError, validateCardBytes } from '../lib/cardFile'
import { CardReaderError } from '../lib/cardReader/errors'
import { downloadDriverCard } from '../lib/cardReader/tachographDownload'
import { dddFileName, saveDownloadedDdd } from '../lib/saveDownloadedDdd'
import { mapDddParserJson } from '../utils/dddMapper'
import { parseDddBinary } from '../utils/dddParser'
import { FileUploader } from './FileUploader'

type DashboardProps = {
  card: DriverCardData | null
  loadedFile: LoadedCardFile | null
  onDataLoaded: (
    parsedJson: DriverCardData,
    fileName: string,
    raw: { bytes: Uint8Array; missingFiles: string[] },
    epoch: number,
  ) => void
  loadEpoch: () => number
  onClearBrowsingHistory: () => void
  onDropLoadedCard: () => void
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
  loadedFile,
  onDataLoaded,
  loadEpoch,
  onClearBrowsingHistory,
  onDropLoadedCard,
}: DashboardProps) {
  const [usbDialogOpen, setUsbDialogOpen] = useState(false)
  const [usbReading, setUsbReading] = useState(false)
  const [usbStatus, setUsbStatus] = useState<string | null>(null)
  const [usbProgress, setUsbProgress] = useState<{ current: number; total: number } | null>(null)
  const [usbError, setUsbError] = useState<{ title: string; message: string } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearedMessage, setClearedMessage] = useState<string | null>(null)

  async function readFromReader() {
    if (usbReading) return
    onDropLoadedCard()
    setUsbReading(true)
    setUsbError(null)
    setUsbStatus('Připravuji komunikaci se čtečkou…')
    setUsbProgress({ current: 0, total: 1 })
    const epoch = loadEpoch()
    try {
      const missingFiles: string[] = []
      const bytes = await downloadDriverCard((info) => {
        setUsbStatus(info.message)
        setUsbProgress({ current: info.current, total: Math.max(info.total, 1) })
      }, missingFiles)
      validateCardBytes(bytes)
      setUsbStatus('Dekóduji výpis karty…')
      setUsbProgress((current) =>
        current ? { current: current.total, total: current.total } : { current: 1, total: 1 },
      )
      const parsed = mapDddParserJson(await parseDddBinary(bytes))
      if (epoch !== loadEpoch()) return
      const fileName = dddFileName(parsed.cardNumber)
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
          ? 'Prohlížeč k čtečce nepustil'
          : cause instanceof CardReaderError && cause.code === 'no_card'
            ? 'Karta není ve čtečce'
            : cause instanceof CardReaderError && cause.code === 'no_reader'
              ? 'Čtečka nenalezena'
              : 'Kartu nelze načíst'
      if (cause instanceof CardReaderError && cause.diagnostic) {
        console.info(`[card-reader] Diagnostika WebUSB\n${cause.diagnostic}`)
      }
      setUsbError({ title, message })
      setUsbStatus(null)
      setUsbProgress(null)
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
            onDataLoaded={(parsedJson, fileName, epoch, bytes) =>
              onDataLoaded(parsedJson, fileName, { bytes, missingFiles: [] }, epoch)
            }
          />
          <div className="dashboard-actions">
            <button type="button" className="btn-accent" onClick={() => setUsbDialogOpen(true)}>
              Načíst ze čtečky USB
            </button>
          </div>
        </div>

        <aside className="import-panel import-panel--recent" aria-label="Načtená karta">
          <h2 className="recent-files-title">Načtená karta</h2>
          {card && loadedFile ? (
            <div className="loaded-card">
              <p className="recent-file-name">{loadedFile.fileName}</p>
              <p className="recent-file-meta">
                {[driverDisplayName(card), card.cardNumber].filter(Boolean).join(' · ') || 'Karta řidiče'}
              </p>
              <p className="recent-file-meta">Platnost {card.dateOfExpiry ?? '—'}</p>
              <time className="recent-file-time" dateTime={new Date(loadedFile.loadedAt).toISOString()}>
                {formatLoadedAt(loadedFile.loadedAt)}
              </time>
              <button
                type="button"
                className="recent-file-export"
                title={`Uložit ${loadedFile.fileName}`}
                onClick={() => {
                  setSaveError(null)
                  setSaveMessage(null)
                  void saveDownloadedDdd({
                    bytes: loadedFile.bytes,
                    missingFiles: loadedFile.missingFiles,
                    cardNumber: card.cardNumber,
                    fileName: loadedFile.fileName,
                  })
                    .then((savedName) => {
                      if (savedName) setSaveMessage(`Soubor ${savedName} byl uložen.`)
                    })
                    .catch((cause: unknown) => {
                      setSaveError(cause instanceof Error ? cause.message : 'Soubor se nepodařilo uložit.')
                    })
                }}
              >
                Exportovat .DDD
              </button>
            </div>
          ) : (
            <p className="recent-files-empty">Není načtená žádná karta.</p>
          )}
          <button type="button" className="recent-files-clear" onClick={() => setClearDialogOpen(true)}>
            Vymazat historii prohlížení
          </button>
          {saveMessage && <p className="file-uploader-status">{saveMessage}</p>}
          {saveError && <p className="file-uploader-error-text">{saveError}</p>}
          {clearedMessage && <p className="file-uploader-status">{clearedMessage}</p>}
        </aside>
      </div>

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
              Opravdu chcete vymazat lokálně uložená data karty? Tato akce odstraní aktuálně načtenou kartu.
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
            {(usbStatus || usbProgress) && (
              <div className="usb-download-progress">
                {usbProgress && (
                  <>
                    <div className="usb-download-progress-head">
                      <span>
                        {usbProgress.current} / {usbProgress.total}
                      </span>
                      <span>{Math.min(100, Math.round((usbProgress.current / Math.max(usbProgress.total, 1)) * 100))} %</span>
                    </div>
                    <div
                      className="usb-download-progress-track"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={usbProgress.total}
                      aria-valuenow={usbProgress.current}
                      aria-label="Průběh stahování karty"
                    >
                      <div
                        className="usb-download-progress-bar"
                        style={{
                          width: `${Math.min(100, (usbProgress.current / Math.max(usbProgress.total, 1)) * 100)}%`,
                        }}
                      />
                    </div>
                  </>
                )}
                {usbStatus && <p className="file-uploader-status">{usbStatus}</p>}
              </div>
            )}
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
