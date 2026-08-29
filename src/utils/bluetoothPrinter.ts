// Impresion termica por Bluetooth (Web Bluetooth API) — via directa, sin
// pasar por el dialogo de impresion del sistema operativo. Complementa (no
// reemplaza) la impresion por cable/USB de utils/ticket.ts, que sigue usando
// window.print(): esa via depende de que la impresora este instalada como
// impresora del sistema operativo (con su driver), algo que la mayoria de
// impresoras termicas Bluetooth "portatiles" baratas no soportan. Aqui se le
// habla directo al modulo Bluetooth de la impresora (perfil BLE, no el
// Bluetooth clasico SPP) enviandole los bytes ESC/POS crudos.
//
// LIMITACION DE PLATAFORMA (no es un bug, es como funciona Web Bluetooth):
// solo esta disponible en navegadores basados en Chromium (Chrome/Edge en
// Windows, Android y Mac); Safari/iOS no lo implementa en absoluto, con o sin
// Chrome instalado (en iOS todos los navegadores usan el motor de Safari).
// Por eso bluetoothDisponible() se chequea siempre antes de ofrecer el boton,
// y si el equipo es un iPhone/iPad hay que usar la impresion por cable o por
// un lector Bluetooth ya emparejado como teclado (ver useKeyboardScanner).

// UUIDs de servicios BLE conocidos que exponen impresoras termicas ESC/POS
// "genericas" (clones chinos vendidos como "Portable thermal printer",
// comunes en Peru: GOOJPRT, Zjiang, MPT-II, Xprinter, etc.) y adaptadores
// seriales BLE genericos que algunas usan por debajo. Web Bluetooth exige
// declarar de antemano cada servicio al que se quiera acceder
// (optionalServices) — no hay forma de "descubrir todo" sin listarlos.
const SERVICIOS_IMPRESORA = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Perfil ESC/POS BLE mas comun en impresoras portatiles
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // UART generico (modulos tipo HM-10 usados por algunos clones)
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service (otro UART generico frecuente)
]

// Tamaño de bloque por escritura BLE. El MTU por defecto sin negociar es de
// 23 bytes (20 de payload util); muchas impresoras BLE baratas nunca
// negocian un MTU mayor, asi que se manda siempre en bloques chicos con una
// pequeña espera entre cada uno — mandar todo de un tirón desborda su buffer
// interno y corta el ticket a la mitad.
const TAMANO_BLOQUE = 20
const PAUSA_ENTRE_BLOQUES_MS = 15

export function bluetoothDisponible(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth
}

let dispositivoActual: BluetoothDevice | null = null
let caracteristicaActual: BluetoothRemoteGATTCharacteristic | null = null

function limpiarConexion() {
  dispositivoActual = null
  caracteristicaActual = null
}

/** Busca, entre los servicios accesibles del dispositivo, la primera
 * caracteristica que acepte escritura — es el canal por el que la impresora
 * recibe los comandos ESC/POS. */
async function buscarCaracteristicaEscritura(
  server: BluetoothRemoteGATTServer,
): Promise<BluetoothRemoteGATTCharacteristic> {
  const servicios = await server.getPrimaryServices()
  for (const servicio of servicios) {
    const caracteristicas = await servicio.getCharacteristics()
    const escribible = caracteristicas.find(
      (c) => c.properties.write || c.properties.writeWithoutResponse,
    )
    if (escribible) return escribible
  }
  throw new Error(
    'La impresora emparejada no expone un canal Bluetooth compatible con ESC/POS. Prueba imprimir por cable USB, o revisa que el modo Bluetooth de la impresora este activado.',
  )
}

/**
 * Abre el selector nativo de Bluetooth, conecta al dispositivo elegido y
 * deja la conexion lista para imprimir. Si ya hay una conexion activa de un
 * ticket anterior en esta misma sesion, la reutiliza sin volver a pedir
 * emparejamiento (evita que el cajero tenga que re-seleccionar la impresora
 * en cada venta).
 */
async function obtenerCaracteristica(): Promise<BluetoothRemoteGATTCharacteristic> {
  if (!bluetoothDisponible()) {
    throw new Error(
      'Este navegador no soporta impresión Bluetooth. Usa Chrome o Edge en Android, Windows o Mac (Safari/iPhone no lo soportan: usa la impresión por cable).',
    )
  }

  if (dispositivoActual?.gatt?.connected && caracteristicaActual) {
    return caracteristicaActual
  }

  const dispositivo = await navigator.bluetooth!.requestDevice({
    acceptAllDevices: true,
    optionalServices: SERVICIOS_IMPRESORA,
  })

  dispositivo.addEventListener('gattserverdisconnected', limpiarConexion)

  if (!dispositivo.gatt) {
    throw new Error('El dispositivo Bluetooth seleccionado no soporta conexión GATT.')
  }
  const server = await dispositivo.gatt.connect()
  const caracteristica = await buscarCaracteristicaEscritura(server)

  dispositivoActual = dispositivo
  caracteristicaActual = caracteristica
  return caracteristica
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Envia los bytes ESC/POS a la impresora ya conectada, en bloques pequeños. */
async function enviarBytes(
  caracteristica: BluetoothRemoteGATTCharacteristic,
  datos: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const sinRespuesta = caracteristica.properties.writeWithoutResponse
  for (let i = 0; i < datos.length; i += TAMANO_BLOQUE) {
    const bloque = datos.subarray(i, i + TAMANO_BLOQUE)
    if (sinRespuesta) {
      await caracteristica.writeValueWithoutResponse(bloque)
    } else {
      await caracteristica.writeValue(bloque)
    }
    await esperar(PAUSA_ENTRE_BLOQUES_MS)
  }
}

/**
 * Imprime un ticket ya armado en ESC/POS (ver utils/escpos.ts) mediante
 * Bluetooth. Lanza un Error con mensaje listo para mostrar en un toast ante
 * cualquier falla (navegador sin soporte, emparejamiento cancelado,
 * desconexion a mitad de envio, etc.) — nunca debe tumbar la app.
 */
export async function imprimirPorBluetooth(datos: Uint8Array<ArrayBuffer>): Promise<void> {
  let caracteristica: BluetoothRemoteGATTCharacteristic
  try {
    caracteristica = await obtenerCaracteristica()
  } catch (e) {
    limpiarConexion()
    if (e instanceof Error && e.name === 'NotFoundError') {
      throw new Error('No se seleccionó ninguna impresora Bluetooth.')
    }
    throw e instanceof Error ? e : new Error('No se pudo conectar con la impresora Bluetooth.')
  }

  try {
    await enviarBytes(caracteristica, datos)
  } catch (e) {
    // Una falla de escritura casi siempre significa que la conexion se cayo
    // (impresora se apago, se alejo, buffer lleno) — se descarta el estado
    // guardado para que el proximo intento vuelva a conectar desde cero en
    // vez de reintentar sobre un canal ya muerto.
    limpiarConexion()
    throw new Error(
      e instanceof Error
        ? `Se perdió la conexión con la impresora Bluetooth: ${e.message}`
        : 'Se perdió la conexión con la impresora Bluetooth.',
    )
  }
}

/** Olvida la conexion activa (por si el cajero quiere imprimir en otra impresora). */
export function desconectarImpresoraBluetooth(): void {
  try {
    dispositivoActual?.gatt?.disconnect()
  } catch {
    // Silenciar: si ya estaba desconectada no hay nada que hacer
  }
  limpiarConexion()
}
