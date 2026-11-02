export type CardReaderErrorCode = 'unsupported' | 'denied' | 'open' | 'blocked' | 'no_card' | 'protocol' | 'empty'

export const USB_BLOCKED_MESSAGE =
  'Rozhraní čtečky blokuje operační systém. Zkontrolujte ovladač WinUSB (ve Windows ho nastaví například Zadig) a ověřte, že je ve čtečce vložená čipová karta.'

export const NO_CARD_MESSAGE =
  'Ve čtečce není karta. Vložte kartu řidiče čipem napřed a čtení spusťte až potom.'

export class CardReaderError extends Error {
  readonly code: CardReaderErrorCode

  constructor(code: CardReaderErrorCode, message: string) {
    super(message)
    this.name = 'CardReaderError'
    this.code = code
  }
}
