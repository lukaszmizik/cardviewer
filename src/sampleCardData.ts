import { activitiesByDay, expandToWeeksContainingData, parseWorkWeekTxt } from './workWeekTxtParser'
import type { ManualEntrySegment, VehicleLoadUnloadEvent, FerryTrainEvent, OutModeEvent, RecordedGpsLocation, FaultOrEvent } from './TachoTypes'

const SAMPLE_TXT = `
----CZ---- 05:45 27.10.2026
(práce) 05:45 - 06:00 (00:15)
(řízení) 06:00 - 10:30 (04:30)
(odpočinek) 10:30 - 11:15 (00:45)
(řízení) 11:15 - 15:45 (04:30)
(práce) 15:45 - 16:00 (00:15)
----CZ---- 16:10 27.10.2026
----CZ---- 05:50 28.10.2026
(práce) 05:50 - 06:05 (00:15)
(řízení) 06:05 - 09:35 (03:30)
(pohotovost) 09:35 - 10:05 (00:30)
(řízení) 10:05 - 14:35 (04:30)
----CZ---- 15:00 28.10.2026
----CZ---- 06:00 29.10.2026
(řízení) 06:00 - 10:00 (04:00)
(odpočinek) 10:00 - 10:45 (00:45)
(řízení) 10:45 - 15:15 (04:30)
----CZ---- 15:30 29.10.2026
`

const parsed = parseWorkWeekTxt(SAMPLE_TXT)
const days = expandToWeeksContainingData(activitiesByDay(parsed.activities), parsed.activities[0]!.startMs)

export const sampleManualEntryBuffer: ManualEntrySegment[] = [
  { activityId: 'START_COUNTRY', day: 27, month: 10, year: 2026, hour: 5, minute: 40, countryCode: 'CZ', isManualEntry: true },
  { activityId: 'WORK', day: 27, month: 10, year: 2026, hour: 5, minute: 40, isManualEntry: true },
  { activityId: 'REST', day: 27, month: 10, year: 2026, hour: 5, minute: 45, isManualEntry: true },
]

const loadMs = Date.UTC(2026, 9, 27, 9, 10)
const unloadMs = Date.UTC(2026, 9, 28, 12, 40)
const ferryMs = Date.UTC(2026, 9, 29, 7, 20)
const outStartMs = Date.UTC(2026, 9, 29, 13, 0)
const outEndMs = Date.UTC(2026, 9, 29, 13, 40)

export const sampleCardView = {
  days,
  countryMarkers: parsed.countryMarkers,
  manualEntryBuffer: sampleManualEntryBuffer,
  lastWithdrawalUtc: Date.UTC(2026, 9, 26, 18, 30),
  loadUnloadEvents: [
    { minuteStartUtc: loadMs, gpsLocation: 'Praha', type: 'load' },
    { minuteStartUtc: unloadMs, gpsLocation: 'Brno', type: 'unload' },
  ] satisfies VehicleLoadUnloadEvent[],
  ferryTrainEvents: [
    { minuteStartUtc: ferryMs, gpsLocation: 'Calais', type: 'activation' },
  ] satisfies FerryTrainEvent[],
  outModeEvents: [
    { minuteStartUtc: outStartMs, type: 'activation' },
    { minuteStartUtc: outEndMs, type: 'deactivation' },
  ] satisfies OutModeEvent[],
  recordedGpsLocations: [
    { minuteStartUtc: Date.UTC(2026, 9, 27, 9, 0), gpsLocation: 'Kolín', recordType: 'gps_3h' },
    { minuteStartUtc: Date.UTC(2026, 9, 28, 8, 0), gpsLocation: 'Jihlava', recordType: 'gps_3h' },
  ] satisfies RecordedGpsLocation[],
  faultsAndEvents: [
    {
      id: 1,
      timestampUtc: Date.UTC(2026, 9, 27, 8, 12),
      type: 'EXCESS_SPEED_WARNING',
    },
  ] satisfies FaultOrEvent[],
}
