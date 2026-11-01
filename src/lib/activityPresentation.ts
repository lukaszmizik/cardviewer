import { DRIVING_SYMBOL } from '../CardLogic'
import type { ActivityType, DayData, ParsedActivity } from '../workWeekTxtParser'

const LONG_REST_MIN = 24 * 60
const WEEKLY_REST_MIN = 45 * 60

export const ACTIVITY_SYMBOL: Record<ActivityType, string> = {
  řízení: DRIVING_SYMBOL,
  práce: '\u005a',
  pohotovost: '\u0058',
  odpočinek: '\u0059',
  'odpočinek>24h': '\u0059',
  'odpočinek>45h': '\u0059',
  neznámá: '?',
}

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  řízení: 'řízení',
  práce: 'práce',
  pohotovost: 'pohotovost',
  odpočinek: 'odpočinek',
  'odpočinek>24h': 'odpoč. 24h–45h',
  'odpočinek>45h': 'odpoč. ≥45h',
  neznámá: 'neznámá',
}

export function formatActivityDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

export function getActivityDisplayColor(act: ParsedActivity): string {
  if (act.type === 'řízení') return '#c41e3a'
  if (act.type === 'práce') return '#c9a227'
  if (act.type === 'pohotovost') return '#d4738a'
  if (act.type === 'odpočinek' || act.type === 'odpočinek>24h' || act.type === 'odpočinek>45h') {
    const minutes = act.originalDurationMinutes ?? act.durationMinutes
    if (minutes >= WEEKLY_REST_MIN) return '#2563eb'
    if (minutes >= LONG_REST_MIN) return '#60a5fa'
    return '#2d7d3e'
  }
  return '#888'
}

function activityLayer(act: ParsedActivity): number {
  return act.isManualEntry || act.type === 'neznámá' ? 0 : act.slot ?? 1
}

/** Aktivita nahoře v grafu (stejná vrstva jako vykreslení). */
export function findTopActivityAt(day: DayData, ms: number): ParsedActivity | undefined {
  const matches = day.activities.filter((act) => ms >= act.startMs && ms < act.endMs)
  if (matches.length === 0) return undefined
  return matches.sort((a, b) => activityLayer(a) - activityLayer(b) || a.startMs - b.startMs)[matches.length - 1]
}
