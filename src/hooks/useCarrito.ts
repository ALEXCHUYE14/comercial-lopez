import { useMemo, useState, useCallback } from 'react'
import { factorModalidad, modalidadValida, precioPresentacion, unidadesDe } from '@/utils/presentaciones'
import type { LineaGuardada } from '@/utils/carritoPersistido'
import type { ItemCarrito, ModalidadVenta, Producto } from '@/types/database'

const TASA_IGV = 0.18

function itemKey(productoId: string, modalidad: ModalidadVenta) {
  return `${productoId}::${modalidad}`
}

function precioItem(item: ItemCarrito): number {
  if (item.modalidad === 'caja') {
    return item.producto.precio_venta_caja ?? item.producto.precio_venta
  }
  if (item.modalidad === 'saco') {
    return item.producto.precio_venta_saco ?? item.producto.precio_venta
  }
  return precioPresentacion(item.producto, item.modalidad)
}

// `reservado` = unidades base que ya ocupan OTRAS líneas del mismo producto en
// el carrito (ej. 1 saco de 50 kg + kg sueltos): el tope de esta línea sale del
// stock que queda libre, no del stock total, para no vender dos veces lo mismo.
function maxCantidad(producto: Producto, modalidad: ModalidadVenta, reservado = 0): number {
  const libre = Math.max(producto.stock_actual - reservado, 0)
  if (modalidad === 'caja') {
    return Math.floor(libre / (producto.unidades_por_caja ?? 1))
  }
  if (modalidad === 'saco') {
    return Math.floor(libre / (producto.kg_por_saco ?? 1))
  }
  if (modalidad !== 'unidad') {
    // Presentación adicional (arroba, docena, ...): cantidad entera de presentaciones.
    return Math.floor(libre / factorModalidad(producto, modalidad) + 1e-9)
  }
  return libre
}

function reservadoPorOtras(items: ItemCarrito[], productoId: string, modalidad: ModalidadVenta): number {
  return items
    .filter((i) => i.producto.id === productoId && i.modalidad !== modalidad)
    .reduce((s, i) => s + unidadesDe(i), 0)
}

export interface CarritoReconstruido {
  items: ItemCarrito[]
  /** Líneas que no se pudieron recuperar (producto eliminado/desactivado,
   * presentación que ya no existe o sin stock). */
  omitidas: number
  /** Líneas cuya cantidad se redujo porque el stock actual ya no alcanza. */
  ajustadas: number
}

/** Reconstruye el carrito guardado contra los productos ACTUALES (precio, stock
 * y presentaciones vigentes tras una actualización o un cambio en el
 * inventario): nunca se restaura un producto ni un precio viejo. Reutiliza el
 * mismo tope de stock que aplica `agregar` (incluido lo reservado por otras
 * líneas del mismo producto), así el carrito restaurado siempre es válido.
 * Función pura: no toca React ni el almacenamiento. */
export function reconstruirCarrito(lineas: LineaGuardada[], productos: Producto[]): CarritoReconstruido {
  const porId = new Map(productos.map((p) => [p.id, p]))
  const items: ItemCarrito[] = []
  let omitidas = 0
  let ajustadas = 0
  for (const l of lineas) {
    const producto = porId.get(l.productoId)
    if (!producto || !modalidadValida(producto, l.modalidad) || !(l.cantidad > 0)) {
      omitidas++
      continue
    }
    const idx = items.findIndex((i) => i.producto.id === producto.id && i.modalidad === l.modalidad)
    const yaEnCarrito = idx >= 0 ? items[idx].cantidad : 0
    const max = maxCantidad(producto, l.modalidad, reservadoPorOtras(items, producto.id, l.modalidad))
    const deseada = yaEnCarrito + l.cantidad
    const cantidad = Math.min(deseada, max)
    if (!(cantidad > 0)) {
      omitidas++
      continue
    }
    if (cantidad < deseada - 1e-9) ajustadas++
    if (idx >= 0) items[idx] = { ...items[idx], cantidad }
    else items.push({ producto, cantidad, modalidad: l.modalidad })
  }
  return { items, omitidas, ajustadas }
}

export interface CarritoSincronizado extends CarritoReconstruido {
  /** Hubo algun cambio respecto del carrito actual (precio, stock, producto). */
  cambio: boolean
  /** Lineas cuyo precio cambio (el administrador lo edito mientras tanto). */
  preciosCambiados: number
}

