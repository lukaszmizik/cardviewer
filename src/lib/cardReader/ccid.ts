import { CardReaderError } from './errors'

const CCID_CLASS = 0x0b
const MSG_POWER_ON = 0x62
const MSG_XFR_BLOCK = 0x6f
const MSG_DATA_BLOCK = 0x80

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

function findCcidEndpoints(device: USBDevice): CcidEndpoints {
  for (const configuration of device.configurations) {
    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        if (alternate.interfaceClass !== CCID_CLASS) continue
        const bulkIn = alternate.endpoints.find((endpoint) => endpoint.type === 'bulk' && endpoint.direction === 'in')
        const bulkOut = alternate.endpoints.find((endpoint) => endpoint.type === 'bulk' && endpoint.direction === 'out')
        if (!bulkIn || !bulkOut) continue
        return {
          configurationValue: configuration.configurationValue,
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          bulkIn: bulkIn.endpointNumber,
          bulkOut: bulkOut.endpointNumber,
        }
      }
    }
  }
  throw new CardReaderError('open', 'Připojené zařízení nemá CCID rozhraní pro čipové karty.')
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
    const endpoints = findCcidEndpoints(device)
    try {
      await device.open()
    } catch {
      throw new CardReaderError('open', 'Čtečku se nepodařilo otevřít. Zavřete jiný program, který ji používá, a zkuste to znovu.')
    }
    try {
      if (device.configuration?.configurationValue !== endpoints.configurationValue) {
        await device.selectConfiguration(endpoints.configurationValue)
      }
      await device.claimInterface(endpoints.interfaceNumber)
      if (endpoints.alternateSetting !== 0) {
        await device.selectAlternateInterface(endpoints.interfaceNumber, endpoints.alternateSetting)
      }
    } catch {
      try {
        await device.close()
      } catch {
        /* zařízení už je zavřené */
      }
      throw new CardReaderError('open', 'Rozhraní čtečky se nepodařilo zabrat.')
    }
    return new CcidSession(device, endpoints)
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
    const atr = await this.transfer(MSG_POWER_ON, new Uint8Array(0), [0, 0, 0])
    if (atr.length === 0) {
      throw new CardReaderError('no_card', 'Čtečka nevrátila ATR. Vložte kartu řidiče a zkuste to znovu.')
    }
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

  private async transfer(type: number, payload: Uint8Array, extra: [number, number, number]): Promise<Uint8Array> {
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

    const sent = await this.device.transferOut(this.endpoints.bulkOut, message)
    if (sent.status !== 'ok') {
      throw new CardReaderError('protocol', 'Odeslání příkazu do čtečky selhalo.')
    }

    const parts: Uint8Array[] = []
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const incoming = await this.readMessage()
      const commandStatus = (incoming.status >> 6) & 0x03
      if (commandStatus === 2) continue
      if (commandStatus === 1) {
        throw new CardReaderError(
          'protocol',
          `Čtečka odmítla příkaz (CCID 0x${incoming.error.toString(16).padStart(2, '0')}).`,
        )
      }
      if (incoming.type !== MSG_DATA_BLOCK) {
        throw new CardReaderError('protocol', 'Čtečka vrátila neočekávaný typ zprávy.')
      }
      parts.push(incoming.data)
      if (incoming.chain === 0 || incoming.chain === 2 || incoming.chain === 0x10) break
    }
    return concat(parts)
  }

  private async readMessage(): Promise<CcidMessage> {
    const result = await this.device.transferIn(this.endpoints.bulkIn, 10 + 65536)
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
