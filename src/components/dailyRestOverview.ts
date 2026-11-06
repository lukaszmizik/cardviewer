import type { ActivityAnalysis, DailyAnalysisSegment } from '../analysis/analyzeDriverActivities.ts'
import type { DailyChainInterpretation, DailyChainNode, DailyRestChain } from '../analysis/dailyRestChain.ts'
import type { RestCandidate } from '../analysis/restCandidates.ts'
import { formatClockDate, formatClockDateTime, formatClockTime } from '../lib/clock.ts'

export type DailyRestOverviewRow = {
  id: string
  dateUtc: string
  intervalUtc: string
  duration: string
  recognition: string
  note: string
}

export type DailyRestOverview =
  | { status: 'needs_anchor'; message: string }
  | { status: 'rows'; rows: DailyRestOverviewRow[] }

const NEEDS_ANCHOR =
  'Denní přehled se zobrazí, až bude známý konec předchozího odpočinku. Vznikne z prvního zaznamenaného odpočinku dlouhého alespoň 11 hodin, nebo ze zadané kotvy UTC.'

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
      dateUtc: dateUtc(segment.startUtc),
      intervalUtc: intervalUtc(segment.startUtc, segment.endUtc),
      duration: durationUtc(segment.startUtc, segment.endUtc),
      recognition: 'Nehodnocený úsek',
      note: 'Denní návaznost tento úsek nehodnotí. Není to chybějící záznam ani porušení.',
    })
    return
  }
  const bridge = candidates.find((candidate) => sameIds(candidate.sourceActivityIds, segment.sourceActivityIds))
  if (bridge != null && !shown.has(restKey(bridge.startUtc, bridge.endUtc, bridge.sourceActivityIds))) {
    shown.add(restKey(bridge.startUtc, bridge.endUtc, bridge.sourceActivityIds))
    rows.push({
      id: `bridge:${bridge.startUtc}:${bridge.endUtc}`,
      dateUtc: dateUtc(bridge.startUtc),
      intervalUtc: intervalUtc(bridge.startUtc, bridge.endUtc),
      duration: durationUtc(bridge.startUtc, bridge.endUtc),
      recognition: recognizedKind(bridge),
      note: joinNotes(['Od konce tohoto odpočinku pokračuje další denní návaznost.', ...restNotes(bridge)]),
    })
  }
  appendChain(rows, segment.chain, candidates, shown, seenWindows)
}

