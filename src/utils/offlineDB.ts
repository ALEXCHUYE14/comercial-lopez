// Cola de ventas pendientes de sincronizar, persistida en IndexedDB — sin
// dependencias externas (API nativa del navegador). Sobrevive a recargar la
// pagina o cerrar la pestaña, a diferencia de guardar esto en memoria: si el
// POS se queda sin internet a media tarde y el cajero cierra el navegador
// por error, las ventas encoladas no se pierden.
import type { ItemCarrito, MetodoPago } from '@/types/database'

const DB_NOMBRE = 'bodeguita_offline'
const DB_VERSION = 1
const STORE = 'ventas_pendientes'

export interface VentaOfflineTotales {
  subtotal: number
  descuento: number
  igv: number
  total: number
}

// Solo efectivo/yape: el fiado depende de validar en el servidor el limite
// de credito actualizado del cliente (otro dispositivo pudo haber vendido al
// mismo cliente mientras este estaba offline), asi que no es seguro
// encolarlo sin conexion — ver PaymentModal (prop `offline`).
export type MetodoOffline = Extract<MetodoPago, 'efectivo' | 'yape'>

export interface VentaOffline {
  /** UUID generado en el cliente — doble uso: llave primaria local Y
   * clave de idempotencia enviada al RPC registrar_venta (ver schema.sql). */
  clientId: string
  creadoEnLocal: string
  itemsCarrito: ItemCarrito[]
  metodo: MetodoOffline
  descuento: number
  pagoRecibido: number
  cajaId: string | null
  cajeroNombre: string | null
  totales: VentaOfflineTotales
  intentos: number
  ultimoError?: string
}

function abrirDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('Este navegador no soporta almacenamiento offline (IndexedDB).'))
      return
    }
    const req = indexedDB.open(DB_NOMBRE, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'clientId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('No se pudo abrir la base de datos offline.'))
  })
}

async function conTienda<T>(
  modo: IDBTransactionMode,
  fn: (tienda: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await abrirDB()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, modo)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('Error en la base de datos offline.'))
    })
  } finally {
    db.close()
  }
}

export async function encolarVentaOffline(venta: VentaOffline): Promise<void> {
  await conTienda('readwrite', (t) => t.add(venta))
}

export async function listarVentasOffline(): Promise<VentaOffline[]> {
  const items = await conTienda<VentaOffline[]>('readonly', (t) => t.getAll())
  // Orden de creacion: las ventas deben sincronizarse en el mismo orden en
  // que ocurrieron (afecta la numeracion correlativa de comprobantes).
  return items.sort((a, b) => a.creadoEnLocal.localeCompare(b.creadoEnLocal))
}

export async function eliminarVentaOffline(clientId: string): Promise<void> {
  await conTienda('readwrite', (t) => t.delete(clientId))
}

export async function actualizarVentaOffline(venta: VentaOffline): Promise<void> {
  await conTienda('readwrite', (t) => t.put(venta))
}

/**
 * Detecta si un error luce como una falla de red (el request nunca llego al
 * servidor a recibir respuesta) en vez de un rechazo real del servidor. Es
 * una heuristica, no una certeza — pero alcanza para decidir entre "guardar
 * offline y reintentar despues" vs. "el servidor de verdad rechazo esto,
 * avisar de inmediato". La usan tanto POS.tsx (al decidir si encolar una
 * venta) como useVentasOffline.ts (al decidir si detener la sincronizacion).
 */
export function pareceErrorDeRed(e: unknown): boolean {
  if (!navigator.onLine) return true
  if (e instanceof TypeError) return true // "Failed to fetch" tipico de fetch sin red
  const msg = e instanceof Error ? e.message.toLowerCase() : ''
  return msg.includes('failed to fetch') || msg.includes('network')
}
