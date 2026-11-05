import type { ActivityAnalysis, NotEvaluatedTopic } from './analyzeDriverActivities.ts'
import type { DailyChainNode } from './dailyRestChain.ts'

export type DiagnosticStatus =
  | 'recorded_fact'
  | 'multiple_interpretations'
  | 'insufficient_data'
  | 'not_implemented'

export type DiagnosticCase = {
  id: string
  status: DiagnosticStatus
  startUtc: number | null
  endUtc: number | null
  sourceActivityIds: string[]
  module: string
  summary: string
  reason: string
  needed: string
}

export type DiagnosticExport = {
  exportedAtUtc: string
  cases: Array<DiagnosticCase & { note: string }>
}

const LIST_LIMIT = 8

const NOT_IMPLEMENTED: Record<NotEvaluatedTopic, Pick<DiagnosticCase, 'summary' | 'reason' | 'needed'>> = {
  infringements: {
    summary: 'Přestupky se nevyhodnocují.',
    reason: 'Jádro eviduje údaje a varianty. Právní nález nevytváří.',
    needed: 'Samostatná vrstva nálezů, až budou pravidla dokončená.',
  },
  consecutive_weeks: {
    summary: 'Pravidlo dvou po sobě jdoucích týdnů není implementováno.',
    reason: 'Týdenní modul tuto kontrolu záměrně nechává jako not_evaluated.',
    needed: 'Doplnit pravidlo dvou týdnů až po explicitním výběru odpočinků.',
  },
  international_regime: {
    summary: 'Zvláštní režim mezinárodní nákladní dopravy není implementován.',
    reason: 'Karta sama neprokazuje dopravu mimo stát usazení.',
    needed: 'Výslovně zadat režim a doplnit čtyřtýdenní podmínku.',
  },
  compensation_taken: {
    summary: 'Čerpání kompenzace zkráceného týdenního odpočinku není implementováno.',
    reason: 'Deficit se smí jen evidovat. K jinému odpočinku se nepřiřazuje.',
    needed: 'Pozdější modul, který kompenzaci teprve spáruje.',
  },
}

/**
 * Diagnostické případy k prověření. Běžný odpočinek sám o sobě případ nevytváří.
 * Délková způsobilost není právní potvrzení.
 */
export function deriveDiagnosticCases(analysis: ActivityAnalysis): DiagnosticCase[] {
  const cases: DiagnosticCase[] = []
  pushRecordedFacts(analysis, cases)
  pushDailyBranches(analysis, cases)
  pushInputGaps(analysis, cases)
  pushUnknowns(analysis, cases)
  pushAmbiguousRests(analysis, cases)
  pushNotImplemented(analysis, cases)
  return cases
}

export function buildDiagnosticExport(
  cases: readonly DiagnosticCase[],
  notes: Readonly<Record<string, string>>,
  exportedAtUtc: string,
): DiagnosticExport {
  return {
    exportedAtUtc,
    cases: cases.map((item) => ({
      ...item,
      sourceActivityIds: [...item.sourceActivityIds],
      note: notes[item.id] ?? '',
    })),
  }
}

