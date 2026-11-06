import type { ActivityAnalysis, NotEvaluatedTopic } from './analyzeDriverActivities.ts'
import type { ConsecutiveWeeksResult } from './consecutiveWeeks.ts'
import type { DailyChainNode } from './dailyRestChain.ts'
import type { WeeklyAutomaticAssignment } from './weeklyRestAssignment.ts'
import type { WeeklySelectionReport } from './weeklyRest.ts'

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

export const DIAGNOSTIC_SCHEMA_VERSION = '2'

export type PeriodBlocker = 'missing_implementation' | 'missing_input' | 'multiple_interpretations' | 'source_uncertainty'

export type PeriodDiagnostic = {
  id: string
  blocker: PeriodBlocker
  startUtc: number | null
  endUtc: number | null
  sourceActivityIds: string[]
  established: string[]
  variants: string[]
  blockedBy: string
  nextStep: string
  module: string
}

export type DiagnosticProjectStatus = {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  modules: string[]
  limitations: string[]
  unresolvedCaseIds: string[]
}

export type DiagnosticExport = {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION
  exportedAtUtc: string
  projectStatus: DiagnosticProjectStatus
  cases: Array<DiagnosticCase & { note: string }>
  periods: Array<PeriodDiagnostic & { note: string }>
  weeklyAssignment: WeeklyAutomaticAssignment | null
  consecutiveWeeks: ConsecutiveWeeksResult | null
}

const MODULES = [
  'restIntervals',
  'restCandidates',
  'restWindowIntersection',
  'dailyRestOptions',
  'dailyRestChain',
  'weeklyRest',
  'weeklyRestAssignment',
  'consecutiveWeeks',
  'analyzeDriverActivities',
]

const LIMITATIONS = [
  'Denní řetězec začíná v ruční kotvě, nebo v konci prvního odpočinku dlouhého alespoň 11 hodin. Stav assessed neznamená vyhodnocení celé historie.',
  'Automatický graf týdenních návazností není právní potvrzení. Ruční větev dál vyžaduje výběr a WeekClock.',
  'Více délkových hranic jednoho odpočinku není více právních interpretací.',
  'Neznámý úsek se nedoplňuje odpočinkem.',
  'Dvojice celá uvnitř jednoho dlouhého odpočinku s tříhodinovou technickou rezervou je doložené volno, ne splnění čl. 8 odst. 6. Ostatní dlouhé odpočinky zůstávají not_evaluated.',
  'Nesplnění základního dvoutýdenního pravidla není přestupek. Mezinárodní režim a kompenzace se neposuzují.',
]

const LIST_LIMIT = 8

const NOT_IMPLEMENTED: Record<NotEvaluatedTopic, Pick<DiagnosticCase, 'summary' | 'reason' | 'needed'>> = {
  infringements: {
    summary: 'Přestupky se nevyhodnocují.',
    reason: 'Jádro eviduje údaje a varianty. Právní nález nevytváří.',
    needed: 'Samostatná vrstva nálezů, až budou pravidla dokončená.',
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

export function derivePeriodDiagnostics(analysis: ActivityAnalysis): PeriodDiagnostic[] {
  const periods: PeriodDiagnostic[] = []
  pushMissingDailyPeriods(analysis, periods)
  pushMissingWeeklyPeriods(analysis, periods)
  pushConcreteDailyPeriods(analysis, periods)
  pushConcreteWeeklyPeriods(analysis, periods)
  pushUnknownPeriods(analysis, periods)
  pushAmbiguousPeriods(analysis, periods)
  pushAutomaticWeeklyPeriods(analysis, periods)
  return periods
}

export function buildDiagnosticExport(
  cases: readonly DiagnosticCase[],
  periods: readonly PeriodDiagnostic[],
  notes: Readonly<Record<string, string>>,
  exportedAtUtc: string,
  weeklyAssignment: WeeklyAutomaticAssignment | null = null,
  consecutiveWeeks: ConsecutiveWeeksResult | null = null,
): DiagnosticExport {
  const withNotes = <T extends { id: string; sourceActivityIds: string[] }>(item: T) => ({
    ...item,
    sourceActivityIds: [...item.sourceActivityIds],
    note: notes[item.id] ?? '',
  })
  const exportedCases = cases.map(withNotes)
  const exportedPeriods = periods.map(withNotes)
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    exportedAtUtc,
    projectStatus: {
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      modules: [...MODULES],
      limitations: [...LIMITATIONS],
      unresolvedCaseIds: [
        ...exportedCases.filter((item) => item.status !== 'recorded_fact').map((item) => item.id),
        ...exportedPeriods.map((item) => item.id),
      ],
    },
    cases: exportedCases,
    periods: exportedPeriods,
    weeklyAssignment,
    consecutiveWeeks,
  }
}

function pushMissingDailyPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  if (analysis.assessed.daily.status !== 'requires_input') return
  periods.push({
    id: 'period:missing-daily-anchor',
    blocker: 'missing_input',
    startUtc: null,
    endUtc: null,
    sourceActivityIds: [],
    established: [
      `Spočteno ${analysis.candidates.restIntervals.length} souvislých odpočinků.`,
      `Týdenní délkovou třídu má ${analysis.candidates.weeklyRestCandidates.length} odpočinků.`,
    ],
    variants: [],
    blockedBy: 'Bez kotvy se findDailyRestOptions ani denní návaznost nevolají. Konkrétní sporná okna proto ve výstupu nejsou.',
    nextStep: 'Zadat UTC konec předchozího denního nebo týdenního odpočinku a export opakovat.',
    module: 'dailyRestChain',
  })
}

function pushMissingWeeklyPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  if (analysis.assessed.weekly.status !== 'requires_input') return
  const regular = analysis.candidates.weeklyRestCandidates.filter((item) => item.lengthClass === 'regular').length
  const reduced = analysis.candidates.weeklyRestCandidates.filter((item) => item.lengthClass === 'reduced').length
  periods.push({
    id: 'period:missing-weekly-selection',
    blocker: 'missing_input',
    startUtc: null,
    endUtc: null,
    sourceActivityIds: [],
    established: [
      `Délková třída regular: ${regular}. Délková třída reduced: ${reduced}.`,
      'Třída popisuje jen délku. Právní použití jako týdenní odpočinek z ní nevzniká.',
    ],
    variants: [],
    blockedBy: `Ruční výběr pro potvrzenou větev chybí (${analysis.assessed.weekly.missing.join(', ')}). Automatický graf návazností je samostatně a není právní potvrzení.`,
    nextStep: 'Porovnat automatické návaznosti. Ruční výběr a WeekClock zadat, teprve když má kontrolor rozhodnout.',
    module: 'weeklyRest',
  })
}

function pushConcreteDailyPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  if (analysis.assessed.daily.status !== 'assessed') return
  const nodes = analysis.assessed.daily.chain.nodes
  const branches = nodes.filter((node) => node.interpretations.length > 1)
  pushLimited(branches, LIST_LIMIT, periods, dailyBranchPeriod, (omitted) => ({
    id: 'period:daily-branches-summary',
    blocker: 'multiple_interpretations',
    startUtc: null,
    endUtc: null,
    sourceActivityIds: [],
    established: [`Dalších oken s více variantami: ${omitted}. Jejich varianty nejsou v tomto výpisu vypsané.`],
    variants: [],
    blockedBy: 'Výpis je omezený, aby zůstal použitelný u dlouhé karty.',
    nextStep: 'Po vyřešení vypsaných oken export opakovat se stejnou kotvou.',
    module: 'dailyRestChain',
  }))
  const blocked = nodes.filter((node) => isBlockedWindow(node, nodes[0]?.anchorUtc))
  pushLimited(blocked, LIST_LIMIT, periods, blockedWindowPeriod, (omitted) => ({
    id: 'period:daily-blocked-summary',
    blocker: 'missing_input',
    startUtc: null,
    endUtc: null,
    sourceActivityIds: [],
    established: [`Dalších neuzavřených oken: ${omitted}.`],
    variants: [],
    blockedBy: 'Okna bez splněného minima nebo s neznámým úsekem nejsou všechna vypsaná.',
    nextStep: 'Doplnit záznam nebo kotvu a export opakovat.',
    module: 'dailyRestChain',
  }))
}

