import { findRestIntervals } from '../analysis/restIntervals.ts'
import { classifyRestCandidates } from '../analysis/restCandidates.ts'
import { classifyWeeklyRestCandidates } from '../analysis/weeklyRest.ts'
import { buildWeeklyRestAssignment, type WeeklyAssignmentNode } from '../analysis/weeklyRestAssignment.ts'
import type { CompensationFulfillmentStatus } from '../analysis/weeklyRestCompensationTaken.ts'
import { assessWeeklyRestCompensationTaken, type ObligationFulfillment } from '../analysis/weeklyRestCompensationTaken.ts'
import { addDays, formatClockDateTime, type ClockMode } from '../lib/clock.ts'
import type { Activity } from '../types/tacho.ts'

const NINE_HOURS = 9 * 60 * 60 * 1000

export type WeeklyRestPanelCompensation = {
  requiredText: string
  deadlineText: string | null
  status: CompensationFulfillmentStatus
  statusText: string
  takenLines: string[]
  uncertaintyText: string | null
}

export type WeeklyRestPanelRest = {
  sourceNodeId: string
  summary: string
  assignmentText: string | null
  compensation: WeeklyRestPanelCompensation | null
  noCompensationText: string | null
}

export type WeeklyRestPanelSnapshotItem = {
  obligationId: string
  summary: string
  requiredText: string
  deadlineText: string | null
  status: CompensationFulfillmentStatus
  statusText: string
}

export type WeeklyRestPanelOutlook = {
  remainingText: string
  nearestDeadlineText: string | null
  attachmentText: string
  combinationText: string | null
  cautionText: string
}

export type WeeklyRestPanel = {
  title: 'Týdenní odpočinky a náhrady'
  basisText: string
  historyNote: string
  rests: WeeklyRestPanelRest[]
  emptyRestsText: string | null
  snapshotTitle: 'Stav k závěru vybraného týdne'
  snapshotNote: string
  snapshotItems: WeeklyRestPanelSnapshotItem[]
  snapshotEmptyText: string | null
  outlookTitle: 'Orientačně k vybranému okamžiku'
  outlook: WeeklyRestPanelOutlook | null
}

const STATUS_TEXT: Record<CompensationFulfillmentStatus, string> = {
  taken: 'Splněno (taken)',
  open: 'Otevřeno (open)',
  missed: 'Nesplněno v termínu (missed)',
  undecided: 'Nelze rozhodnout (undecided)',
}

const UNCERTAINTY: Record<string, string> = {
  record_incomplete: 'Záznam do termínu není úplný. Splnění ani nesplnění z něj nevyplývá.',
  alternative_outcomes: 'Je více přípustných rozdělení a nemají stejný výsledek.',
  obligation_not_unique: 'Týden odpočinku není jednoznačný, proto není jediný termín.',
}

/**
 * Sestaví texty panelu. Právní výpočet neopakuje.
 * Stav k závěru týdne bere jen odpočinky, které před tímto okamžikem celé skončily.
 */
export function buildWeeklyRestPanel(input: {
  activities: readonly Activity[]
  displayedWeekStartUtc: number
  clockMode: ClockMode
}): WeeklyRestPanel {
  const weekStart = input.displayedWeekStartUtc
  const weekEnd = addDays(weekStart, 7, input.clockMode)
  const history = assessRecord(input.activities, null)
  const snapshot = assessRecord(input.activities, weekEnd)
  const historyAssignment = buildWeeklyRestAssignment(history.input)
  const nodes = new Map(historyAssignment.nodes.map((node) => [node.id, node]))
  const fulfillments = new Map(history.report.fulfillments.map((item) => [item.obligationId, item]))
  const decisiveIds = new Set<string>([
    ...history.report.compensation.obligations.map((item) => item.sourceNodeId),
    ...history.report.compensation.notRequired.filter((item) => item.reason === 'regular_length').map((item) => item.sourceNodeId),
  ])
  const rests = [...decisiveIds]
    .map((id) => nodes.get(id))
    .filter((node): node is WeeklyAssignmentNode => node != null && relatesToWeek(node, weekStart, weekEnd))
    .sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)
    .map((node) => restRow(node, history.report.compensation.obligations.find((item) => item.sourceNodeId === node.id) ?? null, fulfillments, input.clockMode))

  const open = snapshot.report.fulfillments.filter((item) => item.status === 'open')
  const snapshotItems = snapshot.report.compensation.obligations
    .map((obligation) => snapshotItem(obligation, snapshot.report.fulfillments.find((item) => item.obligationId === obligation.id) ?? null, input.clockMode))
    .filter((item): item is WeeklyRestPanelSnapshotItem => item != null)
    .sort((left, right) => (left.deadlineText ?? '').localeCompare(right.deadlineText ?? '') || left.summary.localeCompare(right.summary))

  return {
    title: 'Týdenní odpočinky a náhrady',
    basisText: 'Týden a termín náhrady se počítají od pondělí 00:00 UTC. Časy odpočinku jsou ve stejném režimu jako graf.',
    historyNote: 'Splnění náhrady se posuzuje z celého dostupného záznamu, včetně doby po tomto týdnu.',
    rests,
    emptyRestsText: rests.length === 0 ? 'V tomto týdnu není rozhodný týdenní odpočinek.' : null,
    snapshotTitle: 'Stav k závěru vybraného týdne',
    snapshotNote: `Jen údaje dostupné do ${formatWhen(weekEnd, input.clockMode)}. Pozdější záznam se sem nepočítá.`,
    snapshotItems,
    snapshotEmptyText: snapshotItems.length === 0 ? 'K závěru týdne není evidovaná náhrada.' : null,
    outlookTitle: 'Orientačně k vybranému okamžiku',
    outlook: outlookFor(open, snapshot.report.compensation.obligations, input.clockMode),
  }
}