function pushRecordedFacts(analysis: ActivityAnalysis, cases: DiagnosticCase[]): void {
  const activities = analysis.recorded.activities
  if (activities.length === 0) {
    cases.push({
      id: 'insufficient:no-activities',
      status: 'insufficient_data',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      module: 'analyzeDriverActivities',
      summary: 'Karta nemá žádné aktivity.',
      reason: 'Bez časové osy nelze počítat odpočinky.',
      needed: 'Načíst kartu se záznamem činností.',
    })
    return
  }

  const startUtc = Math.min(...activities.map((item) => item.startUtc))
  const endUtc = Math.max(...activities.map((item) => item.endUtc))
  cases.push({
    id: 'recorded:activity-span',
    status: 'recorded_fact',
    startUtc,
    endUtc,
    sourceActivityIds: [],
    module: 'analyzeDriverActivities',
    summary: `Zaznamenáno ${activities.length} aktivit v původní časové ose.`,
    reason: 'Počty a časy pocházejí z aktivit karty, ne z oříznutého grafu.',
    needed: 'Pro denní návaznost zadat explicitní kotvu.',
  })

  const intervals = analysis.candidates.restIntervals
  if (intervals.length === 0) return
  const weekly = analysis.candidates.weeklyRestCandidates
  const regular = weekly.filter((item) => item.lengthClass === 'regular').length
  const reduced = weekly.filter((item) => item.lengthClass === 'reduced').length
  const manual = intervals.filter((item) => item.uncertainties.includes('manual_entry')).length
  const listed = weekly.length <= LIST_LIMIT ? weekly : []
  cases.push({
    id: 'recorded:length-classes',
    status: 'recorded_fact',
    startUtc: Math.min(...intervals.map((item) => item.startUtc)),
    endUtc: Math.max(...intervals.map((item) => item.endUtc)),
    sourceActivityIds: uniqueIds(listed.flatMap((item) => item.sourceActivityIds)),
    module: 'restCandidates',
    summary: `${intervals.length} souvislých odpočinků, z toho ${weekly.length} s týdenní délkou (${regular} alespoň 45 h, ${reduced} alespoň 24 h a méně než 45 h).`,
    reason:
      manual > 0
        ? 'Jde o délkovou způsobilost, ne o právně potvrzený odpočinek. Ruční záznam není chyba.'
        : 'Jde o délkovou způsobilost, ne o právně potvrzený odpočinek.',
    needed: 'Týdenní roli vybrat explicitně. Samotná délka ji nepřiřazuje.',
  })
}

function pushDailyBranches(analysis: ActivityAnalysis, cases: DiagnosticCase[]): void {
  if (analysis.assessed.daily.status !== 'assessed') return
  const nodes = analysis.assessed.daily.chain.nodes
  const branches = nodes.filter((node) => node.interpretations.length > 1)
  pushLimited(branches, LIST_LIMIT, cases, dailyBranchCase, (omitted) => ({
    id: 'multiple:daily-windows-summary',
    status: 'multiple_interpretations',
    startUtc: branches[0]?.windowStartUtc ?? null,
    endUtc: branches[branches.length - 1]?.windowEndUtc ?? null,
    sourceActivityIds: [],
    module: 'dailyRestChain',
    summary: `Dalších ${omitted} oken má více denních variant. Ve výpisu jsou první okna.`,
    reason: 'Každé takové okno připouští více výkladů. Žádný není vybraný.',
    needed: 'Projít zbývající okna jednotlivě a vybrat interpretaci.',
  }))

  const reviewBlocked = nodes.filter((node) => isBlockedWindow(node, nodes[0]?.anchorUtc))
  pushLimited(reviewBlocked, LIST_LIMIT, cases, blockedWindowCase, (omitted) => ({
    id: 'insufficient:daily-windows-summary',
    status: 'insufficient_data',
    startUtc: reviewBlocked[0]?.windowStartUtc ?? null,
    endUtc: reviewBlocked[reviewBlocked.length - 1]?.windowEndUtc ?? null,
    sourceActivityIds: [],
    module: 'dailyRestChain',
    summary: `Dalších ${omitted} oken nelze uzavřít jako splněný denní odpočinek.`,
    reason: 'Chybí minimum v okně, nebo okno protíná neznámý úsek.',
    needed: 'Doplnit kotvu, záznam, nebo okno posoudit ručně. Přestupek se nevytváří.',
  }))
}

function isBlockedWindow(node: DailyChainNode, startAnchor: number | undefined): boolean {
  if (node.interpretations.length > 1) return false
  if (node.status === 'insufficient_data') return true
  if (node.status !== 'window_unsatisfied') return false
  return node.anchorUtc === startAnchor || node.interpretations.length === 1
}

function dailyBranchCase(node: DailyChainNode): DiagnosticCase {
  const kinds = node.interpretations.map((item) => item.kind).join(', ')
  return {
    id: `multiple:daily:${node.anchorUtc}`,
    status: 'multiple_interpretations',
    startUtc: node.windowStartUtc,
    endUtc: node.windowEndUtc,
    sourceActivityIds: uniqueIds(node.interpretations.flatMap((item) => item.parts.flatMap((part) => part.sourceActivityIds))),
    module: 'dailyRestOptions',
    summary: `Okno má více denních variant: ${kinds}.`,
    reason: 'Varianty jsou délkové možnosti. Modul mezi nimi nevolí a žádnou nepotvrzuje jako právní odpočinek.',
    needed: 'Vybrat jednu variantu pro další návaznost.',
  }
}