function windowRow(node: DailyChainNode, candidates: readonly RestCandidate[], shown: Set<string>): DailyRestOverviewRow {
  const base = {
    id: `window:${node.anchorUtc}`,
    dateUtc: dateUtc(node.windowStartUtc),
  }
  if (node.status === 'history_incomplete' || node.status === 'insufficient_data') {
    const rests = recordedRests(node, candidates, shown)
    return {
      ...base,
      intervalUtc: rests.length > 0 ? rests.map((rest) => intervalUtc(rest.startUtc, rest.endUtc)).join('; ') : intervalUtc(node.windowStartUtc, node.windowEndUtc),
      duration: rests.length > 0 ? rests.map((rest) => durationUtc(rest.startUtc, rest.endUtc)).join('; ') : '—',
      recognition: 'Nelze rozhodnout',
      note: joinNotes([
        node.status === 'history_incomplete'
          ? 'Záznam končí dříve, než toto 24hodinové období skončí.'
          : 'V období je neznámý úsek, proto z něj nelze rozhodnout.',
        ...rests.flatMap(restNotes),
      ]),
    }
  }
  if (node.status === 'window_unsatisfied') {
    const rests = recordedRests(node, candidates, shown)
    const continues = node.interpretations.some((item) => item.nextAnchorUtc != null)
    return {
      ...base,
      intervalUtc: rests.length > 0 ? rests.map((rest) => intervalUtc(rest.startUtc, rest.endUtc)).join('; ') : intervalUtc(node.windowStartUtc, node.windowEndUtc),
      duration: rests.length > 0 ? rests.map((rest) => durationUtc(rest.startUtc, rest.endUtc)).join('; ') : '—',
      recognition: continues ? 'Období není splněné' : 'Nedostatečný odpočinek',
      note: joinNotes([
        continues
          ? 'Odpočinek pokračuje za konec období. Toto období tím není splněné.'
          : rests.length > 0
            ? 'Zaznamenaný odpočinek požadavek tohoto období nesplňuje.'
            : 'V tomto 24hodinovém období není odpočinek, který by požadavek splnil.',
        ...rests.flatMap(restNotes),
      ]),
    }
  }
  const qualifying = node.interpretations.filter((item) => item.qualifiesWindow)
  if (qualifying.length > 1) {
    qualifying.flatMap((item) => item.parts).forEach((part) => shown.add(restKey(part.startUtc, part.endUtc, part.sourceActivityIds)))
    return {
      ...base,
      intervalUtc: qualifying.map((item, index) => `Možnost ${index + 1}, ${typeLabel(item.kind)}: ${partsInterval(item)}`).join(' '),
      duration: qualifying.map((item, index) => `Možnost ${index + 1}: ${partsDuration(item)}`).join(' '),
      recognition: 'Více možností',
      note: joinNotes([
        'Platí nejvýše jedna možnost. Žádná není vybraná.',
        ...qualifying.flatMap((item) => interpretationNotes(item, candidates)),
      ]),
    }
  }
  const chosen = qualifying[0]
  if (chosen == null) {
    return {
      ...base,
      intervalUtc: intervalUtc(node.windowStartUtc, node.windowEndUtc),
      duration: '—',
      recognition: 'Nelze rozhodnout',
      note: 'Okno nemá vybranou podobu odpočinku.',
    }
  }
  chosen.parts.forEach((part) => shown.add(restKey(part.startUtc, part.endUtc, part.sourceActivityIds)))
  const first = [...chosen.parts].sort((left, right) => left.startUtc - right.startUtc)[0]
  return {
    ...base,
    dateUtc: dateUtc(first?.startUtc ?? node.windowStartUtc),
    intervalUtc: partsInterval(chosen),
    duration: partsDuration(chosen),
    recognition: singleRecognition(chosen.kind),
    note: joinNotes(interpretationNotes(chosen, candidates)),
  }
}

function recordedRests(node: DailyChainNode, candidates: readonly RestCandidate[], shown: Set<string>): RestCandidate[] {
  const fromParts = node.interpretations.flatMap((item) =>
    item.parts.map((part) => candidateFor(candidates, part.startUtc, part.endUtc, part.sourceActivityIds) ?? syntheticCandidate(part)),
  )
  const inside = candidates.filter((candidate) => candidate.startUtc < node.windowEndUtc && candidate.endUtc > node.windowStartUtc)
  const unique: RestCandidate[] = []
  for (const candidate of [...fromParts, ...inside].sort((left, right) => left.startUtc - right.startUtc || left.endUtc - right.endUtc)) {
    const key = restKey(candidate.startUtc, candidate.endUtc, candidate.sourceActivityIds)
    if (shown.has(key) || unique.some((item) => restKey(item.startUtc, item.endUtc, item.sourceActivityIds) === key)) continue
    shown.add(key)
    unique.push(candidate)
  }
  return unique
}

function syntheticCandidate(part: { startUtc: number; endUtc: number; sourceActivityIds: string[] }): RestCandidate {
  return {
    startUtc: part.startUtc,
    endUtc: part.endUtc,
    durationMs: part.endUtc - part.startUtc,
    durationMinutes: Math.round((part.endUtc - part.startUtc) / 60_000),
    slot: 1,
    sourceActivityIds: [...part.sourceActivityIds],
    manualEntry: false,
    ambiguous: false,
    established: true,
    uncertainties: [],
    overlappingNonRestKinds: [],
    kinds: [],
  }
}

