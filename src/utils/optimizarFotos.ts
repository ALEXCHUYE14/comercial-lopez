// Recomprime las fotos YA subidas de los productos al tamaño actual de
// comprimirImagen (400 px). Las fotos subidas antes de ese cambio pesan 80 KB
// o mas, y cada vez que el POS o el Inventario las muestra gastan Cached
// Egress. Es seguro volver a correrla: una foto ya optimizada queda por debajo
// del umbral y se omite sin descargarla de nuevo para subirla.
import { supabase } from '@/lib/supabase'
import type { Producto } from '@/types/database'
import { comprimirImagen } from '@/hooks/useProductoImagen'
import { fetchConReintentos } from '@/utils/inventarioFotos'

const BUCKET = 'product-images'
const CONCURRENCIA = 3
const OMITIR_BYTES = 40 * 1024

export type ResultadoOptimizacion = { optimizadas: number; omitidas: number; fallidas: string[] }

export async function optimizarFotosInventario(
  productos: Producto[],
  onProgreso?: (hechos: number, total: number) => void,
): Promise<ResultadoOptimizacion> {
  const conFoto = productos.filter((p) => !!p.image_url)
  const resultado: ResultadoOptimizacion = { optimizadas: 0, omitidas: 0, fallidas: [] }
  let hechos = 0
  let cursor = 0

  async function optimizarUna(p: Producto) {
    try {
      const original = await fetchConReintentos(p.image_url as string)
      if (original.size <= OMITIR_BYTES) {
        resultado.omitidas++
        return
      }
      const nueva = await comprimirImagen(original)
      if (nueva.size >= original.size) {
        resultado.omitidas++
        return
      }
      const path = `${p.id}.jpg`
      const { error: errorSubida } = await supabase.storage
        .from(BUCKET)
        .upload(path, nueva, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' })
      if (errorSubida) throw new Error(errorSubida.message)

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
      const { error: errorUpdate } = await supabase
        .from('productos')
        .update({ image_url: `${data.publicUrl}?t=${Date.now()}` })
        .eq('id', p.id)
      if (errorUpdate) throw new Error(errorUpdate.message)

      resultado.optimizadas++
    } catch {
      resultado.fallidas.push(p.sku)
    } finally {
      hechos++
      onProgreso?.(hechos, conFoto.length)
    }
  }

  async function trabajador() {
    while (cursor < conFoto.length) {
      const item = conFoto[cursor++]
      await optimizarUna(item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, conFoto.length) }, trabajador),
  )
  return resultado
}
