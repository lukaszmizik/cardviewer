import type { ActivityAnalysis, DailyAnalysisSegment } from '../analysis/analyzeDriverActivities.ts'
import type { DailyChainInterpretation, DailyChainNode, DailyRestChain } from '../analysis/dailyRestChain.ts'
import type { RestCandidate } from '../analysis/restCandidates.ts'
import { clockParts, formatClockDateTime } from '../lib/clock.ts'

/** Barvy odpočinku z grafu činností. Neznamenají dodržení předpisu. */
export const REST_OVERVIEW_COLOR = {
  daily: '#2d7d3e',
  longReducedLength: '#60a5fa',
  longRegularLength: '#2563eb',
} as const

export type RestTone = keyof typeof REST_OVERVIEW_COLOR | 'neutral'

export type OverviewDetail = {
  label: string
  value: string
}

export type DailyRestOverviewRow = {
  id: string
  dateUtc: string
  /** Okamžik, ze kterého je odvozené datum v UTC. */
  atUtc: number
  restSummary: string
  result: string
  tone: RestTone
  attention: boolean
  details: OverviewDetail[]
}

export type DailyRestOverview =
  | { status: 'needs_anchor'; message: string }
  | { status: 'rows'; rows: DailyRestOverviewRow[] }

const REDUCED_WEEKLY_LENGTH_MS = 24 * 60 * 60 * 1000
const REGULAR_WEEKLY_LENGTH_MS = 45 * 60 * 60 * 1000
const NEEDS_ANCHOR =
  'Denní přehled se zobrazí, až bude známý konec předchozího odpočinku. Vznikne z prvního zaznamenaného odpočinku dlouhého alespoň 11 hodin, nebo ze zadané kotvy UTC.'

type ShownRest = {
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
  established: boolean
  manualEntry: boolean
  kind: DailyChainInterpretation['kind'] | 'recorded'
  partsCount: number
}

/**
 * Zobrazovací řádky denního přehledu. Nový výpočet odpočinků nedělá.
 */
export function buildDailyRestOverview(analysis: ActivityAnalysis): DailyRestOverview {
  if (analysis.assessed.daily.status !== 'assessed') return { status: 'needs_anchor', message: NEEDS_ANCHOR }
  const candidates = analysis.candidates.restCandidates
  const shown = new Set<string>()
  const seenWindows = new Set<number>()
  const rows: DailyRestOverviewRow[] = []
  appendChain(rows, analysis.assessed.daily.chain, candidates, shown, seenWindows)
  for (const segment of analysis.assessed.daily.segments) {
    appendSegment(rows, segment, candidates, shown, seenWindows)
  }
  return { status: 'rows', rows }
}

export function restOverviewColor(tone: RestTone): string | null {
  return tone === 'neutral' ? null : REST_OVERVIEW_COLOR[tone]
}

function appendChain(
  rows: DailyRestOverviewRow[],
  chain: DailyRestChain,
  candidates: readonly RestCandidate[],
  shown: Set<string>,
  seenWindows: Set<number>,
): void {
  const nodes = [...chain.nodes].sort((left, right) => left.anchorUtc - right.anchorUtc || left.windowStartUtc - right.windowStartUtc)
  for (const node of nodes) {
    if (seenWindows.has(node.anchorUtc)) continue
    seenWindows.add(node.anchorUtc)
    rows.push(windowRow(node, candidates, shown))
  }
}

