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
//
// IMPRESORA "YA CONECTADA": el navegador exige que el usuario elija la
// impresora en su selector nativo (requestDevice) al menos una vez — no hay
// forma de saltarse ese permiso. Lo que si se hace aqui es que esa eleccion
// dure: (1) la conexion se mantiene y se reutiliza entre tickets, (2) si se
// cae (la impresora se durmio) se reconecta sola al siguiente ticket, y (3) el
// id de la impresora se guarda en este dispositivo para reconectarla sin
// selector tras recargar la pagina (navigator.bluetooth.getDevices(), donde el
// navegador lo soporte). El estado se expone con useImpresoraBluetooth().
import { useSyncExternalStore } from 'react'

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

// Si la impresora esta apagada/fuera de alcance, gatt.connect() puede tardar
// decenas de segundos en fallar; se corta antes para no dejar al cajero
// esperando frente a un boton girando.
const TIMEOUT_CONEXION_MS = 8000

const CLAVE_GUARDADA = 'impresora-bt-guardada-v1'

export function bluetoothDisponible(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth
}

// --- Estado observable ------------------------------------------------------

export interface EstadoImpresora {
  /** Hay un canal GATT abierto y listo para imprimir ahora mismo. */
  conectada: boolean
  /** Hay una conexion/reconexion en curso. */
  conectando: boolean
  /** Nombre de la ultima impresora usada (aunque este desconectada). */
  nombre: string | null
}

interface ImpresoraGuardada {
  id: string
  nombre: string
}

function leerGuardada(): ImpresoraGuardada | null {
  try {
    const raw = localStorage.getItem(CLAVE_GUARDADA)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ImpresoraGuardada>
    if (typeof v.id === 'string' && v.id) {
      return { id: v.id, nombre: typeof v.nombre === 'string' && v.nombre ? v.nombre : 'Impresora Bluetooth' }
    }
  } catch {
    // dato ilegible o storage bloqueado: se trata como "sin impresora guardada"
  }
  return null
}

function guardarImpresora(d: ImpresoraGuardada | null): void {
  try {
    if (d) localStorage.setItem(CLAVE_GUARDADA, JSON.stringify(d))
    else localStorage.removeItem(CLAVE_GUARDADA)
  } catch {
    // sin persistencia: la conexion de esta sesion sigue funcionando igual
  }
}

let estado: EstadoImpresora = {
  conectada: false,
  conectando: false,
  nombre: leerGuardada()?.nombre ?? null,
}
const oyentes = new Set<() => void>()

function actualizarEstado(parcial: Partial<EstadoImpresora>): void {
  const nuevo = { ...estado, ...parcial }
  if (
    nuevo.conectada === estado.conectada &&
    nuevo.conectando === estado.conectando &&
    nuevo.nombre === estado.nombre
  ) {
    return
  }
  estado = nuevo
  oyentes.forEach((fn) => fn())
}

function suscribir(fn: () => void): () => void {
  oyentes.add(fn)
  return () => {
    oyentes.delete(fn)
  }
}

/** Estado reactivo de la impresora Bluetooth (conectada / conectando / nombre). */
export function useImpresoraBluetooth(): EstadoImpresora {
  return useSyncExternalStore(suscribir, () => estado, () => estado)
}

// --- Conexion ---------------------------------------------------------------

// El dispositivo se conserva aunque se desconecte (la impresora se durmio):
// asi se puede reconectar con dispositivo.gatt.connect() sin abrir el
// selector ni necesitar un gesto del usuario. Solo se suelta al "olvidar".
let dispositivoActual: BluetoothDevice | null = null
let caracteristicaActual: BluetoothRemoteGATTCharacteristic | null = null
// true tras una reconexion fallida: el siguiente intento va directo al
// selector nativo (con gesto fresco del usuario) en vez de volver a esperar
// el timeout contra una impresora que esta apagada.
let saltarReconexion = false
let conexionEnCurso: Promise<BluetoothRemoteGATTCharacteristic> | null = null
let autoconexionIntentada = false

function alDesconectar() {
  caracteristicaActual = null
  actualizarEstado({ conectada: false, conectando: false })
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

function conTimeout<T>(promesa: Promise<T>, ms: number, alExpirar: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      alExpirar()
      reject(new Error('La impresora no respondió a tiempo.'))
    }, ms)
    promesa.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Abre el canal GATT del dispositivo y deja lista la caracteristica de escritura. */
