import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { inicioDelDia, finDelDia } from '@/utils/format'
import { traerTodas } from '@/utils/paginar'
import type { Venta } from '@/types/database'

// Plan Free de Supabase (trafico y mensajes limitados): mientras el tiempo
// real funcione, los cambios de ventas llegan solos y recargar la lista
// completa es trafico desperdiciado. Solo se recarga todo cuando la vista PUDO
// quedar desactualizada: el canal se cayo (internet intermitente, equipo
// suspendido) o se recupero la conexion. Como red de seguridad, al volver a la
// pantalla se recarga tambien si la ultima carga completa tiene mas de 30 min.
const RECARGA_RESPALDO_MS = 30 * 60_000

/**
 * Suscripcion en tiempo real a las ventas del dia.
 * Cuando el POS registra una venta, el dashboard se actualiza al instante.
 */
export function useVentasRealtime() {
  const [ventas, setVentas] = useState<Venta[]>([])
  const [cargando, setCargando] = useState(true)
  const peticionRef = useRef(0)
  const ultimaRecargaRef = useRef(0)
  // true = pudieron perderse cambios en tiempo real desde la ultima carga.
  const desfaseRef = useRef(false)

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
      desfaseRef.current = false
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
          if (suscritoAntes || desfaseRef.current) cargar()
          suscritoAntes = true
        } else if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
          desfaseRef.current = true
        }
      })

    function recargarSiHaceFalta() {
      if (document.visibilityState !== 'visible') return
      const vieja = Date.now() - ultimaRecargaRef.current > RECARGA_RESPALDO_MS
      if (desfaseRef.current || vieja) cargar()
    }
    function alRecuperarInternet() {
      desfaseRef.current = true
      recargarSiHaceFalta()
    }
    document.addEventListener('visibilitychange', recargarSiHaceFalta)
    window.addEventListener('online', alRecuperarInternet)
    window.addEventListener('focus', recargarSiHaceFalta)

    return () => {
      document.removeEventListener('visibilitychange', recargarSiHaceFalta)
      window.removeEventListener('online', alRecuperarInternet)
      window.removeEventListener('focus', recargarSiHaceFalta)
      supabase.removeChannel(canal)
    }
  }, [cargar])

  return { ventas, cargando, recargar: cargar }
}
