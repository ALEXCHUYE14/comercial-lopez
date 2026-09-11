import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { ConfiguracionCaja } from '@/types/database'

// Valores por defecto mientras carga o si la fila aun no existe en la BD
// (el script de schema.sql la siembra, pero esto evita una pantalla vacia
// si algun proyecto todavia no corrio esa migracion).
const CONFIG_POR_DEFECTO: ConfiguracionCaja = {
  id: 1,
  umbral_tolerancia_faltante: 5,
  umbral_alerta_critica: 20,
  actualizado_por: null,
  actualizado_en: new Date().toISOString(),
}

/**
 * Politicas de tolerancia del arqueo a ciegas (ver RPC cerrar_caja_arqueo en
 * supabase/schema.sql): fila unica editable solo por el administrador desde
 * Configuracion. La evaluacion real del cierre de caja siempre ocurre en el
 * servidor contra estos mismos umbrales — este hook es solo para mostrarlos/
 * editarlos en pantalla, nunca se usa para calcular un arqueo en el cliente.
 */
export function useConfiguracionCaja() {
  const [config, setConfig] = useState<ConfiguracionCaja>(CONFIG_POR_DEFECTO)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data } = await supabase
      .from('configuracion_caja')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
    if (data) setConfig(data)
    setCargando(false)
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function guardar(
    umbralTolerancia: number,
    umbralCritico: number,
    usuarioId: string | null,
  ): Promise<ConfiguracionCaja> {
    setGuardando(true)
    try {
      const { data, error } = await supabase
        .from('configuracion_caja')
        .upsert({
          id: 1,
          umbral_tolerancia_faltante: umbralTolerancia,
          umbral_alerta_critica: umbralCritico,
          actualizado_por: usuarioId,
          actualizado_en: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw error
      setConfig(data)
      return data
    } finally {
      setGuardando(false)
    }
  }

  return { config, cargando, guardando, guardar, recargar: cargar }
}