/** Pone al dia el carrito en curso con los productos ACTUALES. Cada linea
 * guarda una copia del producto del momento en que se agrego: sin esto, si el
 * administrador cambiaba un precio (o otro equipo vendia stock) con el
 * carrito ya armado, el POS seguia mostrando y cobrando el precio viejo
 * mientras el servidor registraba la venta con el nuevo — el total cobrado,
 * el ticket y el vuelto no coincidian con lo registrado. Función pura. */
export function sincronizarCarrito(items: ItemCarrito[], productos: Producto[]): CarritoSincronizado {
  const r = reconstruirCarrito(
    items.map((i) => ({ productoId: i.producto.id, modalidad: i.modalidad, cantidad: i.cantidad })),
    productos,
  )
  let preciosCambiados = 0
  let cambio = r.items.length !== items.length
  for (const nuevo of r.items) {
    const viejo = items.find((i) => i.producto.id === nuevo.producto.id && i.modalidad === nuevo.modalidad)
    if (!viejo) {
      cambio = true
      continue
    }
    if (viejo.producto !== nuevo.producto || Math.abs(viejo.cantidad - nuevo.cantidad) > 1e-9) cambio = true
    if (Math.abs(precioItem(viejo) - precioItem(nuevo)) > 0.0001) preciosCambiados++
  }
  return { ...r, cambio, preciosCambiados }
}

export function useCarrito() {
  const [items, setItems] = useState<ItemCarrito[]>([])
  const [descuento, setDescuento] = useState(0)

  const agregar = useCallback(
    (producto: Producto, modalidad: ModalidadVenta = 'unidad', cantidad = 1) => {
      setItems((prev) => {
        const key = itemKey(producto.id, modalidad)
        const idx = prev.findIndex(
          (i) => itemKey(i.producto.id, i.modalidad) === key,
        )
        const max = maxCantidad(producto, modalidad, reservadoPorOtras(prev, producto.id, modalidad))
        if (max <= 0) return prev
        if (idx >= 0) {
          const copia = [...prev]
          const nuevaCant = Math.min(copia[idx].cantidad + cantidad, max)
          copia[idx] = { ...copia[idx], cantidad: nuevaCant } as ItemCarrito
          return copia
        }
        return [
          ...prev,
          { producto, cantidad: Math.min(cantidad, max), modalidad },
        ]
      })
    },
    [],
  )

  const cambiarCantidad = useCallback(
    (productoId: string, modalidad: ModalidadVenta, cantidad: number) => {
      setItems((prev) =>
        prev
          .map((i) =>
            i.producto.id === productoId && i.modalidad === modalidad
              ? {
                  ...i,
                  cantidad: Math.max(
                    0,
                    Math.min(
                      cantidad,
                      maxCantidad(i.producto, modalidad, reservadoPorOtras(prev, productoId, modalidad)),
                    ),
                  ),
                }
              : i,
          )
          .filter((i) => i.cantidad > 0),
      )
    },
    [],
  )

  const quitar = useCallback(
    (productoId: string, modalidad: ModalidadVenta) => {
      setItems((prev) =>
        prev.filter(
          (i) => !(i.producto.id === productoId && i.modalidad === modalidad),
        ),
      )
    },
    [],
  )

  const limpiar = useCallback(() => {
    setItems([])
    setDescuento(0)
  }, [])

  // Recupera un carrito guardado (ver utils/carritoPersistido.ts). Los items
  // deben venir de `reconstruirCarrito`, ya validados contra el stock actual.
  const restaurar = useCallback((nuevos: ItemCarrito[], desc: number) => {
    setItems(nuevos)
    setDescuento(Number.isFinite(desc) && desc > 0 ? desc : 0)
  }, [])

  const totales = useMemo(() => {
    const subtotal = items.reduce(
      (s, i) => s + precioItem(i) * i.cantidad,
      0,
    )
    const desc = Math.min(descuento, subtotal)
    const total = Math.max(subtotal - desc, 0)
    const base = total / (1 + TASA_IGV)
    const igv = total - base
    const unidades = items.reduce((s, i) => s + i.cantidad, 0)
    return {
      subtotal: round(subtotal),
      descuento: round(desc),
      igv: round(igv),
      total: round(total),
      unidades,
    }
  }, [items, descuento])

  return {
    items,
    descuento,
    setDescuento,
    agregar,
    cambiarCantidad,
    quitar,
    limpiar,
    restaurar,
    totales,
    vacio: items.length === 0,
  }
}

function round(n: number) {
  return Math.round(n * 100) / 100
}
