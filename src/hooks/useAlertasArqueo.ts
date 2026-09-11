import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { AlertaArqueo } from '@/types/database'

/**
 * Feed de alertas de arqueo (descuadres de caja fuera de tolerancia) en
 * tiempo real — solo administrador/supervisor pueden leerlo (ver politica
 * alertas_arqueo_select en supabase/schema.sql); para cualquier otro rol
 * simplemente vuelve vacio (RLS filtra en el servidor, no hace falta
 * chequear el rol aqui tambien).
 */
export function useAlertasArqueo(limite = 50) {
  const [alertas, setAlertas] = useState<AlertaArqueo[]>([])
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data } = await supabase
      .from('alertas_arqueo')
      .select('*')
      .order('creado_en', { ascending: false })
      .limit(limite)
    setAlertas(data ?? [])
    setCargando(false)
  }, [limite])

  useEffect(() => {
    cargar()

    const canal = supabase
      .channel('rt-alertas-arqueo')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alertas_arqueo' },
        (payload) => {
          const a = payload.new as AlertaArqueo
          setAlertas((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev]))
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'alertas_arqueo' },
        (payload) => {
          const a = payload.new as AlertaArqueo
          setAlertas((prev) => prev.map((x) => (x.id === a.id ? a : x)))
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(canal)
    }
  }, [cargar])

  async function marcarLeida(id: string): Promise<void> {
    const { data, error } = await supabase.rpc('marcar_alerta_leida', { p_alerta_id: id })
    if (error) throw error
    setAlertas((prev) => prev.map((x) => (x.id === id ? (data as AlertaArqueo) : x)))
  }

  const noLeidas = alertas.filter((a) => !a.leida)
  const criticasNoLeidas = noLeidas.filter((a) => a.tipo === 'critico')

  return { alertas, cargando, recargar: cargar, marcarLeida, noLeidas, criticasNoLeidas }
}
