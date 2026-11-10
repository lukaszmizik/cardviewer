import { deriveDailyRecordCoverageGaps } from '../analysis/dailyRecordCoverage.ts'
import type {
  Activity,
  ActivityKind,
  CardPresentEdge,
  ComplianceRule,
  CardIncident,
  ComplianceViolation,
  DriverCardData,
  HolderContinuity,
  HolderEndCause,
  HolderStartOrigin,
  HolderTimelineMeta,
  HolderTimelineSegment,
  LoadUnloadEntry,
  LoadUnloadKind,
  Location,
  SpecificConditionEntry,
  SpecificConditionKind,
  LocationRecordType,
  VehicleUse,
} from '../types/tacho'

/** JSON výstup Go knihovny dddparser (tachoparser Card). */
export type DddParserCardJson = {
  card_identification_and_driver_card_holder_identification_1?: DddIdentificationBlock
  card_identification_and_driver_card_holder_identification_2?: DddIdentificationBlock
  card_driving_licence_information_1?: DddLicenceBlock
  card_driving_licence_information_2?: DddLicenceBlock
  card_driver_activity_1?: DddActivityBlock
  card_driver_activity_2?: DddActivityBlock
  card_place_daily_work_period_1?: DddPlacesBlock
  card_place_daily_work_period_2?: DddPlacesBlock
  gnss_accumulated_driving?: DddGnssBlock
  card_border_crossings?: DddBorderBlock
  card_load_unload_operations?: DddLoadUnloadBlock
  specific_conditions_1?: DddSpecificConditionsBlock
  specific_conditions_2?: DddSpecificConditionsBlock
  card_vehicles_used_1?: DddVehiclesBlock
  card_vehicles_used_2?: DddVehiclesBlock
  card_event_data_1?: DddEventBlock
  card_event_data_2?: DddEventBlock
  card_fault_data_1?: DddFaultBlock
  card_fault_data_2?: DddFaultBlock
  last_card_download_1?: DddLastDownloadBlock
  last_card_download_2?: DddLastDownloadBlock
}

type DddIdentificationBlock = {
  card_identification?: {
    card_issuing_member_state?: number
    card_number?: string
    card_issuing_authority_name?: string | null
    card_issue_date?: string | null
    card_validity_begin?: string | null
    card_expiry_date?: string | null
  }
  driver_card_holder_identification?: {
    card_holder_name?: {
      holder_surname?: string | null
      holder_first_names?: string | null
    }
    card_holder_birth_date?: {
      year?: number | null
      month?: number | null
      day?: number | null
    }
    card_holder_preferred_language?: string | null
  }
}

type DddLicenceBlock = {
  driving_licence_issuing_authority?: string | null
  driving_licence_number?: string
  driving_licence_issuing_nation?: number
}

type DddLastDownloadBlock = {
  last_card_download?: string | null
}

type DddActivityChange = {
  driver?: boolean
  team?: boolean
  card_present?: boolean
  work_type?: number
  minutes?: number
}

/** 0 přestávka, 1 pohotovost, 2 jiná práce, 3 řízení */
const WORK_TYPE_TO_KIND: Record<number, ActivityKind> = {
  0: 'rest',
  1: 'availability',
  2: 'work',
  3: 'driving',
}

type DddDailyRecord = {
  activity_record_date?: string | null
  activity_change_info?: unknown[]
}

type DddActivityBlock = {
  decoded_activity_daily_records?: DddDailyRecord[]
}

type DddGeo = {
  latitude?: number
  longitude?: number
}

type DddPlaceRecord = {
  entry_time?: string | null
  entry_type_daily_work_period?: number
  daily_work_period_country?: number
  entry_gnss_place_record?: {
    geo_coordinates?: DddGeo
  }
}

type DddPlacesBlock = {
  place_records?: DddPlaceRecord[]
}

type DddGnssRecord = {
  time_stamp?: string | null
  gnss_place_record?: {
    time_stamp?: string | null
    geo_coordinates?: DddGeo
  }
}

type DddGnssBlock = {
  gnss_accumulated_driving_records?: DddGnssRecord[]
}

type DddBorderRecord = {
  country_left?: number
  country_entered?: number
  gnss_place_auth_record?: {
    time_stamp?: string | null
    geo_coordinates?: DddGeo
  }
}

type DddBorderBlock = {
  card_border_crossing_records?: DddBorderRecord[]
}

type DddLoadUnloadRecord = {
  timestamp?: string | null
  operation_type?: number
  vehicle_odometer_value?: number | null
  gnss_place_auth_record?: {
    time_stamp?: string | null
    geo_coordinates?: DddGeo
  }
}

type DddLoadUnloadBlock = {
  card_load_unload_records?: DddLoadUnloadRecord[]
}

type DddSpecificConditionRecord = {
  entry_time?: string | null
  specific_condition_type?: number
}

type DddSpecificConditionsBlock = {
  specific_condition_records?: DddSpecificConditionRecord[]
}

type DddVehicleRecord = {
  vehicle_first_use?: string | null
  vehicle_last_use?: string | null
  vehicle_odometer_begin?: number | null
  vehicle_odometer_end?: number | null
  vehicle_registration?: {
    vehicle_registration_nation?: number | null
    vehicle_registration_number?: string | null
  }
  vu_data_block_counter?: number | null
  vehicle_identification_number?: string | null
}

type DddVehiclesBlock = {
  card_vehicle_records?: DddVehicleRecord[]
}

type DddRegistration = {
  vehicle_registration_number?: string | null
}

type DddEventRecord = {
  event_type?: number
  event_begin_time?: string | null
  event_end_time?: string | null
  event_vehicle_registration?: DddRegistration
}

type DddFaultRecord = {
  fault_type?: number
  fault_begin_time?: string | null
  fault_end_time?: string | null
  fault_vehicle_registration?: DddRegistration
}

type DddEventBlock = {
  card_event_records_array?: Array<{
    card_event_records?: DddEventRecord[]
  }>
}

type DddFaultBlock = {
  card_fault_records_array?: Array<{
    card_fault_records?: DddFaultRecord[]
  }>
}