function appendSegment(
  rows: DailyRestOverviewRow[],
  segment: DailyAnalysisSegment,
  candidates: readonly RestCandidate[],
  shown: Set<string>,
  seenWindows: Set<number>,
): void {
  if (segment.kind === 'analysis_gap') {
    rows.push({
      id: `gap:${segment.startUtc}:${segment.endUtc}`,
      dateUtc: dateLabel(segment.startUtc),
      atUtc: segment.startUtc,
      restSummary: lengthLabel(segment.endUtc - segment.startUtc),
      result: 'Úsek nebyl vyhodnocen',
      tone: 'neutral',
      attention: false,
      details: [
        { label: 'Období', value: intervalLabel(segment.startUtc, segment.endUtc) },
        { label: 'Vysvětlení', value: 'Denní návaznost tento úsek nehodnotí. Nejde o chybějící záznam.' },
      ],
    })
    return
  }
  const bridge = candidates.find((candidate) => sameIds(candidate.sourceActivityIds, segment.sourceActivityIds))
  if (bridge != null && !shown.has(restKey(bridge))) {
    shown.add(restKey(bridge))
    rows.push(recognizedCandidateRow(bridge, ['Od konce tohoto odpočinku pokračuje další denní návaznost.']))
  }
  appendChain(rows, segment.chain, candidates, shown, seenWindows)
}

function windowRow(node: DailyChainNode, candidates: readonly RestCandidate[], shown: Set<string>): DailyRestOverviewRow {
  const windowDetail = { label: 'Posuzované období', value: intervalLabel(node.windowStartUtc, node.windowEndUtc) }
  if (node.status === 'history_incomplete' || node.status === 'insufficient_data') {
    const rests = recordedRests(node, candidates, shown)
    return {
      id: `window:${node.anchorUtc}`,
      dateUtc: dateLabel(node.windowStartUtc),
      atUtc: node.windowStartUtc,
      restSummary: summaryOfRests(rests),
      result: node.status === 'history_incomplete' ? 'Neúplná historie' : 'Nedostatečná data',
      tone: toneOfRests(rests),
      attention: true,
      details: [
        windowDetail,
        {
          label: 'Vysvětlení',
          value: node.status === 'history_incomplete'
            ? 'Záznam končí dříve, než toto 24hodinové období skončí.'
            : 'V období je neznámý úsek. Neznámý úsek není odpočinek a z období nelze rozhodnout.',
        },
        ...restDetailLines(rests),
      ],
    }
  }
  if (node.status === 'window_unsatisfied') {
    const rests = recordedRests(node, candidates, shown)
    const continues = node.interpretations.some((item) => item.nextAnchorUtc != null)
    return {
      id: `window:${node.anchorUtc}`,
      dateUtc: dateLabel(node.windowStartUtc),
      atUtc: node.windowStartUtc,
      restSummary: summaryOfRests(rests),
      result: 'Nesplněné 24hodinové období',
      tone: toneOfRests(rests),
      attention: true,
      details: [
        windowDetail,
        {
          label: 'Vysvětlení',
          value: continues
            ? 'Odpočinek pokračuje za konec období. Toto období tím není splněné. Nejde o pravomocně zjištěný přestupek.'
            : rests.length > 0
              ? 'Zaznamenaný odpočinek požadavek tohoto období nesplňuje. Nejde o pravomocně zjištěný přestupek.'
              : 'V tomto 24hodinovém období není odpočinek, který by požadavek splnil. Nejde o pravomocně zjištěný přestupek.',
        },
        ...restDetailLines(rests),
      ],
    }
  }
  const qualifying = node.interpretations.filter((item) => item.qualifiesWindow)
  if (qualifying.length > 1) {
    const rests = qualifying.flatMap((item) => item.parts.map((part) => shownRest(part, candidates, item.established)))
    rests.forEach((rest) => shown.add(restKey(rest)))
    return {
      id: `window:${node.anchorUtc}`,
      dateUtc: dateLabel(node.windowStartUtc),
      atUtc: node.windowStartUtc,
      restSummary: 'Více možností',
      result: 'Více možných interpretací',
      tone: 'neutral',
      attention: false,
      details: [
        windowDetail,
        { label: 'Vysvětlení', value: 'Jde o možné podoby téhož období. Platí nejvýše jedna a žádná není vybraná.' },
        ...qualifying.map((item, index) => ({
          label: `Možnost ${index + 1}`,
          value: optionText(item, candidates),
        })),
      ],
    }
  }
  const chosen = qualifying[0]
  if (chosen == null) {
    return {
      id: `window:${node.anchorUtc}`,
      dateUtc: dateLabel(node.windowStartUtc),
      atUtc: node.windowStartUtc,
      restSummary: '—',
      result: 'Nedostatečná data',
      tone: 'neutral',
      attention: true,
      details: [windowDetail, { label: 'Vysvětlení', value: 'Okno nemá vybranou podobu odpočinku.' }],
    }
  }
  chosen.parts.forEach((part) => shown.add(restKey(part)))
  return recognizedInterpretationRow(`window:${node.anchorUtc}`, chosen, candidates, [windowDetail])
}

