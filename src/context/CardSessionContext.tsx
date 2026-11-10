import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { fingerprintBytes } from '../lib/cardFingerprint.ts'
import {
  clearAllCardSessions,
  findSessionByFingerprint,
  getCardSession,
  cardSessionKey,
  registerFingerprintAlias,
  upsertCardSession,
  type CardSession,
} from '../lib/cardSessionStore.ts'
import { clearSessionAnalyticsCache, getCachedAnalytics } from '../lib/sessionAnalyticsCache.ts'
import type { DriverCardData } from '../types/tacho.ts'

type IngestResult = {
  session: CardSession
  reusedParse: boolean
}

type CardSessionContextValue = {
  session: CardSession | null
  card: DriverCardData | null
  ingestLoadedCard: (
    card: DriverCardData,
    fileName: string,
    raw: { bytes: Uint8Array; missingFiles: string[]; parserJson?: unknown },
  ) => IngestResult
  clearSessions: () => void
  getAnalytics: <T>(namespace: string, settingsKey: string, compute: () => T) => T
}

const CardSessionContext = createContext<CardSessionContextValue | null>(null)

export function CardSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<CardSession | null>(null)

  const ingestLoadedCard = useCallback(
    (
      card: DriverCardData,
      fileName: string,
      raw: { bytes: Uint8Array; missingFiles: string[]; parserJson?: unknown },
    ): IngestResult => {
      const bytesFingerprint = fingerprintBytes(raw.bytes)
      const byFingerprint = findSessionByFingerprint(bytesFingerprint)
      if (byFingerprint != null) {
        setSession(byFingerprint)
        return { session: byFingerprint, reusedParse: true }
      }

      const sessionKey = cardSessionKey(card)
      const prior = getCardSession(sessionKey)
      const next = upsertCardSession({
        card,
        fileName,
        bytesFingerprint,
        parserJson: raw.parserJson,
      })
      if (prior != null && next.revision > prior.revision) {
        clearSessionAnalyticsCache(next.sessionKey)
      }
      registerFingerprintAlias(bytesFingerprint, next)
      setSession(next)
      return { session: next, reusedParse: false }
    },
    [],
  )

  const clearSessions = useCallback(() => {
    clearAllCardSessions()
    clearSessionAnalyticsCache()
    setSession(null)
  }, [])

  const getAnalytics = useCallback(
    <T,>(namespace: string, settingsKey: string, compute: () => T): T => {
      if (session == null) return compute()
      return getCachedAnalytics(session, namespace, settingsKey, compute)
    },
    [session],
  )

  const value = useMemo(
    (): CardSessionContextValue => ({
      session,
      card: session?.card ?? null,
      ingestLoadedCard,
      clearSessions,
      getAnalytics,
    }),
    [session, ingestLoadedCard, clearSessions, getAnalytics],
  )

  return <CardSessionContext.Provider value={value}>{children}</CardSessionContext.Provider>
}

export function useCardSession(): CardSessionContextValue {
  const value = useContext(CardSessionContext)
  if (value == null) {
    throw new Error('useCardSession must be used within CardSessionProvider')
  }
  return value
}
