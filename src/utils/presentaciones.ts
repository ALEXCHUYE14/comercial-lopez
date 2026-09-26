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
  // "tipo: 'granel'" describe el caso más común (fraccionar por peso), pero
  // medio/cuarto de paquete también se ofrecen con tipo_venta 'unidad' cuando
  // la unidad base es "paquete" — ej. paquetes cerrados que a veces se venden
  // partidos sin pesarlos — ver clavesDisponibles más abajo.
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
    const claves = [...CLAVES_UNIDAD]
    // Paquete / Medio paquete / Cuarto de paquete tambien se ofrecen con
    // tipo_venta 'unidad', sin importar la unidad base elegida (unidad,
    // caja, docena, ...): ej. un producto que se cuenta por piezas pero
    // viene en paquetes de N piezas que a veces se venden partidos. Cada
    // presentacion indica cuantas piezas consume (equivalencia manual, con
    // sugerencia partiendo del "Paquete" ya definido — ver ProductForm).
    // "Paquete" (completo) se omite solo cuando la base YA ES "paquete": ahi
    // seria el mismo precio base, redundante. Mismo criterio que ya rige
    // para tipo_venta='granel' (ver CLAVES_GRANEL_POR_UNIDAD).
    if (unidadBase !== 'paquete') claves.push('paquete')
    claves.push('medio_paquete', 'cuarto_paquete')
    // "Media caja" solo tiene sentido si el producto YA vende por caja
    // completa: ahí se conoce cuántas unidades trae (unidades_por_caja), que
    // es lo que se sugiere partir a la mitad. Sin caja configurada no hay de
    // qué tomar "la mitad", asi que no se ofrece.
    if (tieneCaja) claves.push('media_caja')
    return claves
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

/** Verdadero si la clave es una de las ~15 presentaciones fijas del catálogo
 * (arroba, docena, ...). Una presentación PERSONALIZADA (ver más abajo) es
 * igual de válida para vender/descontar stock, pero no pasa esta prueba — se
 * usa solo para decidir de dónde sale el nombre a mostrar (del catálogo fijo,
 * o del que el negocio escribió) y, en ProductForm, para separar los
 * interruptores fijos de las filas personalizadas al cargar un producto. */
export function esClaveConocida(valor: unknown): valor is ClavePresentacion {
  return typeof valor === 'string' && valor in CATALOGO_PRESENTACIONES
}

// Prefijo de toda clave generada para una presentación personalizada (ver
// clavePersonalizada). Garantiza, pase lo que pase escriba el usuario como
// nombre, que una clave personalizada JAMÁS choque con una del catálogo fijo
// (ninguna clave fija empieza con este prefijo).
const PREFIJO_PERSONALIZADA = 'personalizada__'

export function esClavePersonalizada(clave: string): boolean {
  return clave.startsWith(PREFIJO_PERSONALIZADA)
}

/** Genera una clave estable (slug ascii, sin espacios/tildes) a partir de un
 * nombre libre para una presentación personalizada — ej. "Bolsa" -> algo como
 * "personalizada__bolsa". `existentes` son las claves YA usadas por este
 * mismo producto (fijas activas + otras personalizadas): si hay choque, se
 * agrega un sufijo numérico para no pisar una presentación distinta. */
