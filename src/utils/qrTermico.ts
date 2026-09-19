// Prepara la imagen del QR de Yape para impresion termica. Una impresora
// termica solo imprime puntos negros o blancos: un QR a color (Yape es
// morado) o con degradados saldria borroso/dithered y no se podria escanear.
// Aqui se convierte a blanco y negro puro (umbral de luminancia) sobre un
// lienzo cuadrado, y se entrega en los dos formatos que usan los tickets:
//   - dataUrl: PNG 1-bit para el ticket HTML (impresion por cable)
//   - bytes ESC/POS raster (GS v 0) para el ticket Bluetooth
// Mismo bitmap en ambas vias => el QR se ve identico salga por donde salga.
import { getNegocio } from '@/config/negocio'

// Lado del QR en puntos de impresora. Multiplo de 8 (el raster empaqueta 8
// puntos por byte). 256 puntos ~ 32 mm a 203 dpi: tamaño comodo para escanear
// con el celular y cabe en papel de 58 mm (384 puntos utiles). Mas grande
// tambien seria mas lento por Bluetooth (bloques de 20 bytes).
const LADO_PUNTOS = 256
const UMBRAL_LUMINANCIA = 150
// Menor a los ~5 s que el navegador mantiene el "permiso" de abrir la ventana
// de impresion tras el toque del usuario; si se pasara, el popup se bloquearia.
const TIMEOUT_DESCARGA_MS = 4000

export interface QrTermico {
  dataUrl: string
  /** Ancho en bytes (LADO_PUNTOS / 8) para el comando GS v 0. */
  anchoBytes: number
  alto: number
  /** Bitmap empaquetado, 1 = punto negro, MSB primero. */
  datos: Uint8Array
}

// Solo se recuerda la ultima imagen: la URL cambia (?t=) en cada subida, asi
// que una entrada vieja nunca se reutiliza por error, y no crece sin limite.
let ultimaUrl: string | null = null
let ultimoQr: QrTermico | null = null

async function descargarImagen(url: string): Promise<ImageBitmap | HTMLImageElement> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_DESCARGA_MS)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) throw new Error(`No se pudo descargar el QR (${resp.status}).`)
    const blob = await resp.blob()
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob)
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      const objUrl = URL.createObjectURL(blob)
      img.onload = () => {
        URL.revokeObjectURL(objUrl)
        resolve(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(objUrl)
        reject(new Error('No se pudo leer la imagen del QR.'))
      }
      img.src = objUrl
    })
  } finally {
    clearTimeout(t)
  }
}

/**
 * Descarga la imagen del QR y la convierte a blanco y negro. Lanza Error si no
 * se puede (sin conexion, URL rota, canvas no disponible); quien la use debe
 * decidir si imprime el ticket sin QR.
 */
export async function cargarQrTermico(url: string): Promise<QrTermico> {
  if (ultimaUrl === url && ultimoQr) return ultimoQr

  const origen = await descargarImagen(url)
  const ancho = origen.width
  const alto = origen.height
  if (!ancho || !alto) throw new Error('La imagen del QR está vacía.')

  const canvas = document.createElement('canvas')
  canvas.width = LADO_PUNTOS
  canvas.height = LADO_PUNTOS
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('El navegador no pudo procesar el QR.')

  // Fondo blanco + imagen encajada (sin deformar) y centrada en el cuadrado.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, LADO_PUNTOS, LADO_PUNTOS)
  const escala = Math.min(LADO_PUNTOS / ancho, LADO_PUNTOS / alto)
  const w = Math.max(1, Math.round(ancho * escala))
  const h = Math.max(1, Math.round(alto * escala))
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(origen, Math.floor((LADO_PUNTOS - w) / 2), Math.floor((LADO_PUNTOS - h) / 2), w, h)
  if ('close' in origen) origen.close()

  const px = ctx.getImageData(0, 0, LADO_PUNTOS, LADO_PUNTOS)
  const anchoBytes = LADO_PUNTOS / 8
  const datos = new Uint8Array(anchoBytes * LADO_PUNTOS)
  for (let y = 0; y < LADO_PUNTOS; y++) {
    for (let x = 0; x < LADO_PUNTOS; x++) {
      const i = (y * LADO_PUNTOS + x) * 4
      const luminancia = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2]
      const negro = luminancia < UMBRAL_LUMINANCIA
      if (negro) datos[y * anchoBytes + (x >> 3)] |= 0x80 >> (x & 7)
      const v = negro ? 0 : 255
      px.data[i] = v
      px.data[i + 1] = v
      px.data[i + 2] = v
      px.data[i + 3] = 255
    }
  }
  ctx.putImageData(px, 0, 0)

  const qr: QrTermico = { dataUrl: canvas.toDataURL('image/png'), anchoBytes, alto: LADO_PUNTOS, datos }
  ultimaUrl = url
  ultimoQr = qr
  return qr
}

/** Descarga anticipada (ej. al iniciar sesion) para poder imprimir el QR aunque luego se pierda internet. */
export function precargarQr(url: string | null): void {
  if (!url) return
  cargarQrTermico(url).catch(() => undefined)
}

/**
 * Devuelve el QR que corresponde imprimir en el ticket de una venta, segun la
 * configuracion del negocio. `qr` es null cuando no aplica (no es Yape, esta
 * desactivado, no hay imagen, venta anulada) o cuando fallo la carga — en
 * este ultimo caso `fallo` es true para que la pantalla avise que el ticket
 * salio sin QR en vez de omitirlo en silencio.
 */
export async function qrParaTicket(
  metodo: string,
  anulada?: boolean,
): Promise<{ qr: QrTermico | null; fallo: boolean }> {
  const negocio = getNegocio()
  if (metodo !== 'yape' || anulada || !negocio.imprimirQrYape || !negocio.yapeQrUrl) {
    return { qr: null, fallo: false }
  }
  try {
    return { qr: await cargarQrTermico(negocio.yapeQrUrl), fallo: false }
  } catch {
    return { qr: null, fallo: true }
  }
}
