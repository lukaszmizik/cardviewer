import type { CardSession } from './cardSessionStore.ts'

const cache = new Map<string, unknown>()

function entryKey(session: CardSession, namespace: string, settingsKey: string): string {
  return `${session.sessionKey}@${session.revision}:${namespace}:${settingsKey}`
}

export function clearSessionAnalyticsCache(sessionKey?: string): void {
  if (sessionKey == null) {
    cache.clear()
    return
  }
  const prefix = `${sessionKey}@`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

export function getCachedAnalytics<T>(
  session: CardSession,
  namespace: string,
  settingsKey: string,
  compute: () => T,
): T {
  const key = entryKey(session, namespace, settingsKey)
  if (cache.has(key)) return cache.get(key) as T
  const value = compute()
  cache.set(key, value)
  return value
}

export function sessionAnalyticsCacheSize(): number {
  return cache.size
}

export function hasCachedAnalytics(session: CardSession, namespace: string, settingsKey: string): boolean {
  return cache.has(entryKey(session, namespace, settingsKey))
}
