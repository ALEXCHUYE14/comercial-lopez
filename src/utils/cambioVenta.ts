// Lógica de "cambiar el producto de una venta ya registrada" (pantalla
// components/ventas/CambiarProductoVenta.tsx, RPC modificar_venta). Todo lo que
// se calcula aquí solo sirve para MOSTRAR y para validar antes de enviar: el
// servidor recalcula precios, unidades, stock y totales por su cuenta y es
// quien decide.

import { modalidadValida, precioModalidad, unidadesDe } from '@/utils/presentaciones'
import { redondear2 } from '@/utils/pagos'
import type { DetalleVenta, ModalidadVenta, Producto } from '@/types/database'

/** Una línea de la venta en edición. `cantidad` va como texto (es lo que se
 * escribe en el campo) y se valida/convierte al enviar. */
export interface LineaEdicion {
  clave: string
  producto: Producto | null
  modalidad: ModalidadVenta
  cantidad: string
}

export interface ItemEdicion {
  producto_id: string
  cantidad: number
  modalidad: string
}

let contador = 0
export const claveLinea = (): string => `linea_${++contador}`

/** Líneas iniciales a partir del detalle guardado de la venta. Si el producto
 * ya no existe (fue eliminado) la línea queda sin producto: hay que elegir uno
 * nuevo antes de guardar. */
export function lineasDesdeDetalle(detalle: DetalleVenta[], productos: Producto[]): LineaEdicion[] {
  const porId = new Map(productos.map((p) => [p.id, p]))
  return detalle.map((d) => ({
    clave: claveLinea(),
    producto: d.producto_id ? (porId.get(d.producto_id) ?? null) : null,
    modalidad: d.modalidad,
    cantidad: String(d.cantidad),
  }))
}

/** ¿La cantidad de esta línea debe ser entera? Solo el granel vendido suelto
 * (kg, litros) admite decimales; caja, saco, presentaciones y piezas no. */
export function requiereEntero(producto: Producto, modalidad: ModalidadVenta): boolean {
  return !(producto.tipo_venta === 'granel' && modalidad === 'unidad')
}

const cantidadNum = (l: LineaEdicion): number => parseFloat(l.cantidad)

/** Importe de una línea como lo calcula el servidor (numeric exacto, medio
 * hacia arriba a centavos). En punto flotante 2.053 * 55 da 112.91499… y
 * redondearía un centavo de menos, así que se limpia el ruido binario antes. */
function subtotalLinea(precio: number, cantidad: number): number {
  const centavos = Number(((precio * cantidad) * 100).toFixed(6))
  return Math.round(centavos) / 100
}

/** Subtotal / total de la venta editada, con la MISMA aritmética del servidor
 * (registrar_venta / modificar_venta): el subtotal se acumula redondeando a
 * centavos en cada línea, el descuento original se conserva pero nunca supera
 * el subtotal. Las líneas incompletas (sin producto o cantidad válida) no suman. */
export function totalesEdicion(
  lineas: LineaEdicion[],
  descuentoOriginal: number,
): { subtotal: number; descuento: number; total: number } {
  let subtotal = 0
  for (const l of lineas) {
    const c = cantidadNum(l)
    if (!l.producto || !Number.isFinite(c) || c <= 0) continue
    subtotal = redondear2(subtotal + subtotalLinea(precioModalidad(l.producto, l.modalidad), c))
  }
  const descuento = redondear2(Math.min(Math.max(descuentoOriginal, 0), subtotal))
  return { subtotal, descuento, total: redondear2(Math.max(subtotal - descuento, 0)) }
}

export type ResultadoEdicion = { ok: true; items: ItemEdicion[] } | { ok: false; error: string }

/** Validación previa al envío. Cubre lo que el servidor también rechazaría
 * (así el cajero ve el motivo al instante y sin ida y vuelta): producto elegido,
 * cantidad válida, presentación vigente, cantidad entera cuando corresponde, y
 * stock — que cuenta lo que esta misma venta ya tenía apartado (esas unidades
 * vuelven al stock al guardar). */
export function validarEdicion(
  lineas: LineaEdicion[],
  detalleOriginal: DetalleVenta[],
  descuentoOriginal = 0,
): ResultadoEdicion {
  if (lineas.length === 0) return { ok: false, error: 'La venta debe tener al menos un producto.' }

  const items: ItemEdicion[] = []
  const necesarias = new Map<string, number>()
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]
    const n = i + 1
    if (!l.producto) return { ok: false, error: `Elige el producto de la línea ${n}.` }
    const c = cantidadNum(l)
    if (!Number.isFinite(c) || c <= 0) {
      return { ok: false, error: `${l.producto.nombre}: indica una cantidad mayor a 0.` }
    }
    if (requiereEntero(l.producto, l.modalidad) && !Number.isInteger(c)) {
      return { ok: false, error: `${l.producto.nombre}: la cantidad debe ser un número entero.` }
    }
    if (!modalidadValida(l.producto, l.modalidad)) {
      return {
        ok: false,
        error: `${l.producto.nombre}: la presentación elegida ya no está disponible, elige otra.`,
      }
    }
    items.push({ producto_id: l.producto.id, cantidad: c, modalidad: l.modalidad })
    necesarias.set(l.producto.id, (necesarias.get(l.producto.id) ?? 0) + unidadesDe({ producto: l.producto, modalidad: l.modalidad, cantidad: c }))
  }

  // Stock disponible = el actual + lo que esta venta ya tenia (vuelve al guardar).
  const devueltas = new Map<string, number>()
  for (const d of detalleOriginal) {
    if (d.producto_id) devueltas.set(d.producto_id, (devueltas.get(d.producto_id) ?? 0) + Number(d.unidades ?? 0))
  }
  for (const l of lineas) {
    const p = l.producto as Producto
    const disponible = p.stock_actual + (devueltas.get(p.id) ?? 0)
    const pide = necesarias.get(p.id) ?? 0
    if (pide > disponible + 1e-9) {
      const unidadTxt = p.tipo_venta === 'granel' ? p.unidad : 'u.'
      return {
        ok: false,
        error: `Stock insuficiente para ${p.nombre}: disponible ${Math.round(disponible * 1000) / 1000} ${unidadTxt}, pides ${Math.round(pide * 1000) / 1000}.`,
      }
    }
  }

  if (totalesEdicion(lineas, descuentoOriginal).total <= 0) {
    return { ok: false, error: 'El total de la venta debe ser mayor a 0.' }
  }
  return { ok: true, items }
}

/** Qué implica para el cliente / la caja la diferencia entre el total anterior
 * y el nuevo, según cómo se cobró la venta. */
export function textoDiferencia(metodo: string, delta: number, formato: (n: number) => string): string {
  const d = redondear2(delta)
  if (d === 0) return 'El total no cambia.'
  const monto = formato(Math.abs(d))
  if (metodo === 'fiado') {
    return d > 0 ? `La deuda del cliente sube ${monto}.` : `La deuda del cliente baja ${monto}.`
  }
  const por = metodo === 'yape' ? ' por Yape' : metodo === 'efectivo' ? ' en efectivo' : ''
  return d > 0 ? `El cliente debe pagar ${monto} más${por}.` : `Devolver ${monto} al cliente${por}.`
}
