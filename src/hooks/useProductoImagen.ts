import { useState } from 'react'
import { supabase } from '@/lib/supabase'

const BUCKET = 'product-images'
// Las fotos se muestran como miniaturas (~80 px en POS e Inventario); 400 px
// se ve nítido incluso en pantallas de alta densidad y pesa ~4 veces menos que
// 800 px, lo que baja directamente el Cached Egress de Storage.
export const MAX_LADO_PX = 400
export const CALIDAD_JPG = 0.75

/**
 * Comprime una imagen usando Canvas API antes de subirla.
 * Reduce fotos de cámara de 5-15MB a ~20-40KB sin pérdida visual notable.
 */
export function comprimirImagen(file: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      // Calcular dimensiones manteniendo proporción
      let { width, height } = img
      if (width > MAX_LADO_PX || height > MAX_LADO_PX) {
        if (width >= height) {
          height = Math.round((height * MAX_LADO_PX) / width)
          width = MAX_LADO_PX
        } else {
          width = Math.round((width * MAX_LADO_PX) / height)
          height = MAX_LADO_PX
        }
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas no disponible')); return }

      // JPEG no tiene transparencia: sin fondo blanco, un PNG con fondo
      // transparente saldria con fondo negro.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('No se pudo comprimir la imagen'))
        },
        'image/jpeg',
        CALIDAD_JPG,
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('No se pudo leer la imagen'))
    }

    img.src = url
  })
}

export function useProductoImagen() {
  const [subiendo, setSubiendo] = useState(false)

  async function subir(file: File, productoId: string): Promise<string> {
    setSubiendo(true)
    try {
      // Comprimir antes de subir — convierte cualquier foto a JPEG optimizado
      const blob = await comprimirImagen(file)
      const path = `${productoId}.jpg`

      // cacheControl largo (1 año): la URL ya lleva su propio "?t=" con la
      // fecha de esta subida, asi que cambia sola cuando la foto cambia — es
      // seguro decirle al navegador/CDN que la guarde por mucho tiempo en vez
      // de volver a descargarla cada hora (el valor por defecto de Supabase).
      // Sin esto, cada foto de producto se re-descargaba de Supabase una vez
      // por hora en cada dispositivo de cada cajero que la tuviera abierta,
      // lo que disparaba la cuota de "Cached Egress" del plan gratuito.
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' })

      if (error) throw new Error(error.message)

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
      return `${data.publicUrl}?t=${Date.now()}`
    } finally {
      setSubiendo(false)
    }
  }

  async function eliminar(productoId: string) {
    await supabase.storage.from(BUCKET).remove([`${productoId}.jpg`])
  }

  return { subiendo, subir, eliminar }
}