function assessRecord(activities: readonly Activity[], cutoff: number | null) {
  const candidates = classifyRestCandidates(findRestIntervals(activities))
  const lastEnd = activities.reduce((end, activity) => Math.max(end, activity.endUtc), Number.NEGATIVE_INFINITY)
  const recordEndUtc = cutoff == null ? (Number.isFinite(lastEnd) ? lastEnd : null) : Math.min(cutoff, Number.isFinite(lastEnd) ? lastEnd : cutoff)
  const visible = candidates.filter((candidate) => recordEndUtc == null || candidate.endUtc < recordEndUtc)
  const unknownIntervals = activities
    .filter((activity) => activity.kind === 'unknown' && activity.endUtc > activity.startUtc && (recordEndUtc == null || activity.startUtc < recordEndUtc))
    .map((activity) => ({
      startUtc: activity.startUtc,
      endUtc: recordEndUtc == null ? activity.endUtc : Math.min(activity.endUtc, recordEndUtc),
    }))
    .filter((interval) => interval.endUtc > interval.startUtc)
  const input = {
    candidates: classifyWeeklyRestCandidates(visible),
    rests: visible,
    unknownIntervals,
    recordEndUtc,
  }
  return { input, report: assessWeeklyRestCompensationTaken(input) }
}

function relatesToWeek(node: WeeklyAssignmentNode, weekStart: number, weekEnd: number): boolean {
  if (overlaps(node.startUtc, node.endUtc, weekStart, weekEnd)) return true
  return node.possibleWeeks.some((week) => week.attachment !== 'covered_slice' && overlaps(week.startUtc, week.endUtc, weekStart, weekEnd))
}

function restRow(
  node: WeeklyAssignmentNode,
  obligation: { id: string; compensationMs: number; deadlineUtc: number | null; certainty: 'determined' | 'ambiguous'; alternatives: { weekStartUtc: number }[] } | null,
  fulfillments: ReadonlyMap<string, ObligationFulfillment>,
  clockMode: ClockMode,
): WeeklyRestPanelRest {
  const label = node.lengthClass === 'regular' ? 'Běžný' : 'Zkrácený'
  const fulfillment = obligation == null ? null : fulfillments.get(obligation.id) ?? null
  return {
    sourceNodeId: node.id,
    summary: `${label}, ${durationText(node.durationMs)}, ${formatRange(node.startUtc, node.endUtc, clockMode)}`,
    assignmentText: assignmentText(node),
    compensation:
      obligation == null || fulfillment == null
        ? null
        : {
            requiredText: requirementText(obligation.compensationMs, obligation.deadlineUtc, obligation.certainty, clockMode),
            deadlineText: deadlineText(obligation.deadlineUtc, clockMode),
            status: fulfillment.status,
            statusText: STATUS_TEXT[fulfillment.status],
            takenLines: fulfillment.status === 'taken' ? takenLines(fulfillment, clockMode) : [],
            uncertaintyText: fulfillment.status === 'undecided' ? UNCERTAINTY[fulfillment.reason] ?? 'Výsledek není jednoznačný.' : null,
          },
    noCompensationText: obligation == null ? 'Náhrada nevzniká.' : null,
  }
}