function recognizedCandidateRow(candidate: RestCandidate, notes: string[]): DailyRestOverviewRow {
  return presentRest({
    id: `bridge:${candidate.startUtc}:${candidate.endUtc}`,
    startUtc: candidate.startUtc,
    endUtc: candidate.endUtc,
    sourceActivityIds: [...candidate.sourceActivityIds],
    established: candidate.established,
    manualEntry: candidate.manualEntry,
    summary: lengthLabel(candidate.endUtc - candidate.startUtc),
    result: resultForDuration(candidate.endUtc - candidate.startUtc, candidate.kinds.includes('daily_reduced') && !candidate.kinds.includes('daily_regular') ? 'continuous_reduced' : 'continuous_regular', 1),
    tone: toneForDuration(candidate.endUtc - candidate.startUtc),
    notes,
    extra: [],
  })
}

function recognizedInterpretationRow(
  id: string,
  item: DailyChainInterpretation,
  candidates: readonly RestCandidate[],
  extra: OverviewDetail[],
): DailyRestOverviewRow {
  const parts = [...item.parts].sort((left, right) => left.startUtc - right.startUtc)
  const first = parts[0]
  const last = parts[parts.length - 1]
  const matched = parts
    .map((part) => candidateFor(candidates, part.startUtc, part.endUtc, part.sourceActivityIds))
    .filter((candidate): candidate is RestCandidate => candidate != null)
  const durationMs = parts.reduce((sum, part) => sum + (part.endUtc - part.startUtc), 0)
  const partDetails = parts.length > 1
    ? parts.map((part, index) => ({
        label: `Část ${index + 1}`,
        value: `${intervalLabel(part.startUtc, part.endUtc)}, ${lengthLabel(part.endUtc - part.startUtc)}`,
      }))
    : []
  return presentRest({
    id,
    startUtc: first?.startUtc ?? 0,
    endUtc: last?.endUtc ?? 0,
    sourceActivityIds: [...new Set(parts.flatMap((part) => part.sourceActivityIds))],
    established: item.established && matched.every((candidate) => candidate.established),
    manualEntry: matched.some((candidate) => candidate.manualEntry),
    summary: parts.length > 1 ? parts.map((part) => lengthLabel(part.endUtc - part.startUtc)).join(' + ') : lengthLabel(durationMs),
    result: resultForDuration(durationMs, item.kind, parts.length),
    tone: parts.length > 1 ? 'daily' : toneForDuration(durationMs),
    notes: [],
    extra: [...extra, ...partDetails],
  })
}

function presentRest(input: {
  id: string
  startUtc: number
  endUtc: number
  sourceActivityIds: string[]
  established: boolean
  manualEntry: boolean
  summary: string
  result: string
  tone: RestTone
  notes: string[]
  extra: OverviewDetail[]
}): DailyRestOverviewRow {
  const durationMs = input.endUtc - input.startUtc
  const split = input.summary.includes(' + ')
  const long = input.result === 'Dlouhý souvislý odpočinek'
  const details: OverviewDetail[] = [
    ...(split ? [] : [{ label: 'Začátek a konec', value: intervalLabel(input.startUtc, input.endUtc) }]),
    { label: 'Délka', value: input.summary },
    ...input.extra,
  ]
  if (long) {
    details.push({
      label: 'Délková způsobilost',
      value: durationMs >= REGULAR_WEEKLY_LENGTH_MS
        ? 'Alespoň 45 hodin. Týdenní role není potvrzena.'
        : 'Alespoň 24 hodin a méně než 45 hodin. Týdenní role není potvrzena.',
    })
  }
  if (!input.established) details.push({ label: 'Nejistota', value: 'Interval je nejistý kvůli překryvu.' })
  if (input.manualEntry) details.push({ label: 'Ruční záznam', value: 'Alespoň jedna část je ručně zadaná. Samo o sobě odpočinek nevyřazuje.' })
  if (input.sourceActivityIds.length > 0) details.push({ label: 'Zdroje', value: input.sourceActivityIds.join(', ') })
  for (const note of input.notes) details.push({ label: 'Návaznost', value: note })
  return {
    id: input.id,
    dateUtc: dateLabel(input.startUtc),
    atUtc: input.startUtc,
    restSummary: input.summary,
    result: input.result,
    tone: input.tone,
    attention: false,
    details,
  }
}

