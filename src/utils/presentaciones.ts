// Presentaciones de venta de un producto: el stock SIEMPRE se lleva en la
// unidad base del producto (columna `unidad`: kg, unidad, ...) y cada
// presentación (saco, caja, arroba, docena, ...) es solo una forma de vender
// N unidades base a un precio propio. El servidor (RPC registrar_venta) es
// quien calcula el descuento real y el precio; este archivo replica esa misma
// regla en el cliente únicamente para mostrar precios / límites en pantalla.

import { cantidad } from '@/utils/format'
import type {
  ClavePresentacion,
  ModalidadVenta,
  Presentacion,
  Producto,
  TipoVenta,
} from '@/types/database'

export const CATALOGO_PRESENTACIONES: Record<ClavePresentacion, { nombre: string; tipo: TipoVenta }> = {
  arroba: { nombre: 'Arroba', tipo: 'granel' },
  medio_kilo: { nombre: 'Medio kilo', tipo: 'granel' },
  cuarto_kilo: { nombre: 'Cuarto de kilo', tipo: 'granel' },
  octavo_kilo: { nombre: 'Octavo de kilo', tipo: 'granel' },
  // "Paquete" como PRESENTACIÓN (no como unidad base): equivalente de 1
  // paquete completo cuando el stock se lleva en kg/g, ej. fideos que se
  // pesan por kilo pero también se venden por paquete/medio/cuarto de
  // paquete. Cuando la unidad base YA ES "paquete" no aparece (seria
  // redundante con el precio base — ver CLAVES_GRANEL_POR_UNIDAD).
  paquete: { nombre: 'Paquete', tipo: 'granel' },
  medio_paquete: { nombre: 'Medio paquete', tipo: 'granel' },
  cuarto_paquete: { nombre: 'Cuarto de paquete', tipo: 'granel' },
  docena: { nombre: 'Docena', tipo: 'unidad' },
  media_docena: { nombre: 'Media docena', tipo: 'unidad' },
  cuarto_docena: { nombre: 'Cuarto de docena', tipo: 'unidad' },
  // "Media caja" no tiene un tamaño fijo (a diferencia de docena=12): depende
  // de cuántas unidades trae LA CAJA de este producto (tiene_caja +
  // unidades_por_caja, ya existentes). Por eso solo se ofrece cuando el
  // producto ya vende por caja completa — ver clavesDisponibles más abajo.
  media_caja: { nombre: 'Media caja', tipo: 'unidad' },
}

// Qué presentaciones adicionales tiene sentido ofrecer, según el tipo de venta
// Y la unidad base EXACTA del producto: "Medio kilo" no tiene sentido si la
// base es litros. Las presentaciones de "paquete" SÍ se ofrecen junto con las
// de peso (kg/g) — ej. fideos que se pesan por kilo pero también se venden
// por paquete/medio/cuarto de paquete — pero no cuando la base YA ES
// "paquete" (ahí "Paquete" seria el mismo precio base, redundante).
const CLAVES_GRANEL_POR_UNIDAD: Record<string, ClavePresentacion[]> = {
  kg: ['arroba', 'medio_kilo', 'cuarto_kilo', 'octavo_kilo', 'paquete', 'medio_paquete', 'cuarto_paquete'],
  g: ['medio_kilo', 'cuarto_kilo', 'octavo_kilo', 'paquete', 'medio_paquete', 'cuarto_paquete'],
  paquete: ['medio_paquete', 'cuarto_paquete'],
}
// Para tipo_venta 'unidad', la docena/media docena/cuarto de docena aplican
// sin importar cuál sea la unidad base exacta (unidad, paquete, caja, docena:
// siempre son piezas enteras, solo cambia el nombre de la pieza).
const CLAVES_UNIDAD: ClavePresentacion[] = ['docena', 'media_docena', 'cuarto_docena']

/** Presentaciones que se pueden configurar para un producto, según su tipo de
 * venta, la unidad base exacta elegida (kg, g, paquete, litro, ...) y si el
 * producto ya vende por caja completa (`tieneCaja`, ver el interruptor
 * "Venta por caja"). Litro/ml y otras unidades sin presentaciones predefinidas
 * devuelven una lista vacía. Esta es la ÚNICA función que decide qué se
 * ofrece: tanto el formulario (validación al guardar) como su render la usan,
 * para que nunca queden desincronizados entre sí. */
export function clavesDisponibles(
  tipoVenta: TipoVenta,
  unidadBase: string,
  tieneCaja = false,
): ClavePresentacion[] {
  if (tipoVenta === 'unidad') {
    // "Media caja" solo tiene sentido si el producto YA vende por caja
    // completa: ahí se conoce cuántas unidades trae (unidades_por_caja), que
    // es lo que se sugiere partir a la mitad. Sin caja configurada no hay de
    // qué tomar "la mitad", asi que no se ofrece.
    return tieneCaja ? [...CLAVES_UNIDAD, 'media_caja'] : CLAVES_UNIDAD
  }
  return CLAVES_GRANEL_POR_UNIDAD[unidadBase] ?? []
}

