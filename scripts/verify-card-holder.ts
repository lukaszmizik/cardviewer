import assert from 'node:assert/strict'
import test from 'node:test'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'

const DAY = '2024-06-01T00:00:00.000Z'

function activityBlock() {
  return {
    decoded_activity_daily_records: [
      {
        activity_record_date: DAY,
        activity_change_info: [{ driver: true, card_present: true, work_type: 3, minutes: 0 }],
      },
    ],
  }
}

function emptyGen2Shell() {
  return {
    card_identification: {
      card_issuing_member_state: 0,
      card_number: '',
      card_issuing_authority_name: '',
    },
    driver_card_holder_identification: {
      card_holder_name: { holder_surname: '', holder_first_names: '' },
      card_holder_birth_date: { year: 0, month: 0, day: 0 },
      card_holder_preferred_language: '',
    },
  }
}

test('prázdný gen2 blok nepřepíše platný gen1', () => {
  const mapped = mapDddParserJson({
    card_identification_and_driver_card_holder_identification_2: emptyGen2Shell(),
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: {
        card_issuing_member_state: 49,
        card_number: 'GEN1CARDNUMBER01',
        card_issuing_authority_name: 'AUTHORITY',
        card_issue_date: '2020-01-15T00:00:00Z',
        card_validity_begin: '2020-01-15T00:00:00Z',
        card_expiry_date: '2025-01-15T00:00:00Z',
      },
      driver_card_holder_identification: {
        card_holder_name: { holder_surname: 'SURNAME', holder_first_names: 'GIVEN' },
        card_holder_birth_date: { year: 1990, month: 3, day: 4 },
        card_holder_preferred_language: 'uk',
      },
    },
    card_driving_licence_information_2: { driving_licence_number: '', driving_licence_issuing_nation: 0 },
    card_driving_licence_information_1: {
      driving_licence_number: 'LICENCE01',
      driving_licence_issuing_nation: 49,
      driving_licence_issuing_authority: 'LICAUTH',
    },
    card_driver_activity_1: activityBlock(),
  })
  assert.equal(mapped.cardNumber, 'GEN1CARDNUMBER01')
  assert.equal(mapped.surname, 'SURNAME')
  assert.equal(mapped.firstName, 'GIVEN')
  assert.equal(mapped.dateOfBirth, '04.03.1990')
  assert.equal(mapped.issuingCountry, 'UA')
  assert.equal(mapped.dateOfIssue, '15.01.2020')
  assert.equal(mapped.validityBegin, '15.01.2020')
  assert.equal(mapped.dateOfExpiry, '15.01.2025')
  assert.equal(mapped.drivingLicenseNumber, 'LICENCE01')
  assert.equal(mapped.activities.length, 1)
})

test('platný gen2 má přednost před gen1', () => {
  const mapped = mapDddParserJson({
    card_identification_and_driver_card_holder_identification_2: {
      card_identification: { card_issuing_member_state: 12, card_number: 'GEN2CARDNUMBER001' },
      driver_card_holder_identification: {
        card_holder_name: { holder_surname: 'NEW', holder_first_names: 'NAME' },
        card_holder_birth_date: { year: 1985, month: 1, day: 2 },
      },
    },
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_issuing_member_state: 12, card_number: 'GEN1CARDNUMBER001' },
      driver_card_holder_identification: {
        card_holder_name: { holder_surname: 'OLD', holder_first_names: 'NAME' },
      },
    },
  })
  assert.equal(mapped.cardNumber, 'GEN2CARDNUMBER001')
  assert.equal(mapped.surname, 'NEW')
  assert.equal(mapped.issuingCountry, 'CZ')
})

test('oba identifikační bloky prázdné a bez aktivit skončí chybou', () => {
  assert.throws(
    () =>
      mapDddParserJson({
        card_identification_and_driver_card_holder_identification_2: emptyGen2Shell(),
        card_identification_and_driver_card_holder_identification_1: emptyGen2Shell(),
      }),
    /identifikaci řidiče ani aktivity/,
  )
})

test('neúplný gen2 bez údajů spadne na gen1, aktivity zůstanou', () => {
  const mapped = mapDddParserJson({
    card_identification_and_driver_card_holder_identification_2: {
      card_identification: { card_number: '   ' },
      driver_card_holder_identification: {
        card_holder_birth_date: { year: 0, month: 0, day: 0 },
      },
    },
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'PARTIALGEN1', card_issuing_member_state: 12 },
    },
    card_driver_activity_1: activityBlock(),
  })
  assert.equal(mapped.cardNumber, 'PARTIALGEN1')
  assert.equal(mapped.dateOfBirth, undefined)
  assert.equal(mapped.activities.length, 1)
  assert.equal(mapped.activities[0]!.kind, 'driving')
})