const NATION_ALPHA: Record<number, string> = {
  1: 'AT',
  2: 'AL',
  3: 'AD',
  4: 'AM',
  5: 'AZ',
  6: 'BE',
  7: 'BG',
  8: 'BA',
  9: 'BY',
  10: 'CH',
  11: 'CY',
  12: 'CZ',
  13: 'DE',
  14: 'DK',
  15: 'ES',
  16: 'EE',
  17: 'FR',
  18: 'FI',
  19: 'LI',
  20: 'FO',
  21: 'GB',
  22: 'GE',
  23: 'GR',
  24: 'HU',
  25: 'HR',
  26: 'IT',
  27: 'IE',
  28: 'IS',
  29: 'KZ',
  30: 'LU',
  31: 'LT',
  32: 'LV',
  33: 'MT',
  34: 'MC',
  35: 'MD',
  36: 'MK',
  37: 'NO',
  38: 'NL',
  39: 'PT',
  40: 'PL',
  41: 'RO',
  42: 'SE',
  43: 'SK',
  44: 'SI',
  45: 'TJ',
  46: 'TM',
  47: 'TR',
  48: 'UA',
  49: 'VA',
  50: 'YU',
  51: 'ME',
  52: 'UZ',
  53: 'RU',
}

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  return values.find((value) => value != null) as T | undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function parseUnixMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function formatDateCs(ms: number | null): string | undefined {
  if (ms == null) return undefined
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`
}

function formatBirthDate(block?: DddIdentificationBlock): string | undefined {
  const birth = block?.driver_card_holder_identification?.card_holder_birth_date
  if (!birth || birth.year == null || birth.month == null || birth.day == null) return undefined
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(birth.day)}.${pad(birth.month)}.${birth.year}`
}

function nationCode(numeric?: number): string | undefined {
  if (numeric == null || numeric === 0) return undefined
  return NATION_ALPHA[numeric] ?? String(numeric)
}

function geoLabel(geo?: DddGeo, country?: number): string {
  const code = nationCode(country)
  if (geo?.latitude != null && geo.longitude != null) {
    return `${geo.latitude.toFixed(5)}, ${geo.longitude.toFixed(5)}`
  }
  return code ?? '—'
}

function isInternalCard(value: unknown): value is DriverCardData {
  const data = asRecord(value)
  return (
    !!data &&
    typeof data.cardNumber === 'string' &&
    typeof data.firstName === 'string' &&
    typeof data.surname === 'string' &&
    Array.isArray(data.activities) &&
    Array.isArray(data.locations) &&
    Array.isArray(data.violations)
  )
}

function pickIdentification(card: DddParserCardJson): DddIdentificationBlock | undefined {
  return firstDefined(
    card.card_identification_and_driver_card_holder_identification_2,
    card.card_identification_and_driver_card_holder_identification_1,
  )
}