export function clavePersonalizada(nombre: string, existentes: Iterable<string>): string {
  const slug = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes/diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = PREFIJO_PERSONALIZADA + (slug || 'presentacion')
  const usadas = new Set(existentes)
  if (!usadas.has(base)) return base
  let n = 2
  while (usadas.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

// Plantilla para huevos: además de Docena / Media docena (que ya existen como
// presentaciones fijas, 12 y 6 unidades) se venden por Plancha, Ciento y Jaba.
// Cada equivalencia es en UNIDADES (el stock de huevos se lleva por unidad).
// Ojo: la plancha estándar en Perú trae 30 huevos y la jaba 360 (12 planchas),
// pero es solo el valor inicial — queda editable en el formulario por si el
// proveedor del negocio maneja otra cantidad.
export const PLANTILLA_HUEVOS: { nombre: string; factor: number }[] = [
  { nombre: 'Media plancha', factor: 15 },
  { nombre: 'Plancha', factor: 30 },
  { nombre: 'Medio ciento', factor: 50 },
  { nombre: 'Ciento', factor: 100 },
  { nombre: 'Media jaba', factor: 180 },
  { nombre: 'Jaba', factor: 360 },
]

/** Filas de la plantilla de huevos que AÚN no existen (comparación por nombre,
 * sin distinguir mayúsculas/espacios): aplicar la plantilla dos veces, o sobre
 * un producto que ya tiene "Jaba" configurada, nunca duplica ni pisa nada. */
export function filasFaltantesPlantillaHuevos(
  nombresExistentes: Iterable<string>,
): { nombre: string; factor: number }[] {
  const usados = new Set([...nombresExistentes].map((n) => n.trim().toLowerCase()))
  return PLANTILLA_HUEVOS.filter((p) => !usados.has(p.nombre.toLowerCase()))
}

/** Verdadero si el valor tiene la forma mínima de una Presentacion utilizable:
 * clave y nombre no vacíos, factor > 0, precio >= 0. A propósito NO exige que
 * la clave esté en el catálogo fijo — admite presentaciones personalizadas
 * (jerarquías de empaque propias del negocio, ej. "Bolsa", "Paquete Maestro"). */
function esPresentacionValida(p: unknown): p is Presentacion {
  if (!p || typeof p !== 'object') return false
  const x = p as Record<string, unknown>
  return (
    typeof x.clave === 'string' &&
    x.clave.length > 0 &&
    typeof x.nombre === 'string' &&
    x.nombre.trim().length > 0 &&
    Number.isFinite(Number(x.factor)) &&
    Number(x.factor) > 0 &&
    Number.isFinite(Number(x.precio)) &&
    Number(x.precio) >= 0
  )
}

/** Presentaciones adicionales válidas del producto — catálogo fijo o
 * personalizadas por igual (descarta datos corruptos: factor <= 0, precio
 * negativo, nombre o clave vacíos), nunca lanza. */
export function presentacionesDe(producto: Pick<Producto, 'presentaciones'>): Presentacion[] {
  const lista = producto.presentaciones
  if (!Array.isArray(lista)) return []
  return lista.filter(esPresentacionValida)
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

/** Nombre corto para tickets y etiquetas a partir SOLO del texto de la
 * modalidad (sin acceso al producto ni a datos congelados de la venta):
 * cubre 'caja'/'saco' y las claves del catálogo fijo. Para una presentación
 * personalizada (que no tiene nombre fijo en el código) esto SIEMPRE devuelve
 * undefined — se usa como último recurso cuando no hay nada mejor a mano; ver
 * `etiquetaModalidadDe` (carrito/ticket en vivo) y `detalle_ventas.modalidad_nombre`
 * (ventas ya archivadas) para el nombre correcto en esos casos. */
export function etiquetaModalidad(modalidad: string): string | undefined {
  if (modalidad === 'caja') return 'Caja'
  if (modalidad === 'saco') return 'Saco'
  return esClaveConocida(modalidad) ? CATALOGO_PRESENTACIONES[modalidad].nombre : undefined
}

/** Nombre a mostrar para una línea de venta EN VIVO (carrito, ticket recién
 * emitido, selector del POS) — a diferencia de `etiquetaModalidad`, sí
 * resuelve presentaciones personalizadas, leyendo el nombre que el propio
 * producto tiene guardado para esa clave. Para una venta ya archivada usa en
 * su lugar `detalle_ventas.modalidad_nombre` (nombre congelado al momento de
 * la venta), no esta función — el producto pudo cambiar desde entonces. */
export function etiquetaModalidadDe(producto: Producto, modalidad: ModalidadVenta): string | undefined {
  const propia = presentacionesDe(producto).find((p) => p.clave === modalidad)?.nombre
  return propia ?? etiquetaModalidad(modalidad)
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
      // Nombre propio de la presentación (siempre presente, sea del catálogo
      // fijo o personalizada) — NUNCA se re-deriva del catálogo aquí, porque
      // una clave personalizada no existe en CATALOGO_PRESENTACIONES y esa
      // indexación lanzaría (TypeError: Cannot read properties of undefined).
      etiqueta: p.nombre,
      detalle: `${cantidad(factor)} ${esGranel ? producto.unidad : 'u.'}`,
      precio: Number(p.precio),
      disponible: Math.floor(stock / factor + EPS),
    })
  }
  return opciones
}
