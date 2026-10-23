import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { funcionNoExiste } from '@/hooks/useMermas'
import type { Compra, DetalleCompra, EstadoCompra } from '@/types/database'

export interface ItemCompra {
  producto_id: string | null
  producto_nombre: string
  cantidad: number
  precio_unitario: number
}

export function useCompras() {
  const [compras, setCompras] = useState<Compra[]>([])
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data } = await supabase
      .from('compras')
      .select('*, proveedores(*)')
      .order('creado_en', { ascending: false })
      .limit(150)
    setCompras(data ?? [])
    setCargando(false)
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function crear(
    cabecera: {
      numero: string | null
      proveedor_id: string | null
      fecha_compra: string
      estado: EstadoCompra
      notas: string | null
    },
    items: ItemCompra[],
    actualizarCosto = true,
  ): Promise<Compra> {
    // registrar_compra (ver supabase/correccion_compras_stock.sql) guarda la
    // cabecera, el detalle, SUMA EL STOCK y actualiza el costo en UNA sola
    // transaccion. Antes se hacia en pasos sueltos desde el navegador: el
    // detalle era rechazado por la base de datos (detalle_compras no tenia
    // permiso de escritura) y el stock de lo comprado nunca se sumaba.
    const { data, error } = await supabase.rpc('registrar_compra', {
      p_numero: cabecera.numero,
      p_proveedor_id: cabecera.proveedor_id,
      p_fecha_compra: cabecera.fecha_compra,
      p_estado: cabecera.estado,
      p_notas: cabecera.notas,
      p_items: items.map((i) => ({
        producto_id: i.producto_id,
        producto_nombre: i.producto_nombre,
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario,
      })),
      p_actualizar_costo: actualizarCosto,
    })
    if (error) {
      throw new Error(
        funcionNoExiste(error)
          ? 'Falta actualizar la base de datos: ejecuta el archivo supabase/correccion_compras_stock.sql en el SQL Editor de Supabase. La compra NO se registró.'
          : error.message,
      )
    }
    const creada = data as Compra
    // Se vuelve a leer con el proveedor embebido, como el resto del listado.
    const { data: completa } = await supabase
      .from('compras')
      .select('*, proveedores(*)')
      .eq('id', creada.id)
      .single()
    const compra = (completa ?? creada) as Compra
    setCompras((prev) => [compra, ...prev.filter((x) => x.id !== compra.id)])
    return compra
  }

  async function cambiarEstado(id: string, estado: EstadoCompra): Promise<void> {
    const { data, error } = await supabase
      .from('compras')
      .update({ estado })
      .eq('id', id)
      .select('*, proveedores(*)')
      .single()
    if (error) throw error
    setCompras((prev) => prev.map((x) => (x.id === id ? data : x)))
  }

  async function obtenerDetalles(compra_id: string): Promise<DetalleCompra[]> {
    const { data, error } = await supabase
      .from('detalle_compras')
      .select('*')
      .eq('compra_id', compra_id)
      .order('producto_nombre')
    if (error) throw error
    return data ?? []
  }

  return { compras, cargando, cargar, crear, cambiarEstado, obtenerDetalles }
}
