import type { ManualEntrySegment } from './TachoTypes'

export const DRIVING_SYMBOL = '\u0053'

export function segmentToMsUtc(s: ManualEntrySegment): number {
  return Date.UTC(s.year, s.month - 1, s.day, s.hour, s.minute)
}
