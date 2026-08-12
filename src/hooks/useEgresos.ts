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
    proveedor_nombre: string | null
    notas: string | null
    usuario_id: string | null
    usuario_nombre: string | null
  }): Promise<Egreso> {
    const { data, error } = await supabase.from('egresos').insert(e).select().single()
    if (error) throw error
    setEgresos((prev) => [data, ...prev])
    return data
  }

  async function eliminar(id: string): Promise<void> {
    const { error } = await supabase.from('egresos').delete().eq('id', id)
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