function snapshotItem(
  obligation: { id: string; compensationMs: number; deadlineUtc: number | null; restStartUtc: number; restEndUtc: number; restMs: number; certainty: 'determined' | 'ambiguous' },
  fulfillment: ObligationFulfillment | null,
  clockMode: ClockMode,
): WeeklyRestPanelSnapshotItem | null {
  if (fulfillment == null) return null
  return {
    obligationId: obligation.id,
    summary: `Zkrácený ${durationText(obligation.restMs)}, ${formatRange(obligation.restStartUtc, obligation.restEndUtc, clockMode)}`,
    requiredText: requirementText(obligation.compensationMs, obligation.deadlineUtc, obligation.certainty, clockMode),
    deadlineText: deadlineText(obligation.deadlineUtc, clockMode),
    status: fulfillment.status,
    statusText: STATUS_TEXT[fulfillment.status],
  }
}

function outlookFor(
  open: readonly ObligationFulfillment[],
  obligations: readonly { id: string; compensationMs: number; deadlineUtc: number | null }[],
  clockMode: ClockMode,
): WeeklyRestPanelOutlook | null {
  const items = open
    .map((item) => obligations.find((obligation) => obligation.id === item.obligationId))
    .filter((item): item is { id: string; compensationMs: number; deadlineUtc: number | null } => item != null && item.deadlineUtc != null)
  if (items.length === 0) return null
  const nearest = [...items].sort((left, right) => left.deadlineUtc! - right.deadlineUtc!)[0]!
  const remaining = items.reduce((total, item) => total + item.compensationMs, 0)
  return {
    remainingText: `K závěru týdne zbývá nahradit ${durationText(remaining)}.`,
    nearestDeadlineText: `Nejbližší termín je ${deadlineText(nearest.deadlineUtc, clockMode)}.`,
    attachmentText: 'Náhradu lze připojit k jinému odpočinku nejméně 9 hodin.',
    combinationText: `Hostitelský odpočinek 9 h a náhrada ${durationText(nearest.compensationMs)} vycházejí orientačně na ${durationText(nearest.compensationMs + NINE_HOURS)}.`,
    cautionText: 'Tento součet nepotvrzuje, že je konkrétní navazující odpočinek právně přípustný.',
  }
}

function assignmentText(node: WeeklyAssignmentNode): string | null {
  const weeks = node.possibleWeeks.filter((week) => week.attachment !== 'covered_slice')
  if (node.weekChoice !== 'needs_controller' || weeks.length < 2) return null
  const labels = weeks.map((week) => formatWhen(week.startUtc, 'utc'))
  return `Lze přiřadit k týdnu od ${labels.join(' nebo od ')} UTC, jen k jednomu z nich.`
}

function requirementText(compensationMs: number, deadlineUtc: number | null, certainty: 'determined' | 'ambiguous', clockMode: ClockMode): string {
  if (certainty !== 'determined' || deadlineUtc == null) return `Náhrada ${durationText(compensationMs)}. Termín není jednoznačný.`
  return `Náhrada ${durationText(compensationMs)} do ${deadlineText(deadlineUtc, clockMode)}.`
}

function deadlineText(deadlineUtc: number | null, clockMode: ClockMode): string | null {
  if (deadlineUtc == null) return null
  const utc = `${formatClockDateTime(deadlineUtc, 'utc')} UTC`
  if (clockMode === 'utc') return utc
  return `${utc} (${formatClockDateTime(deadlineUtc, 'local')} místního času)`
}

function takenLines(fulfillment: ObligationFulfillment, clockMode: ClockMode): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const reading of fulfillment.readings) {
    if (!reading.onTime || !reading.assignsObligation) continue
    for (const allocation of reading.allocations) {
      for (const slice of allocation.slices) {
        if (slice.role !== 'compensation' || slice.obligationId !== fulfillment.obligationId) continue
        const key = `${slice.startUtc}:${slice.endUtc}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`Čerpání ${durationText(slice.durationMs)}, ${formatRange(slice.startUtc, slice.endUtc, clockMode)}`)
      }
    }
  }
  return lines
}

function formatRange(startUtc: number, endUtc: number, clockMode: ClockMode): string {
  return `${formatWhen(startUtc, clockMode)}–${formatWhen(endUtc, clockMode)}`
}

function formatWhen(utc: number, clockMode: ClockMode): string {
  return formatClockDateTime(utc, clockMode)
}

function durationText(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}

function overlaps(startUtc: number, endUtc: number, otherStart: number, otherEnd: number): boolean {
  return startUtc < otherEnd && otherStart < endUtc
}
