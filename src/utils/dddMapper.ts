import type {
  Activity,
  ActivityKind,
  ComplianceRule,
  ComplianceViolation,
  DriverCardData,
  Location,
  LocationRecordType,
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
  card_vehicles_used_1?: DddVehiclesBlock
  card_vehicles_used_2?: DddVehiclesBlock
  card_event_data_1?: DddEventBlock
  card_event_data_2?: DddEventBlock
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
  gnss_place_auth_record?: {
    time_stamp?: string | null
    geo_coordinates?: DddGeo
  }
}

type DddLoadUnloadBlock = {
  card_load_unload_records?: DddLoadUnloadRecord[]
}

type DddVehiclesBlock = {
  card_vehicle_records?: Array<{
    vehicle_first_use?: string | null
    vehicle_last_use?: string | null
    vehicle_registration?: {
      vehicle_registration_number?: string | null
    }
  }>
}

type DddEventRecord = {
  event_type?: number
  event_begin_time?: string | null
  event_end_time?: string | null
}

type DddEventBlock = {
  card_event_records_array?: Array<{
    card_event_records?: DddEventRecord[]
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

function pickActivityBlock(card: DddParserCardJson): DddActivityBlock | undefined {
  const gen2 = card.card_driver_activity_2
  const gen1 = card.card_driver_activity_1
  const n2 = gen2?.decoded_activity_daily_records?.length ?? 0
  const n1 = gen1?.decoded_activity_daily_records?.length ?? 0
  if (n2 > 0) return gen2
  if (n1 > 0) return gen1
  return gen2 ?? gen1
}

type SlotChange = {
  dayStart: number
  minutes: number
  change: DddActivityChange
}

function changeTime(item: SlotChange): number {
  return item.dayStart + item.minutes * 60_000
}

function cardIsPresent(change: DddActivityChange): boolean {
  return change.card_present !== false
}

/** VU záznam (karta ve vozidle) — má přednost před výplní i ručním zadáním. */
function isVehicleUnitActivity(act: Activity): boolean {
  return act.isManualEntry !== true && act.kind !== 'unknown'
}

function clipActivity<T extends { startUtc: number; endUtc: number; durationMinutes: number }>(
  act: T,
  startUtc: number,
  endUtc: number,
): T {
  return {
    ...act,
    startUtc,
    endUtc,
    durationMinutes: Math.round((endUtc - startUtc) / 60_000),
  }
}

/**
 * Explicitní ruční vklad: změna bez karty, která končí další změnou téhož dne
 * (nebo přes půlnoc, pokud řidič zadal činnost během dne a další den v 00:00 pokračuje).
 * Mezera mezi vytažením a dalším vložením karty sem nepatří.
 */
function isExplicitManualEntry(current: SlotChange, next: SlotChange | undefined, dayMs: number): boolean {
  if (cardIsPresent(current.change)) return false
  if (!next) return false
  if (next.dayStart === current.dayStart) return true
  return (
    current.minutes > 0 &&
    next.dayStart === current.dayStart + dayMs &&
    next.minutes === 0 &&
    !cardIsPresent(next.change) &&
    next.change.work_type === current.change.work_type
  )
}

function subtractIntervals(base: Activity, cuts: Activity[]): Activity[] {
  let pieces = [base]
  for (const cut of cuts) {
    const next: Activity[] = []
    for (const piece of pieces) {
      if (cut.endUtc <= piece.startUtc || cut.startUtc >= piece.endUtc) {
        next.push(piece)
        continue
      }
      if (cut.startUtc > piece.startUtc) next.push(clipActivity(piece, piece.startUtc, cut.startUtc))
      if (cut.endUtc < piece.endUtc) next.push(clipActivity(piece, cut.endUtc, piece.endUtc))
    }
    pieces = next.filter((item) => item.durationMinutes > 0)
  }
  return pieces
}

/** 1 minuta = 1 činnost; záznam z vozidla rozdělí jakýkoliv roztažený blok. */
function exclusiveByPriority(activities: Activity[]): Activity[] {
  const vehicle = activities
    .filter((act) => isVehicleUnitActivity(act))
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
  const vehicleExclusive: Activity[] = []
  for (const act of vehicle) {
    const copy = { ...act }
    if (vehicleExclusive.length > 0) {
      const prev = vehicleExclusive[vehicleExclusive.length - 1]!
      if (copy.startUtc < prev.endUtc) {
        prev.endUtc = copy.startUtc
        prev.durationMinutes = Math.round((prev.endUtc - prev.startUtc) / 60_000)
        if (prev.durationMinutes <= 0) vehicleExclusive.pop()
      }
    }
    if (copy.endUtc > copy.startUtc) vehicleExclusive.push(copy)
  }

  const others = activities
    .filter((act) => !isVehicleUnitActivity(act))
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)
  const splitOthers: Activity[] = []
  for (const act of others) {
    splitOthers.push(...subtractIntervals(act, vehicleExclusive))
  }
  const othersExclusive: Activity[] = []
  for (const act of splitOthers.sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc)) {
    const copy = { ...act }
    if (othersExclusive.length > 0) {
      const prev = othersExclusive[othersExclusive.length - 1]!
      if (copy.startUtc < prev.endUtc) {
        prev.endUtc = copy.startUtc
        prev.durationMinutes = Math.round((prev.endUtc - prev.startUtc) / 60_000)
        if (prev.durationMinutes <= 0) othersExclusive.pop()
      }
    }
    if (copy.endUtc > copy.startUtc) othersExclusive.push(copy)
  }

  return [...vehicleExclusive, ...othersExclusive]
    .filter((act) => act.durationMinutes > 0 && act.endUtc > act.startUtc)
    .sort((a, b) => a.startUtc - b.startUtc)
    .map((act, index) => ({ ...act, id: `act-${index}` }))
}

