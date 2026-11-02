export type DownloadedCardFile = {
  bytes: Uint8Array
  cardNumber: string
  missingFiles: string[]
}

type SaveFilePicker = (options?: {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>

export function dddFileName(cardNumber: string, when = new Date()): string {
  const number = cardNumber.replace(/[^\w.-]+/g, '') || 'bezcisla'
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    when.getFullYear(),
    pad(when.getMonth() + 1),
    pad(when.getDate()),
    '_',
    pad(when.getHours()),
    pad(when.getMinutes()),
    pad(when.getSeconds()),
    pad(when.getMilliseconds(), 3),
  ].join('')
  return `karta_${number}_${stamp}.DDD`
}

function savePicker(): SaveFilePicker | null {
  const host = window as Window & { showSaveFilePicker?: SaveFilePicker }
  if (typeof host.showSaveFilePicker !== 'function') return null
  return host.showSaveFilePicker.bind(window)
}

function pickerWasCancelled(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === 'AbortError' || cause.name === 'NotAllowedError')
}

function saveFailure(cause: unknown): Error {
  if (cause instanceof DOMException) {
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError' || cause.name === 'NoModificationAllowedError') {
      return new Error('Prohlížeč nepovolil uložení souboru. Zvolte složku, do které lze zapisovat, například Dokumenty nebo Plocha.')
    }
  }
  if (cause instanceof Error && cause.message) return cause
  return new Error('Soubor se nepodařilo uložit.')
}

/** Otevře dialog uložení s navrženým názvem a zapíše původní bajty výpisu. Zrušení vrátí null. */
export async function saveDownloadedDdd(card: DownloadedCardFile): Promise<string | null> {
  const fileName = dddFileName(card.cardNumber)
  if (card.missingFiles.length > 0) {
    console.info(`[card-reader] neúplný export ${fileName}, chybí soubory: ${card.missingFiles.join(', ')}`)
  } else {
    console.info(`[card-reader] export ${fileName}, ${card.bytes.length} B`)
  }

  const pick = savePicker()
  if (!pick) {
    throw new Error('Tento prohlížeč neumí dialog uložení souboru. Export otevřete v Chrome nebo Edge.')
  }

  let handle: FileSystemFileHandle
  try {
    handle = await pick({
      suggestedName: fileName,
      types: [
        {
          description: 'Tachografický výpis DDD',
          accept: { 'application/octet-stream': ['.DDD'] },
        },
      ],
    })
  } catch (cause) {
    if (pickerWasCancelled(cause)) return null
    throw saveFailure(cause)
  }

  const writable = await handle.createWritable()
  try {
    await writable.write(card.bytes)
    await writable.close()
  } catch (cause) {
    await writable.abort().catch(() => undefined)
    throw saveFailure(cause)
  }

  const written = await handle.getFile()
  if (written.size !== card.bytes.byteLength) {
    throw new Error('Soubor se nepodařilo zapsat celý.')
  }
  console.info(`[card-reader] uloženo ${written.name}, ${written.size} B`)
  return written.name
}
