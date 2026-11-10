import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatSegmentsInRange,
  segmentsInRange,
} from '../src/analysis/holderTimelineDiagnostics.ts'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function mapCard(days: object[]) {
  return mapDddParserJson({
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'HTL' },
    },
    card_driver_activity_2: { decoded_activity_daily_records: days },
  })
}

function day(isoDate: string, changes: object[]) {
  return {
    activity_record_date: new Date(isoDate).toISOString(),
    activity_change_info: changes,
  }
}

test('metadata: jedna sloučená chronologie slotů z mapovače', () => {
  const card = mapCard([
    day('2024-10-01T00:00:00.000Z', [
      { driver: true, card_present: true, work_type: 3, minutes: 0 },
      { driver: false, card_present: true, work_type: 0, minutes: 30 },
    ]),
  ])
  assert.equal(card.holderTimelineMeta?.slotChronologyAssumption, 'single_card_merged_timeline')
  assert.ok((card.holderTimelineSegments?.length ?? 0) >= 2)
})

test('jednominutový rest — explicit_change a recorded nebo inferred', () => {
  const start = Date.parse('2025-02-22T03:08:00.000Z')
  const end = start + MINUTE
  const card = mapCard([
    day('2025-02-22T00:00:00.000Z', [
      { driver: true, card_present: true, work_type: 3, minutes: 188 },
      { driver: true, card_present: true, work_type: 0, minutes: 189 },
      { driver: true, card_present: true, work_type: 3, minutes: 190 },
    ]),
  ])
  const hits = segmentsInRange(card.holderTimelineSegments ?? [], start, end + MINUTE)
  const rest = hits.find((segment) => segment.kind === 'rest')
  assert.ok(rest)
  assert.equal(rest.endUtc - rest.startUtc, MINUTE)
  assert.equal(rest.position, 1)
  assert.equal(rest.startOrigin, 'explicit_change')
  assert.equal(rest.sourceChangeCount, 1)
  assert.ok(rest.endCause === 'next_change_same_position' || rest.endCause === 'next_change_other_position')
})

test('přechod pozice 2 → 1 ukončí úsek jinou pozicí', () => {
  const dayA = Date.parse('2024-10-25T00:00:00.000Z')
  const dayB = Date.parse('2024-10-26T00:00:00.000Z')
  const card = mapCard([
    day(new Date(dayA).toISOString(), [
      { driver: false, card_present: true, work_type: 0, minutes: 18 * 60 + 2 },
    ]),
    day(new Date(dayB).toISOString(), [
      { driver: true, card_present: true, work_type: 0, minutes: 7 * 60 + 43 },
    ]),
  ])
  const slot2Rest = card.holderTimelineSegments?.find(
    (segment) => segment.position === 2 && segment.kind === 'rest',
  )
  assert.ok(slot2Rest)
  assert.equal(slot2Rest.endCause, 'next_change_other_position')
  const slot1 = card.holderTimelineSegments?.find(
    (segment) => segment.position === 1 && segment.startUtc >= dayB,
  )
  assert.ok(slot1)
  assert.equal(slot1.startOrigin, 'explicit_change')
})

test('dlouhý rest přes navazující dny — souvislé denní úseky a inferred při >24 h', () => {
  const t0 = Date.parse('2024-10-28T00:00:00.000Z')
  const daily: object[] = []
  for (let index = 0; index < 10; index += 1) {
    const dateIso = new Date(t0 + index * DAY).toISOString()
    const changes =
      index === 0
        ? [{ driver: true, card_present: true, work_type: 0, minutes: 16 * 60 + 47 }]
        : index === 9
          ? [{ driver: true, card_present: true, work_type: 3, minutes: 60 }]
          : [{ driver: true, card_present: true, work_type: 0, minutes: 0 }]
    daily.push(day(dateIso, changes))
  }
  const card = mapCard(daily)
  const rest = (card.holderTimelineSegments ?? []).filter((segment) => segment.kind === 'rest')
  assert.ok(rest.length >= 8)
  const span = rest[rest.length - 1]!.endUtc - rest[0]!.startUtc
  assert.ok(span > 7 * DAY)
  assert.ok(
    rest
      .slice(0, -2)
      .every(
        (segment) =>
          segment.continuity === 'recorded' && segment.endCause === 'next_change_same_position',
      ),
  )
  const inferredLong = rest.find(
    (segment) => segment.continuity === 'inferred' && segment.endUtc - segment.startUtc > DAY,
  )
  assert.ok(inferredLong)
})

test('mezerová unknown mezi dny > 1 den', () => {
  const card = mapCard([
    day('2024-10-01T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
    day('2024-10-04T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
  ])
  const gap = card.holderTimelineSegments?.find((segment) => segment.kind === 'unknown')
  assert.ok(gap)
  assert.equal(gap.endCause, 'unknown_gap')
  assert.equal(gap.continuity, 'unknown')
  assert.equal(gap.sourceChangeCount, 0)
})

test('formát intervalu je bez PII', () => {
  const card = mapCard([
    day('2025-11-16T00:00:00.000Z', [
      { driver: true, card_present: false, work_type: 2, minutes: 22 * 60 + 25 },
      { driver: true, card_present: true, work_type: 0, minutes: 22 * 60 + 26 },
    ]),
    day('2025-11-17T00:00:00.000Z', [
      { driver: true, card_present: true, work_type: 3, minutes: 13 * 60 + 53 },
    ]),
  ])
  const text = formatSegmentsInRange(
    card,
    Date.parse('2025-11-16T22:20:00.000Z'),
    Date.parse('2025-11-17T14:00:00.000Z'),
  )
  assert.match(text, /position=1/)
  assert.doesNotMatch(text, /HTL|card_number/i)
})

test('holder timeline segmenty odpovídají počtu activities (act + gap)', () => {
  const card = mapCard([
    day('2024-10-01T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
    day('2024-10-05T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
  ])
  assert.equal(card.holderTimelineSegments?.length, card.activities.length)
  for (const segment of card.holderTimelineSegments ?? []) {
    const id = segment.sourceActivityIds[0]
    assert.ok(id)
    const activity = card.activities.find((item) => item.id === id)
    assert.ok(activity)
    assert.equal(activity.startUtc, segment.startUtc)
    assert.equal(activity.endUtc, segment.endUtc)
    assert.equal(activity.kind, segment.kind)
  }
})
