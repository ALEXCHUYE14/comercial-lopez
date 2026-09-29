// Fotos del inventario en bloque: descargar todas en un .zip (nombradas por
// SKU) para respaldo o edicion masiva, y volver a subirlas emparejando cada
// archivo con su producto por el nombre del archivo (sin extension) = SKU.
//
// "jszip" se carga con import() dinamico por la misma razon que "xlsx" en
// inventarioExcel.ts: pesa varios cientos de KB y solo hace falta cuando
// alguien de verdad descarga o sube fotos en bloque, no en cada visita al POS.
import { ymd } from '@/utils/format'
import type { Producto } from '@/types/database'

const CONCURRENCIA = 6

function extensionDeUrl(url: string): string {
  const limpio = url.split('?')[0]
  const m = /\.([a-zA-Z0-9]{2,5})$/.exec(limpio)
  return m ? m[1].toLowerCase() : 'jpg'
}

export type ResultadoDescargaFotos = { descargadas: number; sinFoto: number; fallidas: string[] }

/** Descarga un .zip con la foto de cada producto que tenga una, nombrada
 * "<SKU>.<extension>". Ese mismo nombre es lo que despues usa "Subir fotos"
 * para saber a que producto vuelve cada archivo. No incluye a los productos
 * sin foto — se reportan aparte, no como error. */
export async function descargarFotosInventario(
  productos: Producto[],
  onProgreso?: (hechos: number, total: number) => void,
): Promise<ResultadoDescargaFotos> {
  const JSZip = (await import('jszip')).default
  const zip = new JSZip()
  const conFoto = productos.filter((p) => !!p.image_url)
  const fallidas: string[] = []
  let hechos = 0

  async function descargarUna(p: Producto) {
    try {
      const res = await fetch(p.image_url as string)
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      const ext = extensionDeUrl(p.image_url as string)
      zip.file(`${p.sku}.${ext}`, blob)
    } catch {
      fallidas.push(p.sku)
    } finally {
      hechos++
      onProgreso?.(hechos, conFoto.length)
    }
  }

  // Concurrencia acotada: bajar 600+ fotos todas a la vez saturaria la
  // conexion del negocio (y volveria a sumar de golpe al "Cached Egress" que
  // ya se venia corrigiendo) — de a pocas a la vez es igual de rapido en la
  // practica y mucho mas liviano.
  let cursor = 0
  async function trabajador() {
    while (cursor < conFoto.length) {
      const item = conFoto[cursor++]
      await descargarUna(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, conFoto.length) }, trabajador),
  )

  if (conFoto.length - fallidas.length > 0) {
    const contenido = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(contenido)
    const a = document.createElement('a')
    a.href = url
    a.download = `fotos_inventario_${ymd(new Date())}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return {
    descargadas: conFoto.length - fallidas.length,
    sinFoto: productos.length - conFoto.length,
    fallidas,
  }
}

export type FotoLeida = { sku: string; blob: Blob; nombreArchivo: string }

const EXTENSIONES_IMAGEN = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])

function skuDeNombre(nombreArchivo: string): string {
  const sinRuta = nombreArchivo.split('/').pop() ?? nombreArchivo
  return sinRuta.replace(/\.[a-zA-Z0-9]+$/, '').trim()
}

/** Lee las fotos elegidas por el usuario — un .zip (como el que genera
 * descargarFotosInventario) o varias imagenes sueltas — y devuelve cada una
 * con el SKU que se lee de su propio nombre de archivo. No empareja todavia
 * contra el inventario real: eso lo hace quien llama, que es quien tiene la
 * lista de productos vigente. */
export async function leerArchivosFotos(archivos: File[]): Promise<FotoLeida[]> {
  const unico = archivos.length === 1 ? archivos[0] : null
  if (unico && /\.zip$/i.test(unico.name)) {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(await unico.arrayBuffer())
    const resultado: FotoLeida[] = []
    for (const [nombre, entrada] of Object.entries(zip.files)) {
      if (entrada.dir) continue
      const ext = nombre.split('.').pop()?.toLowerCase() ?? ''
      if (!EXTENSIONES_IMAGEN.has(ext)) continue
      const blob = await entrada.async('blob')
      resultado.push({ sku: skuDeNombre(nombre), blob, nombreArchivo: nombre })
    }
    return resultado
  }
  return archivos
    .filter((f) => f.type.startsWith('image/'))
    .map((f) => ({ sku: skuDeNombre(f.name), blob: f, nombreArchivo: f.name }))
}
