import assert from 'node:assert/strict'
import test from 'node:test'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'

const AT = '2026-04-10T07:00:00Z'

function card(places: {
  file1?: Record<string, unknown>[]
  file2?: Record<string, unknown>[]
}) {
  return mapDddParserJson({
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'TEST' },
    },
    card_place_daily_work_period_1: { place_records: places.file1 ?? [] },
    card_place_daily_work_period_2: { place_records: places.file2 ?? [] },
  })
}

test('stejný čas a různý typ zůstanou dva záznamy a shodná kopie jednou', () => {
  const mapped = card({
    file2: [
      { entry_time: AT, entry_type_daily_work_period: 0, daily_work_period_country: 12 },
    ],
    file1: [
      { entry_time: AT, entry_type_daily_work_period: 0, daily_work_period_country: 12 },
      { entry_time: AT, entry_type_daily_work_period: 1, daily_work_period_country: 12 },
    ],
  })
  const places = mapped.locations.filter((location) => location.recordType === 'start_country' || location.recordType === 'end_country')
  assert.equal(places.length, 2)
  assert.deepEqual(
    places.map((location) => [location.entryType, location.recordType, location.placeFile, location.countryCode]),
    [
      [0, 'start_country', 'card_place_2', 'CZ'],
      [1, 'end_country', 'card_place_1', 'CZ'],
    ],
  )
})

test('typy 0 až 5 se zachovají a soubor karty není generace tachografu', () => {
  const mapped = card({
    file1: [0, 1, 2, 3, 4, 5].map((entryType) => ({
      entry_time: AT,
      entry_type_daily_work_period: entryType,
      daily_work_period_country: 12,
    })),
  })
  const places = mapped.locations.filter((location) => location.placeFile === 'card_place_1')
  assert.deepEqual(places.map((location) => location.entryType), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(places.map((location) => location.recordType), [
    'start_country',
    'end_country',
    'start_country',
    'end_country',
    'start_country',
    'end_country',
  ])
  assert.deepEqual(places.map((location) => location.isManualEntry), [false, false, true, true, false, false])
  assert.equal(places.every((location) => location.placeFile === 'card_place_1'), true)
})

test('stejný čas a jiná země zůstanou oba záznamy', () => {
  const mapped = card({
    file2: [
      { entry_time: AT, entry_type_daily_work_period: 0, daily_work_period_country: 12 },
      { entry_time: AT, entry_type_daily_work_period: 0, daily_work_period_country: 13 },
    ],
  })
  assert.deepEqual(
    mapped.locations.map((location) => [location.entryType, location.countryCode]),
    [
      [0, 'CZ'],
      [0, 'DE'],
    ],
  )
})