function candidateFor(
  candidates: readonly RestCandidate[],
  startUtc: number,
  endUtc: number,
  sourceActivityIds: readonly string[],
): RestCandidate | undefined {
  return candidates.find((candidate) => candidate.startUtc === startUtc && candidate.endUtc === endUtc && sameIds(candidate.sourceActivityIds, sourceActivityIds))
}

function interpretationNotes(item: DailyChainInterpretation, candidates: readonly RestCandidate[]): string[] {
  const notes: string[] = []
  if (!item.established) notes.push('Interval je nejistý kvůli překryvu.')
  const manual = item.parts.some((part) => candidateFor(candidates, part.startUtc, part.endUtc, part.sourceActivityIds)?.manualEntry)
  if (manual) notes.push('Ruční záznam.')
  return notes
}

function restNotes(candidate: RestCandidate): string[] {
  const notes: string[] = []
  if (!candidate.established) notes.push('Interval je nejistý kvůli překryvu.')
  if (candidate.manualEntry) notes.push('Ruční záznam.')
  return notes
}

function partsInterval(item: DailyChainInterpretation): string {
  const parts = [...item.parts].sort((left, right) => left.startUtc - right.startUtc)
  if (parts.length <= 1) {
    const part = parts[0]
    return part == null ? '—' : intervalUtc(part.startUtc, part.endUtc)
  }
  return parts.map((part, index) => `část ${index + 1}: ${intervalUtc(part.startUtc, part.endUtc)}`).join('; ')
}

function partsDuration(item: DailyChainInterpretation): string {
  const parts = [...item.parts].sort((left, right) => left.startUtc - right.startUtc)
  if (parts.length === 0) return '—'
  return parts.map((part) => durationUtc(part.startUtc, part.endUtc)).join(' + ')
}

function typeLabel(kind: DailyChainInterpretation['kind']): string {
  if (kind === 'continuous_regular') return 'běžný'
  if (kind === 'continuous_reduced') return 'zkrácený'
  if (kind === 'split_regular') return 'dělený'
  return 'nedostatečný'
}

function singleRecognition(kind: DailyChainInterpretation['kind']): string {
  if (kind === 'continuous_regular') return 'Běžný denní odpočinek'
  if (kind === 'continuous_reduced') return 'Zkrácený denní odpočinek'
  if (kind === 'split_regular') return 'Dělený denní odpočinek'
  return 'Denní odpočinek'
}

function recognizedKind(candidate: RestCandidate): string {
  if (candidate.kinds.includes('daily_regular')) return 'Běžný denní odpočinek'
  if (candidate.kinds.includes('daily_reduced')) return 'Zkrácený denní odpočinek'
  return 'Zaznamenaný odpočinek'
}

function dateUtc(utc: number): string {
  return `${formatClockDate(utc, 'utc')} UTC`
}

function intervalUtc(startUtc: number, endUtc: number): string {
  if (formatClockDate(startUtc, 'utc') === formatClockDate(endUtc, 'utc')) {
    return `${formatClockDate(startUtc, 'utc')} ${formatClockTime(startUtc, 'utc')}–${formatClockTime(endUtc, 'utc')} UTC`
  }
  return `${formatClockDateTime(startUtc, 'utc')} UTC – ${formatClockDateTime(endUtc, 'utc')} UTC`
}

function durationUtc(startUtc: number, endUtc: number): string {
  const total = Math.max(0, Math.round((endUtc - startUtc) / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

function restKey(startUtc: number, endUtc: number, sourceActivityIds: readonly string[]): string {
  return `${startUtc}:${endUtc}:${[...sourceActivityIds].sort().join('+')}`
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSorted = [...right].sort()
  return [...left].sort().every((id, index) => id === rightSorted[index])
}

function joinNotes(notes: string[]): string {
  return [...new Set(notes.filter((note) => note !== ''))].join(' ')
}
