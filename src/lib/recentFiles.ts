const STORAGE_KEY = 'tacho-viewer.recent-files'

export type LoadedCardFile = {
  fileName: string
  loadedAt: number
  bytes: Uint8Array
  missingFiles: string[]
}

/** Smaže dřívější seznam karet z localStorage. Aplikace ho už nezakládá. */
export function forgetStoredCards(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* úložiště prohlížeče není dostupné */
  }
}

forgetStoredCards()