function blockedWindowCase(node: DailyChainNode): DiagnosticCase {
  const continuation = node.interpretations[0]?.nextAnchorUtc ?? null
  return {
    id: `insufficient:daily:${node.anchorUtc}`,
    status: 'insufficient_data',
    startUtc: node.windowStartUtc,
    endUtc: node.windowEndUtc,
    sourceActivityIds: uniqueIds(node.interpretations.flatMap((item) => item.parts.flatMap((part) => part.sourceActivityIds))),
    module: 'dailyRestChain',
    summary:
      node.status === 'insufficient_data'
        ? 'Denní okno protíná neznámý úsek, takže variantu nelze uzavřít.'
        : 'V okně není splněné minimum denního odpočinku.',
    reason:
      continuation == null
        ? 'Z dostupných odpočinků okno splnit nelze. Pozdější délka se do něj zpětně nepočítá.'
        : 'Odpočinek může pokračovat za okno. Původní okno tím není splněné.',
    needed: 'Ručně rozhodnout návaznost. Výsledek není přestupek.',
  }
}

function pushInputGaps(analysis: ActivityAnalysis, cases: DiagnosticCase[]): void {
  if (analysis.assessed.daily.status === 'requires_input') {
    cases.push({
      id: 'insufficient:daily-anchor',
      status: 'insufficient_data',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      module: 'dailyRestChain',
      summary: 'Denní návaznost nemá kotvu.',
      reason: 'Počátek 24hodinového okna se z prvního záznamu karty neodvozuje.',
      needed: 'Zadat skutečný konec předchozího denního nebo týdenního odpočinku v UTC.',
    })
  }
  if (analysis.assessed.weekly.status === 'requires_input') {
    for (const missing of analysis.assessed.weekly.missing) {
      cases.push(weeklyGapCase(missing))
    }
  }
  if (analysis.assessed.weekly.status === 'assessed' && analysis.assessed.weekly.result.dailyReduced.status === 'undecided') {
    cases.push({
      id: 'insufficient:daily-reduced-tally',
      status: 'insufficient_data',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      module: 'weeklyRest',
      summary: 'Počet zkrácených denních odpočinků mezi týdenními předěly není uzavřený.',
      reason: 'Chybí dva použitelné předěly, denní návaznost mezi nimi není úplná, nebo se výklady liší.',
      needed: 'Doplnit předěly a úplnou denní návaznost. Limit tří se neposuzuje.',
    })
  }
}

function weeklyGapCase(missing: string): DiagnosticCase {
  if (missing === 'week_clock') {
    return {
      id: 'insufficient:week-clock',
      status: 'insufficient_data',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      module: 'weeklyRest',
      summary: 'Týdenní posouzení nemá kalendář týdnů.',
      reason: 'Pondělní hranice se z hodin počítače neberou.',
      needed: 'Dodat WeekClock s explicitními pondělními hranicemi.',
    }
  }
  if (missing === 'weekly_selection_not_on_card') {
    return {
      id: 'insufficient:weekly-selection-not-on-card',
      status: 'insufficient_data',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      module: 'weeklyRest',
      summary: 'Vybraný týdenní odpočinek na této kartě není.',
      reason: 'Posouzení smí použít jen odpočinek z aktuálních kandidátů.',
      needed: 'Vybrat kandidát vrácený z této karty.',
    }
  }
  return {
    id: 'insufficient:weekly-selection',
    status: 'insufficient_data',
    startUtc: null,
    endUtc: null,
    sourceActivityIds: [],
    module: 'weeklyRest',
    summary: 'Týdenní odpočinek není vybraný.',
    reason: 'Délková způsobilost není právní použití odpočinku jako týdenního.',
    needed: 'Explicitně vybrat odpočinky a jejich týden.',
  }
}