function decodeChangeWord(b0: number, b1: number): DddActivityChange {
  const v = (b0 << 8) | b1
  return {
    driver: (v & 0x8000) === 0,
    team: (v & 0x4000) > 0,
    card_present: (v & 0x2000) === 0,
    work_type: (v & 0x1800) >> 11,
    minutes: v & 0x07ff,
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  return undefined
}

function normalizeActivityChange(raw: unknown): DddActivityChange | null {
  if (typeof raw === 'string') {
    try {
      const binary = atob(raw)
      if (binary.length >= 2) return decodeChangeWord(binary.charCodeAt(0), binary.charCodeAt(1))
    } catch {
      return null
    }
  }
  if (Array.isArray(raw) && raw.length >= 2) {
    return decodeChangeWord(Number(raw[0]), Number(raw[1]))
  }
  const rec = asRecord(raw)
  if (!rec) return null
  const workType = asNumber(rec.work_type ?? rec.workType)
  const minutes = asNumber(rec.minutes)
  if (workType == null && minutes == null && typeof rec[0] !== 'number') {
    const bytes = rec.data ?? rec.Data
    if (typeof bytes === 'string') return normalizeActivityChange(bytes)
  }
  return {
    driver: rec.driver !== false && rec.Driver !== false,
    team: Boolean(rec.team ?? rec.Team),
    card_present: rec.card_present !== false && rec.cardPresent !== false && rec.CardPresent !== false,
    work_type: workType,
    minutes,
  }
}

function activityKindFromChange(change: DddActivityChange): ActivityKind {
  return WORK_TYPE_TO_KIND[change.work_type ?? 0] ?? 'unknown'
}

function dayHasInsertedCard(day: DddDailyRecord): boolean {
  return (day.activity_change_info ?? []).some((raw) => {
    const change = normalizeActivityChange(raw)
    return change != null && change.card_present !== false
  })
}

/**
 * Jednotka 1. generace zapisuje jen do starého souboru, jednotka 2. generace do nového.
 * Den, který je jen v jednom z nich, se nesmí zahodit. Když jsou zapsané oba a liší se,
 * platí ten, ve kterém byla karta opravdu ve vozidle, jinak bohatší záznam.
 */
function mergeActivityDays(card: DddParserCardJson): DddDailyRecord[] {
  const byDay = new Map<number, DddDailyRecord>()
  const take = (day: DddDailyRecord, incomingIsGen2: boolean) => {
    const key = parseUnixMs(day.activity_record_date)
    if (key == null) return
    const existing = byDay.get(key)
    if (!existing) {
      byDay.set(key, day)
      return
    }
    const existingInserted = dayHasInsertedCard(existing)
    const incomingInserted = dayHasInsertedCard(day)
    if (existingInserted !== incomingInserted) {
      if (incomingInserted) byDay.set(key, day)
      return
    }
    const existingCount = existing.activity_change_info?.length ?? 0
    const incomingCount = day.activity_change_info?.length ?? 0
    if (incomingCount !== existingCount) {
      if (incomingCount > existingCount) byDay.set(key, day)
      return
    }
    if (incomingIsGen2) byDay.set(key, day)
  }
  for (const day of card.card_driver_activity_1?.decoded_activity_daily_records ?? []) take(day, false)
  for (const day of card.card_driver_activity_2?.decoded_activity_daily_records ?? []) take(day, true)
  return [...byDay.values()]
}

function mergeByTime<T>(primary: T[] | undefined, secondary: T[] | undefined, timeOf: (item: T) => string | null | undefined): T[] {
  const merged: T[] = []
  const seen = new Set<string>()
  for (const item of primary ?? []) {
    const key = timeOf(item)
    if (key) seen.add(key)
    merged.push(item)
  }
  for (const item of secondary ?? []) {
    const key = timeOf(item)
    if (key && seen.has(key)) continue
    merged.push(item)
  }
  return merged
}

type SlotChange = {
  dayStart: number
  minutes: number
  change: DddActivityChange
  /** Pořadí v surovém denním seznamu. Při shodném čase se nesmí rozhodit. */
  order: number
}

type CollectedSlotChange = SlotChange & {
  raw: unknown
}

function changeTime(item: SlotChange): number {
  return item.dayStart + item.minutes * 60_000
}

function cardIsPresent(change: DddActivityChange): boolean {
  return change.card_present !== false
}

/**
 * Ruční záznam je činnost bez vložené karty, která má na kartě konkrétní konec.
 * Otevřený úsek bez další změny ruční záznam není.
 */
function isExplicitManualEntry(current: SlotChange, next: SlotChange | undefined): boolean {
  if (cardIsPresent(current.change)) return false
  return next != null
}

/** Stejný slot, stejná činnost a pořád bez karty — záznam v mezeře jen pokračuje. */
function sameAbsentActivity(current: SlotChange, next: SlotChange): boolean {
  return (
    !cardIsPresent(current.change) &&
    !cardIsPresent(next.change) &&
    (current.change.driver === false) === (next.change.driver === false) &&
    (current.change.work_type ?? 0) === (next.change.work_type ?? 0)
  )
}

/** Mezi denními záznamy chybí aspoň jeden celý den. */
function spansUnrecordedDays(current: SlotChange, next: SlotChange, dayMs: number): boolean {
  return next.dayStart - current.dayStart > dayMs
}

function laterChange(collected: SlotChange[], index: number): SlotChange | undefined {
  const startUtc = changeTime(collected[index]!)
  for (let cursor = index + 1; cursor < collected.length; cursor += 1) {
    const candidate = collected[cursor]!
    if (changeTime(candidate) > startUtc) return candidate
  }
  return undefined
}

function slotFromChange(change: DddActivityChange): 1 | 2 {
  return change.driver === false ? 2 : 1
}

function collectSlotChanges(card: DddParserCardJson): CollectedSlotChange[] {
  const days = mergeActivityDays(card)
  const collected: CollectedSlotChange[] = []
  let order = 0

  for (const day of days) {
    const dayStart = parseUnixMs(day.activity_record_date)
    if (dayStart == null) continue
    for (const raw of day.activity_change_info ?? []) {
      const change = normalizeActivityChange(raw)
      if (change == null) continue
      collected.push({
        dayStart,
        minutes: Math.max(0, change.minutes ?? 0),
        change,
        order,
        raw,
      })
      order += 1
    }
  }

  collected.sort((a, b) => changeTime(a) - changeTime(b) || a.order - b.order)
  return collected
}

function cardPresentExplicit(raw: unknown, change: DddActivityChange): { known: boolean; present: boolean } {
  if (typeof raw === 'string' || (Array.isArray(raw) && raw.length >= 2)) {
    return { known: true, present: cardIsPresent(change) }
  }
  const rec = asRecord(raw)
  if (rec) {
    const known = 'card_present' in rec || 'cardPresent' in rec || 'CardPresent' in rec
    if (known) return { known: true, present: cardIsPresent(change) }
  }
  return { known: false, present: cardIsPresent(change) }
}

function changesAreContinuous(prev: SlotChange, next: SlotChange, dayMs: number): boolean {
  const prevUtc = changeTime(prev)
  const nextUtc = changeTime(next)
  if (nextUtc <= prevUtc) return false
  return !spansUnrecordedDays(prev, next, dayMs)
}

function conflictingPresentTimes(items: readonly CollectedSlotChange[]): Set<number> {
  const byTime = new Map<number, boolean>()
  const conflicts = new Set<number>()
  for (const item of items) {
    const atUtc = changeTime(item)
    const state = cardPresentExplicit(item.raw, item.change)
    if (!state.known) continue
    const prior = byTime.get(atUtc)
    if (prior !== undefined && prior !== state.present) conflicts.add(atUtc)
    else if (prior === undefined) byTime.set(atUtc, state.present)
  }
  return conflicts
}

/**
 * Přechody card_present mezi navazujícími změnovými záznamy stejného slotu.
 * Neodvozuje stav z Activity.kind === 'unknown'.
 */
function mapCardPresentEdges(card: DddParserCardJson): CardPresentEdge[] {
  const collected = collectSlotChanges(card)
  const dayMs = 24 * 60 * 60_000
  const edges: CardPresentEdge[] = []

  for (const slot of [1, 2] as const) {
    const slotItems = collected.filter((item) => slotFromChange(item.change) === slot)
    const conflictTimes = conflictingPresentTimes(slotItems)
    let prev: { item: CollectedSlotChange; present: boolean } | null = null

    for (const item of slotItems) {
      const atUtc = changeTime(item)
      if (conflictTimes.has(atUtc)) {
        prev = null
        continue
      }
      const state = cardPresentExplicit(item.raw, item.change)
      if (!state.known) {
        prev = null
        continue
      }
      if (prev != null && changesAreContinuous(prev.item, item, dayMs) && state.present !== prev.present) {
        edges.push({ atUtc, present: state.present, slot })
      }
      prev = { item, present: state.present }
    }
  }

  return edges.sort((a, b) => a.atUtc - b.atUtc || a.slot - b.slot)
}

function mapActivities(card: DddParserCardJson): Activity[] {
  const collected = collectSlotChanges(card)

  const dayMs = 24 * 60 * 60_000
  const activities: Activity[] = []
  for (let i = 0; i < collected.length; i += 1) {
    const current = collected[i]!
    const startUtc = changeTime(current)
    const nextInOrder = collected[i + 1]
    const sharesTimestamp = nextInOrder != null && changeTime(nextInOrder) === startUtc
    const nextLater = laterChange(collected, i)
    let endUtc = nextLater ? changeTime(nextLater) : current.dayStart + dayMs
    let unknownUntil: number | null = null
    if (sharesTimestamp) {
      // Dřívější záznam ve stejné minutě se neprotahuje přes pozdější. Pořadí v kartě zůstává.
      endUtc = startUtc
    } else if (nextLater && spansUnrecordedDays(current, nextLater, dayMs) && !sameAbsentActivity(current, nextLater)) {
      const recordedUntil = current.dayStart + dayMs
      const nextUtc = changeTime(nextLater)
      if (recordedUntil > startUtc && recordedUntil < nextUtc) {
        endUtc = recordedUntil
        unknownUntil = nextUtc
      }
    }
    if (endUtc < startUtc) continue
    const durationMinutes = Math.round((endUtc - startUtc) / 60_000)
    if (durationMinutes < 0) continue
    if (durationMinutes === 0 && !sharesTimestamp) continue

    const inVehicle = cardIsPresent(current.change)
    const explicitManual = isExplicitManualEntry(current, sharesTimestamp ? nextInOrder : nextLater)
    const slot: 1 | 2 = slotFromChange(current.change)

    activities.push({
      id: `act-${i}`,
      kind: inVehicle || explicitManual ? activityKindFromChange(current.change) : 'unknown',
      startUtc,
      endUtc,
      durationMinutes,
      isManualEntry: explicitManual,
      isCrew: inVehicle && current.change.team === true,
      slot,
    })
    if (unknownUntil != null) {
      activities.push({
        id: `gap-${i}`,
        kind: 'unknown',
        startUtc: endUtc,
        endUtc: unknownUntil,
        durationMinutes: Math.round((unknownUntil - endUtc) / 60_000),
        isManualEntry: false,
      })
    }
  }

  return assignVehicleRegistrations(activities, card)
}

const TIMELINE_DAY_MS = 24 * 60 * 60_000

function startOriginForChange(
  explicitManual: boolean,
  inVehicle: boolean,
): HolderStartOrigin {
  if (explicitManual) return 'manual_entry'
  if (!inVehicle) return 'unknown'
  return 'explicit_change'
}

function endCauseForSegment(
  current: CollectedSlotChange,
  nextLater: CollectedSlotChange | undefined,
  sharesTimestamp: boolean,
  unknownUntil: number | null,
): HolderEndCause {
  if (unknownUntil != null) return 'unknown_gap'
  if (sharesTimestamp) return 'unresolved'
  if (!nextLater) return 'day_end'
  const samePosition = slotFromChange(nextLater.change) === slotFromChange(current.change)
  return samePosition ? 'next_change_same_position' : 'next_change_other_position'
}

function continuityForSegment(
  kind: ActivityKind,
  startOrigin: HolderStartOrigin,
  endCause: HolderEndCause,
  startUtc: number,
  endUtc: number,
): HolderContinuity {
  if (kind === 'unknown' || endCause === 'unknown_gap') return 'unknown'
  if (endCause === 'unresolved' || startOrigin === 'unknown') return 'unknown'
  if (endCause === 'next_change_other_position') return 'inferred'
  if (endCause === 'day_end') return 'inferred'
  if (startOrigin === 'manual_entry') return 'inferred'
  if (endUtc - startUtc > TIMELINE_DAY_MS) return 'inferred'
  if (startOrigin === 'explicit_change' && endCause === 'next_change_same_position') return 'recorded'
  return 'inferred'
}

function markPositionOverlapConflicts(segments: HolderTimelineSegment[]): void {
  for (const position of [1, 2] as const) {
    const ordered = segments
      .filter((segment) => segment.position === position)
      .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
    for (let index = 1; index < ordered.length; index += 1) {
      const prev = ordered[index - 1]!
      const next = ordered[index]!
      if (prev.endUtc > next.startUtc && prev.startUtc < next.endUtc) {
        prev.continuity = 'conflict'
        next.continuity = 'conflict'
      }
    }
  }
}

/**
 * Diagnostická osa držitele — stejná časová logika jako mapActivities, bez změny Activity[].
 */
export function mapHolderTimelineSegments(card: DddParserCardJson): {
  segments: HolderTimelineSegment[]
  meta: HolderTimelineMeta
} {
  const collected = collectSlotChanges(card)
  const segments: HolderTimelineSegment[] = []

  for (let i = 0; i < collected.length; i += 1) {
    const current = collected[i]!
    const startUtc = changeTime(current)
    const nextInOrder = collected[i + 1]
    const sharesTimestamp = nextInOrder != null && changeTime(nextInOrder) === startUtc
    const nextLater = laterChange(collected, i)
    let endUtc = nextLater ? changeTime(nextLater) : current.dayStart + TIMELINE_DAY_MS
    let unknownUntil: number | null = null
    if (sharesTimestamp) {
      endUtc = startUtc
    } else if (nextLater && spansUnrecordedDays(current, nextLater, TIMELINE_DAY_MS) && !sameAbsentActivity(current, nextLater)) {
      const recordedUntil = current.dayStart + TIMELINE_DAY_MS
      const nextUtc = changeTime(nextLater)
      if (recordedUntil > startUtc && recordedUntil < nextUtc) {
        endUtc = recordedUntil
        unknownUntil = nextUtc
      }
    }
    if (endUtc < startUtc) continue
    const durationMinutes = Math.round((endUtc - startUtc) / 60_000)
    if (durationMinutes < 0) continue
    if (durationMinutes === 0 && !sharesTimestamp) continue

    const inVehicle = cardIsPresent(current.change)
    const explicitManual = isExplicitManualEntry(current, sharesTimestamp ? nextInOrder : nextLater)
    const position = slotFromChange(current.change)
    const startOrigin = startOriginForChange(explicitManual, inVehicle)
    const endCause = endCauseForSegment(current, nextLater, sharesTimestamp, unknownUntil)
    const kind: ActivityKind =
      inVehicle || explicitManual ? activityKindFromChange(current.change) : 'unknown'
    const continuity = continuityForSegment(kind, startOrigin, endCause, startUtc, endUtc)

    segments.push({
      startUtc,
      endUtc,
      kind,
      position,
      startOrigin,
      endCause,
      continuity,
      sourceActivityIds: [`act-${i}`],
      sourceChangeCount: 1,
    })

    if (unknownUntil != null) {
      segments.push({
        startUtc: endUtc,
        endUtc: unknownUntil,
        kind: 'unknown',
        position,
        startOrigin: 'inferred',
        endCause: 'unknown_gap',
        continuity: 'unknown',
        sourceActivityIds: [`gap-${i}`],
        sourceChangeCount: 0,
      })
    }
  }

  markPositionOverlapConflicts(segments)
  return {
    segments,
    meta: { slotChronologyAssumption: 'single_card_merged_timeline' },
  }
}

export type HolderAbsentLongSpanDiagnostic = {
  sourceActivityId: string
  startUtc: number
  endUtc: number
  currentDayStart: number
  nextLaterDayStart: number | null
  dayStartDiffCalendarDays: number | null
  currentCardPresent: boolean
  nextLaterCardPresent: boolean | null
  currentWorkType: number | null
  nextLaterWorkType: number | null
  currentDriver: boolean | null
  nextLaterDriver: boolean | null
  spansUnrecordedDays: boolean | 'unavailable'
  sameAbsentActivity: boolean | 'unavailable'
  wouldCreateUnknownWithoutSameAbsentException: boolean | 'unavailable'
  dailyRecordsBetweenDayStartsInclusive: number
  dailyRecordsStrictlyBetweenDayStarts: number
}

function countMergedDailyRecords(
  days: readonly DddDailyRecord[],
  fromDayStart: number,
  toDayStart: number,
): { inclusive: number; strictlyBetween: number } {
  let inclusive = 0
  let strictlyBetween = 0
  for (const day of days) {
    const dayStart = parseUnixMs(day.activity_record_date)
    if (dayStart == null) continue
    if (dayStart >= fromDayStart && dayStart <= toDayStart) inclusive += 1
    if (dayStart > fromDayStart && dayStart < toDayStart) strictlyBetween += 1
  }
  return { inclusive, strictlyBetween }
}

/**
 * Read-only diagnostika dlouhých úseků bez karty — stejná smyčka a podmínky jako mapHolderTimelineSegments.
 * Nemění výstup mapování.
 */
export function diagnoseHolderAbsentLongSpans(
  card: DddParserCardJson,
  minDurationMs: number = TIMELINE_DAY_MS,
): HolderAbsentLongSpanDiagnostic[] {
  const collected = collectSlotChanges(card)
  const mergedDays = mergeActivityDays(card)
  const dayMs = TIMELINE_DAY_MS
  const results: HolderAbsentLongSpanDiagnostic[] = []

  for (let i = 0; i < collected.length; i += 1) {
    const current = collected[i]!
    if (cardIsPresent(current.change)) continue

    const startUtc = changeTime(current)
    const nextInOrder = collected[i + 1]
    const sharesTimestamp = nextInOrder != null && changeTime(nextInOrder) === startUtc
    const nextLater = laterChange(collected, i)
    let endUtc = nextLater ? changeTime(nextLater) : current.dayStart + dayMs
    if (sharesTimestamp) {
      endUtc = startUtc
    } else if (nextLater && spansUnrecordedDays(current, nextLater, dayMs) && !sameAbsentActivity(current, nextLater)) {
      const recordedUntil = current.dayStart + dayMs
      const nextUtc = changeTime(nextLater)
      if (recordedUntil > startUtc && recordedUntil < nextUtc) {
        endUtc = recordedUntil
      }
    }
    if (endUtc < startUtc) continue
    if (endUtc - startUtc <= minDurationMs) continue
    if (durationMinutesWouldSkip(endUtc, startUtc, sharesTimestamp)) continue

    const dayCounts =
      nextLater != null
        ? countMergedDailyRecords(mergedDays, current.dayStart, nextLater.dayStart)
        : countMergedDailyRecords(mergedDays, current.dayStart, current.dayStart)

    let spansFlag: boolean | 'unavailable' = 'unavailable'
    let sameAbsent: boolean | 'unavailable' = 'unavailable'
    let wouldUnknown: boolean | 'unavailable' = 'unavailable'
    if (nextLater != null) {
      spansFlag = spansUnrecordedDays(current, nextLater, dayMs)
      sameAbsent = sameAbsentActivity(current, nextLater)
      if (spansFlag && !sameAbsent) {
        const recordedUntil = current.dayStart + dayMs
        const nextUtc = changeTime(nextLater)
        wouldUnknown = recordedUntil > startUtc && recordedUntil < nextUtc
      } else {
        wouldUnknown = false
      }
    }

    const dayStartDiff =
      nextLater != null ? Math.round((nextLater.dayStart - current.dayStart) / dayMs) : null

    results.push({
      sourceActivityId: `act-${i}`,
      startUtc,
      endUtc,
      currentDayStart: current.dayStart,
      nextLaterDayStart: nextLater?.dayStart ?? null,
      dayStartDiffCalendarDays: dayStartDiff,
      currentCardPresent: cardIsPresent(current.change),
      nextLaterCardPresent: nextLater != null ? cardIsPresent(nextLater.change) : null,
      currentWorkType: current.change.work_type ?? null,
      nextLaterWorkType: nextLater?.change.work_type ?? null,
      currentDriver: current.change.driver ?? null,
      nextLaterDriver: nextLater?.change.driver ?? null,
      spansUnrecordedDays: spansFlag,
      sameAbsentActivity: sameAbsent,
      wouldCreateUnknownWithoutSameAbsentException: wouldUnknown,
      dailyRecordsBetweenDayStartsInclusive: dayCounts.inclusive,
      dailyRecordsStrictlyBetweenDayStarts: dayCounts.strictlyBetween,
    })
  }

  return results.sort((a, b) => a.startUtc - b.startUtc)
}

function durationMinutesWouldSkip(endUtc: number, startUtc: number, sharesTimestamp: boolean): boolean {
  const durationMinutes = Math.round((endUtc - startUtc) / 60_000)
  if (durationMinutes < 0) return true
  if (durationMinutes === 0 && !sharesTimestamp) return true
  return false
}

/** Diagnostika z surového výstupu parseru (bez změny mapování). */
export function diagnoseHolderAbsentLongSpansFromParserJson(
  parserJson: unknown,
  minDurationMs: number = TIMELINE_DAY_MS,
): HolderAbsentLongSpanDiagnostic[] {
  const card = unwrapParserCard(parserJson)
  if (!card) return []
  return diagnoseHolderAbsentLongSpans(card, minDurationMs)
}

export type CoverageAnchorChange = CollectedSlotChange & { index: number }

/** Seřazené dayStart z mergeActivityDays — stejná normalizace jako mapper. */
export function mergedActivityDayStarts(card: DddParserCardJson): number[] {
  const days = mergeActivityDays(card)
  const starts: number[] = []
  for (const day of days) {
    const dayStart = parseUnixMs(day.activity_record_date)
    if (dayStart != null) starts.push(dayStart)
  }
  starts.sort((left, right) => left - right)
  return starts
}

export function collectCoverageAnchorChanges(card: DddParserCardJson): CoverageAnchorChange[] {
  return collectSlotChanges(card).map((item, index) => ({ ...item, index }))
}

/** Read-only Activity[] pro coverage overlap — nemění kanonický výstup mapDddParserJson. */
export function mapActivitiesFromDdd(card: DddParserCardJson): Activity[] {
  return mapActivities(card)
}

export function unwrapParserCardForCoverage(parserJson: unknown): DddParserCardJson | null {
  return unwrapParserCard(parserJson)
}

export function mapperUnknownGapFlags(
  current: CollectedSlotChange,
  nextLater: CollectedSlotChange,
  dayMs: number = TIMELINE_DAY_MS,
): {
  spansUnrecordedDays: boolean
  sameAbsentActivityAtAnchors: boolean
  unknownGapGeometryEligible: boolean
  unknownGapSuppressedBySameAbsentActivity: boolean
  unknownGapEmittedByMapper: boolean
} {
  const spans = spansUnrecordedDays(current, nextLater, dayMs)
  const sameAbsent = sameAbsentActivity(current, nextLater)
  const startUtc = changeTime(current)
  const nextUtc = changeTime(nextLater)
  const recordedUntil = current.dayStart + dayMs
  const unknownGapGeometryEligible = spans && recordedUntil > startUtc && recordedUntil < nextUtc
  return {
    spansUnrecordedDays: spans,
    sameAbsentActivityAtAnchors: sameAbsent,
    unknownGapGeometryEligible,
    unknownGapSuppressedBySameAbsentActivity: unknownGapGeometryEligible && sameAbsent,
    unknownGapEmittedByMapper: unknownGapGeometryEligible && !sameAbsent,
  }
}

function holderTimelineFromActivities(activities: readonly Activity[]): HolderTimelineSegment[] {
  return activities
    .filter((activity) => activity.slot === 1 || activity.slot === 2)
    .map((activity) => ({
      startUtc: activity.startUtc,
      endUtc: activity.endUtc,
      kind: activity.kind,
      position: activity.slot === 2 ? 2 : 1,
      startOrigin: activity.isManualEntry
        ? 'manual_entry'
        : activity.kind === 'unknown'
          ? 'unknown'
          : 'inferred',
      endCause: 'unresolved' as const,
      continuity: activity.kind === 'unknown' ? ('unknown' as const) : ('inferred' as const),
      sourceActivityIds: [activity.id],
      sourceChangeCount: activity.id.startsWith('gap-') ? 0 : activity.id.startsWith('act-') ? 1 : 0,
    }))
}

function registrationPlate(value: string | null | undefined): string | null {
  const plate = value?.replace(/\0/g, '').trim()
  return plate ? plate : null
}

/** Značka z období, kdy byla karta ve vozidle. Při překryvu bere novější záznam. */
function assignVehicleRegistrations(activities: Activity[], card: DddParserCardJson): Activity[] {
  const uses = mergeByTime(
    card.card_vehicles_used_2?.card_vehicle_records,
    card.card_vehicles_used_1?.card_vehicle_records,
    (record) => record.vehicle_first_use,
  )
    .map((record) => ({
      first: parseUnixMs(record.vehicle_first_use),
      last: parseUnixMs(record.vehicle_last_use),
      plate: registrationPlate(record.vehicle_registration?.vehicle_registration_number),
    }))
    .filter((record): record is { first: number; last: number; plate: string } =>
      record.first != null && record.last != null && record.plate != null,
    )

  return activities.map((act) => {
    const overlapping = uses.filter((record) => act.startUtc < record.last && act.endUtc > record.first)
    const containing = overlapping.filter((record) => act.startUtc >= record.first && act.startUtc < record.last)
    const chosen = (containing.length > 0 ? containing : overlapping).sort((a, b) => b.first - a.first)[0]
    return chosen ? { ...act, registration: chosen.plate } : act
  })
}

function mapLocations(card: DddParserCardJson): Location[] {
  const locations: Location[] = []
  let index = 0

  const push = (
    recordedAtUtc: number | null,
    label: string,
    recordType: LocationRecordType,
    geo?: DddGeo,
    extra?: { countryCode?: string; isManualEntry?: boolean },
  ) => {
    if (recordedAtUtc == null) return
    locations.push({
      id: `loc-${index}`,
      recordedAtUtc,
      label,
      latitude: geo?.latitude,
      longitude: geo?.longitude,
      recordType,
      countryCode: extra?.countryCode,
      isManualEntry: extra?.isManualEntry,
    })
    index += 1
  }

  const places = mergeByTime(
    card.card_place_daily_work_period_2?.place_records,
    card.card_place_daily_work_period_1?.place_records,
    (place) => place.entry_time,
  )
  for (const place of places) {
    const entryType = place.entry_type_daily_work_period ?? 0
    const type: LocationRecordType = entryType === 1 || entryType === 3 || entryType === 5 ? 'end_country' : 'start_country'
    const code = nationCode(place.daily_work_period_country)
    push(
      parseUnixMs(place.entry_time),
      geoLabel(place.entry_gnss_place_record?.geo_coordinates, place.daily_work_period_country),
      type,
      place.entry_gnss_place_record?.geo_coordinates,
      { countryCode: code, isManualEntry: entryType === 2 || entryType === 3 },
    )
  }

  for (const record of card.gnss_accumulated_driving?.gnss_accumulated_driving_records ?? []) {
    const geo = record.gnss_place_record?.geo_coordinates
    push(
      parseUnixMs(record.time_stamp ?? record.gnss_place_record?.time_stamp),
      geoLabel(geo),
      'gps',
      geo,
    )
  }

  for (const border of card.card_border_crossings?.card_border_crossing_records ?? []) {
    const geo = border.gnss_place_auth_record?.geo_coordinates
    const left = nationCode(border.country_left) ?? '?'
    const entered = nationCode(border.country_entered) ?? '?'
    push(parseUnixMs(border.gnss_place_auth_record?.time_stamp), `${left} → ${entered}`, 'border_crossing', geo)
  }

  for (const load of card.card_load_unload_operations?.card_load_unload_records ?? []) {
    const geo = load.gnss_place_auth_record?.geo_coordinates
    const type: LocationRecordType =
      load.operation_type === 2 ? 'unload' : load.operation_type === 3 ? 'load_unload' : 'load'
    push(parseUnixMs(load.timestamp ?? load.gnss_place_auth_record?.time_stamp), geoLabel(geo), type, geo)
  }

  return locations.sort((a, b) => a.recordedAtUtc - b.recordedAtUtc)
}

function mapEventToViolation(event: DddEventRecord, id: string): ComplianceViolation | null {
  const startedAtUtc = parseUnixMs(event.event_begin_time)
  if (startedAtUtc == null) return null
  const type = event.event_type ?? 0
  const mapping: Record<number, { rule: ComplianceRule; severity: ComplianceViolation['severity']; message: string }> = {
    4: { rule: 'daily_driving', severity: 'infringement', message: 'Řízení bez odpovídající karty.' },
    5: { rule: 'daily_driving', severity: 'warning', message: 'Vložení karty během jízdy.' },
    7: { rule: 'daily_driving', severity: 'warning', message: 'Překročení rychlosti.' },
  }
  const mapped = mapping[type]
  if (!mapped) return null
  return {
    id,
    rule: mapped.rule,
    startedAtUtc,
    endedAtUtc: parseUnixMs(event.event_end_time) ?? undefined,
    severity: mapped.severity,
    message: mapped.message,
  }
}

function mapViolations(card: DddParserCardJson): ComplianceViolation[] {
  const block = firstDefined(card.card_event_data_2, card.card_event_data_1)
  const records = (block?.card_event_records_array ?? []).flatMap((group) => group.card_event_records ?? [])
  return records
    .map((event, index) => mapEventToViolation(event, `evt-${index}`))
    .filter((item): item is ComplianceViolation => item != null)
}

const RECORDED_AFTER = Date.UTC(1990, 0, 1)

const EVENT_LABELS: Record<number, string> = {
  0: 'Bez dalších podrobností',
  1: 'Vložení neplatné karty',
  2: 'Konflikt karet',
  3: 'Překrytí času',
  4: 'Řízení bez odpovídající karty',
  5: 'Vložení karty během jízdy',
  6: 'Poslední relace karty nebyla správně uzavřena',
  7: 'Překročení rychlosti',
  8: 'Přerušení napájení',
  9: 'Chyba údajů o pohybu',
  10: 'Konflikt pohybu vozidla',
  11: 'Konflikt času',
  12: 'Chyba komunikace s dálkovým zařízením',
  13: 'Chybí poloha z GNSS',
  14: 'Chyba komunikace s GNSS',
}

const FAULT_LABELS: Record<number, string> = {
  0x20: 'Závada záznamového zařízení',
  0x21: 'Vnitřní závada jednotky vozidla',
  0x22: 'Závada tiskárny',
  0x23: 'Závada displeje',
  0x24: 'Závada stahování',
  0x25: 'Závada snímače',
  0x30: 'Závada karty',
  0x31: 'Závada karty',
  0x40: 'Závada GNSS',
  0x41: 'Závada přijímače GNSS',
  0x42: 'Závada externího zařízení GNSS',
}

function recordedMs(value: string | null | undefined): number | null {
  const ms = parseUnixMs(value)
  if (ms == null || ms < RECORDED_AFTER) return null
  return ms
}

function odometerKm(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function traveledKilometers(begin: number | null | undefined, end: number | null | undefined): number | null {
  const from = odometerKm(begin)
  const to = odometerKm(end)
  if (from == null || to == null || to < from) return null
  return to - from
}

function incidentLabel(code: number, labels: Record<number, string>, fallback: string): string {
  return labels[code] ?? `${fallback} ${code}`
}

function mapVehicleUses(card: DddParserCardJson): VehicleUse[] {
  return mergeByTime(
    card.card_vehicles_used_2?.card_vehicle_records,
    card.card_vehicles_used_1?.card_vehicle_records,
    (record) => record.vehicle_first_use,
  )
    .map((record) => {
      const fromUtc = recordedMs(record.vehicle_first_use)
      const toUtc = recordedMs(record.vehicle_last_use)
      const registration = registrationPlate(record.vehicle_registration?.vehicle_registration_number)
      if (fromUtc == null || toUtc == null || registration == null) return null
      const vin = record.vehicle_identification_number?.replace(/\0/g, '').trim()
      return {
        registration,
        fromUtc,
        toUtc,
        kilometers: traveledKilometers(record.vehicle_odometer_begin, record.vehicle_odometer_end),
        registrationNation: nationCode(record.vehicle_registration?.vehicle_registration_nation ?? undefined),
        vin: vin ? vin : undefined,
        odometerBeginKm: odometerKm(record.vehicle_odometer_begin),
        odometerEndKm: odometerKm(record.vehicle_odometer_end),
        dataBlockCounter:
          typeof record.vu_data_block_counter === 'number' && Number.isFinite(record.vu_data_block_counter)
            ? record.vu_data_block_counter
            : null,
      }
    })
    .filter((record): record is VehicleUse => record != null)
    .sort((a, b) => b.fromUtc - a.fromUtc)
}

function mapIncidentList(
  groups: Array<{ records?: Array<{ type?: number; begin?: string | null; end?: string | null; plate?: string | null }> }>,
  labels: Record<number, string>,
  fallback: string,
): CardIncident[] {
  const seen = new Set<string>()
  const incidents: CardIncident[] = []
  for (const group of groups) {
    for (const record of group.records ?? []) {
      const fromUtc = recordedMs(record.begin)
      if (fromUtc == null) continue
      const typeCode = record.type ?? 0
      const key = `${typeCode}|${fromUtc}`
      if (seen.has(key)) continue
      seen.add(key)
      const toUtc = recordedMs(record.end)
      incidents.push({
        fromUtc,
        toUtc: toUtc != null && toUtc >= fromUtc ? toUtc : null,
        registration: registrationPlate(record.plate),
        typeLabel: incidentLabel(typeCode, labels, fallback),
      })
    }
  }
  return incidents.sort((a, b) => b.fromUtc - a.fromUtc)
}

function eventGroups(block: DddEventBlock | undefined) {
  return (block?.card_event_records_array ?? []).map((group) => ({
    records: (group.card_event_records ?? []).map((record) => ({
      type: record.event_type,
      begin: record.event_begin_time,
      end: record.event_end_time,
      plate: record.event_vehicle_registration?.vehicle_registration_number,
    })),
  }))
}

function faultGroups(block: DddFaultBlock | undefined) {
  return (block?.card_fault_records_array ?? []).map((group) => ({
    records: (group.card_fault_records ?? []).map((record) => ({
      type: record.fault_type,
      begin: record.fault_begin_time,
      end: record.fault_end_time,
      plate: record.fault_vehicle_registration?.vehicle_registration_number,
    })),
  }))
}

function mapEvents(card: DddParserCardJson): CardIncident[] {
  return mapIncidentList(
    [...eventGroups(card.card_event_data_2), ...eventGroups(card.card_event_data_1)],
    EVENT_LABELS,
    'Událost',
  )
}

function mapFaults(card: DddParserCardJson): CardIncident[] {
  return mapIncidentList(
    [...faultGroups(card.card_fault_data_2), ...faultGroups(card.card_fault_data_1)],
    FAULT_LABELS,
    'Závada',
  )
}

function loadUnloadKind(operation: number | undefined): LoadUnloadKind {
  if (operation === 2) return 'unload'
  if (operation === 3) return 'both'
  return 'load'
}

/** 1 začátek OUT, 2 konec OUT, 3 začátek trajektu, 4 konec trajektu. */
function specificConditionKind(type: number | undefined): SpecificConditionKind | null {
  if (type === 1) return 'out'
  if (type === 2) return 'out_end'
  if (type === 3) return 'ferry'
  if (type === 4) return 'ferry_end'
  return null
}

function mapSpecificConditions(card: DddParserCardJson): SpecificConditionEntry[] {
  const records = mergeByTime(
    card.specific_conditions_2?.specific_condition_records,
    card.specific_conditions_1?.specific_condition_records,
    (record) => record.entry_time,
  )
  const entries: SpecificConditionEntry[] = []
  for (const record of records) {
    const atUtc = parseUnixMs(record.entry_time)
    const kind = specificConditionKind(record.specific_condition_type)
    if (atUtc == null || kind == null) continue
    entries.push({ atUtc, kind })
  }
  return entries.sort((a, b) => a.atUtc - b.atUtc)
}

function mapLoadUnloadEntries(card: DddParserCardJson): LoadUnloadEntry[] {
  const entries: LoadUnloadEntry[] = []
  for (const record of card.card_load_unload_operations?.card_load_unload_records ?? []) {
    const atUtc = recordedMs(record.timestamp ?? record.gnss_place_auth_record?.time_stamp)
    if (atUtc == null) continue
    const geo = record.gnss_place_auth_record?.geo_coordinates
    entries.push({
      atUtc,
      kind: loadUnloadKind(record.operation_type),
      odometerKm: odometerKm(record.vehicle_odometer_value),
      location: geo?.latitude != null && geo.longitude != null ? geoLabel(geo) : null,
    })
  }
  return entries.sort((a, b) => b.atUtc - a.atUtc)
}

function lastWithdrawalUtc(card: DddParserCardJson): number | null {
  const vehicles = mergeByTime(
    card.card_vehicles_used_2?.card_vehicle_records,
    card.card_vehicles_used_1?.card_vehicle_records,
    (record) => record.vehicle_first_use,
  )
  const times = vehicles
    .map((record) => parseUnixMs(record.vehicle_last_use))
    .filter((ms): ms is number => ms != null)
  return times.length ? Math.max(...times) : null
}

function unwrapParserCard(parserJson: unknown): DddParserCardJson | null {
  const root = asRecord(parserJson)
  if (!root) return null
  const nested = asRecord(root.card) ?? asRecord(root.Card)
  return (nested ?? root) as DddParserCardJson
}

export function mapDddParserJson(parserJson: unknown): DriverCardData {
  if (isInternalCard(parserJson)) {
    const card = parserJson
    return {
      ...card,
      holderTimelineSegments: card.holderTimelineSegments ?? holderTimelineFromActivities(card.activities),
      holderTimelineMeta: card.holderTimelineMeta ?? { slotChronologyAssumption: 'unresolved' },
    }
  }

  const card = unwrapParserCard(parserJson)
  if (!card) {
    throw new Error('Výstup dddparser neobsahuje objekt karty řidiče.')
  }

  const identification = pickIdentification(card)
  const licence = firstDefined(card.card_driving_licence_information_2, card.card_driving_licence_information_1)
  const holderBlock = identification?.driver_card_holder_identification
  const holder = holderBlock?.card_holder_name
  const id = identification?.card_identification
  const lastDownload = firstDefined(card.last_card_download_2, card.last_card_download_1)

  const mappedLocations = mapLocations(card)
  const timeline = mapHolderTimelineSegments(card)

  const mapped: DriverCardData = {
    cardNumber: (id?.card_number ?? '').trim(),
    firstName: (holder?.holder_first_names ?? '').trim(),
    surname: (holder?.holder_surname ?? '').trim(),
    dateOfBirth: formatBirthDate(identification),
    preferredLanguage: holderBlock?.card_holder_preferred_language?.trim() || undefined,
    nationality: nationCode(licence?.driving_licence_issuing_nation) ?? nationCode(id?.card_issuing_member_state),
    issuingCountry: nationCode(id?.card_issuing_member_state),
    issuingAuthority: id?.card_issuing_authority_name?.trim() || undefined,
    dateOfIssue: formatDateCs(parseUnixMs(id?.card_issue_date)),
    validityBegin: formatDateCs(parseUnixMs(id?.card_validity_begin)),
    dateOfExpiry: formatDateCs(parseUnixMs(id?.card_expiry_date)),
    drivingLicenseNumber: licence?.driving_licence_number?.trim(),
    licenceIssuingAuthority: licence?.driving_licence_issuing_authority?.trim() || undefined,
    licenceIssuingCountry: nationCode(licence?.driving_licence_issuing_nation),
    lastCardDownloadUtc: parseUnixMs(lastDownload?.last_card_download),
    lastWithdrawalUtc: lastWithdrawalUtc(card),
    locations: mappedLocations,
    activities: mapActivities(card),
    holderTimelineSegments: timeline.segments,
    holderTimelineMeta: timeline.meta,
    dailyRecordCoverageGaps: deriveDailyRecordCoverageGaps(card),
    cardPresentEdges: mapCardPresentEdges(card),
    violations: mapViolations(card),
    vehicleUses: mapVehicleUses(card),
    events: mapEvents(card),
    faults: mapFaults(card),
    loadUnloadEntries: mapLoadUnloadEntries(card),
    specificConditions: mapSpecificConditions(card),
  }

  if (!mapped.cardNumber && !mapped.surname && mapped.activities.length === 0) {
    throw new Error('JSON z dddparser neobsahuje identifikaci řidiče ani aktivity.')
  }

  return mapped
}
