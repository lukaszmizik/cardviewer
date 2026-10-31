export const CARD_FILE_EXTENSIONS = ['.ddd', '.esm', '.561'] as const

export const MIN_CARD_FILE_BYTES = 256
export const MAX_CARD_FILE_BYTES = 2 * 1024 * 1024

export type CardFileErrorCode = 'extension' | 'empty' | 'too_small' | 'too_large' | 'invalid'

export class CardFileError extends Error {
  readonly code: CardFileErrorCode

  constructor(code: CardFileErrorCode, message: string) {
    super(message)
    this.name = 'CardFileError'
    this.code = code
  }
}

export function getFileExtension(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.561')) return '.561'
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}

export function isSupportedCardFileName(fileName: string): boolean {
  return (CARD_FILE_EXTENSIONS as readonly string[]).includes(getFileExtension(fileName))
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function isMostlyZero(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  let zeros = 0
  const sample = Math.min(bytes.length, 4096)
  for (let i = 0; i < sample; i += 1) {
    if (bytes[i] === 0) zeros += 1
  }
  return zeros / sample > 0.98
}

function looksLikeForeignFormat(bytes: Uint8Array): boolean {
  const head = decodeUtf8(bytes.slice(0, 16)).trimStart()
  if (head.startsWith('%PDF') || head.startsWith('PK') || head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
    return true
  }
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}

export function validateCardFile(file: File): void {
  if (!file || file.size === 0) {
    throw new CardFileError('empty', 'Soubor je prázdný. Vyberte výpis z karty řidiče a zkuste to znovu.')
  }

  if (!isSupportedCardFileName(file.name)) {
    throw new CardFileError(
      'extension',
      'Nepodporovaný formát. Použijte soubor s příponou .ddd, .esm nebo .561.',
    )
  }

  if (file.size < MIN_CARD_FILE_BYTES) {
    throw new CardFileError(
      'too_small',
      'Soubor je příliš malý a neodpovídá výpisu z karty řidiče. Minimální velikost je 256 B.',
    )
  }

  if (file.size > MAX_CARD_FILE_BYTES) {
    throw new CardFileError(
      'too_large',
      'Soubor je příliš velký. Maximální velikost výpisu z karty je 2 MB.',
    )
  }
}

export function validateCardBytes(bytes: Uint8Array): void {
  if (isMostlyZero(bytes) || looksLikeForeignFormat(bytes)) {
    throw new CardFileError(
      'invalid',
      'Obsah souboru není platný výpis z karty řidiče. Zkontrolujte, že jde o neupravený soubor z tachografu nebo čtečky.',
    )
  }
}

export const CARD_FILE_ACCEPT = '.ddd,.esm,.561,.DDD,.ESM,.561'
