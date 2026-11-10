import assert from 'node:assert/strict'
import test from 'node:test'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'
import type { CardPresentEdge } from '../src/types/tacho.ts'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const DAY_0 = Date.parse('2024-10-24T00:00:00.000Z')

type Change = {
  driver?: boolean
  team?: boolean
  card_present?: boolean
  work_type?: number
  minutes?: number
}

function day(dateMs: number, changes: Change[]) {
  return {
    activity_record_date: new Date(dateMs).toISOString(),
    activity_change_info: changes,
  }
}

function mapEdges(days: ReturnType<typeof day>[]): CardPresentEdge[] {
  return (
    mapDddParserJson({
      card_identification_and_driver_card_holder_identification_1: {
        card_identification: { card_number: 'CARD-PRESENT' },
      },
      card_driver_activity_2: { decoded_activity_daily_records: days },
    }).cardPresentEdges ?? []
  )
}

test('skutečný přechod true → false', () => {
  const at = DAY_0 + 120 * MINUTE
  const edges = mapEdges([
    day(DAY_0, [
      { driver: true, card_present: true, work_type: 3, minutes: 0 },
      { driver: true, card_present: false, work_type: 2, minutes: 120 },
    ]),
  ])
  assert.deepEqual(edges, [{ atUtc: at, present: false, slot: 1 }])
})

test('skutečný přechod false → true', () => {
  const at = DAY_0 + 60 * MINUTE
  const edges = mapEdges([
    day(DAY_0, [
      { driver: true, card_present: false, work_type: 2, minutes: 0 },
      { driver: true, card_present: true, work_type: 3, minutes: 60 },
    ]),
  ])
  assert.deepEqual(edges, [{ atUtc: at, present: true, slot: 1 }])
})

test('opakování stejného stavu nevytvoří hranu', () => {
  const edges = mapEdges([
    day(DAY_0, [
      { driver: true, card_present: true, work_type: 3, minutes: 0 },
      { driver: true, card_present: true, work_type: 0, minutes: 90 },
      { driver: true, card_present: true, work_type: 3, minutes: 180 },
    ]),
  ])
  assert.equal(edges.length, 0)
})

test('první záznam bez explicitního card_present nevytvoří přechod', () => {
  const edges = mapEdges([
    day(DAY_0, [
      { driver: true, work_type: 3, minutes: 0 },
      { driver: true, card_present: false, work_type: 2, minutes: 30 },
    ]),
  ])
  assert.equal(edges.length, 0)
})

test('přechod přes půlnoc při doložené návaznosti', () => {
  const at = DAY_0 + DAY + 30 * MINUTE
  const edges = mapEdges([
    day(DAY_0, [{ driver: true, card_present: true, work_type: 3, minutes: 23 * 60 }]),
    day(DAY_0 + DAY, [{ driver: true, card_present: false, work_type: 2, minutes: 30 }]),
  ])
  assert.deepEqual(edges, [{ atUtc: at, present: false, slot: 1 }])
})

test('mezeru mezi dny bez doložené návaznosti nepřemosťuje hranou', () => {
  const edges = mapEdges([
    day(DAY_0, [{ driver: true, card_present: true, work_type: 3, minutes: 100 }]),
    day(DAY_0 + 2 * DAY, [{ driver: true, card_present: false, work_type: 2, minutes: 0 }]),
  ])
  assert.equal(edges.length, 0)
})

test('oddělené sloty mapují přechody nezávisle', () => {
  const slot1At = DAY_0 + 90 * MINUTE
  const slot2At = DAY_0 + 45 * MINUTE
  const edges = mapEdges([
    day(DAY_0, [
      { driver: true, card_present: true, work_type: 3, minutes: 0 },
      { driver: false, card_present: true, work_type: 1, minutes: 0 },
      { driver: false, card_present: false, work_type: 2, minutes: 45 },
      { driver: true, card_present: false, work_type: 2, minutes: 90 },
    ]),
  ])
  assert.equal(edges.length, 2)
  assert.deepEqual(
    edges.find((edge) => edge.slot === 1),
    { atUtc: slot1At, present: false, slot: 1 },
  )
  assert.deepEqual(
    edges.find((edge) => edge.slot === 2),
    { atUtc: slot2At, present: false, slot: 2 },
  )
})

test('konfliktní card_present ve stejném čase nevytvoří hranu', () => {
  const edges = mapEdges([
    day(DAY_0, [
      { driver: true, card_present: true, work_type: 3, minutes: 100 },
      { driver: true, card_present: false, work_type: 2, minutes: 100 },
    ]),
  ])
  assert.equal(edges.length, 0)
})
