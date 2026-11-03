export type UsbTraceStepStatus = 'ok' | 'fail' | 'skip'

export type UsbTraceStep = {
  step: string
  status: UsbTraceStepStatus
  detail: string
}

function hexWord(value: number | undefined): string {
  if (value == null) return '—'
  return `0x${value.toString(16).padStart(4, '0')}`
}

function hexByte(value: number | undefined): string {
  if (value == null) return '—'
  return `0x${value.toString(16).padStart(2, '0')}`
}

export function formatCause(cause: unknown): string {
  if (cause instanceof DOMException) {
    return `DOMException name=${cause.name} message=${cause.message} code=${cause.code}`
  }
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return String(cause)
}

function endpointLine(endpoint: USBEndpoint): string {
  return `ep ${endpoint.endpointNumber} ${endpoint.direction} ${endpoint.type} max=${endpoint.packetSize}`
}

function alternateLine(alternate: USBAlternateInterface): string {
  const endpoints = alternate.endpoints.length
    ? alternate.endpoints.map(endpointLine).join('; ')
    : 'žádné endpointy'
  return [
    `alt ${alternate.alternateSetting}`,
    `class=${hexByte(alternate.interfaceClass)}`,
    `subclass=${hexByte(alternate.interfaceSubclass)}`,
    `protocol=${hexByte(alternate.interfaceProtocol)}`,
    endpoints,
  ].join(' ')
}

export function describeUsbDevice(device: USBDevice): string {
  const header = [
    `product="${device.productName ?? '—'}"`,
    `manufacturer="${device.manufacturerName ?? '—'}"`,
    `VID=${hexWord(device.vendorId)}`,
    `PID=${hexWord(device.productId)}`,
    `opened=${device.opened}`,
    `usb=${device.usbVersionMajor}.${device.usbVersionMinor}.${device.usbVersionSubminor}`,
    `class=${hexByte(device.deviceClass)} subclass=${hexByte(device.deviceSubclass)} protocol=${hexByte(device.deviceProtocol)}`,
    `serial="${device.serialNumber ?? '—'}"`,
  ].join(' ')

  const configurations = device.configurations.map((configuration) => {
    const active = device.configuration?.configurationValue === configuration.configurationValue ? ' [aktivní]' : ''
    const interfaces = configuration.interfaces.map((iface) => {
      const alts = iface.alternates.map(alternateLine).join(' | ')
      return `    interface ${iface.interfaceNumber} claimed=${iface.claimed}${alts ? ` → ${alts}` : ''}`
    })
    return [`  configuration ${configuration.configurationValue}${active}`, ...interfaces].join('\n')
  })

  return [header, configurations.join('\n') || '  (Chrome neposkytl žádnou konfiguraci)'].join('\n')
}

export class UsbTrace {
  readonly steps: UsbTraceStep[] = []

  note(step: string, status: UsbTraceStepStatus, detail: string): void {
    this.steps.push({ step, status, detail })
    const line = `[card-reader][webusb] ${status.toUpperCase()} ${step} — ${detail}`
    if (status === 'fail') console.error(line)
    else console.info(line)
  }

  ok(step: string, detail: string): void {
    this.note(step, 'ok', detail)
  }

  fail(step: string, cause: unknown, extra = ''): void {
    const suffix = extra ? ` ${extra}` : ''
    this.note(step, 'fail', `${formatCause(cause)}${suffix}`)
  }

  skip(step: string, detail: string): void {
    this.note(step, 'skip', detail)
  }

  toText(): string {
    if (this.steps.length === 0) return 'Diagnostika WebUSB neproběhla.'
    return this.steps
      .map((item, index) => `${index + 1}. [${item.status.toUpperCase()}] ${item.step}\n${item.detail}`)
      .join('\n\n')
  }
}
