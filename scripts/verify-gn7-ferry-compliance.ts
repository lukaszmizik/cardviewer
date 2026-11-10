import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComplianceReview } from '../src/components/complianceReview.ts'
import type { Activity, SpecificConditionEntry } from '../src/types/tacho.ts'

const H = 60 * 60 * 1000
const MIN = 60_000
const NOW = Date.parse('2026-04-27T20:00:00.000Z')
const T0 = Date.parse('2026-04-20T00:00:00.000Z')

function act(id: string, kind: Activity['kind'], startMin: number, endMin: number, extra: Partial<Activity> = {}): Activity {
  return {
    id,
    kind,
    startUtc: T0 + startMin * MIN,
    endUtc: T0 + endMin * MIN,
    durationMinutes: endMin - startMin,
    slot: 1,
    ...extra,
  }
}

function review(activities: Activity[], specificConditions: SpecificConditionEntry[] = []) {
  return buildComplianceReview({
    activities,
    nowUtc: NOW,
    clockMode: 'utc',
    specificConditions,
  })
}

function gn7(activities: Activity[], specificConditions: SpecificConditionEntry[] = []) {
  return review(activities, specificConditions).findings.filter((finding) => finding.methodology === 'gn7')
}

test('běžný denní odpočinek bez trajektu není porušení', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('d', 'driving', 11 * 60, 13 * 60),
    act('r1', 'rest', 13 * 60, 25 * 60),
    act('tail', 'driving', 25 * 60, 30 * 60),
  ])
  assert.equal(findings.some((finding) => finding.reviewStatus === 'proven'), false)
})

test('8h odpočinek bez trajektu je prokázaný nedostatek podle GN7', () => {
  const view = review([
    act('r0', 'rest', 0, 11 * 60),
    act('w', 'work', 11 * 60, 12 * 60),
    act('r8', 'rest', 12 * 60, 20 * 60),
    act('d', 'driving', 20 * 60, 11 * 60 + 36 * 60),
  ])
  const finding = view.findings.find((item) => item.id.startsWith('gn7-daily:'))
  assert.equal(finding?.severity, 'violation')
  assert.equal(finding?.reviewStatus, 'proven')
  assert.equal(finding?.methodology, 'gn7')
  assert.equal(finding?.ferryException, 'none')
  assert.match(finding?.explanation ?? '', /metodika GN7/)
  assert.equal(view.violationCount >= 1, true)
})

test('dvě navazující neúplná období zůstanou dvěma zjištěními', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('r1', 'rest', 12 * 60, 20 * 60),
    act('d1', 'driving', 20 * 60, 12 * 60 + 24 * 60),
    act('r2', 'rest', 12 * 60 + 24 * 60, 12 * 60 + 32 * 60),
    act('d2', 'driving', 12 * 60 + 32 * 60, 12 * 60 + 50 * 60),
  ])
  const proven = findings.filter((finding) => finding.reviewStatus === 'proven')
  assert.equal(proven.length, 2)
  assert.equal(proven[1]!.startUtc, proven[0]!.endUtc)
})

test('5 h + 30 min práce + 6 h při trajektu vyžaduje ověření', () => {
  const view = review([
    act('r0', 'rest', 0, 11 * 60),
    act('gap', 'driving', 11 * 60 + 1, 12 * 60),
    act('r1', 'rest', 12 * 60, 17 * 60),
    act('w', 'work', 17 * 60, 17 * 60 + 30),
    act('r2', 'rest', 17 * 60 + 30, 23 * 60 + 30),
    act('d', 'driving', 23 * 60 + 31, 11 * 60 + 40 * 60),
  ], [
    { atUtc: T0 + 17 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (17 * 60 + 30) * MIN, kind: 'ferry_end' },
  ])
  const finding = view.findings.find((item) => item.methodology === 'gn7')
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(finding?.ferryException, 'possible')
  assert.match(finding?.explanation ?? '', /čl\. 9 odst\. 1/)
  assert.equal(view.findings.some((item) => item.methodology === 'gn7' && item.severity === 'violation'), false)
})

test('tři přerušení trajekt neodstraní', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('a', 'rest', 12 * 60, 16 * 60),
    act('w1', 'work', 16 * 60, 16 * 60 + 10),
    act('b', 'rest', 16 * 60 + 10, 20 * 60 + 10),
    act('w2', 'work', 20 * 60 + 10, 20 * 60 + 20),
    act('c', 'rest', 20 * 60 + 20, 24 * 60 + 20),
    act('w3', 'work', 24 * 60 + 20, 24 * 60 + 30),
    act('d', 'rest', 24 * 60 + 30, 28 * 60 + 30),
    act('tail', 'driving', 28 * 60 + 30, 11 * 60 + 40 * 60),
  ], [
    { atUtc: T0 + 16 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (24 * 60 + 30) * MIN, kind: 'ferry_end' },
  ])
  assert.equal(findings.some((finding) => finding.ferryException === 'possible'), false)
  assert.equal(findings.some((finding) => finding.reviewStatus === 'proven'), true)
})

