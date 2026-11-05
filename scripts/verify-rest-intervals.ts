import type { Activity, ActivityKind } from '../src/types/tacho.ts'
import { findRestIntervals } from '../src/analysis/restIntervals.ts'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const failures: string[] = []

function assert(condition: boolean, message: string) {
  if (!condition) failures.push(message)
  console.log(condition ? `OK  ${message}` : `FAIL ${message}`)
}

function activity(input: {
  id: string
  kind: ActivityKind
  startUtc: number
  endUtc: number
  slot?: 1 | 2
  isManualEntry?: boolean
}): Activity {
  return {
    id: input.id,
    kind: input.kind,
    startUtc: input.startUtc,
    endUtc: input.endUtc,
    durationMinutes: Math.round((input.endUtc - input.startUtc) / MINUTE),
    slot: input.slot ?? 1,
    isManualEntry: input.isManualEntry,
  }
}

function flagsOf(hours: number) {
  return findRestIntervals([
    activity({ id: 'r', kind: 'rest', startUtc: 0, endUtc: hours * HOUR }),
  ])[0]?.candidateFlags
}

const eleven = findRestIntervals([
  activity({ id: 'r1', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR }),
])
assert(eleven.length === 1, 'jeden rest 11 h → jeden interval')
assert(eleven[0]?.durationMs === 11 * HOUR, 'jeden rest 11 h → délka 11 h')
assert(eleven[0]?.ambiguous === false, 'jeden rest 11 h → jednoznačný')
assert(eleven[0]?.candidateFlags.atLeast9h === true && eleven[0]?.candidateFlags.atLeast11h === true, '11 h má příznaky 9 a 11')
assert(eleven[0]?.candidateFlags.atLeast24h === false && eleven[0]?.candidateFlags.atLeast45h === false, '11 h nemá příznaky 24 a 45')
assert(eleven[0]?.sourceActivityIds.join() === 'r1', '11 h odkazuje zdroj r1')

const chained = findRestIntervals([
  activity({ id: 'a', kind: 'rest', startUtc: 0, endUtc: 5 * HOUR }),
  activity({ id: 'b', kind: 'rest', startUtc: 5 * HOUR, endUtc: 11 * HOUR }),
])
assert(chained.length === 1, 'navazující 5 h + 6 h → jeden interval')
assert(chained[0]?.durationMs === 11 * HOUR, 'navazující 5 h + 6 h → délka 11 h')
assert(chained[0]?.sourceActivityIds.join() === 'a,b', 'navazující rest zachová oba zdroje')
assert(chained[0]?.ambiguous === false, 'navazující rest bez jiné činnosti je jednoznačný')

const splitByDriving = findRestIntervals([
  activity({ id: 'r1', kind: 'rest', startUtc: 0, endUtc: 5 * HOUR }),
  activity({ id: 'd', kind: 'driving', startUtc: 5 * HOUR, endUtc: 5 * HOUR + MINUTE }),
  activity({ id: 'r2', kind: 'rest', startUtc: 5 * HOUR + MINUTE, endUtc: 11 * HOUR + MINUTE }),
])
assert(splitByDriving.length === 2, 'rest oddělený 1 min řízení → dva intervaly')
assert(splitByDriving.every((item) => item.ambiguous === false), 'řízení mezi resty intervaly nepřekrývá')
assert(splitByDriving[0]?.sourceActivityIds.join() === 'r1' && splitByDriving[1]?.sourceActivityIds.join() === 'r2', 'řízení mezi resty zdroje nespojí')

const hole = findRestIntervals([
  activity({ id: 'r1', kind: 'rest', startUtc: 0, endUtc: 5 * HOUR }),
  activity({ id: 'r2', kind: 'rest', startUtc: 5 * HOUR + MINUTE, endUtc: 11 * HOUR }),
])
assert(hole.length === 2, 'mezera bez záznamu resty nespojí')
assert(hole.every((item) => item.durationMs < 11 * HOUR), 'mezera se nedoplní odpočinkem')

const unknownGap = findRestIntervals([
  activity({ id: 'r1', kind: 'rest', startUtc: 0, endUtc: 5 * HOUR }),
  activity({ id: 'u', kind: 'unknown', startUtc: 5 * HOUR, endUtc: 5 * HOUR + MINUTE }),
  activity({ id: 'r2', kind: 'rest', startUtc: 5 * HOUR + MINUTE, endUtc: 11 * HOUR + MINUTE }),
])
assert(unknownGap.length === 2, 'neznámá mezera resty nespojí')
assert(unknownGap.every((item) => item.ambiguous === false), 'neznámá činnost mezi resty je nepřekrývá')

