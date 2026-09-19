import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { setNegocio, useNegocio, documentoValido } from '@/config/negocio'
import type { ConfiguracionNegocio } from '@/types/database'

const BUCKET = 'negocio-assets'
const RUTA_QR = 'yape-qr.png'
const MAX_LADO_QR_PX = 600
const MAX_ARCHIVO_MB = 8

// Errores tipicos cuando aun no se corrio el SQL nuevo en Supabase (tabla o
// bucket inexistentes) o el usuario no es administrador: se traducen a un
// mensaje accionable en vez del texto tecnico de PostgREST/Storage.
function mensajeSupabase(msg: string): string {
  if (/configuracion_negocio|schema cache|does not exist/i.test(msg)) {
    return 'Falta actualizar la base de datos: ejecuta el archivo supabase/schema.sql en Supabase (SQL Editor) y vuelve a intentar.'
  }
  if (/bucket not found/i.test(msg)) {
    return 'Falta crear el almacenamiento de imágenes: ejecuta supabase/schema.sql en Supabase (SQL Editor) y vuelve a intentar.'
  }
  if (/row-level security|permission denied|not authorized|unauthorized/i.test(msg)) {
    return 'Solo un administrador activo puede cambiar estos datos.'
  }
  return msg
}

function aNegocio(fila: ConfiguracionNegocio) {
  return {
    nombre: fila.nombre,
    documento: fila.documento ?? '',
    direccion: fila.direccion ?? '',
    yapeQrUrl: fila.yape_qr_url,
    imprimirQrYape: fila.imprimir_qr_yape,
  }
}

/**
 * Trae la configuracion del negocio desde Supabase y la publica en el almacen
 * global (config/negocio.ts). Nunca lanza: si falla (sin internet, tabla aun
 * no creada) se conserva lo que ya hubiera en cache/valores por defecto.
 */
export async function sincronizarNegocio(): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('configuracion_negocio')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) return
    setNegocio(aNegocio(data))
  } catch {
    // Sin conexion: se sigue con la ultima configuracion conocida.
  }
}

/**
 * Convierte cualquier imagen a PNG sobre fondo BLANCO y de lado maximo
 * MAX_LADO_QR_PX. PNG (no JPEG) para no meter artefactos de compresion en los
 * modulos del QR, y fondo blanco porque un PNG transparente saldria negro al
 * pasarlo a blanco y negro para la impresora termica.
 */
function normalizarImagenQr(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (!width || !height) {
        reject(new Error('La imagen está vacía o dañada.'))
        return
      }
      const escala = Math.min(1, MAX_LADO_QR_PX / Math.max(width, height))
      width = Math.max(1, Math.round(width * escala))
      height = Math.max(1, Math.round(height * escala))

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Tu navegador no pudo procesar la imagen.'))
        return
      }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo procesar la imagen.'))),
        'image/png',
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('No se pudo leer la imagen. Usa un archivo PNG o JPG.'))
    }
    img.src = url
  })
}

export interface DatosNegocioForm {
  nombre: string
  documento: string
  direccion: string
}

/**
 * Edicion de la configuracion del negocio (solo administrador — el servidor
 * lo exige con RLS; ver configuracion_negocio en supabase/schema.sql).
 */
export function useConfiguracionNegocio() {
  const negocio = useNegocio()
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [subiendoQr, setSubiendoQr] = useState(false)

  useEffect(() => {
    let activo = true
    sincronizarNegocio().finally(() => {
      if (activo) setCargando(false)
    })
    return () => {
      activo = false
    }
  }, [])

  const guardar = useCallback(async (datos: DatosNegocioForm, usuarioId: string | null) => {
    const nombre = datos.nombre.trim()
    const documento = datos.documento.trim()
    const direccion = datos.direccion.trim()
    if (!nombre) throw new Error('El nombre del negocio es obligatorio.')
    if (nombre.length > 80) throw new Error('El nombre del negocio admite hasta 80 caracteres.')
    if (!documentoValido(documento)) {
      throw new Error('El DNI debe tener 8 dígitos o el RUC 11 dígitos (solo números).')
    }
    if (direccion.length > 120) throw new Error('La dirección admite hasta 120 caracteres.')

    setGuardando(true)
    try {
      const { data, error } = await supabase
        .from('configuracion_negocio')
        .upsert({
          id: 1,
          nombre,
          documento,
          direccion,
          actualizado_por: usuarioId,
          actualizado_en: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw new Error(mensajeSupabase(error.message))
      setNegocio(aNegocio(data))
    } finally {
      setGuardando(false)
    }
  }, [])

  const cambiarImprimirQr = useCallback(async (valor: boolean, usuarioId: string | null) => {
    const { data, error } = await supabase
      .from('configuracion_negocio')
      .upsert({
        id: 1,
        imprimir_qr_yape: valor,
        actualizado_por: usuarioId,
        actualizado_en: new Date().toISOString(),
      })
      .select()
      .single()
    if (error) throw new Error(mensajeSupabase(error.message))
    setNegocio(aNegocio(data))
  }, [])

  const subirQr = useCallback(async (file: File, usuarioId: string | null) => {
    if (!file.type.startsWith('image/')) {
      throw new Error('El archivo debe ser una imagen (PNG o JPG).')
    }
    if (file.size > MAX_ARCHIVO_MB * 1024 * 1024) {
      throw new Error(`La imagen supera los ${MAX_ARCHIVO_MB} MB.`)
    }
    setSubiendoQr(true)
    try {
      const blob = await normalizarImagenQr(file)
      const { error: errSubida } = await supabase.storage
        .from(BUCKET)
        .upload(RUTA_QR, blob, { upsert: true, contentType: 'image/png' })
      if (errSubida) throw new Error(mensajeSupabase(errSubida.message))

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(RUTA_QR)
      // ?t=: mismo path en cada subida -> sin esto el navegador/CDN seguirian
      // mostrando (e imprimiendo) el QR anterior.
      const url = `${pub.publicUrl}?t=${Date.now()}`

      const { data, error } = await supabase
        .from('configuracion_negocio')
        .upsert({
          id: 1,
          yape_qr_url: url,
          actualizado_por: usuarioId,
          actualizado_en: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw new Error(mensajeSupabase(error.message))
      setNegocio(aNegocio(data))
    } finally {
      setSubiendoQr(false)
    }
  }, [])

  const quitarQr = useCallback(async (usuarioId: string | null) => {
    setSubiendoQr(true)
    try {
      const { data, error } = await supabase
        .from('configuracion_negocio')
        .upsert({
          id: 1,
          yape_qr_url: null,
          actualizado_por: usuarioId,
          actualizado_en: new Date().toISOString(),
        })
        .select()
        .single()
      if (error) throw new Error(mensajeSupabase(error.message))
      setNegocio(aNegocio(data))
      // Se borra el archivo despues de desvincularlo: si esto falla queda un
      // archivo huerfano inofensivo, pero nunca una referencia rota.
      await supabase.storage.from(BUCKET).remove([RUTA_QR]).catch(() => undefined)
    } finally {
      setSubiendoQr(false)
    }
  }, [])

  return { negocio, cargando, guardando, subiendoQr, guardar, subirQr, quitarQr, cambiarImprimirQr }
}
