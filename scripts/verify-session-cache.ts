import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprintBytes } from '../src/lib/cardFingerprint.ts'
import {
  clearAllCardSessions,
  findSessionByFingerprint,
  upsertCardSession,
} from '../src/lib/cardSessionStore.ts'
import {
  clearSessionAnalyticsCache,
  getCachedAnalytics,
  hasCachedAnalytics,
} from '../src/lib/sessionAnalyticsCache.ts'
import type { DriverCardData } from '../src/types/tacho.ts'

function card(id: string): DriverCardData {
  return {
    cardNumber: id,
    firstName: 'A',
    surname: 'B',
    lastWithdrawalUtc: null,
    activities: [],
    locations: [],
    violations: [],
  }
}

test('stejný soubor — stejný fingerprint', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  assert.equal(fingerprintBytes(bytes), fingerprintBytes(bytes))
})

test('session reuse — stejný fingerprint nezvyšuje revizi', () => {
  clearAllCardSessions()
  clearSessionAnalyticsCache()
  const bytes = new Uint8Array([9, 8, 7])
  const fp = fingerprintBytes(bytes)
  const first = upsertCardSession({ card: card('CZ1'), fileName: 'a.ddd', bytesFingerprint: fp })
  const second = upsertCardSession({ card: card('CZ1'), fileName: 'a.ddd', bytesFingerprint: fp })
  assert.equal(first.revision, second.revision)
  assert.equal(findSessionByFingerprint(fp)?.sessionKey, 'card:CZ1')
})

test('změna dat karty — nová revize a nový cache klíč', () => {
  clearAllCardSessions()
  clearSessionAnalyticsCache()
  const sessionV1 = upsertCardSession({
    card: card('CZ2'),
    fileName: 'b.ddd',
    bytesFingerprint: fingerprintBytes(new Uint8Array([1])),
  })
  let runs = 0
  getCachedAnalytics(sessionV1, 'demo', 'k', () => {
    runs += 1
    return 42
  })
  assert.equal(runs, 1)
  assert.equal(hasCachedAnalytics(sessionV1, 'demo', 'k'), true)

  const sessionV2 = upsertCardSession({
    card: card('CZ2'),
    fileName: 'b.ddd',
    bytesFingerprint: fingerprintBytes(new Uint8Array([2])),
  })
  assert.equal(sessionV2.revision, sessionV2.revision > sessionV1.revision ? sessionV2.revision : sessionV1.revision + 1)
  runs = 0
  getCachedAnalytics(sessionV2, 'demo', 'k', () => {
    runs += 1
    return 99
  })
  assert.equal(runs, 1)
  assert.equal(hasCachedAnalytics(sessionV1, 'demo', 'k'), true)
  assert.equal(hasCachedAnalytics(sessionV2, 'demo', 'k'), true)
})

test('dvě karty — oddělené session', () => {
  clearAllCardSessions()
  const a = upsertCardSession({
    card: card('AAA'),
    fileName: 'a.ddd',
    bytesFingerprint: fingerprintBytes(new Uint8Array([10])),
  })
  const b = upsertCardSession({
    card: card('BBB'),
    fileName: 'b.ddd',
    bytesFingerprint: fingerprintBytes(new Uint8Array([20])),
  })
  assert.notEqual(a.sessionKey, b.sessionKey)
})
