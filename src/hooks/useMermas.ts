import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Merma, MotivoMerma } from '@/types/database'

export function useMermas(desde: Date, hasta: Date) {
  const [mermas, setMermas] = useState<Merma[]>([])
  const [cargando, setCargando] = useState(true)

  // Use getTime() (primitive) so Date objects are compared by value, not reference.
  // Without this, inline new Date() calls in the parent cause infinite re-renders.
  const desdeMs = desde.getTime()
  const hastaMs = hasta.getTime()

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data } = await supabase
      .from('mermas')
      .select('*')
      .gte('creado_en', new Date(desdeMs).toISOString())
      .lte('creado_en', new Date(hastaMs).toISOString())
      .order('creado_en', { ascending: false })
    setMermas(data ?? [])
    setCargando(false)
  }, [desdeMs, hastaMs])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function registrar(m: NuevaMerma): Promise<Merma> {
    // registrar_merma (ver supabase/mermas_excel.sql) guarda la merma y
    // descuenta el stock en UNA transaccion: o se hacen ambas cosas o ninguna.
    const rpc = await supabase.rpc('registrar_merma', {
      p_producto_id: m.producto_id,
      p_producto_nombre: m.producto_nombre,
      p_cantidad: m.cantidad,
      p_costo_unitario: m.costo_unitario,
      p_motivo: m.motivo,
      p_descripcion: m.descripcion,
    })
    let data: Merma
    if (!rpc.error) {
      data = rpc.data as Merma
    } else if (funcionNoExiste(rpc.error)) {
      data = await registrarSinRpc(m)
    } else {
      throw new Error(rpc.error.message)
    }

    setMermas((prev) => [data, ...prev])
    return data
  }

  // Number(): NUMERIC puede llegar como string desde Supabase.
  const costoTotal = mermas.reduce((s, m) => s + Number(m.costo_total || 0), 0)

  return { mermas, cargando, cargar, registrar, costoTotal }
}

/** El RPC aun no existe en la base (no se ejecuto supabase/mermas_excel.sql). */
export function funcionNoExiste(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'PGRST202' ||
    error.code === '42883' ||
    /could not find the function/i.test(error.message ?? '')
  )
}

type NuevaMerma = {
  producto_id: string | null
  producto_nombre: string
  cantidad: number
  costo_unitario: number
  motivo: MotivoMerma
  descripcion: string | null
}

/** Respaldo mientras no se ejecute supabase/mermas_excel.sql: mismo
 * resultado que registrar_merma, en dos pasos. Corrige dos bugs del flujo
 * anterior: (1) ajustar_stock SUMA la cantidad que recibe, y se le enviaba en
 * positivo — cada merma AUMENTABA el stock; ahora se envia en negativo. (2) Si
 * el descuento de stock fallaba (ej. stock insuficiente) se ignoraba en
 * silencio y la merma quedaba registrada igual; ahora se deshace la merma y
 * se informa el error. */
async function registrarSinRpc(m: NuevaMerma): Promise<Merma> {
  const payload = {
    ...m,
    costo_total: Math.round(m.cantidad * m.costo_unitario * 100) / 100,
  }
  const { data, error } = await supabase.from('mermas').insert(payload).select().single()
  if (error) throw new Error(error.message)

  if (m.producto_id) {
    const { error: errStock } = await supabase.rpc('ajustar_stock', {
      p_producto_id: m.producto_id,
      p_cantidad: -m.cantidad,
      p_tipo: 'salida',
      p_motivo: `Merma: ${ETIQUETA_MOTIVO[m.motivo]}`,
    })
    if (errStock) {
      await supabase.from('mermas').delete().eq('id', data.id)
      throw new Error(`No se registró la merma: ${errStock.message}`)
    }
  }
  return data as Merma
}

export const ETIQUETA_MOTIVO: Record<MotivoMerma, string> = {
  vencido: 'Producto vencido',
  danado: 'Producto dañado',
  consumo_interno: 'Consumo interno',
  otro: 'Otro motivo',
}