async function conectarDispositivo(
  dispositivo: BluetoothDevice,
): Promise<BluetoothRemoteGATTCharacteristic> {
  if (!dispositivo.gatt) {
    throw new Error('El dispositivo Bluetooth seleccionado no soporta conexión GATT.')
  }
  dispositivo.addEventListener('gattserverdisconnected', alDesconectar)
  try {
    const server = await dispositivo.gatt.connect()
    const caracteristica = await buscarCaracteristicaEscritura(server)

    dispositivoActual = dispositivo
    caracteristicaActual = caracteristica
    saltarReconexion = false
    const nombre = dispositivo.name || 'Impresora Bluetooth'
    guardarImpresora({ id: dispositivo.id, nombre })
    actualizarEstado({ conectada: true, conectando: false, nombre })
    return caracteristica
  } catch (e) {
    // No dejar un enlace GATT a medias (conectado pero sin canal de escritura).
    try {
      dispositivo.gatt.disconnect()
    } catch {
      // ya estaba desconectado
    }
    throw e
  }
}

/** Dispositivo de la impresora guardada, recuperado sin abrir el selector
 * (solo si el navegador soporta getDevices()). */
async function dispositivoGuardado(): Promise<BluetoothDevice | null> {
  const guardada = leerGuardada()
  if (!guardada || !navigator.bluetooth?.getDevices) return null
  try {
    const dispositivos = await navigator.bluetooth.getDevices()
    return dispositivos.find((d) => d.id === guardada.id) ?? null
  } catch {
    return null
  }
}

/** Impresora conocida (la de esta sesion o la guardada de una anterior). */
async function buscarCandidato(): Promise<BluetoothDevice | null> {
  return dispositivoActual ?? (await dispositivoGuardado())
}

/** Reconexion sin selector ni gesto del usuario, con tope de espera. */
function conectarConTimeout(candidato: BluetoothDevice): Promise<BluetoothRemoteGATTCharacteristic> {
  return conTimeout(conectarDispositivo(candidato), TIMEOUT_CONEXION_MS, () => {
    try {
      candidato.gatt?.disconnect()
    } catch {
      // ya estaba desconectado
    }
  })
}

async function elegirYConectar(): Promise<BluetoothRemoteGATTCharacteristic> {
  const dispositivo = await navigator.bluetooth!.requestDevice({
    acceptAllDevices: true,
    optionalServices: SERVICIOS_IMPRESORA,
  })
  return conectarDispositivo(dispositivo)
}

function traducirErrorConexion(e: unknown): Error {
  if (e instanceof Error && e.name === 'NotFoundError') {
    return new Error('No se seleccionó ninguna impresora Bluetooth.')
  }
  if (e instanceof Error && e.name === 'SecurityError') {
    return new Error('Toca de nuevo el botón para elegir la impresora Bluetooth.')
  }
  return e instanceof Error ? e : new Error('No se pudo conectar con la impresora Bluetooth.')
}

/** Ejecuta una conexion registrandola como "en curso": cualquier otra llamada
 * simultanea (impresion, autoconexion, boton de Configuracion) espera a esta
 * misma en vez de abrir una segunda conexion. */
function compartirConexion(
  tarea: () => Promise<BluetoothRemoteGATTCharacteristic>,
): Promise<BluetoothRemoteGATTCharacteristic> {
  actualizarEstado({ conectando: true })
  const promesa = tarea()
    .catch((e) => {
      throw traducirErrorConexion(e)
    })
    .finally(() => {
      conexionEnCurso = null
      actualizarEstado({ conectando: false })
    })
  conexionEnCurso = promesa
  return promesa
}

/**
 * Devuelve el canal de escritura de la impresora, conectando si hace falta:
 * reutiliza la conexion activa; si no, reconecta la impresora conocida sin
 * selector; y solo si nunca se eligio una (o se pide otra) abre el selector
 * nativo.
 */
async function obtenerCaracteristica(elegirNueva = false): Promise<BluetoothRemoteGATTCharacteristic> {
  if (!bluetoothDisponible()) {
    throw new Error(
      'Este navegador no soporta impresión Bluetooth. Usa Chrome o Edge en Android, Windows o Mac (Safari/iPhone no lo soportan: usa la impresión por cable).',
    )
  }

  if (!elegirNueva && dispositivoActual?.gatt?.connected && caracteristicaActual) {
    return caracteristicaActual
  }
  if (conexionEnCurso) return conexionEnCurso

  return compartirConexion(async () => {
    if (elegirNueva) {
      desconectarSinOlvidar()
      return elegirYConectar()
    }
    if (!saltarReconexion) {
      const candidato = await buscarCandidato()
      if (candidato) {
        try {
          return await conectarConTimeout(candidato)
        } catch {
          // La impresora no respondio (apagada/lejos). El gesto del usuario
          // ya pudo consumirse esperando, asi que no se abre el selector
          // ahora: se avisa, y el siguiente toque lo abre directamente.
          saltarReconexion = true
          throw new Error(
            'No se pudo conectar con la impresora. Enciéndela y toca Bluetooth de nuevo para volver a elegirla.',
          )
        }
      }
    }
    return elegirYConectar()
  })
}

