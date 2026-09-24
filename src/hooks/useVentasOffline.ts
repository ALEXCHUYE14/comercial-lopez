import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import {
  encolarVentaOffline,
  listarVentasOffline,
  eliminarVentaOffline,
  actualizarVentaOffline,
  pareceErrorDeRed,
  type VentaOffline,
} from '@/utils/offlineDB'
import { precioPresentacion } from '@/utils/presentaciones'
import type { ItemCarrito, Venta } from '@/types/database'

function precioItem(item: ItemCarrito): number {
  if (item.modalidad === 'caja') return item.producto.precio_venta_caja ?? item.producto.precio_venta
  if (item.modalidad === 'saco') return item.producto.precio_venta_saco ?? item.producto.precio_venta
  return precioPresentacion(item.producto, item.modalidad)
}

/**
 * Cola de ventas registradas sin conexion (ver utils/offlineDB.ts) y su
 * sincronizacion contra registrar_venta cuando vuelve internet. El llamador
 * (POS.tsx) provee `aplicarEfectosVenta`, que replica los efectos
 * secundarios de una venta exitosa (sumar a caja, etc.) SOLO en el momento
 * en que esa venta ya quedo confirmada en el servidor — nunca antes.
 */
export function useVentasOffline(
  aplicarEfectosVenta: (venta: Venta, pendiente: VentaOffline) => Promise<void>,
  onAdvertencia?: (mensaje: string) => void,
) {
  const [pendientes, setPendientes] = useState<VentaOffline[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const [sincronizando, setSincronizando] = useState(false)
  const sincronizandoRef = useRef(false)

  const recargar = useCallback(async () => {
    try {
      setPendientes(await listarVentasOffline())
    } catch {
      // Si IndexedDB no esta disponible (modo privado estricto, etc.) la
      // cola offline simplemente no persiste — no debe tumbar el POS.
    }
  }, [])

  const sincronizar = useCallback(async () => {
    if (sincronizandoRef.current || !navigator.onLine) return
    sincronizandoRef.current = true
    setSincronizando(true)
    try {
      const lista = await listarVentasOffline()
      for (const pendiente of lista) {
        const items = pendiente.itemsCarrito.map((i) => ({
          producto_id: i.producto.id,
          cantidad: i.cantidad,
          precio_unitario: precioItem(i),
          modalidad: i.modalidad,
        }))
        try {
          const { data, error } = await supabase.rpc('registrar_venta', {
            p_items: items,
            p_metodo: pendiente.metodo,
            p_descuento: pendiente.descuento,
            p_pago_recibido: pendiente.pagoRecibido,
            p_caja_id: pendiente.cajaId,
            p_cliente_id: null,
            p_idempotency_key: pendiente.clientId,
          })
          if (error) throw error

          // A partir de aqui la venta YA quedo registrada en el servidor de
          // forma seguRa e idempotente (gracias a p_idempotency_key: un
          // reintento con la misma clave nunca la duplica). Por eso se saca
          // de la cola ANTES de aplicar los efectos secundarios (sumar a
          // caja) y no despues: si se dejara en la cola para reintentar
          // ante un fallo de aplicarEfectosVenta, un reintento correria el
          // riesgo real de acreditar el monto a la caja DOS veces (si el
          // primer incrementar_caja si llego a buen puerto pero su
          // respuesta se perdio en el camino) — incrementar_caja, a
          // diferencia de registrar_venta, no es idempotente. Es exactamente
          // la misma decision que ya toma el camino online en POS.tsx: si
          // sumarVenta falla despues de una venta ya registrada, se avisa
          // como advertencia en vez de reintentar.
          await eliminarVentaOffline(pendiente.clientId)
          try {
            await aplicarEfectosVenta(data as unknown as Venta, pendiente)
          } catch {
            onAdvertencia?.(
              `La venta de ${pendiente.itemsCarrito.length} producto(s) se sincronizó, pero no se pudo acreditar a la caja. Revisa el cierre de caja.`,
            )
          }
        } catch (e) {
          if (pareceErrorDeRed(e)) {
            // Se corto la conexion a mitad de la cola: se detiene todo el
            // intento (los siguientes fallarian igual) y se reintenta en el
            // proximo evento "online" o el siguiente tick del intervalo.
            break
          }
          // El servidor SI respondio, y respondio con un error real (ej. el
          // stock ya no alcanza porque otro dispositivo vendio lo ultimo
          // mientras este estaba offline). Se guarda el motivo y se sigue
          // con las demas ventas encoladas — un item invalido no debe
          // trabar la sincronizacion del resto.
          const actualizado: VentaOffline = {
            ...pendiente,
            intentos: pendiente.intentos + 1,
            ultimoError: e instanceof Error ? e.message : 'No se pudo sincronizar.',
          }
          await actualizarVentaOffline(actualizado)
        }
      }
    } finally {
      sincronizandoRef.current = false
      setSincronizando(false)
      await recargar()
    }
  }, [aplicarEfectosVenta, onAdvertencia, recargar])

  const encolar = useCallback(
    async (venta: VentaOffline) => {
      await encolarVentaOffline(venta)
      await recargar()
    },
    [recargar],
  )

  const descartar = useCallback(
    async (clientId: string) => {
      await eliminarVentaOffline(clientId)
      await recargar()
    },
    [recargar],
  )

  useEffect(() => {
    recargar()
  }, [recargar])

  // Reintenta automaticamente al recuperar conexion, y cada 30s mientras
  // haya pendientes (por si "online" del navegador da falso positivo, ej.
  // conectado a un WiFi sin salida real a internet).
  useEffect(() => {
    function marcarOnline() {
      setOnline(true)
      sincronizarRef.current()
    }
    function marcarOffline() {
      setOnline(false)
    }
    window.addEventListener('online', marcarOnline)
    window.addEventListener('offline', marcarOffline)
    return () => {
      window.removeEventListener('online', marcarOnline)
      window.removeEventListener('offline', marcarOffline)
    }
    // Sin dependencias: el listener se registra UNA sola vez y siempre llama
    // a la version mas reciente de sincronizar via el ref (ver mas abajo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `sincronizar` cambia de identidad en cada render (depende de
  // aplicarEfectosVenta, que POS.tsx no memoiza) — sin este ref, tanto el
  // listener de arriba como el intervalo de abajo se re-crearian en cada
  // render, y el setInterval de 30s nunca llegaria a completar un ciclo
  // completo antes de ser reemplazado, con lo que el reintento automatico
  // periodico jamas dispararia en la practica.
  const sincronizarRef = useRef(sincronizar)
  useEffect(() => {
    sincronizarRef.current = sincronizar
  }, [sincronizar])

  useEffect(() => {
    if (pendientes.length === 0) return
    const id = setInterval(() => sincronizarRef.current(), 30_000)
    return () => clearInterval(id)
  }, [pendientes.length])

  return { pendientes, online, sincronizando, encolar, sincronizar, descartar }
}
