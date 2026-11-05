import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { mapDddParserJson } from '../src/utils/dddMapper.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'
import type { Activity } from '../src/types/tacho.ts'

const dumpGapOnly = process.argv.includes('--dump-gap')

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const DAY_24 = Date.parse('2024-10-24T00:00:00.000Z')

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

function mapChanges(days: ReturnType<typeof day>[]): Activity[] {
  return mapDddParserJson({
    card_identification_and_driver_card_holder_identification_1: {
      card_identification: { card_number: 'TIMELINE' },
    },
    card_driver_activity_2: { decoded_activity_daily_records: days },
  }).activities
}

if (dumpGapOnly) {
  const activities = mapChanges([
    day(DAY_24, [{ driver: true, card_present: true, work_type: 0, minutes: 600 }]),
    day(DAY_24 + 2 * DAY, [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
  ])
  console.log(JSON.stringify(activities))
  process.exit(0)
}

function overlaps(activities: Activity[]): number {
  let count = 0
  for (let i = 0; i < activities.length; i += 1) {
    for (let j = i + 1; j < activities.length; j += 1) {
      const left = activities[i]!
      const right = activities[j]!
      if (left.startUtc < right.endUtc && right.startUtc < left.endUtc) count += 1
    }
  }
  return count
}

test('přechod slot 1 → slot 2 → slot 1 se nesmí překrývat', () => {
  const activities = mapChanges([
    day(DAY_24, [
      { driver: true, card_present: true, work_type: 0, minutes: 0 },
      { driver: false, card_present: true, work_type: 2, minutes: 120 },
      { driver: true, card_present: true, work_type: 3, minutes: 180 },
    ]),
  ])
  assert.deepEqual(
    activities.map((activity) => [activity.slot, activity.kind, activity.startUtc, activity.endUtc]),
    [
      [1, 'rest', DAY_24, DAY_24 + 120 * MINUTE],
      [2, 'work', DAY_24 + 120 * MINUTE, DAY_24 + 180 * MINUTE],
      [1, 'driving', DAY_24 + 180 * MINUTE, DAY_24 + DAY],
    ],
  )
  assert.equal(overlaps(activities), 0)
})

test('konec aktivity je nejbližší pozdější změna bez ohledu na slot', () => {
  const activities = mapChanges([
    day(DAY_24, [
      { driver: true, card_present: true, work_type: 3, minutes: 0 },
      { driver: false, card_present: true, work_type: 0, minutes: 60 },
    ]),
  ])
  assert.equal(activities[0]?.slot, 1)
  assert.equal(activities[0]?.kind, 'driving')
  assert.equal(activities[0]?.endUtc, DAY_24 + 60 * MINUTE)
  assert.equal(activities[1]?.slot, 2)
  assert.equal(activities[1]?.kind, 'rest')
  assert.equal(activities[1]?.startUtc, DAY_24 + 60 * MINUTE)
})

test('stejná minuta ve dvou slotech nevytvoří dlouhý překryv a zachová pořadí', () => {
  const activities = mapChanges([
    day(DAY_24, [
      { driver: false, card_present: false, work_type: 1, minutes: 100 },
      { driver: true, card_present: true, work_type: 2, minutes: 100 },
      { driver: true, card_present: true, work_type: 0, minutes: 130 },
    ]),
  ])
  assert.deepEqual(
    activities.map((activity) => [activity.slot, activity.kind, activity.startUtc, activity.endUtc, activity.isManualEntry === true]),
    [
      [2, 'availability', DAY_24 + 100 * MINUTE, DAY_24 + 100 * MINUTE, true],
      [1, 'work', DAY_24 + 100 * MINUTE, DAY_24 + 130 * MINUTE, false],
      [1, 'rest', DAY_24 + 130 * MINUTE, DAY_24 + DAY, false],
    ],
  )
  assert.equal(overlaps(activities), 0)
  assert.ok(activities.every((activity) => activity.endUtc >= activity.startUtc))
})

test('aktivita přechází přes UTC půlnoc bez unknown', () => {
  const activities = mapChanges([
    day(DAY_24, [{ driver: true, card_present: true, work_type: 0, minutes: 23 * 60 }]),
    day(DAY_24 + DAY, [{ driver: true, card_present: true, work_type: 3, minutes: 60 }]),
  ])
  assert.equal(activities.length, 2)
  assert.equal(activities[0]?.startUtc, DAY_24 + 23 * 60 * MINUTE)
  assert.equal(activities[0]?.endUtc, DAY_24 + DAY + 60 * MINUTE)
  assert.equal(activities.some((activity) => activity.id.startsWith('gap-')), false)
})

test('mezera jednoho a více dnů končí na UTC půlnoci a unknown nemá slot 1', () => {
  const one = mapChanges([
    day(DAY_24, [{ driver: true, card_present: true, work_type: 0, minutes: 600 }]),
    day(DAY_24 + 2 * DAY, [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
  ])
  const gap = one.find((activity) => activity.id.startsWith('gap-'))
  assert.equal(one[0]?.kind, 'rest')
  assert.equal(one[0]?.endUtc, DAY_24 + DAY)
  assert.equal(gap?.kind, 'unknown')
  assert.equal(gap?.startUtc, DAY_24 + DAY)
  assert.equal(gap?.endUtc, DAY_24 + 2 * DAY)
  assert.equal(gap?.slot, undefined)
  assert.equal(one[0]?.endUtc - one[0]?.startUtc, 14 * 60 * MINUTE)

  const many = mapChanges([
    day(DAY_24, [{ driver: true, card_present: true, work_type: 2, minutes: 0 }]),
    day(DAY_24 + 4 * DAY, [{ driver: true, card_present: true, work_type: 0, minutes: 0 }]),
  ])
  const longGap = many.find((activity) => activity.id.startsWith('gap-'))
  assert.equal(many[0]?.endUtc, DAY_24 + DAY)
  assert.equal(longGap?.startUtc, DAY_24 + DAY)
  assert.equal(longGap?.endUtc, DAY_24 + 4 * DAY)
  assert.equal(longGap?.slot, undefined)
})

test('TZ=UTC a TZ=Europe/Prague dají stejné UTC hranice', () => {
  const run = (tz: string) => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', fileURLToPath(import.meta.url), '--dump-gap'],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  assert.equal(run('UTC'), run('Europe/Prague'))
})

test('ruční záznam, osádka a slot zůstávají na původním UTC čase', () => {
  const activities = mapChanges([
    day(DAY_24, [
      { driver: true, card_present: false, work_type: 2, minutes: 15 },
      { driver: false, team: true, card_present: true, work_type: 1, minutes: 45 },
    ]),
  ])
  assert.equal(activities[0]?.isManualEntry, true)
  assert.equal(activities[0]?.kind, 'work')
  assert.equal(activities[0]?.slot, 1)
  assert.equal(activities[0]?.isCrew, false)
  assert.equal(activities[0]?.startUtc, DAY_24 + 15 * MINUTE)
  assert.equal(activities[1]?.isManualEntry, false)
  assert.equal(activities[1]?.slot, 2)
  assert.equal(activities[1]?.isCrew, true)
  assert.equal(activities[1]?.kind, 'availability')
  assert.equal(activities[1]?.startUtc, DAY_24 + 45 * MINUTE)
})

test('unknown není odpočinek', () => {
  const activities = mapChanges([
    day(DAY_24, [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
    day(DAY_24 + 3 * DAY, [{ driver: true, card_present: true, work_type: 3, minutes: 0 }]),
  ])
  const gap = activities.find((activity) => activity.kind === 'unknown')
  assert.ok(gap)
  assert.equal(gap?.kind, 'unknown')
  assert.equal(findRestIntervals(activities).some((interval) => interval.sourceActivityIds.includes(gap!.id)), false)
  assert.equal(activities.some((activity) => activity.kind === 'rest'), false)
})
