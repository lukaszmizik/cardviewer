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
  assert.match(finding?.explanation ?? '', /9 h ani 11 h/)
  assert.doesNotMatch(finding?.explanation ?? '', /čl\. 9/)
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
  assert.match(finding?.explanation ?? '', /Podmíněná osádka/)
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

test('trajektový kandidát mění kvalifikaci dřívějšího odpočinku a nepotvrdí ho', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('early', 'rest', 12 * 60, 17 * 60),
    act('fw', 'work', 17 * 60, 17 * 60 + 30),
    act('late', 'rest', 17 * 60 + 30, 23 * 60 + 30),
    act('tail', 'driving', 23 * 60 + 31, 11 * 60 + 30 * 60),
  ], [
    { atUtc: T0 + 17 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (17 * 60 + 30) * MIN, kind: 'ferry_end' },
  ])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.severity, 'uncertain')
  assert.equal(findings[0]!.reviewStatus, 'needs_verification')
  assert.equal(findings[0]!.ferryException, 'possible')
  assert.match(findings[0]!.explanation, /čl\. 9 odst\. 1/)
})

test('nejistota trajektu se přenáší jen na závislá následující období', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('early8', 'rest', 12 * 60, 20 * 60),
    act('gap', 'work', 20 * 60, 35 * 60),
    act('a', 'rest', 36 * 60, 41 * 60),
    act('fw', 'work', 41 * 60, 41 * 60 + 30),
    act('b', 'rest', 41 * 60 + 30, 47 * 60 + 30),
    act('mid', 'driving', 47 * 60 + 31, 59 * 60),
    act('late8', 'rest', 60 * 60, 68 * 60),
    act('tail', 'work', 68 * 60, 120 * 60),
  ], [
    { atUtc: T0 + 41 * 60 * MIN, kind: 'ferry' },
    { atUtc: T0 + (41 * 60 + 30) * MIN, kind: 'ferry_end' },
  ])
  const ordered = findings.slice().sort((left, right) => left.startUtc - right.startUtc)
  assert.equal(ordered.length >= 3, true)
  assert.equal(ordered[0]!.reviewStatus, 'proven')
  assert.equal(ordered[0]!.ferryException, 'none')
  assert.equal(ordered[1]!.reviewStatus, 'needs_verification')
  assert.equal(ordered[1]!.ferryException, 'possible')
  assert.match(ordered[1]!.explanation, /čl\. 9 odst\. 1/)
  assert.equal(ordered.slice(2).every((finding) => finding.reviewStatus === 'needs_verification'), true)
  assert.match(ordered[2]!.explanation, /posunout kotvu/)
  assert.match(ordered[2]!.explanation, /náhradní referenční období/)
  assert.equal(ordered.slice(1).some((finding) => finding.severity === 'violation'), false)
})

test('nezávislý přestupek v řízení zůstává potvrzený vedle nejistého denního odpočinku', () => {
  const view = review([
    act('r0', 'rest', 0, 11 * 60),
    act('long', 'driving', 11 * 60 + 1, 16 * 60 + 1),
    act('a', 'rest', 16 * 60 + 1, 21 * 60 + 1),
    act('fw', 'work', 21 * 60 + 1, 21 * 60 + 31),
    act('b', 'rest', 21 * 60 + 31, 27 * 60 + 31),
    act('tail', 'work', 27 * 60 + 32, 11 * 60 + 40 * 60),
  ], [
    { atUtc: T0 + (21 * 60 + 1) * MIN, kind: 'ferry' },
    { atUtc: T0 + (21 * 60 + 31) * MIN, kind: 'ferry_end' },
  ])
  const daily = view.findings.filter((item) => item.methodology === 'gn7')
  const restBreak = view.findings.find((item) => item.id.startsWith('break:'))
  assert.equal(daily.every((item) => item.severity !== 'violation'), true)
  assert.equal(restBreak?.severity, 'violation')
})

test('úplný padesátidenní záznam se neořízne a nedostatek odpočinku zůstane prokázaný', () => {
  const start = NOW - 50 * 24 * H
  const findings = gn7([
    {
      id: 'r0',
      kind: 'rest',
      startUtc: start,
      endUtc: start + 11 * H,
      durationMinutes: 11 * 60,
      slot: 1,
    },
    {
      id: 'tail',
      kind: 'work',
      startUtc: start + 11 * H,
      endUtc: start + 50 * 24 * H,
      durationMinutes: (50 * 24 * 60) - (11 * 60),
      slot: 1,
    },
  ])
  const truncated = findings.filter((finding) => /ořezaný/.test(finding.explanation))
  const proven = findings.filter((finding) => finding.reviewStatus === 'proven')
  assert.equal(truncated.length, 0)
  assert.equal(proven.length > 1, true)
  assert.equal(proven.every((finding) => finding.severity === 'violation'), true)
})

test('neověřený výchozí 9h odpočinek nepotvrdí navazující nedostatek', () => {
  const findings = gn7([
    act('r9', 'rest', 0, 9 * 60),
    act('w', 'work', 9 * 60, 10 * 60),
    act('r8', 'rest', 10 * 60, 18 * 60),
    act('tail', 'driving', 18 * 60, 9 * 60 + 36 * 60),
  ])
  assert.equal(findings.length >= 1, true)
  assert.equal(findings.some((finding) => finding.severity === 'violation'), false)
  assert.match(findings.map((finding) => finding.explanation).join(' '), /přípustnost zkrácení/)
})

test('jednoznačný výchozí 11h odpočinek potvrdí navazující 8h bez trajektu', () => {
  const findings = gn7([
    act('r0', 'rest', 0, 11 * 60),
    act('w', 'work', 11 * 60, 12 * 60),
    act('r8', 'rest', 12 * 60, 20 * 60),
    act('tail', 'driving', 20 * 60, 11 * 60 + 36 * 60),
  ])
  const finding = findings.find((item) => item.reviewStatus === 'proven')
  assert.equal(finding?.severity, 'violation')
  assert.doesNotMatch(finding?.explanation ?? '', /přípustnost zkrácení/)
  assert.doesNotMatch(finding?.explanation ?? '', /čl\. 9/)
})