function resultForDuration(durationMs: number, kind: DailyChainInterpretation['kind'], partsCount: number): string {
  if (durationMs >= REDUCED_WEEKLY_LENGTH_MS && partsCount <= 1) return 'Dlouhý souvislý odpočinek'
  if (partsCount > 1 || kind === 'split_regular') return 'Dělený denní odpočinek'
  if (kind === 'continuous_reduced') return 'Zkrácený denní odpočinek'
  if (kind === 'continuous_regular') return 'Běžný denní odpočinek'
  return 'Rozpoznaný odpočinek'
}

function combinedRest(item: DailyChainInterpretation, candidates: readonly RestCandidate[]): ShownRest {
  const parts = [...item.parts].sort((left, right) => left.startUtc - right.startUtc)
  const first = parts[0]
  const last = parts[parts.length - 1]
  const matched = parts
    .map((part) => candidateFor(candidates, part.startUtc, part.endUtc, part.sourceActivityIds))
    .filter((candidate): candidate is RestCandidate => candidate != null)
  return {
    startUtc: first?.startUtc ?? 0,
    endUtc: last?.endUtc ?? first?.startUtc ?? 0,
    sourceActivityIds: [...new Set(parts.flatMap((part) => part.sourceActivityIds))],
    established: item.established && matched.every((candidate) => candidate.established),
    manualEntry: matched.some((candidate) => candidate.manualEntry),
    kind: item.kind,
    partsCount: parts.length,
  }
}

function recordedRests(node: DailyChainNode, candidates: readonly RestCandidate[], shown: Set<string>): ShownRest[] {
  const fromParts = node.interpretations.flatMap((item) => item.parts.map((part) => shownRest(part, candidates, item.established)))
  const inside = candidates
    .filter((candidate) => candidate.startUtc < node.windowEndUtc && candidate.endUtc > node.windowStartUtc)
    .map((candidate) => shownRest(candidate, candidates, candidate.established))
  const unique: ShownRest[] = []
  for (const rest of [...fromParts, ...inside].sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)) {
    const key = restKey(rest)
    if (shown.has(key) || unique.some((item) => restKey(item) === key)) continue
    shown.add(key)
    unique.push(rest)
  }
  return unique
}

function shownRest(
  part: { startUtc: number; endUtc: number; sourceActivityIds: readonly string[] },
  candidates: readonly RestCandidate[],
  established: boolean,
): ShownRest {
  const matched = candidateFor(candidates, part.startUtc, part.endUtc, part.sourceActivityIds)
  return {
    startUtc: part.startUtc,
    endUtc: part.endUtc,
    sourceActivityIds: [...part.sourceActivityIds],
    established: established && (matched?.established ?? true),
    manualEntry: matched?.manualEntry ?? false,
    kind: 'recorded',
    partsCount: 1,
  }
}

function summaryOfRests(rests: readonly ShownRest[]): string {
  if (rests.length === 0) return 'Bez zaznamenaného odpočinku'
  if (rests.length > 1) return 'Více úseků'
  return lengthLabel(rests[0]!.endUtc - rests[0]!.startUtc)
}

