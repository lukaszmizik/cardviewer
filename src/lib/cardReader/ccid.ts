import { CardReaderError, NO_CARD_MESSAGE, USB_BLOCKED_MESSAGE } from './errors'
import { UsbTrace, describeUsbDevice, formatCause } from './usbTrace'

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

function failOpen(trace: UsbTrace | undefined, step: string, code: 'blocked' | 'open', message: string, cause?: unknown): never {
  if (cause != null) trace?.fail(step, cause)
  else trace?.note(step, 'fail', message)
  throw new CardReaderError(code, message, trace?.toText())
}

async function ensureConfiguration(device: USBDevice, trace?: UsbTrace): Promise<void> {
  if (device.configuration != null) {
    trace?.ok(
      'selectConfiguration',
      `už vybraná konfigurace ${device.configuration.configurationValue}`,
    )
    return
  }
  try {
    await device.selectConfiguration(1)
    trace?.ok('selectConfiguration', 'vybrána konfigurace 1')
  } catch (cause) {
    const fallback = device.configurations[0]?.configurationValue
    if (isOsBlocked(cause) && (fallback == null || fallback === 1)) {
      failOpen(trace, 'selectConfiguration', 'blocked', USB_BLOCKED_MESSAGE, cause)
    }
    if (fallback == null || fallback === 1) {
      failOpen(trace, 'selectConfiguration', 'open', 'U čtečky se nepodařilo vybrat USB konfiguraci.', cause)
    }
    try {
      await device.selectConfiguration(fallback)
      trace?.ok('selectConfiguration', `konfigurace 1 selhala (${formatCause(cause)}), použita ${fallback}`)
    } catch (fallbackCause) {
      failOpen(trace, 'selectConfiguration', isOsBlocked(fallbackCause) ? 'blocked' : 'open', USB_BLOCKED_MESSAGE, fallbackCause)
    }
  }
}

async function selectConfigurationWithCcid(device: USBDevice, trace?: UsbTrace): Promise<void> {
  await ensureConfiguration(device, trace)
  const active = device.configuration
  if (active?.interfaces.some((iface) => isCcid(iface))) {
    trace?.ok('ccidConfiguration', `CCID je v aktivní konfiguraci ${active.configurationValue}`)
    return
  }
  const ccidConfiguration = device.configurations.find((configuration) => configuration.interfaces.some((iface) => isCcid(iface)))
  if (!ccidConfiguration || ccidConfiguration.configurationValue === active?.configurationValue) {
    trace?.skip(
      'ccidConfiguration',
      ccidConfiguration
        ? 'aktivní konfigurace už byla vybrána'
        : 'žádná konfigurace nemá interfaceClass 0x0b',
    )
    return
  }
  try {
    await device.selectConfiguration(ccidConfiguration.configurationValue)
    trace?.ok('ccidConfiguration', `přepnuto na konfiguraci ${ccidConfiguration.configurationValue} s CCID`)
  } catch (cause) {
    failOpen(trace, 'ccidConfiguration', isOsBlocked(cause) ? 'blocked' : 'open', USB_BLOCKED_MESSAGE, cause)
  }
}

/**
 * Postupně zabere rozhraní aktivní konfigurace. Vrátí to, na kterém claimInterface uspěje.
 */
async function claimWorkingInterface(device: USBDevice, trace?: UsbTrace): Promise<CcidEndpoints> {
  const configuration = device.configuration
  if (!configuration) failOpen(trace, 'claimInterface', 'open', 'Čtečka nemá vybranou USB konfiguraci.')

  let firstBlocked: unknown
  const order = interfacesToClaim(configuration)
  trace?.ok(
    'interfaces',
    `pořadí pokusu: ${order.map((iface) => iface.interfaceNumber).join(', ') || '(žádné)'}`,
  )
  for (const iface of order) {
    const label = `claimInterface(${iface.interfaceNumber})`
    try {
      if (!iface.claimed) await device.claimInterface(iface.interfaceNumber)
      trace?.ok(label, `claimed=${iface.claimed}`)
    } catch (cause) {
      trace?.fail(label, cause)
      firstBlocked ??= cause
      continue
    }

    const endpoints = endpointsForInterface(configuration, iface)
    if (!endpoints) {
      trace?.skip(`endpoints interface ${iface.interfaceNumber}`, 'chybí bulk IN nebo bulk OUT')
      try {
        await device.releaseInterface(iface.interfaceNumber)
      } catch {
        /* rozhraní bez bulk konců pustíme dál */
      }
      continue
    }
    trace?.ok(
      `endpoints interface ${iface.interfaceNumber}`,
      `alt=${endpoints.alternateSetting} bulkIn=${endpoints.bulkIn} bulkOut=${endpoints.bulkOut}`,
    )
    if (endpoints.alternateSetting !== 0) {
      try {
        await device.selectAlternateInterface(iface.interfaceNumber, endpoints.alternateSetting)
        trace?.ok(
          `selectAlternateInterface(${iface.interfaceNumber}, ${endpoints.alternateSetting})`,
          'ok',
        )
      } catch (cause) {
        failOpen(trace, `selectAlternateInterface(${iface.interfaceNumber})`, isOsBlocked(cause) ? 'blocked' : 'open', USB_BLOCKED_MESSAGE, cause)
      }
    }
    return endpoints
  }

  if (firstBlocked != null) {
    failOpen(trace, 'claimInterface', 'blocked', USB_BLOCKED_MESSAGE, firstBlocked)
  }
  failOpen(trace, 'claimInterface', 'open', 'Žádné rozhraní čtečky se nepodařilo zabrat.')
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

  static async open(device: USBDevice, trace?: UsbTrace): Promise<CcidSession> {
    try {
      await device.open()
      trace?.ok('device.open', `opened=${device.opened}`)
    } catch (cause) {
      failOpen(trace, 'device.open', 'blocked', USB_BLOCKED_MESSAGE, cause)
    }

    let endpoints: CcidEndpoints | null = null
    try {
      await selectConfigurationWithCcid(device, trace)
      try {
        endpoints = await claimWorkingInterface(device, trace)
      } catch (cause) {
        if (cause instanceof CardReaderError && cause.code !== 'blocked' && cause.code !== 'open') throw cause
        trace?.note(
          'device.reset',
          'skip',
          `první claim selhal, zkouším reset zařízení (${cause instanceof Error ? cause.message : String(cause)})`,
        )
        try {
          await device.reset()
          trace?.ok('device.reset', 'reset dokončen')
        } catch (resetCause) {
          trace?.fail('device.reset', resetCause)
          throw cause
        }
        await selectConfigurationWithCcid(device, trace)
        endpoints = await claimWorkingInterface(device, trace)
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
      failOpen(trace, 'CcidSession.open', isOsBlocked(cause) ? 'blocked' : 'open', USB_BLOCKED_MESSAGE, cause)
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
      throw new CardReaderError(
        isOsBlocked(cause) ? 'blocked' : 'protocol',
        isOsBlocked(cause) ? USB_BLOCKED_MESSAGE : 'Odeslání příkazu do čtečky selhalo.',
        `transferOut ep=${this.endpoints.bulkOut}\n${formatCause(cause)}`,
      )
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
      throw new CardReaderError(
        isOsBlocked(cause) ? 'blocked' : 'protocol',
        isOsBlocked(cause) ? USB_BLOCKED_MESSAGE : 'Čtečka neodpověděla.',
        `transferIn ep=${this.endpoints.bulkIn}\n${formatCause(cause)}`,
      )
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
