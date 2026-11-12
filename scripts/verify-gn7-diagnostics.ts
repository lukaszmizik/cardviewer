import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGn7DiagnosticFeed } from '../src/analysis/gn7DiagnosticFeed.ts'
import type { Activity } from '../src/types/tacho.ts'

const H = 60 * 60 * 1000
const MIN = 60_000
const T0 = Date.parse('2024-10-25T00:00:00.000Z')

function at(startMin: number, endMin: number, kind: Activity['kind'], id: string, extra: Partial<Activity> = {}): Activity {
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

test('běžné 11h období je diagnostický podklad a není hranice směny', () => {
  const feed = buildGn7DiagnosticFeed({
    anchorUtc: T0,
    activities: [
      at(0, 480, 'driving', 'd'),
      at(480, 1140, 'rest', 'r'),
      at(1140, 1800, 'driving', 'd2'),
    ],
  })
  const first = feed.periods[0]!
  assert.equal(first.boundarySource, 'gn7')
  assert.equal(first.startUtc, T0)
  assert.equal(first.endUtc, T0 + 24 * H)
  assert.equal(first.nextAnchorUtc, T0 + 1140 * MIN)
  assert.equal(first.dataComplete, true)
  assert.equal(first.confirmation, 'confirmed')
  assert.equal(first.analysisTruncated, false)
  assert.equal(first.usableForGn7Diagnostics, true)
  assert.equal(first.usableAsWorkPeriodBoundary, false)
  assert.match(first.limitation ?? '', /není hranice pracovní doby/)
})

test('podmíněná osádka není potvrzený podklad', () => {
  const feed = buildGn7DiagnosticFeed({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'c1', { isCrew: true }),
      at(300, 40 * 60, 'driving', 'c2', { isCrew: true }),
    ],
  })
  const period = feed.periods[0]!
  assert.equal(period.confirmation, 'conditional')
  assert.equal(period.dataComplete, false)
  assert.equal(period.nextAnchorUtc, null)
  assert.equal(period.usableForGn7Diagnostics, false)
  assert.equal(period.usableAsWorkPeriodBoundary, false)
  assert.match(period.limitation ?? '', /Podmíněná osádka/)
})

test('nejednoznačný odpočinek nemá určenou kotvu', () => {
  const feed = buildGn7DiagnosticFeed({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'd0'),
      at(120, 780, 'rest', 'r1', { slot: 1 }),
      at(240, 360, 'rest', 'r2', { slot: 2 }),
      at(780, 1600, 'driving', 'd1'),
    ],
  })
  const period = feed.periods[0]!
  assert.equal(period.confirmation, 'unconfirmed')
  assert.equal(period.dataComplete, false)
  assert.equal(period.nextAnchorUtc, null)
  assert.equal(period.usableForGn7Diagnostics, false)
  assert.equal(period.usableAsWorkPeriodBoundary, false)
})

test('překryv oken nemění časy', () => {
  const feed = buildGn7DiagnosticFeed({
    anchorUtc: T0,
    activities: [
      at(0, 120, 'driving', 'd0'),
      at(120, 780, 'rest', 'r1'),
      at(780, 840, 'driving', 'd1'),
      at(840, 1500, 'rest', 'r2'),
      at(1500, 2000, 'driving', 'd2'),
    ],
  })
  const [first, second] = feed.periods
  assert.ok(first != null && second != null)
  assert.equal(first.endUtc, T0 + 24 * H)
  assert.equal(second.startUtc, T0 + 780 * MIN)
  assert.ok(second.startUtc < first.endUtc)
  assert.equal(first.overlapsAnotherControlPeriod, true)
  assert.equal(second.overlapsAnotherControlPeriod, true)
  assert.equal(first.usableAsWorkPeriodBoundary, false)
  assert.equal(second.usableAsWorkPeriodBoundary, false)
  assert.match(first.limitation ?? '', /překrývá/)
})

test('padesátidenní záznam zůstane v řetězci a není ořezaný', () => {
  const feed = buildGn7DiagnosticFeed({
    anchorUtc: 0,
    activities: [{
      id: 'd',
      kind: 'driving',
      startUtc: 0,
      endUtc: 50 * 24 * H,
      durationMinutes: 50 * 24 * 60,
      slot: 1,
    }],
  })
  assert.equal(feed.analysisTruncated, false)
  assert.equal(feed.periods.length, 50)
  const last = feed.periods[49]!
  assert.equal(last.analysisTruncated, false)
  assert.equal(last.usableForGn7Diagnostics, true)
  assert.equal(last.confirmation, 'confirmed')
  assert.equal(last.usableAsWorkPeriodBoundary, false)
  assert.equal(last.nextAnchorUtc, 50 * 24 * H)
  assert.match(last.limitation ?? '', /pracovní doby/)
})