const overDriving = findRestIntervals([
  activity({ id: 'r', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR }),
  activity({ id: 'd', kind: 'driving', startUtc: 2 * HOUR, endUtc: 3 * HOUR }),
])
assert(overDriving.length === 1, 'rest překrytý řízením zůstane jeden interval')
assert(overDriving[0]?.ambiguous === true, 'překryv řízením je nejednoznačný')
assert(overDriving[0]?.overlappingNonRestKinds.join() === 'driving', 'překryv uvádí driving')
assert(overDriving[0]?.sourceActivityIds.join() === 'r', 'zdrojem zůstává jen rest')
assert(overDriving[0]?.candidateFlags.atLeast11h === true, 'příznak délky se u nejednoznačného intervalu nevykládá právně, ale délka zůstane')

const overWork = findRestIntervals([
  activity({ id: 'r', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR }),
  activity({ id: 'w', kind: 'work', startUtc: HOUR, endUtc: 2 * HOUR }),
])
assert(overWork[0]?.ambiguous === true && overWork[0]?.overlappingNonRestKinds.join() === 'work', 'překryv prací je nejednoznačný')

const twentyNine = findRestIntervals([
  activity({ id: 'r', kind: 'rest', startUtc: 0, endUtc: 29 * HOUR }),
])
assert(twentyNine.length === 1 && twentyNine[0]?.ambiguous === false, '29 h je jeden jednoznačný interval')
assert(
  twentyNine[0]?.candidateFlags.atLeast9h === true &&
    twentyNine[0]?.candidateFlags.atLeast11h === true &&
    twentyNine[0]?.candidateFlags.atLeast24h === true &&
    twentyNine[0]?.candidateFlags.atLeast45h === false,
  '29 h má kandidáty 9, 11 a 24, ne 45',
)
assert(!('interpretation' in (twentyNine[0] ?? {})), '29 h nevybírá právní interpretaci')

const fortyFive = flagsOf(45)
assert(
  fortyFive?.atLeast9h === true &&
    fortyFive.atLeast11h === true &&
    fortyFive.atLeast24h === true &&
    fortyFive.atLeast45h === true,
  'přesně 45 h má všechny délkové kandidáty',
)

const unsorted = [
  activity({ id: 'b', kind: 'rest', startUtc: 5 * HOUR, endUtc: 11 * HOUR }),
  activity({ id: 'a', kind: 'rest', startUtc: 0, endUtc: 5 * HOUR }),
]
const unsortedResult = findRestIntervals(unsorted)
assert(unsorted[0]?.id === 'b' && unsorted[1]?.id === 'a', 'vstupní pořadí se nemění')
assert(unsortedResult.length === 1 && unsortedResult[0]?.sourceActivityIds.join() === 'a,b', 'neuspořádané navazující resty se spojí')

const slots = findRestIntervals([
  activity({ id: 's1', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR, slot: 1 }),
  activity({ id: 's2', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR, slot: 2 }),
])
assert(slots.length === 2, 'duplicitní rest slotu 1 a 2 zůstane ve dvou osách')
assert(slots.every((item) => item.ambiguous && item.uncertainties.includes('overlaps_rest_in_other_slot')), 'překryv slotů je nejednoznačný')
assert(slots.map((item) => item.slot).join() === '1,2', 'sloty se nesloučí do jednoho řidiče')

const crossDriving = findRestIntervals([
  activity({ id: 'r', kind: 'rest', startUtc: 0, endUtc: 9 * HOUR, slot: 1 }),
  activity({ id: 'd', kind: 'driving', startUtc: HOUR, endUtc: 2 * HOUR, slot: 2 }),
])
assert(crossDriving[0]?.ambiguous === true && crossDriving[0]?.overlappingNonRestKinds.join() === 'driving', 'rest slotu 1 překrytý řízením slotu 2 je nejednoznačný')

const manual = findRestIntervals([
  activity({ id: 'm', kind: 'rest', startUtc: 0, endUtc: 11 * HOUR, isManualEntry: true }),
])
assert(manual[0]?.ambiguous === false && manual[0]?.uncertainties.includes('manual_entry'), 'ruční rest zůstane intervalem a nese nejasnost manual_entry')

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nall checks passed')
