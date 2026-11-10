import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDailyRecordCoverageReport } from '../src/dev/dailyRecordCoverageReport.ts'
import type { DriverCardData } from '../src/types/tacho.ts'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'

function cardJson(cardNumber: string, days: object[]) {
  return {
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: cardNumber },
    },
    card_driver_activity_2: { decoded_activity_daily_records: days },
  }
}

function day(isoDate: string, changes: object[] = []) {
  return {
    activity_record_date: new Date(isoDate).toISOString(),
    activity_change_info: changes,
  }
}

function minimalInternalCard(overrides: Partial<DriverCardData> = {}): DriverCardData {
  return {
    cardNumber: 'LEG',
    firstName: 'A',
    surname: 'B',
    lastWithdrawalUtc: null,
    activities: [],
    locations: [],
    violations: [],
    ...overrides,
  }
}

test('jedna karta — mapování připojí dailyRecordCoverageGaps', () => {
  const parserJson = cardJson('ONE', [
    day('2024-10-28T00:00:00.000Z', [
      { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
    ]),
    day('2024-12-28T00:00:00.000Z', [
      { driver: true, card_present: false, work_type: 0, minutes: 0 },
    ]),
  ])
  const mapped = mapDddParserJson(parserJson)
  assert.ok(mapped.dailyRecordCoverageGaps)
  assert.equal(mapped.dailyRecordCoverageGaps.length, 1)
  assert.equal(mapped.dailyRecordCoverageGaps[0]!.calendarDaysBetween, 60)
})

test('dvě různé karty — odlišné coverage metadata', () => {
  const cardA = mapDddParserJson(
    cardJson('AAA', [
      day('2024-10-28T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
      day('2024-11-05T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
    ]),
  )
  const cardB = mapDddParserJson(
    cardJson('BBB', [
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-12-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  assert.notDeepEqual(cardA.dailyRecordCoverageGaps, cardB.dailyRecordCoverageGaps)
  assert.equal(cardA.dailyRecordCoverageGaps?.[0]?.calendarDaysBetween, 7)
  assert.equal(cardB.dailyRecordCoverageGaps?.[0]?.calendarDaysBetween, 60)
})

test('přepnutí aktivní karty — metadata zůstávají vázaná na objekt karty', () => {
  const cardA = mapDddParserJson(
    cardJson('SWA', [
      day('2024-10-01T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
      day('2024-10-03T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
    ]),
  )
  const cardB = mapDddParserJson(
    cardJson('SWB', [
      day('2024-10-01T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
      day('2024-10-05T00:00:00.000Z', [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
    ]),
  )
  let active: DriverCardData = cardA
  assert.equal(active.dailyRecordCoverageGaps?.length, 1)
  assert.equal(active.dailyRecordCoverageGaps?.[0]?.calendarDaysBetween, 1)
  active = cardB
  assert.equal(active.dailyRecordCoverageGaps?.[0]?.calendarDaysBetween, 3)
  assert.notEqual(active.dailyRecordCoverageGaps, cardA.dailyRecordCoverageGaps)
})

test('starý uložený objekt bez coverage — isInternalCard kompatibilita', () => {
  const legacy = mapDddParserJson(minimalInternalCard({ cardNumber: 'OLD' }))
  assert.equal(legacy.dailyRecordCoverageGaps, undefined)
  assert.equal(legacy.cardNumber, 'OLD')
})

test('serializace a deserializace JSON zachová coverage', () => {
  const mapped = mapDddParserJson(
    cardJson('SER', [
      day('2024-10-28T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
      day('2024-10-30T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
    ]),
  )
  const roundTrip = JSON.parse(JSON.stringify(mapped)) as DriverCardData
  assert.deepEqual(roundTrip.dailyRecordCoverageGaps, mapped.dailyRecordCoverageGaps)
})

test('opakované načtení stejné karty — shodná coverage metadata', () => {
  const parserJson = cardJson('REL', [
    day('2024-10-28T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
    day('2024-11-02T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
  ])
  const first = mapDddParserJson(parserJson)
  const second = mapDddParserJson(parserJson)
  assert.deepEqual(first.dailyRecordCoverageGaps, second.dailyRecordCoverageGaps)
})

test('DEV report preferuje metadata na kartě před parserJson', () => {
  const mapped = mapDddParserJson(
    cardJson('DEV', [
      day('2024-10-28T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
      day('2024-10-30T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
    ]),
  )
  const otherParser = cardJson('OTHER', [
    day('2024-10-28T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
    day('2024-12-28T00:00:00.000Z', [{ driver: true, card_present: false, work_type: 0, minutes: 0 }]),
  ])
  const text = formatDailyRecordCoverageReport(mapped, otherParser)
  assert.match(text, /Zdroj gaps: DriverCardData\.dailyRecordCoverageGaps/)
  assert.match(text, /Celkem coverage gaps: 1/)
  assert.equal(mapped.dailyRecordCoverageGaps?.[0]?.calendarDaysBetween, 1)
  assert.equal(deriveFromOtherParserWouldBe60(), 60)

  function deriveFromOtherParserWouldBe60(): number {
    const other = mapDddParserJson(otherParser)
    return other.dailyRecordCoverageGaps?.[0]?.calendarDaysBetween ?? -1
  }
})
