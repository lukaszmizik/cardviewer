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

export function rememberRecentFile(current: RecentCardFile[], fileName: string, card: DriverCardData): RecentCardFile[] {
  const next: RecentCardFile = {
    id: `${Date.now()}-${fileName}`,
    fileName,
    loadedAt: Date.now(),
    driverName: driverDisplayName(card),
    cardNumber: card.cardNumber,
    card,
  }
  const withoutSameName = current.filter((item) => item.fileName.toLowerCase() !== fileName.toLowerCase())
  const list = [next, ...withoutSameName].slice(0, MAX_RECENT_FILES)
  saveRecentFiles(list)
  return list
}

export function clearStoredRecentFiles(): void {
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
