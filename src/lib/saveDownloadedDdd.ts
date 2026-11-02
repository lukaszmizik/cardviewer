export type DownloadedCardFile = {
  bytes: Uint8Array
  cardNumber: string
  missingFiles: string[]
}

type DirectoryPicker = (options?: { mode?: 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>

export function dddFileName(cardNumber: string): string {
  const number = cardNumber.replace(/[^\w.-]+/g, '') || 'bezcisla'
  return `karta_${number}.DDD`
}

function folderPicker(): DirectoryPicker | null {
  const host = window as Window & { showDirectoryPicker?: DirectoryPicker }
  if (typeof host.showDirectoryPicker !== 'function') return null
  return host.showDirectoryPicker.bind(window)
}

/** Zapíše původní bajty výpisu do složky vybrané v dialogu prohlížeče. */
export async function saveDownloadedDdd(card: DownloadedCardFile): Promise<void> {
  const fileName = dddFileName(card.cardNumber)
  if (card.missingFiles.length > 0) {
    console.info(`[card-reader] neúplný export ${fileName}, chybí soubory: ${card.missingFiles.join(', ')}`)
  } else {
    console.info(`[card-reader] export ${fileName}, ${card.bytes.length} B`)
  }

  const pick = folderPicker()
  if (!pick) {
    throw new Error('Tento prohlížeč neumí vybrat složku. Uložení otevřete v Chrome nebo Edge.')
  }

  const directory = await pick({ mode: 'readwrite', id: 'tacho-ddd' })
  const handle = await directory.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable()
  await writable.write(new Blob([card.bytes.slice()]))
  await writable.close()
}
