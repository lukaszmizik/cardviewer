import type { DriverCardData } from '../types/tacho'
import { driverDisplayName } from './placeholderCard'

const STORAGE_KEY = 'tacho-viewer.recent-files'
const MAX_RECENT_FILES = 8

export type RecentCardFile = {
  id: string
  fileName: string
  loadedAt: number
  driverName: string
  cardNumber: string
  card: DriverCardData
}

export type RecentCardRaw = {
  bytes: Uint8Array
  missingFiles: string[]
}

const rawById = new Map<string, RecentCardRaw>()

export function recentCardRaw(id: string): RecentCardRaw | undefined {
  return rawById.get(id)
}

export function loadRecentFiles(): RecentCardFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RecentCardFile[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.fileName === 'string' && item.card)
  } catch {
    return []
  }
}

export function rememberRecentFile(
  current: RecentCardFile[],
  fileName: string,
  card: DriverCardData,
  raw?: RecentCardRaw,
  loadedAt = Date.now(),
): RecentCardFile[] {
  const next: RecentCardFile = {
    id: `${loadedAt}-${fileName}`,
    fileName,
    loadedAt,
    driverName: driverDisplayName(card),
    cardNumber: card.cardNumber,
    card,
  }
  if (raw) {
    rawById.set(next.id, {
      bytes: raw.bytes.slice(),
      missingFiles: raw.missingFiles.slice(),
    })
  }
  const withoutSameName = current.filter((item) => item.fileName.toLowerCase() !== fileName.toLowerCase())
  const list = [next, ...withoutSameName].slice(0, MAX_RECENT_FILES)
  const kept = new Set(list.map((item) => item.id))
  for (const item of current) {
    if (!kept.has(item.id)) rawById.delete(item.id)
  }
  saveRecentFiles(list)
  return list
}

export function clearStoredRecentFiles(): void {
  rawById.clear()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* úložiště prohlížeče není dostupné */
  }
}

function saveRecentFiles(files: RecentCardFile[]) {
  let list = files
  while (list.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
      return
    } catch {
      list = list.slice(0, -1)
    }
  }
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* úložiště prohlížeče je plné */
  }
}
