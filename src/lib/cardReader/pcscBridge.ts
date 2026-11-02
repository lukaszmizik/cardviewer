import { CardReaderError, type CardReaderErrorCode } from './errors'

const PCSC_BASE = 'http://127.0.0.1:8787'

export type CardChannel = {
  transmit(apdu: Uint8Array): Promise<{ data: Uint8Array; sw1: number; sw2: number }>
  close(): Promise<void>
}

export async function pcscBridgeReady(): Promise<boolean> {
  try {
    const response = await fetch(`${PCSC_BASE}/health`, { signal: AbortSignal.timeout(700) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForBridge(ms: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await pcscBridgeReady()) return true
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return false
}

export async function ensurePcscBridge(): Promise<boolean> {
  if (await pcscBridgeReady()) return true
  return waitForBridge(12000)
}

/** Čtení přes ovladač Windows (PC/SC), stejnou cestou jako Datacho. */
export class PcscSession implements CardChannel {
  static async open(): Promise<PcscSession> {
    const response = await fetch(`${PCSC_BASE}/pcsc/open`, { method: 'POST' })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
      const code = (body?.error ?? 'open') as CardReaderErrorCode
      throw new CardReaderError(
        code === 'no_card' || code === 'blocked' || code === 'no_reader' || code === 'unsupported' ? code : 'open',
        body?.message || 'Čtečku se přes ovladač Windows nepodařilo otevřít.',
      )
    }
    return new PcscSession()
  }

  async transmit(apdu: Uint8Array): Promise<{ data: Uint8Array; sw1: number; sw2: number }> {
    const response = await fetch(`${PCSC_BASE}/pcsc/transmit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: apdu,
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
      const code = (body?.error ?? 'protocol') as CardReaderErrorCode
      throw new CardReaderError(
        code === 'no_card' || code === 'blocked' ? code : 'protocol',
        body?.message || 'Příkaz na kartu selhal.',
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length < 2) throw new CardReaderError('protocol', 'Karta vrátila neúplnou odpověď.')
    return {
      data: bytes.subarray(0, bytes.length - 2),
      sw1: bytes[bytes.length - 2]!,
      sw2: bytes[bytes.length - 1]!,
    }
  }

  async close(): Promise<void> {
    try {
      await fetch(`${PCSC_BASE}/pcsc/close`, { method: 'POST' })
    } catch {
      /* místní služba už neběží */
    }
  }
}
