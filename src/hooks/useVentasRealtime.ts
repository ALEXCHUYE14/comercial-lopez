import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { inicioDelDia, finDelDia } from '@/utils/format'
import { traerTodas } from '@/utils/paginar'
import type { Venta } from '@/types/database'

const MIN_MS_ENTRE_RECARGAS = 15_000

/**
 * Suscripcion en tiempo real a las ventas del dia.
 * Cuando el POS registra una venta, el dashboard se actualiza al instante.
 */
export function useVentasRealtime() {
  const [ventas, setVentas] = useState<Venta[]>([])
  const [cargando, setCargando] = useState(true)
  const peticionRef = useRef(0)
  const ultimaRecargaRef = useRef(0)

  const cargar = useCallback(async () => {
    const id = ++peticionRef.current
    ultimaRecargaRef.current = Date.now()
    try {
      // Paginado: Supabase entrega maximo 1000 filas por consulta.
      const data = await traerTodas<Venta>((ini, fin) =>
        supabase
          .from('ventas')
          .select('*')
          .gte('creado_en', inicioDelDia().toISOString())
          .lte('creado_en', finDelDia().toISOString())
          .eq('anulada', false)
          .order('creado_en', { ascending: true })
          .order('id', { ascending: true })
          .range(ini, fin),
      )
      if (id !== peticionRef.current) return
      setVentas(data.reverse())
    } catch {
      // Sin conexion: se conserva lo que ya se mostraba; se reintenta al
      // volver la conexion o al regresar a la pantalla.
    } finally {
      if (id === peticionRef.current) setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()

    let suscritoAntes = false
    const canal = supabase
      // Nombre unico por instancia (dos pantallas no deben compartir canal).
      .channel(`rt-ventas-${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ventas' },
        (payload) => {
          const v = payload.new as Venta
          // Solo ventas de hoy y no anuladas
          if (new Date(v.creado_en) >= inicioDelDia() && !v.anulada) {
            setVentas((prev) =>
              prev.some((x) => x.id === v.id) ? prev : [v, ...prev],
            )
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'ventas' },
        (payload) => {
          const v = payload.new as Venta
          setVentas((prev) =>
            v.anulada
              ? prev.filter((x) => x.id !== v.id)
              : prev.map((x) => (x.id === v.id ? v : x)),
          )
        },
      )
      .subscribe((estado) => {
        // Las ventas hechas mientras el canal estuvo caido no se reenvian:
        // al reconectar se recarga todo para no "perderlas" de la vista.
        if (estado === 'SUBSCRIBED') {
          if (suscritoAntes) cargar()
          suscritoAntes = true
        }
      })

    function recargarSiHaceFalta() {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - ultimaRecargaRef.current < MIN_MS_ENTRE_RECARGAS) return
      cargar()
    }
    document.addEventListener('visibilitychange', recargarSiHaceFalta)
    window.addEventListener('online', recargarSiHaceFalta)
    window.addEventListener('focus', recargarSiHaceFalta)

    return () => {
      document.removeEventListener('visibilitychange', recargarSiHaceFalta)
      window.removeEventListener('online', recargarSiHaceFalta)
      window.removeEventListener('focus', recargarSiHaceFalta)
      supabase.removeChannel(canal)
    }
  }, [cargar])

  return { ventas, cargando, recargar: cargar }
}
