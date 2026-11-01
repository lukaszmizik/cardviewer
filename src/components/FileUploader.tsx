import { useId, useState, type DragEvent } from 'react'
import type { DriverCardData } from '../types/tacho'
import { CARD_FILE_ACCEPT, CardFileError, validateCardBytes, validateCardFile } from '../lib/cardFile'
import { mapDddParserJson } from '../utils/dddMapper'
import { parseDddBinary } from '../utils/dddParser'

type FileUploaderProps = {
  onDataLoaded: (parsedJson: DriverCardData, fileName: string) => void
}

export function FileUploader({ onDataLoaded }: FileUploaderProps) {
  const fileInputId = useId()
  const [isDragging, setIsDragging] = useState(false)
  const [isReading, setIsReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File | undefined) {
    if (!file || isReading) return
    setIsReading(true)
    setError(null)
    try {
      validateCardFile(file)
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      validateCardBytes(bytes)
      const parserJson = await parseDddBinary(bytes)
      onDataLoaded(mapDddParserJson(parserJson), file.name)
    } catch (cause) {
      const message =
        cause instanceof CardFileError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'Soubor se nepodařilo načíst. Zkontrolujte formát a zkuste to znovu.'
      setError(message)
    } finally {
      setIsReading(false)
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setIsDragging(false)
    void handleFile(event.dataTransfer.files[0])
  }

  return (
    <div className="file-uploader">
      <label
        htmlFor={fileInputId}
        className={isDragging ? 'dropzone is-dragging' : 'dropzone'}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
      >
        <strong>Přetáhněte sem soubor z karty</strong>
        <span>Podporované formáty: .ddd, .esm, .561</span>
        <span>nebo klikněte a vyberte soubor z disku</span>
        <input
          id={fileInputId}
          type="file"
          accept={CARD_FILE_ACCEPT}
          className="work-week-file-input-hidden"
          disabled={isReading}
          onChange={(event) => {
            void handleFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </label>

      {isReading && <p className="file-uploader-status">Ověřuji soubor a dekóduji ho v prohlížeči…</p>}

      {error && (
        <div className="work-week-warnings-panel file-uploader-error" role="alert">
          <h3 className="work-week-warnings-title">Soubor nelze načíst</h3>
          <p className="file-uploader-error-text">{error}</p>
        </div>
      )}
    </div>
  )
}
