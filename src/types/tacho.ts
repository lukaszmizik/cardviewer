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
  locations: Location[]
  violations: ComplianceViolation[]
}
