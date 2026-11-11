import assert from 'node:assert/strict'
import test from 'node:test'
import { addDays } from '../src/lib/clock.ts'
import type { OutModeEvent } from '../src/TachoTypes.ts'
import {
  buildOutModeGraphModel,
  formatOutModeTimeRange,
  formatOutModeTooltip,
  sliceOutRangeForDay,
} from '../src/lib/outModeGraph.ts'
import { partitionOutSliceByManualOverlap } from '../src/lib/outModeGraph.ts'

const MIN = 60_000
const DAY0 = Date.parse('2026-04-10T00:00:00.000Z')

function out(type: OutModeEvent['type'], minuteFromDay0: number): OutModeEvent {
  return { type, minuteStartUtc: DAY0 + minuteFromDay0 * MIN }
}

test('běžný interval OUT uvnitř dne', () => {
  const model = buildOutModeGraphModel(
    [out('activation', 10 * 60 + 15), out('deactivation', 12 * 60 + 40)],
    DAY0 + 24 * 60 * MIN,
  )
  assert.equal(model.ranges.length, 1)
  assert.equal(model.ranges[0]!.incomplete, false)
  const slice = sliceOutRangeForDay(model.ranges[0]!, DAY0, 'utc')
  assert.deepEqual(slice, {
    startMs: DAY0 + (10 * 60 + 15) * MIN,
    endMs: DAY0 + (12 * 60 + 40) * MIN,
  })
  assert.equal(formatOutModeTimeRange(slice!.startMs, slice!.endMs, 'utc'), '10:15–12:40')
})

test('OUT přes půlnoc – dva denní řezy', () => {
  const start = 22 * 60
  const end = 26 * 60
  const model = buildOutModeGraphModel([out('activation', start), out('deactivation', end)], DAY0 + 48 * 60 * MIN)
  const range = model.ranges[0]!
  const day1 = sliceOutRangeForDay(range, DAY0, 'utc')
  const day2 = sliceOutRangeForDay(range, addDays(DAY0, 1, 'utc'), 'utc')
  assert.ok(day1 && day2)
  assert.equal(day1.endMs, addDays(DAY0, 1, 'utc'))
  assert.equal(day2.startMs, addDays(DAY0, 1, 'utc'))
})

test('OUT přes několik dní', () => {
  const model = buildOutModeGraphModel([out('activation', 30), out('deactivation', 3 * 24 * 60 + 60)], DAY0 + 5 * 24 * 60 * MIN)
  const range = model.ranges[0]!
  let slices = 0
  for (let d = 0; d < 4; d++) {
    if (sliceOutRangeForDay(range, addDays(DAY0, d, 'utc'), 'utc') != null) slices++
  }
  assert.equal(slices, 4)
})

test('chybějící out_end – neúplný interval do konce dat', () => {
  const recordEnd = DAY0 + (8 * 60) * MIN
  const model = buildOutModeGraphModel([out('activation', 6 * 60)], recordEnd)
  assert.equal(model.ranges.length, 1)
  assert.equal(model.ranges[0]!.incomplete, true)
  assert.equal(model.ranges[0]!.endMs, recordEnd)
})

test('osamocené out_end bez začátku', () => {
  const model = buildOutModeGraphModel([out('deactivation', 9 * 60 + 30)], DAY0 + 24 * 60 * MIN)
  assert.equal(model.ranges.length, 0)
  assert.equal(model.orphanEnds.length, 1)
  assert.equal(model.orphanEnds[0]!.endMs, DAY0 + (9 * 60 + 30) * MIN)
})

test('opakovaná aktivace bez ukončení – nejisté párování', () => {
  const model = buildOutModeGraphModel(
    [out('activation', 60), out('activation', 120), out('deactivation', 180)],
    DAY0 + 24 * 60 * MIN,
  )
  assert.equal(model.ranges.length, 2)
  assert.equal(model.ranges[0]!.incomplete, true)
  assert.equal(model.ranges[0]!.uncertain, true)
  assert.equal(model.ranges[1]!.uncertain, true)
})

test('tooltip obsahuje povinné řádky', () => {
  const tooltip = formatOutModeTooltip(DAY0 + 10 * MIN, DAY0 + 40 * MIN, 'utc', false, false)
  assert.match(tooltip, /^Režim OUT\n/)
  assert.match(tooltip, /Tachograf byl v režimu mimo působnost/)
  assert.match(tooltip, /Oprávněnost použití OUT/)
  assert.match(tooltip, /Délka: 0:30/)
})

test('překryv OUT s manuálním zadáním rozdělí pás na dva řádky', () => {
  const sliceStart = DAY0 + 60 * MIN
  const sliceEnd = DAY0 + 180 * MIN
  const manuals = [{ startMs: DAY0 + 90 * MIN, endMs: DAY0 + 120 * MIN }]
  const parts = partitionOutSliceByManualOverlap(sliceStart, sliceEnd, manuals)
  assert.equal(parts.length, 3)
  assert.equal(parts[0]!.manualRow, false)
  assert.equal(parts[1]!.manualRow, true)
  assert.equal(parts[2]!.manualRow, false)
})

test('interval přes půlnoc zobrazí datum v čase', () => {
  const start = DAY0 + 23 * 60 * MIN
  const end = DAY0 + 25 * 60 * MIN
  const label = formatOutModeTimeRange(start, end, 'utc')
  assert.notEqual(label, '23:00–01:00')
  assert.match(label, /–/)
})
