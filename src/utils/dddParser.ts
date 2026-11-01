import { CardFileError } from '../lib/cardFile'
import { loadDddParser, parseCardInBrowser } from './dddWasm'

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function looksLikeJson(bytes: Uint8Array): boolean {
  let i = 0
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i += 1
  }
  return bytes[i] === 0x7b || bytes[i] === 0x5b
}

/**
 * Binární výpis karty dekóduje Go tachoparser zkompilovaný do WebAssembly v prohlížeči.
 */
export async function parseDddBinary(data: ArrayBuffer | Uint8Array): Promise<unknown> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

  if (looksLikeJson(bytes)) {
    try {
      return JSON.parse(decodeUtf8(bytes))
    } catch {
      throw new CardFileError(
        'invalid',
        'Soubor se tváří jako JSON výstup dddparser, ale nejde ho zpracovat.',
      )
    }
  }

  try {
    await loadDddParser()
    return parseCardInBrowser(bytes)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : ''
    throw new CardFileError(
      'invalid',
      detail || 'Parser v prohlížeči soubor neodkódoval. Soubor není platný výpis karty řidiče, nebo jde o data z vozidlové jednotky (VU).',
    )
  }
}
