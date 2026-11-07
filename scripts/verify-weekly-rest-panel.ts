import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWeeklyRestPanel } from '../src/components/weeklyRestPanel.ts'
import type { Activity } from '../src/types/tacho.ts'

const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR
const WEEK_START = Date.parse('2026-03-02T00:00:00.000Z')

function activity(id: string, kind: Activity['kind'], startUtc: number, endUtc: number): Activity {
  return { id, kind, startUtc, endUtc, durationMinutes: Math.round((endUtc - startUtc) / 60_000), slot: 1 }
}

function panel(activities: Activity[], weekStart = WEEK_START) {
  return buildWeeklyRestPanel({ activities, displayedWeekStartUtc: weekStart, clockMode: 'utc' })
}

function withTail(activities: Activity[], tailStart: number): Activity[] {
  return [...activities, activity('tail', 'driving', tailStart, tailStart + 30 * 60 * 1000)]
}

test('běžný týdenní odpočinek nemá náhradu', () => {
  const start = Date.parse('2026-03-03T00:00:00.000Z')
  const view = panel(withTail([activity('regular', 'rest', start, start + 45 * HOUR)], start + 46 * HOUR))
  assert.equal(view.rests.length, 1)
  assert.equal(view.rests[0]?.summary.startsWith('Běžný, 45 h'), true)
  assert.equal(view.rests[0]?.compensation, null)
  assert.equal(view.rests[0]?.noCompensationText, 'Náhrada nevzniká.')
  assert.equal(view.snapshotItems.length, 0)
  assert.equal(view.outlook, null)
  assert.equal(JSON.stringify(view).includes('přestupek'), false)
})

test('zkrácený odpočinek má otevřený dluh', () => {
  const start = Date.parse('2026-03-03T00:00:00.000Z')
  const view = panel(withTail([activity('reduced', 'rest', start, start + 24 * HOUR)], Date.parse('2026-03-20T00:00:00.000Z')))
  const rest = view.rests[0]
  assert.equal(rest?.summary.startsWith('Zkrácený, 24 h'), true)
  assert.equal(rest?.compensation?.status, 'open')
  assert.equal(rest?.compensation?.requiredText.includes('21 h'), true)
  assert.equal(rest?.compensation?.deadlineText, '30.03.2026 00:00 UTC')
  assert.deepEqual(rest?.compensation?.takenLines, [])
  assert.equal(view.outlook?.remainingText, 'K závěru týdne zbývá nahradit 21 h.')
  assert.equal(view.outlook?.combinationText?.includes('30 h'), true)
  assert.equal(view.outlook?.cautionText.includes('nepotvrzuje'), true)
})

test('později včas splněná náhrada se v historickém týdnu ještě nepočítá', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const block = Date.parse('2026-03-12T00:00:00.000Z')
  const view = panel(
    withTail(
      [activity('reduced', 'rest', reduced, reduced + 24 * HOUR), activity('block', 'rest', block, block + 66 * HOUR)],
      Date.parse('2026-06-01T00:00:00.000Z'),
    ),
  )
  const rest = view.rests.find((item) => item.summary.includes('24 h'))
  assert.equal(rest?.compensation?.status, 'taken')
  assert.equal(rest?.compensation?.takenLines.length, 2)
  assert.equal(rest?.compensation?.takenLines.every((line) => line.includes('21 h')), true)
  const snapshot = view.snapshotItems.find((item) => item.summary.includes('24 h'))
  assert.equal(snapshot?.status, 'open')
  assert.equal(snapshot?.statusText.includes('taken'), false)
})

test('prokazatelně nesplněná náhrada není označená jako splněná', () => {
  const reduced = Date.parse('2026-03-03T00:00:00.000Z')
  const short = Date.parse('2026-03-05T00:00:00.000Z')
  const regular = Date.parse('2026-03-09T00:00:00.000Z')
  const view = panel(
    withTail(
      [
        activity('reduced', 'rest', reduced, reduced + 24 * HOUR),
        activity('short', 'rest', short, short + 29 * HOUR),
        activity('regular', 'rest', regular, regular + 45 * HOUR),
      ],
      Date.parse('2026-06-01T00:00:00.000Z'),
    ),
  )
  const rest = view.rests.find((item) => item.summary.startsWith('Zkrácený, 24 h'))
  assert.equal(rest?.compensation?.status, 'missed')
  assert.deepEqual(rest?.compensation?.takenLines, [])
  assert.equal(view.rests.some((item) => item.compensation?.status === 'taken'), false)
})

test('nejisté přiřazení ponechá oba týdny a nevybere termín', () => {
  const start = Date.parse('2026-03-08T18:00:00.000Z')
  const view = panel(withTail([activity('span', 'rest', start, start + 30 * HOUR)], Date.parse('2026-06-01T00:00:00.000Z')))
  const rest = view.rests[0]
  assert.equal(rest?.compensation?.status, 'undecided')
  assert.equal(rest?.assignmentText?.includes('02.03.2026 00:00'), true)
  assert.equal(rest?.assignmentText?.includes('09.03.2026 00:00'), true)
  assert.equal(rest?.compensation?.deadlineText, null)
  assert.equal(rest?.compensation?.requiredText.includes('Termín není jednoznačný'), true)
  assert.equal(view.outlook, null)
})

test('dvě současně otevřené náhrady zahrnují i starší týden', () => {
  const first = Date.parse('2026-03-03T00:00:00.000Z')
  const second = Date.parse('2026-03-09T06:00:00.000Z')
  const view = panel(
    withTail(
      [activity('first', 'rest', first, first + 24 * HOUR), activity('second', 'rest', second, second + 25 * HOUR)],
      Date.parse('2026-03-20T00:00:00.000Z'),
    ),
    WEEK_START + WEEK,
  )
  assert.equal(view.rests.length, 1)
  assert.equal(view.rests[0]?.summary.includes('25 h'), true)
  assert.equal(view.snapshotItems.length, 2)
  assert.equal(view.snapshotItems.every((item) => item.status === 'open'), true)
  assert.equal(view.outlook?.remainingText, 'K závěru týdne zbývá nahradit 41 h.')
  assert.equal(view.outlook?.nearestDeadlineText, 'Nejbližší termín je 30.03.2026 00:00 UTC.')
})

test('neúplná data nevytvoří splnění ani nesplnění', () => {
  const start = Date.parse('2026-03-03T00:00:00.000Z')
  const view = panel(
    withTail(
      [
        activity('reduced', 'rest', start, start + 24 * HOUR),
        activity('gap', 'unknown', Date.parse('2026-03-15T00:00:00.000Z'), Date.parse('2026-03-16T00:00:00.000Z')),
      ],
      Date.parse('2026-06-01T00:00:00.000Z'),
    ),
  )
  assert.equal(view.rests[0]?.compensation?.status, 'undecided')
  assert.equal(view.rests[0]?.compensation?.uncertaintyText?.includes('není úplný'), true)
  assert.notEqual(view.rests[0]?.compensation?.status, 'missed')
  assert.notEqual(view.rests[0]?.compensation?.status, 'taken')
})
