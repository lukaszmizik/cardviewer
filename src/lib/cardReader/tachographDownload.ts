import { CardReaderError, PCSC_UNAVAILABLE_MESSAGE } from './errors'
import { CcidSession } from './ccid'
import { ensurePcscBridge, pcscBridgeReady, PcscSession, type CardChannel } from './pcscBridge'
import { UsbTrace, describeUsbDevice, formatCause } from './usbTrace'

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

async function readSelectedFile(session: CardChannel): Promise<{ bytes: Uint8Array; denied: boolean }> {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset < MAX_EF_BYTES) {
    const ask = Math.min(256, MAX_EF_BYTES - offset)
    let response = await session.transmit(readBinary(offset, ask))
    if (response.sw1 === 0x6c) {
      response = await session.transmit(readBinary(offset, response.sw2))
    }
    if (response.sw1 === 0x69 && response.sw2 === 0x82 && parts.length === 0) {
      return { bytes: new Uint8Array(), denied: true }
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
  return { bytes: concat(parts), denied: false }
}

function blocksFromFile(spec: EfSpec, bytes: Uint8Array): Uint8Array[] {
  if (bytes.length === 0) return []
  // Soubor na kartě obsahuje jen data. Podpis je v DDD samostatný záznam a karta ho
  // přes READ BINARY nevrací. Uříznutí konce souboru ničí jméno, poslední místa a GPS.
  if (spec.signatureLength > 0) {
    console.info(
      `[card-reader] soubor ${fileLabel(spec.fid)} ${bytes.length} B dat, podpis karta neposkytla a do DDD se nedoplní`,
    )
  }
  return [tlv(spec.fid, spec.dataAppendix, bytes)]
}

function fileLabel(fid: number): string {
  return fid.toString(16).toUpperCase().padStart(4, '0')
}

const FILE_TITLES: Record<number, string> = {
  0x0002: 'Identifikace čipu',
  0x0005: 'Informace o kartě',
  0x0501: 'Identifikace řidiče',
  0x0502: 'Řidičský průkaz',
  0x0503: 'Události',
  0x0504: 'Závady',
  0x0505: 'Činnosti řidiče',
  0x0506: 'Použitá vozidla',
  0x0507: 'Místa začátku a konce směny',
  0x0508: 'Stav počítadla kilometrů',
  0x050e: 'Kalibrace a nastavení',
  0x0520: 'Poslední stažení',
  0x0521: 'Předchozí stažení',
  0x0522: 'Specifické podmínky',
  0x0523: 'Hranice',
  0x0524: 'Nakládky a vykládky',
  0x0525: 'Záznamy GNSS',
  0x0526: 'Doplňkové GNSS',
  0x0527: 'Doplňkové aktivity',
  0x0528: 'Doplňková vozidla',
  0x0529: 'Doplňková místa',
  0x0530: 'Autentizace GNSS',
  0x0540: 'Doplňkové události',
  0xc100: 'Stav aplikace 1. generace',
  0xc101: 'Stav aplikace 2. generace',
  0xc108: 'Certifikát karty',
  0xc109: 'Certifikát karty 2. generace',
}

function fileTitle(fid: number): string {
  return FILE_TITLES[fid] ?? `Soubor ${fileLabel(fid)}`
}

function noteMissing(missingFiles: string[] | undefined, fid: number, reason: string) {
  const label = fileLabel(fid)
  console.info(`[card-reader] soubor ${label} nebyl načten (${reason}), do DDD se nedoplní`)
  missingFiles?.push(label)
}

async function readFiles(
  session: CardChannel,
  files: EfSpec[],
  onFile: (fid: number) => void,
  missingFiles?: string[],
): Promise<Uint8Array[]> {
  const blocks: Uint8Array[] = []
  for (const spec of files) {
    onFile(spec.fid)
    const selected = await selectOk(session, selectEf(spec.fid))
    if (!selected) {
      noteMissing(missingFiles, spec.fid, 'výběr souboru selhal')
      continue
    }
    const read = await readSelectedFile(session)
    if (read.bytes.length === 0) {
      noteMissing(
        missingFiles,
        spec.fid,
        read.denied ? 'SW 6982, bez autentizace karty nedostupné' : 'karta nevrátila data',
      )
      continue
    }
    blocks.push(...blocksFromFile(spec, read.bytes))
  }
  return blocks
}

export type DownloadProgressInfo = {
  message: string
  current: number
  total: number
  fileId?: string
}

export type DownloadProgress = (info: DownloadProgressInfo) => void

const SETUP_STEPS = 4
const DECODE_STEPS = 1

function report(onProgress: DownloadProgress | undefined, current: number, total: number, message: string, fileId?: string) {
  onProgress?.({ message, current, total, fileId })
}

async function readDriverCard(session: CardChannel, onProgress?: DownloadProgress, missingFiles?: string[]): Promise<Uint8Array> {
  let total = SETUP_STEPS + MF_FILES.length + GEN1_FILES.length + DECODE_STEPS
  let current = 0
  const next = (message: string, fileId?: string) => {
    current += 1
    report(onProgress, current, total, message, fileId)
  }

  try {
    next('Resetuji kartu a čtu ATR…')
    const blocks: Uint8Array[] = []

    next('Vybírám hlavní soubor karty…')
    await selectOk(session, selectMasterFile())
    blocks.push(
      ...(await readFiles(
        session,
        MF_FILES,
        (fid) => next(`${fileTitle(fid)} (${fileLabel(fid)})`, fileLabel(fid)),
        missingFiles,
      )),
    )

    next('Vybírám aplikaci tachografu…')
    const gen1 = await selectOk(session, selectAid(AID_GEN1))
    if (!gen1) {
      throw new CardReaderError('protocol', 'Na kartě není aplikace tachografu. Vložte kartu řidiče čipem napřed.')
    }
    blocks.push(
      ...(await readFiles(
        session,
        GEN1_FILES,
        (fid) => next(`${fileTitle(fid)} (${fileLabel(fid)})`, fileLabel(fid)),
        missingFiles,
      )),
    )

    next('Ověřuji datové struktury 2. generace…')
    const gen2 = await selectOk(session, selectAid(AID_GEN2))
    if (gen2) {
      total += GEN2_FILES.length
      report(onProgress, current, total, 'Čtu datové struktury 2. generace…')
      blocks.push(
        ...(await readFiles(
          session,
          GEN2_FILES,
          (fid) => next(`${fileTitle(fid)} (${fileLabel(fid)})`, fileLabel(fid)),
          missingFiles,
        )),
      )
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

function hostIsWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent)
}

function logPath(path: 'PC/SC' | 'WebUSB', detail: string) {
  console.info(`[card-reader] cesta=${path} — ${detail}`)
}

async function downloadViaWindowsDriver(onProgress?: DownloadProgress, missingFiles?: string[]): Promise<Uint8Array> {
  logPath('PC/SC', 'winscard.dll přes službu http://127.0.0.1:8787')
  report(onProgress, 0, SETUP_STEPS + MF_FILES.length + GEN1_FILES.length + DECODE_STEPS, 'Připojuji čtečku přes systémovou službu…')
  const session = await PcscSession.open()
  return readDriverCard(session, onProgress, missingFiles)
}

/** Složí výpis karty řidiče (TLV .DDD) včetně podpisů datových souborů. */
export async function downloadDriverCard(onProgress?: DownloadProgress, missingFiles?: string[]): Promise<Uint8Array> {
  if (hostIsWindows()) {
    logPath('PC/SC', 'Windows, WebUSB se nepoužije')
    const ready = (await pcscBridgeReady()) || (await ensurePcscBridge())
    if (!ready) {
      console.error('[card-reader] cesta=PC/SC nedostupná, přechod na WebUSB je na Windows vypnutý')
      throw new CardReaderError('unsupported', PCSC_UNAVAILABLE_MESSAGE)
    }
    return downloadViaWindowsDriver(onProgress, missingFiles)
  }

  if (await pcscBridgeReady()) {
    logPath('PC/SC', 'místní služba je dostupná')
    return downloadViaWindowsDriver(onProgress, missingFiles)
  }

  logPath('WebUSB', 'mimo Windows a PC/SC služba neběží')
  const trace = new UsbTrace()
  trace.ok(
    'platform',
    `ua=${navigator.userAgent} platform=${navigator.platform} usb=${typeof navigator.usb === 'object'}`,
  )

  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new CardReaderError(
      'unsupported',
      'Tento prohlížeč neumí WebUSB. Čtečku otevřete v Google Chrome nebo Microsoft Edge.',
      trace.toText(),
    )
  }

  let device: USBDevice
  try {
    device = await navigator.usb.requestDevice({ filters: [{ classCode: 0x0b }] })
    trace.ok('requestDevice', describeUsbDevice(device))
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : ''
    trace.fail('requestDevice', cause)
    if (name === 'NotFoundError' || name === 'SecurityError' || name === 'AbortError') {
      throw new CardReaderError(
        'denied',
        'Přístup ke čtečce byl zrušen. Výběr zařízení potvrďte v okně prohlížeče.',
        trace.toText(),
      )
    }
    throw new CardReaderError('open', 'Čtečku se nepodařilo vybrat.', trace.toText())
  }

  report(onProgress, 0, SETUP_STEPS + MF_FILES.length + GEN1_FILES.length + DECODE_STEPS, 'Otevírám čtečku…')
  let session: CcidSession | null = null
  try {
    session = await CcidSession.open(device, trace)
    report(onProgress, 0, SETUP_STEPS + MF_FILES.length + GEN1_FILES.length + DECODE_STEPS, 'Napájím kartu…')
    const atr = await session.powerOn()
    trace.ok('powerOn', `ATR ${atr.length} B`)
    const bytes = await readDriverCard(session, onProgress, missingFiles)
    trace.ok('readDriverCard', `${bytes.length} B`)
    return bytes
  } catch (cause) {
    await session?.close()
    const withTrace =
      cause instanceof CardReaderError
        ? new CardReaderError(cause.code, cause.message, [trace.toText(), cause.diagnostic].filter(Boolean).join('\n\n'))
        : new CardReaderError('open', 'Kartu se nepodařilo načíst.', `${trace.toText()}\n\n${formatCause(cause)}`)
    if (withTrace.code === 'blocked' || withTrace.code === 'open') {
      report(onProgress, 0, SETUP_STEPS + MF_FILES.length + GEN1_FILES.length + DECODE_STEPS, 'Prohlížeč k čtečce nepustil, zkouším systémovou službu…')
      if (await ensurePcscBridge()) {
        logPath('PC/SC', 'WebUSB selhalo, místní služba naběhla')
        return downloadViaWindowsDriver(onProgress, missingFiles)
      }
    }
    throw withTrace
  }
}
