import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { CategoriaEgreso, Egreso, MetodoEgreso } from '@/types/database'

export function useEgresos(desde: Date, hasta: Date) {
  const [egresos, setEgresos] = useState<Egreso[]>([])
  const [cargando, setCargando] = useState(true)

  // Use getTime() (primitivo) para comparar por valor, no por referencia.
  // Sin esto, un new Date() creado inline en el padre en cada render
  // provocaria un loop infinito de recargas.
  const desdeMs = desde.getTime()
  const hastaMs = hasta.getTime()

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data } = await supabase
      .from('egresos')
      .select('*')
      .gte('creado_en', new Date(desdeMs).toISOString())
      .lte('creado_en', new Date(hastaMs).toISOString())
      .order('creado_en', { ascending: false })
    setEgresos(data ?? [])
    setCargando(false)
  }, [desdeMs, hastaMs])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function registrar(e: {
    concepto: string
    categoria: CategoriaEgreso
    monto: number
    metodo: MetodoEgreso
    proveedor_id: string | null
    notas: string | null
    caja_id: string | null
  }): Promise<Egreso> {
    // El RPC valida (concepto, monto > 0, efectivo disponible en caja si
    // corresponde) y — si se indica una caja abierta — resta el monto de su
    // saldo disponible de inmediato, todo en una unica transaccion atomica.
    const { data, error } = await supabase.rpc('registrar_egreso', {
      p_concepto: e.concepto,
      p_categoria: e.categoria,
      p_monto: e.monto,
      p_metodo: e.metodo,
      p_proveedor_id: e.proveedor_id,
      p_notas: e.notas,
      p_caja_id: e.caja_id,
    })
    if (error) throw error
    setEgresos((prev) => [data, ...prev])
    return data
  }

  async function eliminar(id: string): Promise<void> {
    // El RPC revierte el total acreditado en la caja (si sigue abierta)
    // antes de borrar el registro, para no dejar el cierre descuadrado.
    const { error } = await supabase.rpc('eliminar_egreso', { p_egreso_id: id })
    if (error) throw error
    setEgresos((prev) => prev.filter((x) => x.id !== id))
  }

  // Conversión numérica segura: Supabase puede devolver NUMERIC como string
  const totalMes = egresos.reduce((s, e) => s + Number(e.monto), 0)

  return { egresos, cargando, cargar, registrar, eliminar, totalMes }
}

export const ETIQUETA_CATEGORIA_EGRESO: Record<CategoriaEgreso, string> = {
  proveedor: 'Pago a proveedor',
  servicios: 'Servicios (luz, agua, internet)',
  alquiler: 'Alquiler',
  planilla: 'Planilla / personal',
  transporte: 'Transporte',
  mantenimiento: 'Mantenimiento',
  otro: 'Otro',
}

export const ETIQUETA_METODO_EGRESO: Record<MetodoEgreso, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  transferencia: 'Transferencia',
  otro: 'Otro',
}
