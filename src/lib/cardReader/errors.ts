export type CardReaderErrorCode = 'unsupported' | 'denied' | 'open' | 'blocked' | 'no_card' | 'no_reader' | 'protocol' | 'empty'

export const USB_BLOCKED_MESSAGE =
  'Prohlížeč čtečku neotevře, protože ji drží ovladač Windows (Thales Smart Card). To není jiný program — Datacho může být vypnuté a přesto WebUSB kartu nedostane. Čtení proto běží přes stejný ovladač jako Datacho. Nechte spuštěné npm run dev (služba na portu 8787) a zkuste to znovu. Datacho při čtení nechte zavřené.'

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
