import type { DailyRecordCoverageGap } from './coverage.ts'

export type ActivityKind = 'driving' | 'work' | 'availability' | 'rest' | 'unknown'

export interface Activity {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
  durationMinutes: number
  isManualEntry?: boolean
  /** Příznak osádky z bitové změny činnosti na kartě. */
  isCrew?: boolean
  /** 1 = slot řidiče, 2 = slot spolujezdce. */
  slot?: 1 | 2
  countryCode?: string
  /** Registrační značka vozidla, ve kterém karta v té době byla. */
  registration?: string
}

export type LocationRecordType =
  | 'gps'
  | 'start_country'
  | 'end_country'
  | 'load'
  | 'unload'
  | 'load_unload'
  | 'border_crossing'

export interface Location {
  id: string
  recordedAtUtc: number
  label: string
  latitude?: number
  longitude?: number
  recordType?: LocationRecordType
  countryCode?: string
  isManualEntry?: boolean
}

export type ComplianceRule =
  | 'daily_driving'
  | 'weekly_driving'
  | 'fortnightly_driving'
  | 'break'
  | 'daily_rest'
  | 'weekly_rest'

export interface ComplianceViolation {
  id: string
  rule: ComplianceRule
  startedAtUtc: number
  endedAtUtc?: number
  severity: 'warning' | 'infringement'
  message: string
}

export interface VehicleUse {
  registration: string
  fromUtc: number
  toUtc: number
  /** Ujeté kilometry podle počítadla. Chybí, když karta konec jízdy nezaznamenala. */
  kilometers: number | null
  /** Stát registrace vozidla z karty, kód ISO. */
  registrationNation?: string
  /** Identifikační číslo vozidla. U 1. generace karta VIN neukládá. */
  vin?: string
  odometerBeginKm?: number | null
  odometerEndKm?: number | null
  /** Čítač datového bloku vozidlové jednotky. */
  dataBlockCounter?: number | null
}

export interface CardIncident {
  fromUtc: number
  toUtc: number | null
  registration: string | null
  typeLabel: string
}

export type LoadUnloadKind = 'load' | 'unload' | 'both'

export type SpecificConditionKind = 'out' | 'out_end' | 'ferry' | 'ferry_end'

export interface SpecificConditionEntry {
  atUtc: number
  kind: SpecificConditionKind
}

export interface LoadUnloadEntry {
  atUtc: number
  kind: LoadUnloadKind
  /** Stav počítadla kilometrů v okamžiku zadání. */
  odometerKm: number | null
  location: string | null
}

export type HolderStartOrigin = 'explicit_change' | 'manual_entry' | 'inferred' | 'unknown'

export type HolderEndCause =
  | 'next_change_same_position'
  | 'next_change_other_position'
  | 'day_end'
  | 'unknown_gap'
  | 'unresolved'

export type HolderContinuity = 'recorded' | 'inferred' | 'unknown' | 'conflict'

/** Diagnostická časová osa držitele — nemění význam Activity[]. */
export interface HolderTimelineSegment {
  startUtc: number
  endUtc: number
  kind: ActivityKind
  position: 1 | 2
  startOrigin: HolderStartOrigin
  endCause: HolderEndCause
  continuity: HolderContinuity
  sourceActivityIds: string[]
  sourceChangeCount: number
}

export type HolderTimelineMeta = {
  /**
   * Mapovač řadí změny slot 1 i 2 do jedné chronologie (laterChange).
   * Normativní význam bitu driver v EU specifikaci není v tomto repozitáři ověřen.
   */
  slotChronologyAssumption: 'single_card_merged_timeline' | 'unresolved'
}

/** Odvozený přechod příznaku přítomnosti karty ze změnových záznamů DDD (ne fyzické vložení/vyjmutí). */
export interface CardPresentEdge {
  atUtc: number
  present: boolean
  slot: 1 | 2
}

export interface DriverCardData {
  cardNumber: string
  firstName: string
  surname: string
  dateOfBirth?: string
  preferredLanguage?: string
  nationality?: string
  issuingCountry?: string
  issuingAuthority?: string
  dateOfIssue?: string
  validityBegin?: string
  dateOfExpiry?: string
  drivingLicenseNumber?: string
  licenceIssuingAuthority?: string
  licenceIssuingCountry?: string
  lastCardDownloadUtc?: number | null
  lastWithdrawalUtc: number | null
  activities: Activity[]
  holderTimelineSegments?: HolderTimelineSegment[]
  holderTimelineMeta?: HolderTimelineMeta
  /** Kalendářní mezery mezi zdrojovými dny aktivit — ne Activity[]. */
  dailyRecordCoverageGaps?: DailyRecordCoverageGap[]
  cardPresentEdges?: CardPresentEdge[]
  locations: Location[]
  violations: ComplianceViolation[]
  vehicleUses?: VehicleUse[]
  events?: CardIncident[]
  faults?: CardIncident[]
  loadUnloadEntries?: LoadUnloadEntry[]
  specificConditions?: SpecificConditionEntry[]
}
