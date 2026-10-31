import { CardFileError } from '../lib/cardFile'

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

async function postBinary(url: string, bytes: Uint8Array): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('parser unreachable')
}

/**
 * Předá binární výpis karty do Go dddparser (tachoparser).
 * JSON výstup knihovny se parsuje přímo.
 * Binární .DDD/.ESM/.561 jde na /api/parse-card (Vite proxy na lokální Go službu).
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

  const parserUrl = import.meta.env.VITE_DDD_PARSER_URL ?? '/api/parse-card'

  let response: Response
  try {
    response = await postBinary(parserUrl, bytes)
  } catch {
    throw new CardFileError(
      'invalid',
      'Nepodařilo se spojit s parserem. Nechte běžet npm run dev (spouští Go službu tachoparser) nebo samostatně npm run parser.',
    )
  }

  if (!response.ok) {
    const detail = (await response.text()).trim()
    if (response.status >= 500 || /ECONNREFUSED|proxy error/i.test(detail)) {
      throw new CardFileError(
        'invalid',
        'Parser neběží. Zastavte Vite, v novém terminálu (bez GOOS=js) spusťte npm run dev a zkuste nahrání znovu.',
      )
    }
    throw new CardFileError(
      'invalid',
      detail || 'Parser dddparser soubor neodkódoval. Soubor není platný výpis karty řidiče, nebo jde o data z vozidlové jednotky (VU).',
    )
  }

  try {
    return await response.json()
  } catch {
    throw new CardFileError('invalid', 'Parser nevrátil platný JSON výstup.')
  }
}
