import type { DriverCardData, Activity, ActivityKind, Location, ComplianceViolation } from '../types/tacho'
import type { CountryMarker, ParsedActivity, ActivityType, DayData } from '../workWeekTxtParser'
import { activitiesByDay, expandToWeeksContainingData } from '../workWeekTxtParser'
import type { ClockMode } from '../lib/clock'
import { clockParts } from '../lib/clock'
import type {
  FaultOrEvent,
  ManualEntrySegment,
  RecordedGpsLocation,
  VehicleLoadUnloadEvent,
} from '../TachoTypes'

const KIND_TO_TYPE: Record<ActivityKind, ActivityType> = {
  driving: 'řízení',
  work: 'práce',
  availability: 'pohotovost',
  rest: 'odpočinek',
  unknown: 'neznámá',
}

const KIND_TO_EDITOR: Record<ActivityKind, ManualEntrySegment['activityId']> = {
  driving: 'UNKNOWN',
  work: 'WORK',
  availability: 'AVAILABILITY',
  rest: 'REST',
  unknown: 'UNKNOWN',
}

export type CardGraphModel = {
  days: DayData[]
  countryMarkers: CountryMarker[]
  manualEntryBuffer: ManualEntrySegment[]
  lastWithdrawalUtc: number | null
  loadUnloadEvents: VehicleLoadUnloadEvent[]
  recordedGpsLocations: RecordedGpsLocation[]
  faultsAndEvents: FaultOrEvent[]
}

function classifyActivity(act: Activity): ActivityType {
  return KIND_TO_TYPE[act.kind] ?? 'neznámá'
}

function toParsedActivity(act: Activity): ParsedActivity {
  const type = classifyActivity(act)
  return {
    type,
    startMs: act.startUtc,
    endMs: act.endUtc,
    durationMinutes: act.durationMinutes,
    originalDurationMinutes: act.durationMinutes,
    isManualEntry: act.isManualEntry,
    isCrew: act.isCrew,
    slot: act.slot,
    registration: act.registration,
    gpsLocation: act.countryCode,
  }
}

function isVehicleUnitParsed(act: ParsedActivity): boolean {
  return act.isManualEntry !== true && act.type !== 'neznámá'
}

function clipParsed(act: ParsedActivity, startMs: number, endMs: number): ParsedActivity {
  return {
    ...act,
    startMs,
    endMs,
    durationMinutes: Math.round((endMs - startMs) / 60_000),
  }
}

function subtractParsed(base: ParsedActivity, cuts: ParsedActivity[]): ParsedActivity[] {
  let pieces = [base]
  for (const cut of cuts) {
    const next: ParsedActivity[] = []
    for (const piece of pieces) {
      if (cut.endMs <= piece.startMs || cut.startMs >= piece.endMs) {
        next.push(piece)
        continue
      }
      if (cut.startMs > piece.startMs) next.push(clipParsed(piece, piece.startMs, cut.startMs))
      if (cut.endMs < piece.endMs) next.push(clipParsed(piece, cut.endMs, piece.endMs))
    }
    pieces = next.filter((item) => item.durationMinutes > 0)
  }
  return pieces
}

function chainExclusive(list: ParsedActivity[]): ParsedActivity[] {
  const out: ParsedActivity[] = []
  for (const act of [...list].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const copy = { ...act }
    if (out.length > 0) {
      const prev = out[out.length - 1]!
      if (copy.startMs < prev.endMs) {
        prev.endMs = copy.startMs
        prev.durationMinutes = Math.round((prev.endMs - prev.startMs) / 60_000)
        if (prev.durationMinutes <= 0) out.pop()
      }
    }
    if (copy.endMs > copy.startMs) out.push(copy)
  }
  return out
}

