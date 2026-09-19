// Datos del negocio editables desde Configuracion (nombre, DNI/RUC, direccion,
// QR de Yape). Reemplazan a BRAND.nombre/ruc/direccion en toda la UI y en los
// tickets, pero BRAND sigue siendo el valor por defecto: mientras la
// configuracion remota no cargo (sin sesion, sin internet, migracion SQL aun
// no corrida) todo sigue funcionando exactamente como antes.
//
// Es un almacen a nivel de modulo (no un Context) a proposito: los
// generadores de tickets (utils/ticket.ts, escpos.ts, ...) son funciones
// planas fuera de React y necesitan leer el valor vigente de forma sincrona.
// Los componentes se suscriben con useNegocio() y se re-renderizan solos.
import { useSyncExternalStore } from 'react'
import { BRAND } from '@/config/brand'

export interface Negocio {
  nombre: string
  /** DNI (8 digitos) o RUC (11 digitos); '' si no esta configurado. */
  documento: string
  direccion: string
  yapeQrUrl: string | null
  imprimirQrYape: boolean
}

const CLAVE_CACHE = 'negocio-config-v1'

const POR_DEFECTO: Negocio = {
  nombre: BRAND.nombre,
  documento: BRAND.ruc,
  direccion: BRAND.direccion,
  yapeQrUrl: null,
  imprimirQrYape: true,
}

function limpiar(n: Partial<Negocio> | null | undefined): Negocio {
  const nombre = typeof n?.nombre === 'string' ? n.nombre.trim() : ''
  return {
    nombre: nombre || POR_DEFECTO.nombre,
    documento: typeof n?.documento === 'string' ? n.documento.trim() : POR_DEFECTO.documento,
    direccion: typeof n?.direccion === 'string' ? n.direccion.trim() : POR_DEFECTO.direccion,
    yapeQrUrl: typeof n?.yapeQrUrl === 'string' && n.yapeQrUrl ? n.yapeQrUrl : null,
    imprimirQrYape: typeof n?.imprimirQrYape === 'boolean' ? n.imprimirQrYape : POR_DEFECTO.imprimirQrYape,
  }
}

// Ultima configuracion conocida en este dispositivo: permite imprimir con el
// nombre correcto aun sin internet y evita el "parpadeo" del nombre por
// defecto en cada recarga. localStorage puede no estar disponible (modo
// privado, cuota, storage bloqueado) — nunca debe tumbar la app.
function leerCache(): Negocio {
  try {
    const raw = localStorage.getItem(CLAVE_CACHE)
    if (raw) return limpiar(JSON.parse(raw) as Partial<Negocio>)
  } catch {
    // cache ilegible o storage no disponible: se usan los valores por defecto
  }
  return { ...POR_DEFECTO }
}

let actual: Negocio = leerCache()
const oyentes = new Set<() => void>()

export function getNegocio(): Negocio {
  return actual
}

export function setNegocio(nuevo: Partial<Negocio>): void {
  const limpio = limpiar(nuevo)
  // Sin cambios reales no se notifica: evita re-renders innecesarios cuando
  // la sincronizacion remota devuelve exactamente lo que ya se tenia.
  if (JSON.stringify(limpio) === JSON.stringify(actual)) return
  actual = limpio
  try {
    localStorage.setItem(CLAVE_CACHE, JSON.stringify(limpio))
  } catch {
    // sin cache local; el valor en memoria sigue siendo el correcto
  }
  oyentes.forEach((fn) => fn())
}

function suscribir(fn: () => void): () => void {
  oyentes.add(fn)
  return () => {
    oyentes.delete(fn)
  }
}

/** Suscripcion reactiva: el componente se re-renderiza al cambiar la config. */
export function useNegocio(): Negocio {
  return useSyncExternalStore(suscribir, getNegocio, getNegocio)
}

/** "DNI" (8 digitos) o "RUC" (11 digitos), segun el largo del documento. */
export function etiquetaDocumento(documento: string): 'DNI' | 'RUC' {
  return documento.length === 8 ? 'DNI' : 'RUC'
}

/** Ej. "RUC: 20123456789" — o '' si el negocio no configuro su documento. */
export function textoDocumento(n: Negocio = actual): string {
  return n.documento ? `${etiquetaDocumento(n.documento)}: ${n.documento}` : ''
}

/** Valida DNI (8) / RUC (11). '' es valido (campo opcional). */
export function documentoValido(documento: string): boolean {
  return documento === '' || /^(\d{8}|\d{11})$/.test(documento)
}
