import assert from 'node:assert/strict'
import test from 'node:test'
import {
  diagnoseWorkPeriodsFromCard,
  formatWorkPeriodDiagnosticsReport,
} from '../src/analysis/workPeriodDiagnostics.ts'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY_0 = Date.parse('2024-10-24T00:00:00.000Z')

function mapCard(changes: object[]) {
  return mapDddParserJson({
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'DIAG' },
    },
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        {
          activity_record_date: new Date(DAY_0).toISOString(),
          activity_change_info: changes,
        },
      ],
    },
  })
}

test('formát diagnostického výstupu obsahuje požadované sekce', () => {
  const card = mapCard([
    { driver: true, card_present: true, work_type: 3, minutes: 0 },
    { driver: true, card_present: false, work_type: 0, minutes: 120 },
    { driver: true, card_present: true, work_type: 3, minutes: 240 },
  ])
  const report = diagnoseWorkPeriodsFromCard(card)
  assert.equal(report.activities.count, card.activities.length)
  assert.ok(report.cardPresentEdges.total >= 1)
  assert.equal(report.workEnvelopeCount, 1)
  assert.equal(report.candidateCutCount, report.cuts.length)

  const text = formatWorkPeriodDiagnosticsReport(report)
  assert.match(text, /^=== WorkPeriod diagnostika/)
  assert.match(text, /Aktivity: počet=/)
  assert.match(text, /cardPresentEdges:/)
  assert.match(text, /VehicleUse: počet=/)
  assert.match(text, /WorkEnvelope: počet=1/)
  assert.match(text, /CandidateCut: počet=/)
  assert.doesNotMatch(text, /\bSECRET\b|card_number|1AB2345/i)
})

test('diagnostika neobsahuje registrační značky z VehicleUse', () => {
  const card = mapDddParserJson({
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'SECRET' },
    },
    card_driver_activity_2: {
      decoded_activity_daily_records: [
        {
          activity_record_date: new Date(DAY_0).toISOString(),
          activity_change_info: [
            { driver: true, work_type: 3, minutes: 0 },
            { driver: true, work_type: 0, minutes: 180 },
            { driver: true, work_type: 3, minutes: 300 },
          ],
        },
      ],
    },
    card_vehicles_used_2: {
      card_vehicle_records: [
        {
          vehicle_first_use: new Date(DAY_0).toISOString(),
          vehicle_last_use: new Date(DAY_0 + 3 * HOUR).toISOString(),
          vehicle_registration: { vehicle_registration_number: '1AB2345' },
        },
        {
          vehicle_first_use: new Date(DAY_0 + 5 * HOUR).toISOString(),
          vehicle_last_use: new Date(DAY_0 + 9 * HOUR).toISOString(),
          vehicle_registration: { vehicle_registration_number: '6CD7890' },
        },
      ],
    },
  })
  const text = formatWorkPeriodDiagnosticsReport(diagnoseWorkPeriodsFromCard(card))
  assert.match(text, /VehicleUse: počet=2/)
  assert.doesNotMatch(text, /1AB2345|6CD7890|SECRET/)
})