function toneOfRests(rests: readonly ShownRest[]): RestTone {
  if (rests.length !== 1) return rests.length === 0 ? 'neutral' : 'daily'
  return toneForDuration(rests[0]!.endUtc - rests[0]!.startUtc)
}

function toneForDuration(durationMs: number): RestTone {
  if (durationMs >= REGULAR_WEEKLY_LENGTH_MS) return 'longRegularLength'
  if (durationMs >= REDUCED_WEEKLY_LENGTH_MS) return 'longReducedLength'
  return 'daily'
}

function restDetailLines(rests: readonly ShownRest[]): OverviewDetail[] {
  return rests.map((rest, index) => ({
    label: rests.length === 1 ? 'Zaznamenaný odpočinek' : `Úsek ${index + 1}`,
    value: [
      `${intervalLabel(rest.startUtc, rest.endUtc)}, ${lengthLabel(rest.endUtc - rest.startUtc)}`,
      rest.established ? '' : 'Interval je nejistý kvůli překryvu.',
      rest.manualEntry ? 'Ruční záznam.' : '',
      rest.sourceActivityIds.length > 0 ? `Zdroje: ${rest.sourceActivityIds.join(', ')}.` : '',
    ].filter((part) => part !== '').join(' '),
  }))
}

function optionText(item: DailyChainInterpretation, candidates: readonly RestCandidate[]): string {
  const rest = combinedRest(item, candidates)
  const long = rest.endUtc - rest.startUtc >= REDUCED_WEEKLY_LENGTH_MS
  const label = long ? 'dlouhý souvislý odpočinek' : item.kind === 'split_regular' ? 'dělený denní odpočinek' : item.kind === 'continuous_reduced' ? 'zkrácený denní odpočinek' : 'běžný denní odpočinek'
  const parts = [...item.parts].sort((left, right) => left.startUtc - right.startUtc)
  const body = parts.length > 1
    ? parts.map((part, index) => `část ${index + 1}: ${intervalLabel(part.startUtc, part.endUtc)}, ${lengthLabel(part.endUtc - part.startUtc)}`).join('; ')
    : `${intervalLabel(rest.startUtc, rest.endUtc)}, ${lengthLabel(rest.endUtc - rest.startUtc)}`
  const notes = [
    !item.established ? 'Interval je nejistý kvůli překryvu.' : '',
    rest.manualEntry ? 'Ruční záznam.' : '',
  ].filter((note) => note !== '')
  return [`${label}: ${body}`, ...notes].join(' ')
}

function candidateFor(
  candidates: readonly RestCandidate[],
  startUtc: number,
  endUtc: number,
  sourceActivityIds: readonly string[],
): RestCandidate | undefined {
  return candidates.find((candidate) => candidate.startUtc === startUtc && candidate.endUtc === endUtc && sameIds(candidate.sourceActivityIds, sourceActivityIds))
}

function dateLabel(utc: number): string {
  const parts = clockParts(utc, 'utc')
  return `${parts.day}. ${parts.month}. ${parts.year}`
}

function intervalLabel(startUtc: number, endUtc: number): string {
  return `${formatClockDateTime(startUtc, 'utc')}–${formatClockDateTime(endUtc, 'utc')} UTC`
}

function lengthLabel(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000))
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) {
    const dayText = days === 1 ? '1 den' : days >= 2 && days <= 4 ? `${days} dny` : `${days} dní`
    if (hours === 0 && minutes === 0) return dayText
    if (minutes === 0) return `${dayText} ${hours} h`
    return `${dayText} ${hours} h ${minutes} min`
  }
  if (hours === 0) return `${minutes} min`
  if (minutes === 0) return `${hours} h`
  return `${hours} h ${minutes} min`
}

function restKey(rest: { startUtc: number; endUtc: number; sourceActivityIds: readonly string[] }): string {
  return `${rest.startUtc}:${rest.endUtc}:${[...rest.sourceActivityIds].sort().join('+')}`
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSorted = [...right].sort()
  return [...left].sort().every((id, index) => id === rightSorted[index])
}