function dailyBranchPeriod(node: DailyChainNode): PeriodDiagnostic {
  return {
    id: `period:daily:${node.anchorUtc}`,
    blocker: 'multiple_interpretations',
    startUtc: node.windowStartUtc,
    endUtc: node.windowEndUtc,
    sourceActivityIds: uniqueIds(node.interpretations.flatMap((item) => item.parts.flatMap((part) => part.sourceActivityIds))),
    established: [
      `Okno ${node.windowStartUtc} až ${node.windowEndUtc}.`,
      'Časy částí jsou původní intervaly. Minuty před lomítkem jsou jen průnik s oknem.',
    ],
    variants: node.interpretations.map(describeInterpretation),
    blockedBy: 'dailyRestOptions vrátil více variant a žádnou nevybral.',
    nextStep: 'Pro toto okno zvolit jednu vrácenou variantu a z jejího skutečného konce pokračovat.',
    module: 'dailyRestOptions',
  }
}

function blockedWindowPeriod(node: DailyChainNode): PeriodDiagnostic {
  return {
    id: `period:daily-blocked:${node.anchorUtc}`,
    blocker: node.status === 'insufficient_data' ? 'source_uncertainty' : 'missing_implementation',
    startUtc: node.windowStartUtc,
    endUtc: node.windowEndUtc,
    sourceActivityIds: uniqueIds(node.interpretations.flatMap((item) => item.parts.flatMap((part) => part.sourceActivityIds))),
    established: [`Stav okna vrácený dailyRestChain: ${node.status}.`],
    variants: node.interpretations.map(describeInterpretation),
    blockedBy:
      node.status === 'insufficient_data'
        ? 'Okno protíná neznámý úsek, takže varianta denního odpočinku nevznikla.'
        : 'Minimum v okně splněno není. Právní nález z toho jádro nevytváří.',
    nextStep:
      node.interpretations[0]?.nextAnchorUtc == null
        ? 'Doplnit data nebo kotvu. Výsledek okna se nemá doplňovat odhadem.'
        : `Skutečný konec pokračujícího odpočinku je ${node.interpretations[0].nextAnchorUtc}. Původní okno tím není splněné.`,
    module: 'dailyRestChain',
  }
}

function describeInterpretation(item: DailyChainNode['interpretations'][number]): string {
  const minutes = item.parts.map((part) => `${part.restMinutesInsideWindow}/${part.candidateMinutes}`).join(', ')
  const sources = item.parts.flatMap((part) => part.sourceActivityIds).join('+')
  return `${item.kind}; qualifiesWindow=${item.qualifiesWindow}; nextAnchorUtc=${item.nextAnchorUtc ?? 'null'}; minutesInside/total=${minutes || 'none'}; sources=${sources || 'none'}`
}

function pushConcreteWeeklyPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  if (analysis.assessed.weekly.status !== 'assessed') return
  const result = analysis.assessed.weekly.result
  const notable = result.selections.filter(
    (item) =>
      (item.assignment.status !== 'assigned' && item.assignment.status !== 'continuous_cover') || item.timing.status !== 'on_time',
  )
  pushLimited(notable, LIST_LIMIT, periods, weeklySelectionPeriod, (omitted) => ({
    id: 'period:weekly-selections-summary',
    blocker: 'missing_input',
    startUtc: null,
    endUtc: null,
    sourceActivityIds: [],
    established: [`Dalších nevyřízených týdenních výběrů: ${omitted}.`],
    variants: [],
    blockedBy: 'Výpis neobsahuje všechny vrácené výběry.',
    nextStep: 'Po vyřešení vypsaných výběrů export opakovat.',
    module: 'weeklyRest',
  }))
  if (result.dailyReduced.status === 'undecided') {
    periods.push({
      id: 'period:daily-reduced-undecided',
      blocker: 'missing_input',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      established: [`Použitelné konce týdenních odpočinků: ${result.boundaryEndsUtc.join(', ') || 'žádné'}.`],
      variants: [],
      blockedBy: 'Součet zkrácených denních odpočinků mezi předěly se neuzavřel.',
      nextStep: 'Doplnit dva předěly a úplnou denní návaznost mezi nimi. Limit tří se neposuzuje.',
      module: 'weeklyRest',
    })
  }
}