function mapActivities(card: DddParserCardJson): Activity[] {
  const block = pickActivityBlock(card)
  const days = block?.decoded_activity_daily_records ?? []
  const collected: SlotChange[] = []

  for (const day of days) {
    const dayStart = parseUnixMs(day.activity_record_date)
    if (dayStart == null) continue
    const changes = (day.activity_change_info ?? [])
      .map((raw) => normalizeActivityChange(raw))
      .filter((change): change is DddActivityChange => change != null)
    for (const change of changes) {
      if (change.driver === false) continue
      collected.push({
        dayStart,
        minutes: Math.max(0, change.minutes ?? 0),
        change,
      })
    }
  }

  collected.sort((a, b) => changeTime(a) - changeTime(b))

  const dayMs = 24 * 60 * 60_000
  const activities: Activity[] = []
  for (let i = 0; i < collected.length; i += 1) {
    const current = collected[i]!
    const next = collected[i + 1]
    const startUtc = changeTime(current)
    const endUtc = next ? changeTime(next) : current.dayStart + dayMs
    const durationMinutes = Math.round((endUtc - startUtc) / 60_000)
    if (durationMinutes <= 0) continue

    const inVehicle = cardIsPresent(current.change)
    const explicitManual = isExplicitManualEntry(current, next, dayMs)

    activities.push({
      id: `act-${i}`,
      kind: inVehicle || explicitManual ? activityKindFromChange(current.change) : 'unknown',
      startUtc,
      endUtc,
      durationMinutes,
      isManualEntry: explicitManual,
      isCrew: inVehicle && current.change.team === true,
      slot: 1,
    })
  }

  return assignVehicleRegistrations(exclusiveByPriority(activities), card)
}

function registrationPlate(value: string | null | undefined): string | null {
  const plate = value?.replace(/\0/g, '').trim()
  return plate ? plate : null
}

/** Značka z období, kdy byla karta ve vozidle. Při překryvu bere novější záznam. */
function assignVehicleRegistrations(activities: Activity[], card: DddParserCardJson): Activity[] {
  const uses = (firstDefined(card.card_vehicles_used_2, card.card_vehicles_used_1)?.card_vehicle_records ?? [])
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

  const places = firstDefined(card.card_place_daily_work_period_2, card.card_place_daily_work_period_1)
  for (const place of places?.place_records ?? []) {
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
    const type: LocationRecordType = load.operation_type === 2 ? 'unload' : 'load'
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

function lastWithdrawalUtc(card: DddParserCardJson): number | null {
  const vehicles = firstDefined(card.card_vehicles_used_2, card.card_vehicles_used_1)
  const times = (vehicles?.card_vehicle_records ?? [])
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
  if (isInternalCard(parserJson)) return parserJson

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
    violations: mapViolations(card),
  }

  if (!mapped.cardNumber && !mapped.surname && mapped.activities.length === 0) {
    throw new Error('JSON z dddparser neobsahuje identifikaci řidiče ani aktivity.')
  }

  return mapped
}
