import {
  buildGn7ControlPeriods,
  type BuildGn7ControlPeriodsInput,
  type Gn7ControlPeriod,
} from './gn7ControlPeriods.ts'

export type Gn7Confirmation = 'confirmed' | 'conditional' | 'unconfirmed'

/**
 * Označené referenční období GN7 pro navazující diagnostiku.
 * Časy se nemění a okno se nepovažuje za hranici pracovní doby.
 */
export type Gn7DiagnosticPeriod = {
  boundarySource: 'gn7'
  startUtc: number
  endUtc: number
  nextAnchorUtc: number | null
  dataComplete: boolean
  confirmation: Gn7Confirmation
  analysisTruncated: boolean
  overlapsAnotherControlPeriod: boolean
  /** Metodická diagnostika GN7. Není to podklad přestupku ani hranice směny. */
  usableForGn7Diagnostics: boolean
  /** GN7 referenční okno samo neprokazuje skutečnou hranici pracovní doby. */
  usableAsWorkPeriodBoundary: false
  limitation: string | null
}

export type Gn7DiagnosticFeed = {
  analysisTruncated: boolean
  periods: Gn7DiagnosticPeriod[]
}

export function buildGn7DiagnosticFeed(input: BuildGn7ControlPeriodsInput): Gn7DiagnosticFeed {
  const periods = buildGn7ControlPeriods(input)
  const overlaps = overlapFlags(periods)
  return {
    analysisTruncated: periods.some((period) => period.analysisTruncated),
    periods: periods.map((period, index) => toDiagnostic(period, overlaps[index] === true)),
  }
}

function toDiagnostic(period: Gn7ControlPeriod, overlapsAnotherControlPeriod: boolean): Gn7DiagnosticPeriod {
  const dataComplete = period.dataCompleteness === 'complete'
  const conditional = period.crewBasis === 'conditional'
  const anchorKnown = period.nextAnchorUtc != null
  const usableForGn7Diagnostics = dataComplete
    && !conditional
    && anchorKnown
    && !period.analysisTruncated
    && period.status !== 'insufficient_data'
    && period.status !== 'history_incomplete'
  const confirmation: Gn7Confirmation = conditional
    ? 'conditional'
    : usableForGn7Diagnostics && period.confirmedForEnforcement && period.reducedRestPermitted !== 'not_assessed'
      ? 'confirmed'
      : 'unconfirmed'

  return {
    boundarySource: 'gn7',
    startUtc: period.startUtc,
    endUtc: period.endUtc,
    nextAnchorUtc: period.nextAnchorUtc,
    dataComplete,
    confirmation,
    analysisTruncated: period.analysisTruncated,
    overlapsAnotherControlPeriod,
    usableForGn7Diagnostics,
    usableAsWorkPeriodBoundary: false,
    limitation: limitationText(period, overlapsAnotherControlPeriod, usableForGn7Diagnostics, confirmation),
  }
}

function limitationText(
  period: Gn7ControlPeriod,
  overlapsAnotherControlPeriod: boolean,
  usableForGn7Diagnostics: boolean,
  confirmation: Gn7Confirmation,
): string | null {
  const reasons: string[] = []
  if (period.crewBasis === 'conditional') {
    reasons.push('Podmíněná osádka není potvrzený podklad. 24h i 30h varianta zůstávají jen diagnostické.')
  }
  if (period.dataCompleteness !== 'complete') {
    reasons.push(period.assessmentBasis)
  }
  if (period.nextAnchorUtc == null) reasons.push('Kotva dalšího období není určena.')
  if (period.analysisTruncated) reasons.push('Výpočet je ořezaný a nepokrývá celou dostupnou historii.')
  if (period.reducedRestPermitted === 'not_assessed') {
    reasons.push('Dosažení 9 hodin nepotvrzuje právní přípustnost dalšího zkrácení.')
  }
  if (overlapsAnotherControlPeriod) {
    reasons.push('Referenční okno se překrývá s jiným kontrolním obdobím. Časy se nemění.')
  }
  reasons.push('Referenční okno GN7 není hranice pracovní doby.')
  if (usableForGn7Diagnostics && confirmation === 'confirmed' && reasons.length === 1 && !overlapsAnotherControlPeriod) {
    return reasons[0]!
  }
  return reasons.join(' ')
}

function overlapFlags(periods: readonly Gn7ControlPeriod[]): boolean[] {
  return periods.map((period, index) => periods.some((other, otherIndex) =>
    otherIndex !== index && period.startUtc < other.endUtc && other.startUtc < period.endUtc,
  ))
}
