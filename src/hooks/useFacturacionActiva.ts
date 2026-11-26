import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * ¿Esta activada la emision de boletas/facturas (Ajustes → Facturacion
 * electronica)? null mientras carga. Ante cualquier falla (sin internet, SQL
 * aun no ejecutado) responde false: la pantalla queda como antes, solo con
 * la nota de venta.
 */
export function useFacturacionActiva(): boolean | null {
  const [activa, setActiva] = useState<boolean | null>(null)
  useEffect(() => {
    let vivo = true
    supabase
      .from('facturacion_config')
      .select('activo')
      .eq('id', 1)
      .maybeSingle()
      .then(
        ({ data, error }) => {
          if (vivo) setActiva(!error && !!data?.activo)
        },
        () => {
          if (vivo) setActiva(false)
        },
      )
    return () => {
      vivo = false
    }
  }, [])
  return activa
}
