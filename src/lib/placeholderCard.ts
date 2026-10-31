import type { DriverCardData } from '../types/tacho'

export function driverDisplayName(card: DriverCardData): string {
  return [card.firstName, card.surname].filter(Boolean).join(' ')
}