function pushUnknowns(analysis: ActivityAnalysis, cases: DiagnosticCase[]): void {
  const unknowns = analysis.recorded.unknownIntervals
  pushLimited(
    unknowns,
    LIST_LIMIT,
    cases,
    (interval) => ({
      id: `insufficient:unknown:${interval.sourceActivityIds.join('+')}:${interval.startUtc}`,
      status: 'insufficient_data',
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
      sourceActivityIds: [...interval.sourceActivityIds],
      module: 'restIntervals',
      summary: 'Neznámý úsek není odpočinek.',
      reason: 'Chybějící záznam se nedoplňuje domnělým odpočinkem a nepřemosťuje se.',
      needed: 'Doplnit zdrojový záznam, nebo úsek ponechat jako neznámý.',
    }),
    (omitted) => ({
      id: 'insufficient:unknown-summary',
      status: 'insufficient_data',
      startUtc: Math.min(...unknowns.map((item) => item.startUtc)),
      endUtc: Math.max(...unknowns.map((item) => item.endUtc)),
      sourceActivityIds: uniqueIds(
        [...unknowns]
          .sort((a, b) => b.endUtc - b.startUtc - (a.endUtc - a.startUtc))
          .slice(0, LIST_LIMIT)
          .flatMap((item) => item.sourceActivityIds),
      ),
      module: 'restIntervals',
      summary: `Karta obsahuje ${unknowns.length} neznámých úseků. Nejsou odpočinek.`,
      reason: `Ve výpisu nejsou všechny. Dalších ${omitted} úseků má stejný význam.`,
      needed: 'Prověřit dlouhé mezery. Žádná se nesmí doplnit odpočinkem.',
    }),
  )
}

function pushAmbiguousRests(analysis: ActivityAnalysis, cases: DiagnosticCase[]): void {
  const ambiguous = analysis.candidates.restIntervals.filter((interval) => interval.ambiguous)
  pushLimited(
    ambiguous,
    LIST_LIMIT,
    cases,
    (interval) => ({
      id: `insufficient:ambiguous:${interval.sourceActivityIds.join('+')}:${interval.startUtc}`,
      status: 'insufficient_data',
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
      sourceActivityIds: [...interval.sourceActivityIds],
      module: 'restIntervals',
      summary: 'Souvislost odpočinku nelze prokázat.',
      reason: interval.uncertainties.join(', ') || 'Interval se překrývá s jinou činností.',
      needed: 'Vyjasnit pořadí překrývajících se činností. Do té doby odpočinek není prokázaný.',
    }),
    (omitted) => ({
      id: 'insufficient:ambiguous-summary',
      status: 'insufficient_data',
      startUtc: Math.min(...ambiguous.map((item) => item.startUtc)),
      endUtc: Math.max(...ambiguous.map((item) => item.endUtc)),
      sourceActivityIds: [],
      module: 'restIntervals',
      summary: `${ambiguous.length} odpočinků má nejednoznačný překryv.`,
      reason: `Dalších ${omitted} intervalů se do výpisu nevešlo. Délka u nich není prokázaný odpočinek.`,
      needed: 'Prověřit překryvy činností na ose.',
    }),
  )
}

function pushNotImplemented(analysis: ActivityAnalysis, cases: DiagnosticCase[]): void {
  for (const item of analysis.notEvaluated) {
    const text = NOT_IMPLEMENTED[item.topic]
    cases.push({
      id: `not-implemented:${item.topic}`,
      status: 'not_implemented',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      module: 'analyzeDriverActivities',
      summary: text.summary,
      reason: text.reason,
      needed: text.needed,
    })
  }
}

function pushLimited<T>(
  items: readonly T[],
  limit: number,
  cases: DiagnosticCase[],
  one: (item: T) => DiagnosticCase,
  summary: (omitted: number) => DiagnosticCase,
): void {
  if (items.length === 0) return
  const shown = items.length <= limit ? items : items.slice(0, limit)
  cases.push(...shown.map(one))
  if (items.length > limit) cases.push(summary(items.length - limit))
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].slice(0, LIST_LIMIT)
}
