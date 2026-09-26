// Persistencia del carrito del POS. La app es una PWA con actualización
// automática: al haber una versión nueva, la página se recarga sola y el
// carrito (que vivía solo en memoria) desaparecía con todo lo que el cajero ya
// había seleccionado. Aquí se guarda en localStorage y se recupera al volver a
// abrir el POS; el carrito solo se vacía cuando el cajero lo cancela ("Vaciar")
// o cuando la venta se cobra.
//
// Solo se guarda lo mínimo — {producto, presentación, cantidad} + descuento —
// y NO el producto entero: al restaurar, el carrito se reconstruye con los
// productos ACTUALES (ver reconstruirCarrito en hooks/useCarrito.ts), de modo
// que precios y stock nuevos tras la actualización se respetan en vez de
// mostrar datos viejos. Va por usuario: otro cajero en el mismo equipo no
// hereda un carrito ajeno.

const VERSION = 1
const MAX_LINEAS = 200

export interface LineaGuardada {
  productoId: string
  modalidad: string
  cantidad: number
}

export interface CarritoGuardado {
  v: number
  guardadoEn: string
  descuento: number
  lineas: LineaGuardada[]
}

const claveDe = (usuarioId: string): string => `carrito_pos_v${VERSION}:${usuarioId}`

/** localStorage puede no existir o lanzar (modo privado estricto, cuota llena,
 * bloqueado por el navegador): en ese caso el carrito simplemente no persiste,
 * pero el POS sigue funcionando igual. */
function almacen(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function borrarCarrito(usuarioId: string, st: Storage | null = almacen()): void {
  if (!st || !usuarioId) return
  try {
    st.removeItem(claveDe(usuarioId))
  } catch {
    /* sin almacenamiento: nada que borrar */
  }
}

/** Guarda el carrito; con 0 líneas borra lo guardado (carrito vacío = nada que recuperar). */
export function guardarCarrito(
  usuarioId: string,
  lineas: LineaGuardada[],
  descuento: number,
  st: Storage | null = almacen(),
): void {
  if (!st || !usuarioId) return
  if (lineas.length === 0) {
    borrarCarrito(usuarioId, st)
    return
  }
  const dato: CarritoGuardado = {
    v: VERSION,
    guardadoEn: new Date().toISOString(),
    descuento: Number.isFinite(descuento) && descuento > 0 ? descuento : 0,
    lineas: lineas.slice(0, MAX_LINEAS),
  }
  try {
    st.setItem(claveDe(usuarioId), JSON.stringify(dato))
  } catch {
    /* cuota llena o bloqueado: el carrito sigue en memoria, solo no se guarda */
  }
}

/** Lee y VALIDA lo guardado. Cualquier dato ilegible, de otra versión o con
 * líneas inválidas se descarta (y se borra) en vez de propagarse al carrito:
 * jamás lanza. */
export function leerCarrito(usuarioId: string, st: Storage | null = almacen()): CarritoGuardado | null {
  if (!st || !usuarioId) return null
  let crudo: string | null
  try {
    crudo = st.getItem(claveDe(usuarioId))
  } catch {
    return null
  }
  if (!crudo) return null
  try {
    const p = JSON.parse(crudo) as Partial<CarritoGuardado> | null
    if (!p || typeof p !== 'object' || p.v !== VERSION || !Array.isArray(p.lineas)) throw new Error('formato')
    const lineas: LineaGuardada[] = []
    for (const l of p.lineas.slice(0, MAX_LINEAS)) {
      if (
        l &&
        typeof l.productoId === 'string' &&
        l.productoId.length > 0 &&
        typeof l.modalidad === 'string' &&
        l.modalidad.length > 0 &&
        typeof l.cantidad === 'number' &&
        Number.isFinite(l.cantidad) &&
        l.cantidad > 0
      ) {
        lineas.push({ productoId: l.productoId, modalidad: l.modalidad, cantidad: l.cantidad })
      }
    }
    if (lineas.length === 0) throw new Error('vacio')
    const descuento = typeof p.descuento === 'number' && Number.isFinite(p.descuento) && p.descuento > 0 ? p.descuento : 0
    return { v: VERSION, guardadoEn: typeof p.guardadoEn === 'string' ? p.guardadoEn : '', descuento, lineas }
  } catch {
    borrarCarrito(usuarioId, st)
    return null
  }
}
