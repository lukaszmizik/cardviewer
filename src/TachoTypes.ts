export type EditorActivityId = 'REST' | 'WORK' | 'AVAILABILITY' | 'UNKNOWN' | 'START_COUNTRY' | 'END_COUNTRY'

export type ManualEntrySegment = {
  activityId: EditorActivityId
  day: number
  month: number
  year: number
  hour: number
  minute: number
  countryCode?: string
  isManualEntry?: boolean
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
}

export type FaultOrEvent = {
  id: number
  timestampUtc: number
  type: 'DRIVING_WITHOUT_CARD_WARNING' | 'DRIVING_WITHOUT_VALID_CARD_WARNING' | 'EXCESS_SPEED_WARNING'
  duringIncompleteManualEntry?: boolean
}

export type SymbolMap = Record<number, string>
