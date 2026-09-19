// Tipos minimos de Web Bluetooth API — no vienen en el lib "DOM" estandar de
// TypeScript y el proyecto no depende de @types/web-bluetooth. Solo se
// declara la superficie que usa src/utils/bluetoothPrinter.ts.
// Referencia: https://webbluetoothcg.github.io/web-bluetooth/

interface BluetoothRemoteGATTCharacteristic {
  readonly uuid: string
  readonly properties: {
    readonly write: boolean
    readonly writeWithoutResponse: boolean
  }
  writeValue(value: BufferSource): Promise<void>
  writeValueWithoutResponse(value: BufferSource): Promise<void>
}

interface BluetoothRemoteGATTService {
  readonly uuid: string
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>
}

interface BluetoothDevice extends EventTarget {
  readonly id: string
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
  /** Revoca el permiso concedido a este dispositivo (Chrome 100+). */
  forget?(): Promise<void>
}

interface RequestDeviceOptions {
  filters?: Array<{ services?: string[]; name?: string; namePrefix?: string }>
  optionalServices?: string[]
  acceptAllDevices?: boolean
}

interface Bluetooth extends EventTarget {
  requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>
  getDevices?(): Promise<BluetoothDevice[]>
}

interface Navigator {
  readonly bluetooth?: Bluetooth
}
