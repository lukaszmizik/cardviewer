import type { DriverCardData } from '../types/tacho.ts'

export type CardSession = {
  sessionKey: string
  revision: number
  card: DriverCardData
  fileName: string
  bytesFingerprint: string
  loadedAt: number
  parserJson?: unknown
}

const sessionsByKey = new Map<string, CardSession>()
const sessionKeyByFingerprint = new Map<string, string>()

export function cardSessionKey(card: DriverCardData): string {
  const number = card.cardNumber?.trim()
  if (number) return `card:${number}`
  return 'card:unknown'
}

export function findSessionByFingerprint(bytesFingerprint: string): CardSession | null {
  const sessionKey = sessionKeyByFingerprint.get(bytesFingerprint)
  if (sessionKey == null) return null
  return sessionsByKey.get(sessionKey) ?? null
}

export function getCardSession(sessionKey: string): CardSession | null {
  return sessionsByKey.get(sessionKey) ?? null
}

export function upsertCardSession(input: {
  card: DriverCardData
  fileName: string
  bytesFingerprint: string
  parserJson?: unknown
}): CardSession {
  const sessionKey = cardSessionKey(input.card)
  const existing = sessionsByKey.get(sessionKey)
  if (existing != null && existing.bytesFingerprint === input.bytesFingerprint) {
    return existing
  }

  const revision = existing != null ? existing.revision + 1 : 1
  const session: CardSession = {
    sessionKey,
    revision,
    card: input.card,
    fileName: input.fileName,
    bytesFingerprint: input.bytesFingerprint,
    loadedAt: Date.now(),
    parserJson: input.parserJson,
  }
  sessionsByKey.set(sessionKey, session)
  sessionKeyByFingerprint.set(input.bytesFingerprint, sessionKey)
  return session
}

export function registerFingerprintAlias(bytesFingerprint: string, session: CardSession): void {
  sessionKeyByFingerprint.set(bytesFingerprint, session.sessionKey)
}

export function clearAllCardSessions(): void {
  sessionsByKey.clear()
  sessionKeyByFingerprint.clear()
}