/** 1 minuta = 1 činnost; jízda/práce/odpočinek z vozidla rozdělí roztaženou výplň. */
function exclusiveParsedTimeline(activities: ParsedActivity[]): ParsedActivity[] {
  const vehicleExclusive = chainExclusive(activities.filter((act) => isVehicleUnitParsed(act)))
  const others = activities.filter((act) => !isVehicleUnitParsed(act))
  const splitOthers = others.flatMap((act) => subtractParsed(act, vehicleExclusive))
  return [...vehicleExclusive, ...chainExclusive(splitOthers)].sort((a, b) => a.startMs - b.startMs)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function clockDateParts(ms: number, mode: ClockMode) {
  const p = clockParts(ms, mode)
  return {
    ...p,
    timeStr: `${pad(p.hour)}:${pad(p.minute)}`,
    dateStr: `${pad(p.day)}.${pad(p.month)}.${p.year}`,
  }
}

function countryFromLocation(loc: Location, fallback: string): string {
  if (loc.countryCode && /^[A-Z]{2}$/i.test(loc.countryCode)) return loc.countryCode.toUpperCase()
  if (/^[A-Z]{2}$/i.test(loc.label.trim())) return loc.label.trim().toUpperCase()
  const match = loc.label.match(/\b([A-Z]{2})\b/)
  return match?.[1] ?? fallback
}

function toCountryMarkers(locations: Location[], fallbackCountry: string, mode: ClockMode): CountryMarker[] {
  return locations
    .filter((loc) => loc.recordType === 'start_country' || loc.recordType === 'end_country')
    .map((loc) => {
      const parts = clockDateParts(loc.recordedAtUtc, mode)
      return {
        activityId: loc.recordType === 'end_country' ? 'END_COUNTRY' : 'START_COUNTRY',
        countryCode: countryFromLocation(loc, fallbackCountry),
        timeStr: parts.timeStr,
        dateStr: parts.dateStr,
        recordedAtUtc: loc.recordedAtUtc,
      } satisfies CountryMarker
    })
}

function toManualBuffer(card: DriverCardData, mode: ClockMode): ManualEntrySegment[] {
  const segments: ManualEntrySegment[] = []

  for (const loc of card.locations) {
    if (loc.recordType !== 'start_country' && loc.recordType !== 'end_country') continue
    const parts = clockDateParts(loc.recordedAtUtc, mode)
    segments.push({
      activityId: loc.recordType === 'end_country' ? 'END_COUNTRY' : 'START_COUNTRY',
      day: parts.day,
      month: parts.month,
      year: parts.year,
      hour: parts.hour,
      minute: parts.minute,
      countryCode: countryFromLocation(loc, card.issuingCountry ?? card.nationality ?? 'CZ'),
      isManualEntry: loc.isManualEntry,
      recordedAtUtc: loc.recordedAtUtc,
    })
  }

  for (const act of card.activities.filter((item) => item.isManualEntry)) {
    const parts = clockDateParts(act.startUtc, mode)
    segments.push({
      activityId: KIND_TO_EDITOR[act.kind],
      day: parts.day,
      month: parts.month,
      year: parts.year,
      hour: parts.hour,
      minute: parts.minute,
      countryCode: act.countryCode,
      isManualEntry: true,
      recordedAtUtc: act.startUtc,
    })
  }

  return segments.sort((a, b) => {
    const am = a.recordedAtUtc ?? Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute)
    const bm = b.recordedAtUtc ?? Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute)
    return am - bm
  })
}

function toLoadUnload(locations: Location[]): VehicleLoadUnloadEvent[] {
  return locations
    .filter((loc) => loc.recordType === 'load' || loc.recordType === 'unload')
    .map((loc) => ({
      minuteStartUtc: loc.recordedAtUtc,
      gpsLocation: loc.label,
      type: loc.recordType === 'unload' ? 'unload' : 'load',
    }))
}

function toGpsLocations(locations: Location[]): RecordedGpsLocation[] {
  return locations
    .filter((loc) => loc.recordType === 'gps' || loc.recordType === 'border_crossing')
    .map((loc) => ({
      minuteStartUtc: loc.recordedAtUtc,
      gpsLocation: loc.label,
      recordType: loc.recordType === 'border_crossing' ? 'border_crossing' : 'gps_3h',
      latitude: loc.latitude,
      longitude: loc.longitude,
      countryCode: loc.countryCode,
    }))
}

function toFaults(violations: ComplianceViolation[]): FaultOrEvent[] {
  return violations.map((violation, index) => {
    let type: FaultOrEvent['type'] = 'DRIVING_WITHOUT_VALID_CARD_WARNING'
    if (violation.message.includes('rychlost')) type = 'EXCESS_SPEED_WARNING'
    else if (violation.message.includes('bez odpovídající karty') || violation.message.includes('bez karty')) {
      type = 'DRIVING_WITHOUT_CARD_WARNING'
    }
    return {
      id: index + 1,
      timestampUtc: violation.startedAtUtc,
      type,
    }
  })
}

function isRest(type: ActivityType): boolean {
  return type === 'odpočinek' || type === 'odpočinek>24h' || type === 'odpočinek>45h'
}

/** Navazující odpočinek přes půlnoc má na každém úseku délku celého bloku. */
function annotateRestSpans(days: DayData[]) {
  const rests: ParsedActivity[] = []
  for (const day of days) {
    for (const act of day.activities) {
      if (isRest(act.type)) rests.push(act)
    }
  }
  rests.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  let index = 0
  while (index < rests.length) {
    let endIndex = index
    while (endIndex + 1 < rests.length && rests[endIndex]!.endMs === rests[endIndex + 1]!.startMs) endIndex += 1
    const minutes = Math.round((rests[endIndex]!.endMs - rests[index]!.startMs) / 60000)
    for (let cursor = index; cursor <= endIndex; cursor += 1) rests[cursor]!.originalDurationMinutes = minutes
    index = endIndex + 1
  }
}

export function cardToGraph(card: DriverCardData, clockMode: ClockMode = 'local'): CardGraphModel {
  const useLocalTime = clockMode === 'local'
  const parsed = exclusiveParsedTimeline(
    card.activities.filter((act) => act.slot !== 2).map(toParsedActivity),
  )
  const byDay = activitiesByDay(parsed, { useLocalTime })
  const referenceMs = parsed[0]?.startMs ?? Date.now()
  const fallbackCountry = card.issuingCountry ?? card.nationality ?? 'CZ'
  const days = expandToWeeksContainingData(byDay, referenceMs, useLocalTime)
  annotateRestSpans(days)

  return {
    days,
    countryMarkers: toCountryMarkers(card.locations, fallbackCountry, clockMode),
    manualEntryBuffer: toManualBuffer(card, clockMode),
    lastWithdrawalUtc: card.lastWithdrawalUtc,
    loadUnloadEvents: toLoadUnload(card.locations),
    recordedGpsLocations: toGpsLocations(card.locations),
    faultsAndEvents: toFaults(card.violations),
  }
}