function desconectarSinOlvidar() {
  try {
    dispositivoActual?.gatt?.disconnect()
  } catch {
    // Silenciar: si ya estaba desconectada no hay nada que hacer
  }
  caracteristicaActual = null
  actualizarEstado({ conectada: false })
}

// --- API publica ------------------------------------------------------------

/**
 * Conecta explicitamente la impresora (boton "Conectar" de Configuracion).
 * Con elegirNueva=true abre siempre el selector para cambiar de impresora.
 */
export async function conectarImpresora(elegirNueva = false): Promise<void> {
  await obtenerCaracteristica(elegirNueva)
}

/**
 * Intento silencioso, una vez por carga de la app, de reconectar la impresora
 * usada la ultima vez — para que ya este lista al abrir el POS. Nunca abre el
 * selector, nunca lanza y no muestra errores: si la impresora esta apagada
 * simplemente queda "desconectada" y se reconecta al imprimir.
 */
export async function reconectarImpresoraGuardada(): Promise<void> {
  if (autoconexionIntentada || !bluetoothDisponible() || !leerGuardada()) return
  autoconexionIntentada = true
  if (conexionEnCurso || estado.conectada) return
  try {
    await compartirConexion(async () => {
      const candidato = await buscarCandidato()
      if (!candidato) throw new Error('Sin impresora conocida.')
      return conectarConTimeout(candidato)
    })
  } catch {
    // Silencioso a proposito: ver comentario de la funcion.
  }
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

// Cola de impresion: dos tickets pedidos casi a la vez (doble toque, cierre de
// caja + venta) se envian uno detras de otro. Escribir en paralelo sobre la
// misma caracteristica mezclaria los bytes de ambos y saldria basura.
let cola: Promise<unknown> = Promise.resolve()

/**
 * Imprime un ticket ya armado en ESC/POS (ver utils/escpos.ts) mediante
 * Bluetooth. Lanza un Error con mensaje listo para mostrar en un toast ante
 * cualquier falla (navegador sin soporte, emparejamiento cancelado,
 * desconexion a mitad de envio, etc.) — nunca debe tumbar la app.
 */
export function imprimirPorBluetooth(datos: Uint8Array<ArrayBuffer>): Promise<void> {
  const tarea = cola.then(() => imprimirAhora(datos))
  cola = tarea.catch(() => undefined)
  return tarea
}

async function imprimirAhora(datos: Uint8Array<ArrayBuffer>): Promise<void> {
  const caracteristica = await obtenerCaracteristica()

  try {
    await enviarBytes(caracteristica, datos)
  } catch (e) {
    // Una falla de escritura casi siempre significa que la conexion se cayo
    // (impresora se apago, se alejo, buffer lleno) — se suelta el canal para
    // que el proximo intento reconecte desde cero en vez de reintentar sobre
    // un canal ya muerto (el dispositivo se conserva: no hace falta selector).
    desconectarSinOlvidar()
    throw new Error(
      e instanceof Error
        ? `Se perdió la conexión con la impresora Bluetooth: ${e.message}`
        : 'Se perdió la conexión con la impresora Bluetooth.',
    )
  }
}

/** Corta la conexion actual pero recuerda la impresora para reconectarla luego. */
export function desconectarImpresoraBluetooth(): void {
  desconectarSinOlvidar()
}

/** Corta la conexion y borra la impresora guardada de este dispositivo. */
export async function olvidarImpresoraBluetooth(): Promise<void> {
  const dispositivo = dispositivoActual
  desconectarSinOlvidar()
  dispositivoActual = null
  saltarReconexion = false
  guardarImpresora(null)
  actualizarEstado({ nombre: null })
  try {
    // Revoca el permiso en el navegador (Chrome 100+); si no existe, no pasa nada.
    await dispositivo?.forget?.()
  } catch {
    // no critico
  }
}
