import { CardReaderError, NO_CARD_MESSAGE, USB_BLOCKED_MESSAGE } from './errors'

const CCID_CLASS = 0x0b
const MSG_POWER_ON = 0x62
const MSG_SLOT_STATUS = 0x65
const MSG_XFR_BLOCK = 0x6f
const MSG_DATA_BLOCK = 0x80
const MSG_SLOT_STATUS_RESPONSE = 0x81
const ICC_ABSENT = 2
const CCID_ICC_MUTE = 0xfe

type ApduResponse = {
  data: Uint8Array
  sw1: number
  sw2: number
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

type CcidEndpoints = {
  configurationValue: number
  interfaceNumber: number
  alternateSetting: number
  bulkIn: number
  bulkOut: number
}

function isOsBlocked(cause: unknown): boolean {
  return cause instanceof DOMException && (cause.name === 'SecurityError' || cause.name === 'NetworkError')
}

function endpointsOf(configuration: USBConfiguration, iface: USBInterface, alternate: USBAlternateInterface): CcidEndpoints | null {
  const bulkIn = alternate.endpoints.find((endpoint) => endpoint.type === 'bulk' && endpoint.direction === 'in')
  const bulkOut = alternate.endpoints.find((endpoint) => endpoint.type === 'bulk' && endpoint.direction === 'out')
  if (!bulkIn || !bulkOut) return null
  return {
    configurationValue: configuration.configurationValue,
    interfaceNumber: iface.interfaceNumber,
    alternateSetting: alternate.alternateSetting,
    bulkIn: bulkIn.endpointNumber,
    bulkOut: bulkOut.endpointNumber,
  }
}

function isCcid(iface: USBInterface): boolean {
  return iface.alternates.some((alternate) => alternate.interfaceClass === CCID_CLASS)
}

/** Nejdřív CCID, potom rozhraní 0 a 1, pak zbytek. */
function interfacesToClaim(configuration: USBConfiguration): USBInterface[] {
  const all = configuration.interfaces
  const ccid = all.filter((iface) => isCcid(iface))
  const slot01 = all.filter((iface) => (iface.interfaceNumber === 0 || iface.interfaceNumber === 1) && !ccid.includes(iface))
  const rest = all.filter((iface) => !ccid.includes(iface) && !slot01.includes(iface))
  return [...ccid, ...slot01, ...rest]
}

function endpointsForInterface(configuration: USBConfiguration, iface: USBInterface): CcidEndpoints | null {
  const alternates = [...iface.alternates].sort((a, b) => Number(b.interfaceClass === CCID_CLASS) - Number(a.interfaceClass === CCID_CLASS))
  for (const alternate of alternates) {
    const endpoints = endpointsOf(configuration, iface, alternate)
    if (endpoints) return endpoints
  }
  return null
}

async function ensureConfiguration(device: USBDevice): Promise<void> {
  if (device.configuration != null) return
  try {
    await device.selectConfiguration(1)
  } catch (cause) {
    if (isOsBlocked(cause)) throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
    const fallback = device.configurations[0]?.configurationValue
    if (fallback == null || fallback === 1) {
      throw new CardReaderError('open', 'U čtečky se nepodařilo vybrat USB konfiguraci.')
    }
    await device.selectConfiguration(fallback)
  }
}

async function selectConfigurationWithCcid(device: USBDevice): Promise<void> {
  await ensureConfiguration(device)
  const active = device.configuration
  if (active?.interfaces.some((iface) => isCcid(iface))) return
  const ccidConfiguration = device.configurations.find((configuration) => configuration.interfaces.some((iface) => isCcid(iface)))
  if (!ccidConfiguration || ccidConfiguration.configurationValue === active?.configurationValue) return
  await device.selectConfiguration(ccidConfiguration.configurationValue)
}

/**
 * Postupně zabere rozhraní aktivní konfigurace. Vrátí to, na kterém claimInterface uspěje.
 */
async function claimWorkingInterface(device: USBDevice): Promise<CcidEndpoints> {
  const configuration = device.configuration
  if (!configuration) throw new CardReaderError('open', 'Čtečka nemá vybranou USB konfiguraci.')

  let sawBlocked = false
  for (const iface of interfacesToClaim(configuration)) {
    try {
      if (!iface.claimed) await device.claimInterface(iface.interfaceNumber)
    } catch (cause) {
      if (isOsBlocked(cause)) sawBlocked = true
      continue
    }

    const endpoints = endpointsForInterface(configuration, iface)
    if (!endpoints) {
      try {
        await device.releaseInterface(iface.interfaceNumber)
      } catch {
        /* rozhraní bez bulk konců pustíme dál */
      }
      continue
    }
    if (endpoints.alternateSetting !== 0) {
      await device.selectAlternateInterface(iface.interfaceNumber, endpoints.alternateSetting)
    }
    return endpoints
  }

  if (sawBlocked) throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
  throw new CardReaderError('open', 'Žádné rozhraní čtečky se nepodařilo zabrat.')
}

type CcidMessage = {
  type: number
  status: number
  error: number
  chain: number
  data: Uint8Array
}

/**
 * CCID přes WebUSB: napájení karty (ATR) a přenos APDU (ISO 7816-4).
 */
export class CcidSession {
  private seq = 0
  private readonly slot = 0

  private constructor(
    private readonly device: USBDevice,
    private readonly endpoints: CcidEndpoints,
  ) {}

  static async open(device: USBDevice): Promise<CcidSession> {
    try {
      await device.open()
    } catch (cause) {
      if (isOsBlocked(cause)) throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
      throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
    }

    let endpoints: CcidEndpoints | null = null
    try {
      await selectConfigurationWithCcid(device)
      try {
        endpoints = await claimWorkingInterface(device)
      } catch (cause) {
        if (cause instanceof CardReaderError && cause.code !== 'blocked' && cause.code !== 'open') throw cause
        await device.reset()
        await selectConfigurationWithCcid(device)
        endpoints = await claimWorkingInterface(device)
      }
      return new CcidSession(device, endpoints)
    } catch (cause) {
      if (endpoints) {
        const iface = device.configuration?.interfaces.find((item) => item.interfaceNumber === endpoints?.interfaceNumber)
        if (iface?.claimed) {
          try {
            await device.releaseInterface(endpoints.interfaceNumber)
          } catch {
            /* rozhraní už není zabrané */
          }
        }
      }
      try {
        await device.close()
      } catch {
        /* zařízení už je zavřené */
      }
      if (cause instanceof CardReaderError) throw cause
      if (isOsBlocked(cause)) throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
      throw new CardReaderError('open', 'Rozhraní čtečky se nepodařilo zabrat.')
    }
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.endpoints.interfaceNumber)
    } catch {
      /* rozhraní už není zabrané */
    }
    try {
      await this.device.close()
    } catch {
      /* zavření selhalo */
    }
  }

  async powerOn(): Promise<Uint8Array> {
    await this.assertCardPresent()
    const atr = await this.transfer(MSG_POWER_ON, new Uint8Array(0), [0, 0, 0])
    if (atr.length === 0) throw new CardReaderError('no_card', NO_CARD_MESSAGE)
    return atr
  }

  async transmit(apdu: Uint8Array): Promise<ApduResponse> {
    let response = await this.transfer(MSG_XFR_BLOCK, apdu, [0, 0, 0])
    let guard = 0
    while (response.length >= 2 && response[response.length - 2] === 0x61 && guard < 8) {
      const more = await this.transfer(MSG_XFR_BLOCK, Uint8Array.of(0x00, 0xc0, 0x00, 0x00, response[response.length - 1]!), [0, 0, 0])
      response = concat([response.subarray(0, response.length - 2), more])
      guard += 1
    }
    if (response.length < 2) {
      throw new CardReaderError('protocol', 'Karta vrátila neúplnou odpověď APDU.')
    }
    return {
      data: response.subarray(0, response.length - 2),
      sw1: response[response.length - 2]!,
      sw2: response[response.length - 1]!,
    }
  }

  private async assertCardPresent(): Promise<void> {
    try {
      const status = await this.exchange(MSG_SLOT_STATUS, new Uint8Array(0), [0, 0, 0], [MSG_SLOT_STATUS_RESPONSE, MSG_DATA_BLOCK])
      if ((status.status & 0x03) === ICC_ABSENT) throw new CardReaderError('no_card', NO_CARD_MESSAGE)
    } catch (cause) {
      if (cause instanceof CardReaderError && (cause.code === 'no_card' || cause.code === 'blocked')) throw cause
    }
  }

  private async transfer(type: number, payload: Uint8Array, extra: [number, number, number]): Promise<Uint8Array> {
    const message = await this.exchange(type, payload, extra, [MSG_DATA_BLOCK])
    return message.data
  }

  private async exchange(
    type: number,
    payload: Uint8Array,
    extra: [number, number, number],
    acceptedTypes: number[],
  ): Promise<CcidMessage> {
    const seq = this.seq & 0xff
    this.seq = (this.seq + 1) & 0xff
    const message = new Uint8Array(10 + payload.length)
    const header = new DataView(message.buffer)
    message[0] = type
    header.setUint32(1, payload.length, true)
    message[5] = this.slot
    message[6] = seq
    message[7] = extra[0]
    message[8] = extra[1]
    message[9] = extra[2]
    message.set(payload, 10)

    let sent: USBOutTransferResult
    try {
      sent = await this.device.transferOut(this.endpoints.bulkOut, message)
    } catch (cause) {
      if (isOsBlocked(cause)) throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
      throw new CardReaderError('protocol', 'Odeslání příkazu do čtečky selhalo.')
    }
    if (sent.status !== 'ok') {
      throw new CardReaderError('protocol', 'Odeslání příkazu do čtečky selhalo.')
    }

    const parts: Uint8Array[] = []
    let last: CcidMessage | null = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const incoming = await this.readMessage()
      last = incoming
      const commandStatus = (incoming.status >> 6) & 0x03
      if (commandStatus === 2) continue
      if (commandStatus === 1 || incoming.error === CCID_ICC_MUTE) {
        if (incoming.error === CCID_ICC_MUTE || (incoming.status & 0x03) === ICC_ABSENT) {
          throw new CardReaderError('no_card', NO_CARD_MESSAGE)
        }
        throw new CardReaderError(
          'protocol',
          `Čtečka odmítla příkaz (CCID 0x${incoming.error.toString(16).padStart(2, '0')}).`,
        )
      }
      if (!acceptedTypes.includes(incoming.type)) {
        throw new CardReaderError('protocol', 'Čtečka vrátila neočekávaný typ zprávy.')
      }
      parts.push(incoming.data)
      if (incoming.chain === 0 || incoming.chain === 2 || incoming.chain === 0x10) break
    }
    if (!last) throw new CardReaderError('protocol', 'Čtečka neodpověděla.')
    return { ...last, data: concat(parts) }
  }

  private async readMessage(): Promise<CcidMessage> {
    let result: USBInTransferResult
    try {
      result = await this.device.transferIn(this.endpoints.bulkIn, 10 + 65536)
    } catch (cause) {
      if (isOsBlocked(cause)) throw new CardReaderError('blocked', USB_BLOCKED_MESSAGE)
      throw new CardReaderError('protocol', 'Čtečka neodpověděla.')
    }
    if (result.status !== 'ok' || !result.data || result.data.byteLength < 10) {
      throw new CardReaderError('protocol', 'Čtečka neodpověděla.')
    }
    const view = result.data
    const length = view.getUint32(1, true)
    if (10 + length > view.byteLength) {
      throw new CardReaderError('protocol', 'Odpověď čtečky je kratší, než udává hlavička.')
    }
    const data = new Uint8Array(length)
    data.set(new Uint8Array(view.buffer, view.byteOffset + 10, length))
    return {
      type: view.getUint8(0),
      status: view.getUint8(7),
      error: view.getUint8(8),
      chain: view.getUint8(9),
      data,
    }
  }
}
