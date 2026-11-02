import { CardReaderError } from './errors'
import { CcidSession } from './ccid'
import { ensurePcscBridge, pcscBridgeReady, PcscSession, type CardChannel } from './pcscBridge'

/** Gen1 „TACHO“, gen2 „SMRDT“ — AID podle přílohy 2 nařízení 2016/799. */
const AID_GEN1 = Uint8Array.of(0xff, 0x54, 0x41, 0x43, 0x48, 0x4f)
const AID_GEN2 = Uint8Array.of(0xff, 0x53, 0x4d, 0x52, 0x44, 0x54)

const SIG_GEN1 = 128
const SIG_GEN2 = 64
const MAX_EF_BYTES = 0xffff

type EfSpec = {
  fid: number
  /** 0 = celý soubor je data, jinak délka podpisu na konci EF. */
  signatureLength: number
  /** 0/1 gen1 data/podpis, 2/3 gen2 data/podpis. */
  dataAppendix: number
  sigAppendix: number
}

const MF_FILES: EfSpec[] = [
  { fid: 0x0002, signatureLength: 0, dataAppendix: 0x00, sigAppendix: 0x01 },
  { fid: 0x0005, signatureLength: 0, dataAppendix: 0x00, sigAppendix: 0x01 },
]

const GEN1_FILES: EfSpec[] = [
  ...signed(0x00, 0x01, SIG_GEN1, [0x0501, 0x0502, 0x0503, 0x0504, 0x0505, 0x0506, 0x0507, 0x0508, 0x050e, 0x0520, 0x0521, 0x0522]),
  ...plain(0x00, [0xc100, 0xc108]),
]

const GEN2_FILES: EfSpec[] = [
  ...signed(0x02, 0x03, SIG_GEN2, [
    0x0501, 0x0502, 0x0503, 0x0504, 0x0505, 0x0506, 0x0507, 0x0508, 0x050e, 0x0520, 0x0521, 0x0522, 0x0523, 0x0524, 0x0525,
    0x0526, 0x0527, 0x0528, 0x0529, 0x0530, 0x0540,
  ]),
  ...plain(0x02, [0xc101, 0xc108, 0xc109]),
]

function signed(dataAppendix: number, sigAppendix: number, signatureLength: number, fids: number[]): EfSpec[] {
  return fids.map((fid) => ({ fid, signatureLength, dataAppendix, sigAppendix }))
}

function plain(dataAppendix: number, fids: number[]): EfSpec[] {
  return fids.map((fid) => ({ fid, signatureLength: 0, dataAppendix, sigAppendix: dataAppendix + 1 }))
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function tlv(fid: number, appendix: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length)
  out[0] = (fid >> 8) & 0xff
  out[1] = fid & 0xff
  out[2] = appendix
  out[3] = (payload.length >> 8) & 0xff
  out[4] = payload.length & 0xff
  out.set(payload, 5)
  return out
}

function selectMasterFile(): Uint8Array {
  return Uint8Array.of(0x00, 0xa4, 0x00, 0x0c, 0x02, 0x3f, 0x00)
}

function selectAid(aid: Uint8Array): Uint8Array {
  const apdu = new Uint8Array(5 + aid.length)
  apdu[0] = 0x00
  apdu[1] = 0xa4
  apdu[2] = 0x04
  apdu[3] = 0x0c
  apdu[4] = aid.length
  apdu.set(aid, 5)
  return apdu
}

function selectEf(fid: number): Uint8Array {
  return Uint8Array.of(0x00, 0xa4, 0x02, 0x0c, 0x02, (fid >> 8) & 0xff, fid & 0xff)
}

function readBinary(offset: number, le: number): Uint8Array {
  const leByte = le >= 256 ? 0 : le
  if (offset <= 0x7fff) {
    return Uint8Array.of(0x00, 0xb0, (offset >> 8) & 0xff, offset & 0xff, leByte)
  }
  return Uint8Array.of(0x00, 0xb1, 0x00, 0x00, 0x04, 0x54, 0x02, (offset >> 8) & 0xff, offset & 0xff, leByte)
}

async function selectOk(session: CardChannel, apdu: Uint8Array): Promise<boolean> {
  const response = await session.transmit(apdu)
  return response.sw1 === 0x90 && response.sw2 === 0x00
}

async function readSelectedFile(session: CardChannel): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset < MAX_EF_BYTES) {
    const ask = Math.min(256, MAX_EF_BYTES - offset)
    let response = await session.transmit(readBinary(offset, ask))
    if (response.sw1 === 0x6c) {
      response = await session.transmit(readBinary(offset, response.sw2))
    }
    if (response.sw1 === 0x6b || (response.sw1 === 0x6a && response.sw2 === 0x86)) break
    if (response.sw1 === 0x62 && response.sw2 === 0x82) {
      if (response.data.length > 0) parts.push(response.data)
      break
    }
    if (response.sw1 !== 0x90 || response.sw2 !== 0x00) {
      throw new CardReaderError(
        'protocol',
        `Čtení souboru karty selhalo (SW ${response.sw1.toString(16)}${response.sw2.toString(16)}).`,
      )
    }
    if (response.data.length === 0) break
    parts.push(response.data)
    offset += response.data.length
    const expected = ask >= 256 ? 256 : ask
    if (response.data.length < expected) break
  }
  return concat(parts)
}

