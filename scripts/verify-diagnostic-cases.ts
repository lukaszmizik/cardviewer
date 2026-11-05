import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeDriverActivities } from '../src/analysis/analyzeDriverActivities.ts'
import { buildDiagnosticExport, deriveDiagnosticCases } from '../src/analysis/diagnosticCases.ts'
import type { Activity, DriverCardData } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const ANCHOR = Date.parse('2026-03-02T06:00:00.000Z')

function activity(id: string, kind: Activity['kind'], startUtc: number, endUtc: number, overrides: Partial<Activity> = {}): Activity {
  return {
    id,
    kind,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
    slot: 1,
    ...overrides,
  }
}

function card(activities: Activity[]): DriverCardData {
  return {
    cardNumber: 'SECRET-CARD',
    firstName: 'Tajny',
    surname: 'Ridic',
    lastWithdrawalUtc: null,
    activities,
    locations: [],
    violations: [],
  }
}

test('chybějící vstupy a délka nevytvářejí případ pro každý odpočinek', () => {
  const activities = Array.from({ length: 20 }, (_, index) =>
    activity(`rest-${index}`, 'rest', ANCHOR + index * 12 * HOUR, ANCHOR + index * 12 * HOUR + 11 * HOUR),
  )
  const cases = deriveDiagnosticCases(analyzeDriverActivities({ card: card(activities) }))
  assert.equal(cases.filter((item) => item.id === 'recorded:length-classes').length, 1)
  assert.equal(cases.filter((item) => item.id.startsWith('recorded:rest-')).length, 0)
  assert.equal(cases.some((item) => item.id === 'insufficient:daily-anchor'), true)
  assert.equal(cases.some((item) => item.id === 'insufficient:weekly-selection'), true)
  assert.equal(cases.filter((item) => item.status === 'not_implemented').length, 4)
  assert.equal(cases.every((item) => item.status !== ('compliant' as typeof item.status)), true)
  const lengthCase = cases.find((item) => item.id === 'recorded:length-classes')
  assert.match(lengthCase?.summary ?? '', /20 souvislých odpočinků/)
  assert.match(lengthCase?.reason ?? '', /ne o právně potvrzený odpočinek/)
})

test('neznámý úsek je jeden případ a není odpočinek', () => {
  const activities = [
    activity('rest-1', 'rest', ANCHOR, ANCHOR + 11 * HOUR),
    activity('gap-1', 'unknown', ANCHOR + 12 * HOUR, ANCHOR + 36 * HOUR),
  ]
  const cases = deriveDiagnosticCases(analyzeDriverActivities({ card: card(activities) }))
  const unknown = cases.find((item) => item.id.startsWith('insufficient:unknown:'))
  assert.ok(unknown)
  assert.equal(unknown?.status, 'insufficient_data')
  assert.deepEqual(unknown?.sourceActivityIds, ['gap-1'])
  assert.equal(cases.some((item) => item.sourceActivityIds.includes('gap-1') && item.module === 'restCandidates'), false)
})

test('dvě denní varianty jsou jeden případ více interpretací', () => {
  const activities = [
    activity('part-3', 'rest', Date.parse('2026-03-02T08:00:00.000Z'), Date.parse('2026-03-02T11:00:00.000Z')),
    activity('part-9', 'rest', Date.parse('2026-03-02T14:00:00.000Z'), Date.parse('2026-03-02T23:00:00.000Z')),
  ]
  const cases = deriveDiagnosticCases(
    analyzeDriverActivities({ card: card(activities), dailyAnchorUtc: ANCHOR }),
  )
  const branch = cases.find((item) => item.status === 'multiple_interpretations')
  assert.ok(branch)
  assert.equal(branch?.module, 'dailyRestOptions')
  assert.deepEqual([...(branch?.sourceActivityIds ?? [])].sort(), ['part-3', 'part-9'])
  assert.match(branch?.summary ?? '', /continuous_reduced/)
  assert.match(branch?.summary ?? '', /split_regular/)
})

test('mnoho neznámých úseků se ve výpisu sloučí', () => {
  const activities = Array.from({ length: 30 }, (_, index) =>
    activity(`gap-${index}`, 'unknown', ANCHOR + index * 2 * HOUR, ANCHOR + index * 2 * HOUR + HOUR),
  )
  const cases = deriveDiagnosticCases(analyzeDriverActivities({ card: card(activities) }))
  const unknownCases = cases.filter((item) => item.id.startsWith('insufficient:unknown'))
  assert.equal(unknownCases.length, 9)
  assert.equal(unknownCases.some((item) => item.id === 'insufficient:unknown-summary'), true)
})

test('export obsahuje poznámku a neobsahuje identitu řidiče', () => {
  const cases = deriveDiagnosticCases(analyzeDriverActivities({ card: card([]) }))
  const exported = buildDiagnosticExport(cases, { 'insufficient:no-activities': 'ověřit u dopravce' }, '2026-03-02T06:00:00.000Z')
  const json = JSON.stringify(exported)
  assert.equal(exported.cases[0]?.note, 'ověřit u dopravce')
  assert.equal(json.includes('SECRET-CARD'), false)
  assert.equal(json.includes('Tajny'), false)
  assert.equal(json.includes('Ridic'), false)
  assert.equal(json.includes('cardNumber'), false)
  assert.equal(Object.hasOwn(exported, 'activities'), false)
})