test('přerušení nad 60 minut trajekt neodstraní', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('a', 'rest', 12 * 60, 16 * 60),
    act('w1', 'work', 16 * 60, 16 * 60 + 31),
    act('b', 'rest', 16 * 60 + 31, 20 * 60 + 31),
    act('w2', 'work', 20 * 60 + 31, 20 * 60 + 61),
    act('c', 'rest', 20 * 60 + 61, 26 * 60 + 61),
    act('tail', 'driving', 26 * 60 + 61, 11 * 60 + 40 * 60),
  ], [
    { atUtc: T0 + 16 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (20 * 60 + 61) * MIN, kind: 'ferry_end' },
  ])
  assert.equal(findings.some((finding) => finding.ferryException === 'possible'), false)
  assert.equal(findings.some((finding) => finding.reviewStatus === 'proven'), true)
})

test('přerušovaných 9 h se výjimkou čl. 9 neuzná', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('a', 'rest', 12 * 60, 16 * 60),
    act('w', 'work', 16 * 60, 16 * 60 + 20),
    act('b', 'rest', 16 * 60 + 20, 21 * 60 + 20),
    act('tail', 'driving', 21 * 60 + 20, 11 * 60 + 40 * 60),
  ], [
    { atUtc: T0 + 16 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (16 * 60 + 20) * MIN, kind: 'ferry_end' },
  ])
  assert.equal(findings.some((finding) => finding.ferryException === 'possible'), false)
  assert.equal(findings.some((finding) => finding.reviewStatus === 'proven'), true)
})

test('podmíněná osádka není prokázané porušení', () => {
  const view = review([
    act('r0', 'rest', 0, 11 * 60),
    act('c1', 'driving', 11 * 60, 13 * 60, { isCrew: true }),
    act('c2', 'driving', 16 * 60, 40 * 60, { isCrew: true }),
  ])
  const finding = view.findings.find((item) => item.methodology === 'gn7')
  assert.equal(finding?.severity, 'uncertain')
  assert.equal(finding?.reviewStatus, 'needs_verification')
  assert.equal(view.findings.some((item) => item.methodology === 'gn7' && item.severity === 'violation'), false)
})

test('neznámý úsek nevytvoří prokázané porušení', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('d', 'driving', 11 * 60, 12 * 60),
    act('u', 'unknown', 12 * 60, 14 * 60),
    act('tail', 'driving', 14 * 60, 40 * 60),
  ])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.reviewStatus, 'needs_verification')
  assert.equal(findings[0]!.severity, 'uncertain')
})

test('překrývající se okna nevytvoří dvě prokázaná porušení', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('d', 'driving', 11 * 60, 19 * 60),
    act('r1', 'rest', 19 * 60, 30 * 60),
    act('tail', 'driving', 30 * 60, 11 * 60 + 30 * 60),
  ])
  assert.equal(findings.filter((finding) => finding.severity === 'violation').length <= 1, true)
})

test('trajekt může změnit kotvu a nezávislá přestávka zůstane', () => {
  const view = review([
    act('r0', 'rest', 0, 11 * 60),
    act('long', 'driving', 11 * 60 + 1, 17 * 60),
    act('r1', 'rest', 17 * 60, 22 * 60),
    act('w', 'work', 22 * 60, 22 * 60 + 30),
    act('r2', 'rest', 22 * 60 + 30, 28 * 60 + 30),
    act('tail', 'driving', 28 * 60 + 31, 11 * 60 + 40 * 60),
  ], [
    { atUtc: T0 + 22 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (22 * 60 + 30) * MIN, kind: 'ferry_end' },
  ])
  const daily = view.findings.find((item) => item.methodology === 'gn7')
  const restBreak = view.findings.find((item) => item.id.startsWith('break:'))
  assert.equal(daily?.ferryException, 'possible')
  assert.equal(daily?.reviewStatus, 'needs_verification')
  assert.equal(restBreak?.severity, 'violation')
  assert.equal(view.violationCount >= 1, true)
  assert.equal(view.findings.filter((item) => item.methodology === 'gn7' && item.severity === 'violation').length, 0)
})
