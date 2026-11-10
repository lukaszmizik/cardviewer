import assert from 'node:assert/strict'
import test from 'node:test'
import { assessWorkPeriodsFromCard } from '../src/analysis/workPeriods.ts'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const DAY_0 = Date.parse('2024-10-24T00:00:00.000Z')

type Change = {
  driver?: boolean
  team?: boolean
  card_present?: boolean
  work_type?: number
  minutes?: number
}

function iso(atUtc: number): string {
  return new Date(atUtc).toISOString()
}

function day(dateMs: number, changes: Change[]) {
  return {
    activity_record_date: iso(dateMs),
    activity_change_info: changes,
  }
}

function mapCard(parserJson: object) {
  return mapDddParserJson({
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'WP-INT' },
    },
    ...parserJson,
  })
}

test('DDD → karta: card_present na kraji odpočinku podpoří kandidátní předěl', () => {
  const restStart = DAY_0 + 2 * HOUR
  const restEnd = DAY_0 + 4 * HOUR
  const card = mapCard({
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        day(DAY_0, [
          { driver: true, card_present: true, work_type: 3, minutes: 0 },
          { driver: true, card_present: false, work_type: 0, minutes: 120 },
          { driver: true, card_present: true, work_type: 3, minutes: 240 },
        ]),
      ],
    },
  })
  assert.ok(card.cardPresentEdges && card.cardPresentEdges.length >= 1)
  const envelope = assessWorkPeriodsFromCard(card)
  assert.equal(envelope.cuts.length, 1)
  assert.equal(envelope.cuts[0]?.restSegments[0]?.startUtc, restStart)
  assert.equal(envelope.cuts[0]?.restSegments.at(-1)?.endUtc, restEnd)
  assert.ok(envelope.cuts[0]?.support.includes('card_present_edge'))
  assert.equal(envelope.cuts[0]?.cardPresentSupport, 'two_sided')
})

test('DDD bez explicitních přechodů card_present: žádná podpora card_present_edge', () => {
  const card = mapCard({
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        day(DAY_0, [
          { driver: true, work_type: 3, minutes: 0 },
          { driver: true, work_type: 0, minutes: 120 },
          { driver: true, work_type: 3, minutes: 240 },
        ]),
      ],
    },
  })
  assert.equal(card.cardPresentEdges?.length ?? 0, 0)
  const envelope = assessWorkPeriodsFromCard(card)
  assert.equal(envelope.cuts.length, 0)
})

test('DDD s mezerou v chronologii: unknown a dataComplete === false', () => {
  const card = mapCard({
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        day(DAY_0, [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
        day(DAY_0 + 2 * DAY, [{ driver: true, card_present: true, work_type: 3, minutes: 60 }]),
      ],
    },
  })
  const envelope = assessWorkPeriodsFromCard(card)
  assert.equal(envelope.dataComplete, false)
  assert.ok(envelope.blockers.some((item) => item.kind === 'unknown'))
  const unknownActs = card.activities.filter((activity) => activity.kind === 'unknown')
  assert.ok(unknownActs.length > 0)
})

test('vícedenní DDD: jedna pracovní obálka', () => {
  const card = mapCard({
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        day(DAY_0, [{ driver: true, card_present: true, work_type: 3, minutes: 60 }]),
        day(DAY_0 + 5 * DAY, [{ driver: true, card_present: true, work_type: 3, minutes: 120 }]),
      ],
    },
  })
  const work = card.activities.filter((activity) =>
    activity.kind === 'driving' || activity.kind === 'work' || activity.kind === 'availability',
  )
  const envelope = assessWorkPeriodsFromCard(card)
  assert.equal(envelope.startUtc, Math.min(...work.map((activity) => activity.startUtc)))
  assert.equal(envelope.endUtc, Math.max(...work.map((activity) => activity.endUtc)))
  assert.ok((envelope.endUtc ?? 0) - (envelope.startUtc ?? 0) > 4 * DAY)
})

test('DDD: VehicleUse podporuje předěl, card_present ne', () => {
  const restStart = DAY_0 + 3 * HOUR
  const restEnd = DAY_0 + 5 * HOUR
  const workEnd = restEnd + 4 * HOUR
  const card = mapCard({
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        day(DAY_0, [
          { driver: true, work_type: 3, minutes: 0 },
          { driver: true, work_type: 0, minutes: 180 },
          { driver: true, work_type: 3, minutes: 300 },
        ]),
      ],
    },
    card_vehicles_used_2: {
      card_vehicle_records: [
        {
          vehicle_first_use: iso(DAY_0),
          vehicle_last_use: iso(restStart),
          vehicle_registration: { vehicle_registration_number: '1AB2345' },
        },
        {
          vehicle_first_use: iso(restEnd),
          vehicle_last_use: iso(workEnd),
          vehicle_registration: { vehicle_registration_number: '6CD7890' },
        },
      ],
    },
  })
  assert.equal(card.cardPresentEdges?.length ?? 0, 0)
  assert.equal(card.vehicleUses?.length, 2)
  const envelope = assessWorkPeriodsFromCard(card)
  assert.equal(envelope.cuts.length, 1)
  assert.deepEqual(envelope.cuts[0]?.support, ['vehicle_use_gap'])
  assert.ok(!envelope.cuts[0]?.support.includes('card_present_edge'))
})
