/**
 * Kalendářní mezera mezi dvěma existujícími zdrojovými dny aktivit v DDD.
 * Popisuje chybějící denní záznamy v souboru — ne neznámou činnost řidiče.
 */
export interface DailyRecordCoverageGap {
  id: string
  /** [startUtc, endUtc) — první chybějící UTC den (00:00) po currentDayStart. */
  startUtc: number
  /** [startUtc, endUtc) — začátek prvního existujícího následujícího zdrojového dne (vyloučeno). */
  endUtc: number
  currentDayStart: number
  nextLaterDayStart: number
  /** Počet chybějících celých UTC dní v intervalu (endUtc − startUtc) / 24h. */
  calendarDaysBetween: number
  /** Počet zdrojových denních záznamů se dayStart přísně mezi krajními dny — u mezery z řetězce vždy 0. */
  dailyRecordsStrictlyBetween: number
  /** act-{index} startovní změny na currentDayStart, pokud bezpečně určitelné. */
  startAnchorSourceActivityId: string | null
  /** act-{index} koncové změny na nextLaterDayStart, pokud bezpečně určitelné. */
  endAnchorSourceActivityId: string | null
  /** Activity.id protínající [startUtc, endUtc) — pouze odvození bez změny Activity[]. */
  overlappedActivityIds: string[] | null
  spansUnrecordedDays: boolean | null
  sameAbsentActivityAtAnchors: boolean | null
  unknownGapGeometryEligible: boolean | null
  unknownGapSuppressedBySameAbsentActivity: boolean | null
  unknownGapEmittedByMapper: boolean | null
}
