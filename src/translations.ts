import { createContext, useContext, createElement, type ReactNode } from 'react'

export type WorkWeekTranslations = {
  dayNames: [string, string, string, string, string, string, string]
  activityLabels: Record<string, string>
  activityTypes: Record<string, string>
  lastWithdrawal: string
  manualEntries: string
  places: string
  loadUnload: string
  none: string
  close: string
  resetLoadUnload: string
  noData: string
  weekGraphTitle: string
  prevWeek: string
  nextWeek: string
  card1: string
  card2: string
  manualEntryLabel: string
  resetLoadUnloadTitle: string
  warningsPanelTitle: string
  workShiftDuration: string
  workShiftRest: string
  recordedLocationsTitle: string
  manualRecordsTitle: string
  tachographRecordsTitle: string
  lastWithdrawalLabel: string
  manualDataLabel: string
  shiftMarkerLabel: string
  loadUnloadSection: string
  ferryTrainSection: string
  outModeSection: string
  activation: string
  deactivation: string
  outModeStartMark: string
  outModeEndMark: string
  outModeLegendLine: string
  legendRest45h: string
  legendRest24h: string
  shiftSumLabel: string
  shiftSumRestPlaceholder: string
  shiftLengthLabel: string
  faultDrivingWithoutCard: string
  faultDrivingWithoutValidCard: string
  faultExcessSpeed: string
  recordedLocationTypes: Record<string, string>
}

export type ViewerTranslations = {
  workWeek: WorkWeekTranslations
  manualEntry: {
    load: string
    unload: string
    loadUnload: string
  }
}

export const cs: ViewerTranslations = {
  workWeek: {
    dayNames: ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'],
    activityLabels: {
      REST: 'odpočinek',
      WORK: 'práce',
      AVAILABILITY: 'pohotovost',
      DRIVING: 'řízení',
      UNKNOWN: 'neznámá činnost',
      START_COUNTRY: 'výchozí země',
      END_COUNTRY: 'cílová země',
    },
    activityTypes: {
      řízení: 'řízení',
      práce: 'práce',
      pohotovost: 'pohotovost',
      odpočinek: 'odpočinek',
      'odpočinek>24h': 'odpoč. 24h–45h',
      'odpočinek>45h': 'odpoč. ≥45h',
      neznámá: 'neznámá',
    },
    lastWithdrawal: 'Poslední vytažení',
    manualEntries: 'Manuální záznamy',
    places: 'Místa',
    loadUnload: 'nakládka/vykládka',
    none: 'žádné',
    close: 'Zavřít',
    resetLoadUnload: 'Reset nakládky/vykládky',
    noData: 'Žádná data k zobrazení',
    weekGraphTitle: 'Graf pracovního týdne',
    prevWeek: 'Předchozí týden',
    nextWeek: 'Následující týden',
    card1: 'Karta 1',
    card2: 'Karta 2',
    manualEntryLabel: 'manuální zadání',
    resetLoadUnloadTitle: 'Resetovat nakládky/vykládky',
    warningsPanelTitle: 'Výstrahy v paměti tachografu',
    workShiftDuration: 'Délka pracovní směny',
    workShiftRest: 'Odpočinek',
    recordedLocationsTitle: 'Zaznamenané lokace',
    manualRecordsTitle: 'Manuální záznamy',
    tachographRecordsTitle: 'Záznamy tachografu',
    lastWithdrawalLabel: 'Poslední vyjmutí:',
    manualDataLabel: 'Manuálně zadaná data:',
    shiftMarkerLabel: '(značka směny)',
    loadUnloadSection: 'Nakládky/vykládky:',
    ferryTrainSection: 'Režim trajekt:',
    outModeSection: 'Režim OUT:',
    activation: 'aktivace',
    deactivation: 'deaktivace',
    outModeStartMark: 'out začátek',
    outModeEndMark: 'out konec',
    outModeLegendLine: 'režim OUT',
    legendRest45h: '≥ 45h',
    legendRest24h: '24h - 44h 59m',
    shiftSumLabel: 'Součet aktivit v probíhající směně:',
    shiftSumRestPlaceholder: '----',
    shiftLengthLabel: 'Délka aktuální směny:',
    faultDrivingWithoutCard: 'Jízda bez karty',
    faultDrivingWithoutValidCard: 'Jízda bez platné karty',
    faultExcessSpeed: '(39)(39) Příliš vysoká rychlost',
    recordedLocationTypes: {
      gps_3h: 'automatická detekce každé 3h',
      start_country: 'výchozí země',
      end_country: 'cílová země',
      end_country_card: 'cílová země (vytažení karty)',
      load: 'nakládka',
      unload: 'vykládka',
      load_unload: 'nakládka/vykládka',
      border_crossing: 'průjezd hranic',
    },
  },
  manualEntry: {
    load: 'nakládka',
    unload: 'vykládka',
    loadUnload: 'nakládka/vykládka',
  },
}

type LanguageContextValue = {
  t: ViewerTranslations
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

export function LanguageProvider({ children }: { children: ReactNode }) {
  return createElement(LanguageContext.Provider, { value: { t: cs } }, children)
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider')
  return ctx
}
