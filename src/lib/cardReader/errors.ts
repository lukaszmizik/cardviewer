export type CardReaderErrorCode = 'unsupported' | 'denied' | 'open' | 'blocked' | 'no_card' | 'no_reader' | 'protocol' | 'empty'

export const PCSC_UNAVAILABLE_MESSAGE =
  'Na tomto počítači se karta čte přes systémovou službu čtečky (PC/SC). Služba na adrese 127.0.0.1:8787 nyní neběží, proto se čtení nespustilo. Spusťte aplikaci včetně místní služby a akci zopakujte. Ostatní programy, které čtečku používají, před čtením ukončete.'

export const USB_BLOCKED_MESSAGE =
  'Prohlížeč čtečku rozpoznal, ale z bezpečnostních důvodů k ní webové stránce přístup nepovolil. V telefonu kartu stáhněte na počítači a soubor sem nahrajte.'

export const NO_CARD_MESSAGE =
  'Ve čtečce není karta. Vložte kartu řidiče čipem napřed a čtení spusťte až potom.'

export class CardReaderError extends Error {
  readonly code: CardReaderErrorCode
  readonly diagnostic?: string

  constructor(code: CardReaderErrorCode, message: string, diagnostic?: string) {
    super(message)
    this.name = 'CardReaderError'
    this.code = code
    this.diagnostic = diagnostic
  }
}