// Equivalencia sugerida al activar una presentación, según la unidad base del
// stock. Si la unidad base no está aquí no se sugiere nada (ej. "paquete" no
// tiene un peso universal: el peso de un paquete lo indica cada negocio).
// "media_caja" queda deliberadamente vacía aquí: su sugerencia depende del
// tamaño de caja de CADA producto (unidades_por_caja), no de la unidad base —
// se calcula aparte, en ProductForm, con ese dato a la mano.
const FACTOR_SUGERIDO: Record<ClavePresentacion, Record<string, number>> = {
  arroba: { kg: 11.5, g: 11500 },
  medio_kilo: { kg: 0.5, g: 500 },
  cuarto_kilo: { kg: 0.25, g: 250 },
  octavo_kilo: { kg: 0.125, g: 125 },
  paquete: {},
  medio_paquete: { paquete: 0.5 },
  cuarto_paquete: { paquete: 0.25 },
  docena: { unidad: 12, paquete: 12, caja: 12 },
  media_docena: { unidad: 6, paquete: 6, caja: 6 },
  cuarto_docena: { unidad: 3, paquete: 3, caja: 3 },
  media_caja: {},
}

export function factorSugerido(clave: ClavePresentacion, unidadBase: string): number | null {
  return FACTOR_SUGERIDO[clave][unidadBase] ?? null
}

function esClave(valor: unknown): valor is ClavePresentacion {
  return typeof valor === 'string' && valor in CATALOGO_PRESENTACIONES
}

/** Presentaciones adicionales válidas del producto (descarta datos corruptos:
 * factor <= 0, precio negativo o clave desconocida), nunca lanza. */
export function presentacionesDe(producto: Pick<Producto, 'presentaciones'>): Presentacion[] {
  const lista = producto.presentaciones
  if (!Array.isArray(lista)) return []
  return lista.filter(
    (p) =>
      !!p &&
      esClave(p.clave) &&
      Number.isFinite(Number(p.factor)) &&
      Number(p.factor) > 0 &&
      Number.isFinite(Number(p.precio)) &&
      Number(p.precio) >= 0,
  )
}

/** Cuántas unidades base del stock consume vender 1 de esta modalidad. */
export function factorModalidad(producto: Producto, modalidad: ModalidadVenta): number {
  if (modalidad === 'unidad') return 1
  if (modalidad === 'caja') return producto.unidades_por_caja ?? 1
  if (modalidad === 'saco') return producto.kg_por_saco ?? 1
  const pres = presentacionesDe(producto).find((p) => p.clave === modalidad)
  return pres ? Number(pres.factor) : 1
}

/** Precio de una presentación ADICIONAL; para cualquier otra modalidad
 * devuelve el precio de venta base (los precios de caja/saco los resuelve
 * cada llamador con sus columnas propias, como siempre). */
export function precioPresentacion(producto: Producto, modalidad: ModalidadVenta): number {
  const pres = presentacionesDe(producto).find((p) => p.clave === modalidad)
  return pres ? Number(pres.precio) : producto.precio_venta
}

/** Nombre corto para tickets y etiquetas; undefined para venta suelta/por unidad. */
export function etiquetaModalidad(modalidad: string): string | undefined {
  if (modalidad === 'caja') return 'Caja'
  if (modalidad === 'saco') return 'Saco'
  return esClave(modalidad) ? CATALOGO_PRESENTACIONES[modalidad].nombre : undefined
}

/** Unidades base de stock que descuenta una línea (cantidad * equivalencia). */
export function unidadesDe(item: { producto: Producto; modalidad: ModalidadVenta; cantidad: number }): number {
  return item.cantidad * factorModalidad(item.producto, item.modalidad)
}

export interface OpcionVenta {
  modalidad: ModalidadVenta
  etiqueta: string
  /** Equivalencia legible, ej. "11.5 kg". */
  detalle?: string
  precio: number
  /** Cuántas se pueden vender con el stock actual. */
  disponible: number
}

// Tolerancia para no perder una presentación por ruido de coma flotante
// (ej. 0.3 / 0.1 = 2.9999999999999996).
const EPS = 1e-9

/** Todas las formas de vender un producto con presentaciones múltiples, con su
 * precio y disponibilidad — alimenta el selector del punto de venta. */
export function opcionesVenta(producto: Producto): OpcionVenta[] {
  const esGranel = producto.tipo_venta === 'granel'
  const stock = Math.max(producto.stock_actual, 0)
  const opciones: OpcionVenta[] = [
    {
      modalidad: 'unidad',
      etiqueta: esGranel ? `Por ${producto.unidad}` : 'Unidad',
      precio: producto.precio_venta,
      disponible: esGranel ? stock : Math.floor(stock + EPS),
    },
  ]
  if (!esGranel && producto.tiene_caja && (producto.unidades_por_caja ?? 0) > 0) {
    const upc = producto.unidades_por_caja as number
    opciones.push({
      modalidad: 'caja',
      etiqueta: 'Caja',
      detalle: `${upc} u.`,
      precio: producto.precio_venta_caja ?? producto.precio_venta,
      disponible: Math.floor(stock / upc + EPS),
    })
  }
  if (esGranel && producto.tiene_saco && (producto.kg_por_saco ?? 0) > 0) {
    const kg = producto.kg_por_saco as number
    opciones.push({
      modalidad: 'saco',
      etiqueta: 'Saco',
      detalle: `${cantidad(kg)} ${producto.unidad}`,
      precio: producto.precio_venta_saco ?? producto.precio_venta,
      disponible: Math.floor(stock / kg + EPS),
    })
  }
  for (const p of presentacionesDe(producto)) {
    const factor = Number(p.factor)
    opciones.push({
      modalidad: p.clave,
      etiqueta: CATALOGO_PRESENTACIONES[p.clave].nombre,
      detalle: `${cantidad(factor)} ${esGranel ? producto.unidad : 'u.'}`,
      precio: Number(p.precio),
      disponible: Math.floor(stock / factor + EPS),
    })
  }
  return opciones
}
