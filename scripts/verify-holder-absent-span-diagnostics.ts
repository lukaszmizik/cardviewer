import assert from 'node:assert/strict'
import test from 'node:test'
import { formatHolderAbsentLongSpanDiagnosticsReport } from '../src/dev/holderTimelineAbsentSpanDiagnostics.ts'
import { diagnoseHolderAbsentLongSpansFromParserJson } from '../src/utils/dddMapper.ts'

const DAY = 24 * 60 * 60_000
const MINUTE = 60_000

function cardJson(days: object[]) {
  return {
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'ABS' },
    },
    card_driver_activity_2: { decoded_activity_daily_records: days },
  }
}

function day(isoDate: string, changes: object[]) {
  return {
    activity_record_date: new Date(isoDate).toISOString(),
    activity_change_info: changes,
  }
}

test('mezerová absent bridge: sameAbsentActivity, bez unknown', () => {
  const start = Date.parse('2024-10-28T16:47:00.000Z')
  const endDay = Date.parse('2024-12-28T00:00:00.000Z')
  const rows = diagnoseHolderAbsentLongSpansFromParserJson(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-12-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  const hit = rows.find((row) => row.startUtc === start && row.endUtc === endDay)
  assert.ok(hit)
  assert.equal(hit.spansUnrecordedDays, true)
  assert.equal(hit.sameAbsentActivity, true)
  assert.equal(hit.wouldCreateUnknownWithoutSameAbsentException, false)
  assert.equal(hit.dailyRecordsStrictlyBetweenDayStarts, 0)
  assert.equal(hit.dayStartDiffCalendarDays, 61)
})

test('bez sameAbsentActivity: wouldCreateUnknown true (zkrácení na konec dne)', () => {
  const rows = diagnoseHolderAbsentLongSpansFromParserJson(
    cardJson([
      day('2024-10-01T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
      day('2024-10-05T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 3, minutes: 0 },
      ]),
    ]),
    MINUTE,
  )
  const row = rows[0]
  assert.ok(row)
  assert.equal(row.sameAbsentActivity, false)
  assert.equal(row.spansUnrecordedDays, true)
  assert.equal(row.wouldCreateUnknownWithoutSameAbsentException, true)
  assert.equal(row.endUtc - row.startUtc, DAY)
})

test('navazující denní absent záznamy: krátké segmenty se nehlásí jako >24h', () => {
  const daily: object[] = []
  const t0 = Date.parse('2024-10-28T00:00:00.000Z')
  for (let index = 0; index < 5; index += 1) {
    daily.push(
      day(new Date(t0 + index * DAY).toISOString(), [
        {
          driver: true,
          card_present: false,
          work_type: 0,
          minutes: index === 0 ? 16 * 60 + 47 : 0,
        },
      ]),
    )
  }
  const rows = diagnoseHolderAbsentLongSpansFromParserJson(cardJson(daily))
  assert.equal(
    rows.length,
    0,
    'denní absent resty s nextLater na další den by neměly překročit 24h v jednom act',
  )
})

test('DEV report bez PII a s highlight štítkem', () => {
  const report = formatHolderAbsentLongSpanDiagnosticsReport(
    cardJson([
      day('2024-10-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 16 * 60 + 47 },
      ]),
      day('2024-12-28T00:00:00.000Z', [
        { driver: true, card_present: false, work_type: 0, minutes: 0 },
      ]),
    ]),
  )
  assert.match(report, /highlight 2024-10-28\/12-28/)
  assert.match(report, /sourceActivityId=act-0/)
  assert.match(report, /sameAbsentActivity=true/)
  assert.doesNotMatch(report, /card_number|holder_surname|SPZ/i)
})

test('card present start: nezařazen do absent diagnostiky', () => {
  const rows = diagnoseHolderAbsentLongSpansFromParserJson(
    cardJson([
      day('2024-10-01T00:00:00.000Z', [
        { driver: true, card_present: true, work_type: 0, minutes: 0 },
      ]),
      day('2024-10-10T00:00:00.000Z', [
        { driver: true, card_present: true, work_type: 3, minutes: 0 },
      ]),
    ]),
  )
  assert.equal(rows.length, 0)
})
