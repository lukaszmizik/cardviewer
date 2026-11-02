export type CardReaderErrorCode = 'unsupported' | 'denied' | 'open' | 'no_card' | 'protocol' | 'empty'

export class CardReaderError extends Error {
  readonly code: CardReaderErrorCode

  constructor(code: CardReaderErrorCode, message: string) {
    super(message)
    this.name = 'CardReaderError'
    this.code = code
  }
}