function blocksFromFile(spec: EfSpec, bytes: Uint8Array): Uint8Array[] {
  if (bytes.length === 0) return []
  if (spec.signatureLength <= 0 || bytes.length <= spec.signatureLength) {
    return [tlv(spec.fid, spec.dataAppendix, bytes)]
  }
  const data = bytes.subarray(0, bytes.length - spec.signatureLength)
  const signature = bytes.subarray(bytes.length - spec.signatureLength)
  return [tlv(spec.fid, spec.dataAppendix, data), tlv(spec.fid, spec.sigAppendix, signature)]
}

async function readFiles(session: CardChannel, files: EfSpec[], onFile: (fid: number) => void): Promise<Uint8Array[]> {
  const blocks: Uint8Array[] = []
  for (const spec of files) {
    onFile(spec.fid)
    const selected = await selectOk(session, selectEf(spec.fid))
    if (!selected) continue
    const bytes = await readSelectedFile(session)
    blocks.push(...blocksFromFile(spec, bytes))
  }
  return blocks
}

export type DownloadProgress = (message: string) => void

async function readDriverCard(session: CardChannel, onProgress?: DownloadProgress): Promise<Uint8Array> {
  try {
    onProgress?.('Reset karty (ATR)…')
    const blocks: Uint8Array[] = []

    onProgress?.('Čtu identifikaci čipu…')
    await selectOk(session, selectMasterFile())
    blocks.push(...(await readFiles(session, MF_FILES, () => undefined)))

    onProgress?.('Vybírám aplikaci tachografu…')
    const gen1 = await selectOk(session, selectAid(AID_GEN1))
    if (!gen1) {
      throw new CardReaderError('protocol', 'Na kartě není aplikace tachografu. Vložte kartu řidiče čipem napřed.')
    }
    blocks.push(...(await readFiles(session, GEN1_FILES, (fid) => onProgress?.(`Čtu soubor ${fid.toString(16).toUpperCase()}…`))))

    const gen2 = await selectOk(session, selectAid(AID_GEN2))
    if (gen2) {
      onProgress?.('Čtu datové struktury 2. generace…')
      blocks.push(...(await readFiles(session, GEN2_FILES, (fid) => onProgress?.(`Čtu soubor ${fid.toString(16).toUpperCase()}…`))))
    }

    const ddd = concat(blocks)
    if (ddd.length < 256) {
      throw new CardReaderError('empty', 'Z karty se nepodařilo přečíst dostatek dat pro výpis .DDD.')
    }
    return ddd
  } finally {
    await session.close()
  }
}

async function downloadViaWindowsDriver(onProgress?: DownloadProgress): Promise<Uint8Array> {
  onProgress?.('Připojuji čtečku přes ovladač Windows…')
  const session = await PcscSession.open()
  return readDriverCard(session, onProgress)
}

/** Složí výpis karty řidiče (TLV .DDD) včetně podpisů datových souborů. */
export async function downloadDriverCard(onProgress?: DownloadProgress): Promise<Uint8Array> {
  if (await pcscBridgeReady()) {
    return downloadViaWindowsDriver(onProgress)
  }

  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new CardReaderError(
      'unsupported',
      'Tento prohlížeč neumí WebUSB. Čtečku otevřete v Google Chrome nebo Microsoft Edge.',
    )
  }

  let device: USBDevice
  try {
    device = await navigator.usb.requestDevice({ filters: [{ classCode: 0x0b }] })
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : ''
    if (name === 'NotFoundError' || name === 'SecurityError' || name === 'AbortError') {
      throw new CardReaderError('denied', 'Přístup ke čtečce byl zrušen. Výběr zařízení potvrďte v okně prohlížeče.')
    }
    throw new CardReaderError('open', 'Čtečku se nepodařilo vybrat.')
  }

  onProgress?.('Otevírám čtečku…')
  let session: CcidSession | null = null
  try {
    session = await CcidSession.open(device)
    await session.powerOn()
    return await readDriverCard(session, onProgress)
  } catch (cause) {
    await session?.close()
    if (cause instanceof CardReaderError && (cause.code === 'blocked' || cause.code === 'open')) {
      onProgress?.('Ovladač Windows drží čtečku, přepínám na něj…')
      if (await ensurePcscBridge()) return downloadViaWindowsDriver(onProgress)
    }
    throw cause
  }
}
