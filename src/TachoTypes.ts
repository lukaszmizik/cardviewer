export type EditorActivityId = 'REST' | 'WORK' | 'AVAILABILITY' | 'DRIVING' | 'UNKNOWN' | 'START_COUNTRY' | 'END_COUNTRY'

export type ManualEntrySegment = {
  activityId: EditorActivityId
  day: number
  month: number
  year: number
  hour: number
  minute: number
  countryCode?: string
  isManualEntry?: boolean
  recordedAtUtc?: number
}

export type LoadUnloadEventType = 'load' | 'unload' | 'both'

export type VehicleLoadUnloadEvent = {
  minuteStartUtc: number
  gpsLocation?: string
  type: LoadUnloadEventType
}

export type FerryTrainEventType = 'activation' | 'deactivation'

export type FerryTrainEvent = {
  minuteStartUtc: number
  gpsLocation?: string
  type: FerryTrainEventType
}

export type OutModeEventType = 'activation' | 'deactivation'

export type OutModeEvent = {
  minuteStartUtc: number
  gpsLocation?: string
  type: OutModeEventType
}

export type RecordedGpsRecordType =
  | 'gps_3h'
  | 'start_country'
  | 'end_country'
  | 'end_country_card'
  | 'load'
  | 'unload'
  | 'load_unload'
  | 'border_crossing'

export type RecordedGpsLocation = {
  minuteStartUtc: number
  gpsLocation: string
  recordType?: RecordedGpsRecordType
  latitude?: number
  longitude?: number
  countryCode?: string
}

export type FaultOrEvent = {
  id: number
  timestampUtc: number
  type: 'DRIVING_WITHOUT_CARD_WARNING' | 'DRIVING_WITHOUT_VALID_CARD_WARNING' | 'EXCESS_SPEED_WARNING'
  duringIncompleteManualEntry?: boolean
}

export type SymbolMap = Record<number, string>

/** Znaky fontu SymbolTacho1. Číslo je index glyfu, hodnota je znak, který ho vykreslí. */
export const TACHO_SYMBOLS: SymbolMap = {
  49: 'o',
  52: 'r',
  53: 's',
  54: 't',
}