function weeklySelectionPeriod(item: WeeklySelectionReport): PeriodDiagnostic {
  const timing = item.timing.status === 'undetermined' ? 'undetermined' : item.timing.status
  return {
    id: `period:weekly:${item.startUtc}:${item.sourceActivityIds.join('+')}`,
    blocker: item.assignment.status !== 'assigned' ? 'missing_input' : item.timing.status === 'undetermined' ? 'source_uncertainty' : 'missing_implementation',
    startUtc: item.startUtc,
    endUtc: item.endUtc,
    sourceActivityIds: [...item.sourceActivityIds],
    established: [
      `Délková třída ${item.lengthClass}, manualEntry=${item.manualEntry}, established=${item.established}.`,
      `Přiřazení: ${item.assignment.status}. Časování vůči šesti 24hodinovým obdobím: ${timing}.`,
    ],
    variants: [],
    blockedBy:
      item.assignment.status === 'rejected'
        ? `Výběr týdne odmítnut: ${item.assignment.reason}.`
        : item.assignment.status === 'continuous_cover'
          ? 'Fyzický odpočinek pokračuje přes více týdnů. Průniky se nepřekrývají. Šestidobá lhůta běží až od skutečného konce. Právní přiřazení jednotlivých týdnů není potvrzené a přestupek se nevytváří.'
          : item.timing.status === 'late'
            ? 'Začátek je později než konec předchozího týdenního odpočinku plus šestkrát 24 hodin. Přestupek se nevytváří.'
            : 'Návaznost od předchozího týdenního konce nelze potvrdit.',
    nextStep: 'Opravit výběr týdne nebo doplnit chybějící záznam a export opakovat.',
    module: 'weeklyRest',
  }
}

function pushAutomaticWeeklyPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  const assignment = analysis.weeklyAssignment
  if (assignment.nodes.length === 0) return
  const branches = assignment.nodes.filter((node) => node.nextOnTime.length > 1)
  const twoWeeks = assignment.nodes.filter((node) => node.weekChoice === 'needs_controller')
  const longRests = assignment.nodes.filter((node) => node.weekChoice === 'continuous_cover')
  const shownIds =
    assignment.recommendation.status === 'suggested' ? assignment.recommendation.nodeIds.slice(0, LIST_LIMIT) : []
  periods.push({
    id: 'period:weekly-assignment',
    blocker: assignment.recommendation.status === 'undecided' ? 'multiple_interpretations' : 'missing_input',
    startUtc: assignment.nodes[0]?.startUtc ?? null,
    endUtc: assignment.nodes[assignment.nodes.length - 1]?.endUtc ?? null,
    sourceActivityIds: uniqueIds(assignment.nodes.flatMap((node) => node.sourceActivityIds)),
    established: [
      `Týdenních délkových kandidátů v grafu: ${assignment.nodes.length}.`,
      'Hranice týdne je pondělí 00:00 UTC. Místní čas tachografu z karty nelze zjistit.',
      assignment.recommendation.reason,
      `Nepřerušených odpočinků přes více než dva týdny: ${longRests.length}. Původní interval zůstává jeden.`,
      shownIds.length > 0 && assignment.recommendation.status === 'suggested' && assignment.recommendation.nodeIds.length > shownIds.length
        ? `Výpis doporučené větve ukazuje ${shownIds.length} z ${assignment.recommendation.nodeIds.length} uzlů. Graf obsahuje všechny.`
        : 'Po lhůtě vede jen hrana k nejbližšímu dalšímu odpočinku. Vzdálenější odpočinky nejsou alternativy tohoto kroku.',
    ],
    variants:
      assignment.recommendation.status === 'suggested'
        ? shownIds.map((id) => `zobrazení ${id}`)
        : branches.slice(0, LIST_LIMIT).map(
            (node) =>
              `od ${node.sourceActivityIds.join('+')}: ${node.nextOnTime.map((link) => link.toId).join(', ')}`,
          ),
    blockedBy:
      'Doporučení algoritmu není právní závěr. Kompenzace a mezinárodní režim zůstávají nevyhodnocené.',
    nextStep:
      assignment.recommendation.status === 'suggested'
        ? 'Kontrolor doporučenou větev potvrdí, nebo z grafu vybere jinou návaznost.'
        : 'Kontrolor vybere, který odpočinek je v daném kroku týdenní.',
    module: 'weeklyRestAssignment',
  })

  for (const node of twoWeeks.slice(0, LIST_LIMIT)) {
    periods.push({
      id: `period:weekly-week:${node.startUtc}`,
      blocker: 'multiple_interpretations',
      startUtc: node.startUtc,
      endUtc: node.endUtc,
      sourceActivityIds: [...node.sourceActivityIds],
      established: [`Délková třída ${node.lengthClass}. Jeden odpočinek se nezapočítá do obou týdnů.`],
      variants: node.possibleWeeks.map((week) => `${week.attachment} ${week.weekId}`),
      blockedBy: 'Odpočinek zasahuje do dvou kalendářních týdnů. Přiřazení jednomu z nich není vybrané.',
      nextStep: 'Kontrolor určí, ke kterému týdnu se tento odpočinek vztahuje.',
      module: 'weeklyRestAssignment',
    })
  }
  if (twoWeeks.length > LIST_LIMIT) {
    periods.push({
      id: 'period:weekly-week-summary',
      blocker: 'multiple_interpretations',
      startUtc: null,
      endUtc: null,
      sourceActivityIds: [],
      established: [`Odpočinků ve dvou týdnech: ${twoWeeks.length}.`],
      variants: [],
      blockedBy: `Dalších ${twoWeeks.length - LIST_LIMIT} odpočinků přes dva týdny je ve grafu a ve výpisu se nezobrazuje.`,
      nextStep: 'Projít zbývající uzly s weekChoice needs_controller v exportu.',
      module: 'weeklyRestAssignment',
    })
  }
}

function pushUnknownPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  const unknowns = analysis.recorded.unknownIntervals
  pushLimited(
    unknowns,
    LIST_LIMIT,
    periods,
    (interval) => ({
      id: `period:unknown:${interval.sourceActivityIds.join('+')}:${interval.startUtc}`,
      blocker: 'source_uncertainty',
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
      sourceActivityIds: [...interval.sourceActivityIds],
      established: ['V původních aktivitách je druh unknown. Odpočinek z něj nevznikl.'],
      variants: [],
      blockedBy: 'Neznámý úsek přerušuje možnost spolehlivé návaznosti.',
      nextStep: 'Doplnit činnost v tomto intervalu, nebo ho ponechat jako neznámý.',
      module: 'restIntervals',
    }),
    (omitted) => ({
      id: 'period:unknown-summary',
      blocker: 'source_uncertainty',
      startUtc: Math.min(...unknowns.map((item) => item.startUtc)),
      endUtc: Math.max(...unknowns.map((item) => item.endUtc)),
      sourceActivityIds: uniqueIds(
        [...unknowns]
          .sort((a, b) => b.endUtc - b.startUtc - (a.endUtc - a.startUtc))
          .slice(0, LIST_LIMIT)
          .flatMap((item) => item.sourceActivityIds),
      ),
      established: [`Počet neznámých úseků: ${unknowns.length}.`],
      variants: [],
      blockedBy: `Ve výpisu je nejvýše ${LIST_LIMIT} jednotlivých úseků. Dalších ${omitted} má stejný význam.`,
      nextStep: 'Prověřit nejdřív nejdelší mezery. Žádnou nedoplňovat odpočinkem.',
      module: 'restIntervals',
    }),
  )
}

function pushAmbiguousPeriods(analysis: ActivityAnalysis, periods: PeriodDiagnostic[]): void {
  const ambiguous = analysis.candidates.restIntervals.filter((interval) => interval.ambiguous)
  pushLimited(
    ambiguous,
    LIST_LIMIT,
    periods,
    (interval) => ({
      id: `period:ambiguous:${interval.sourceActivityIds.join('+')}:${interval.startUtc}`,
      blocker: 'source_uncertainty',
      startUtc: interval.startUtc,
      endUtc: interval.endUtc,
      sourceActivityIds: [...interval.sourceActivityIds],
      established: [`Délka intervalu je ${interval.durationMinutes} minut. Souvislost odpočinku prokázaná není.`],
      variants: [],
      blockedBy: interval.uncertainties.join(', ') || 'Překryv s jinou činností.',
      nextStep: 'Vyjasnit pořadí překrytých činností. Délkové role se nemají brát jako právní varianty.',
      module: 'restIntervals',
    }),
    (omitted) => ({
      id: 'period:ambiguous-summary',
      blocker: 'source_uncertainty',
      startUtc: Math.min(...ambiguous.map((item) => item.startUtc)),
      endUtc: Math.max(...ambiguous.map((item) => item.endUtc)),
      sourceActivityIds: [],
      established: [`Nejednoznačných odpočinků: ${ambiguous.length}.`],
      variants: [],
      blockedBy: `Dalších ${omitted} překryvů není vypsáno jednotlivě.`,
      nextStep: 'Řešit vypsané překryvy. Ostatní mají stejný typ nejistoty.',
      module: 'restIntervals',
    }),
  )
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
