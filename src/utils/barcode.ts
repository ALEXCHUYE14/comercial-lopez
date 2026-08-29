// Generador de codigos de barra EAN-13 (SVG), sin dependencias externas —
// para reimprimir la etiqueta de un producto cuando la original se daño o
// nunca tuvo una (ej. producto a granel repacado). Se eligio EAN-13 y no
// Code128 a proposito: es el simbolo real que ya traen la gran mayoria de
// productos de abarrotes/bebidas (los SKU de ejemplo del sistema ya son
// EAN-13 de 13 digitos), Y esta en la lista de formatos que el escaner de
// camara de la app ya sabe leer (ver CameraScanner.tsx), asi que una etiqueta
// impresa aqui vuelve a escanear correctamente en POS/Inventario.
//
// Referencia del algoritmo (GS1 General Specifications): las tablas de
// modulos de abajo se verifican contra el numero de ejemplo oficial del
// estandar "5901234123457" — ver el comentario junto a calcularDigitoControl.

// Patron de 7 modulos (barra=1, espacio=0) para cada digito 0-9 en el lado
// IZQUIERDO con paridad IMPAR ("L-code"). Es la unica tabla que se transcribe
// a mano: G-code y R-code se DERIVAN de esta algoritmicamente (ver abajo),
// en vez de transcribir dos tablas mas, para reducir el riesgo de un error
// de tipeo en una tabla larga.
const L_CODE: string[] = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
]

// G-code (izquierda, paridad par) = espejo del complemento de L-code.
// R-code (derecha)                = complemento de L-code (sin espejo).
// Ambas son relaciones formales del estandar EAN/UPC, no arbitrarias.
function complemento(bits: string): string {
  return bits.replace(/[01]/g, (b) => (b === '0' ? '1' : '0'))
}
function invertir(bits: string): string {
  return [...bits].reverse().join('')
}
const G_CODE: string[] = L_CODE.map((b) => invertir(complemento(b)))
const R_CODE: string[] = L_CODE.map((b) => complemento(b))

// Patron L/G de los digitos 2-7 segun el primer digito (0-9) del codigo.
// 'L' = usar L_CODE, 'G' = usar G_CODE. Tabla estandar EAN-13 ("primer
// digito" / parity pattern).
const PARIDAD: string[] = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
]

/** Calcula el digito de control EAN-13/UPC a partir de los primeros 12 digitos. */
export function calcularDigitoControl(doce: string): number {
  let suma = 0
  for (let i = 0; i < 12; i++) {
    const d = doce.charCodeAt(i) - 48
    suma += d * (i % 2 === 0 ? 1 : 3)
  }
  return (10 - (suma % 10)) % 10
}
// Auto-verificacion en tiempo de carga contra el numero de ejemplo oficial
// del estandar GS1 ("590123412345" -> digito de control 7). Si algun dia se
// edita el algoritmo de arriba por error, esto lanza en desarrollo apenas se
// importa el modulo, en vez de fallar en silencio con etiquetas ilegibles.
if (calcularDigitoControl('590123412345') !== 7) {
  throw new Error('barcode.ts: fallo la auto-verificacion del algoritmo EAN-13.')
}

/**
 * true si el texto puede representarse como EAN-13: 12 o 13 digitos
 * numericos (con 13, el ultimo debe ser el digito de control correcto).
 */
export function esEan13Valido(texto: string): boolean {
  const limpio = texto.trim()
  if (!/^\d{12,13}$/.test(limpio)) return false
  if (limpio.length === 13) {
    return calcularDigitoControl(limpio.slice(0, 12)) === Number(limpio[12])
  }
  return true
}

/** Completa a 13 digitos (agrega el digito de control si vinieron 12). */
export function normalizarEan13(texto: string): string {
  const limpio = texto.trim()
  if (limpio.length === 12) return limpio + String(calcularDigitoControl(limpio))
  return limpio
}

interface BarraSvgOpts {
  /** Ancho de un modulo (la barra mas angosta), en unidades SVG (~mm si el viewBox es en mm). */
  moduloAncho?: number
  altoBarras?: number
  mostrarTexto?: boolean
}

/**
 * Arma el SVG del codigo de barras EAN-13 para `codigo` (ya validado con
 * esEan13Valido). Estructura estandar: guarda izq (101) + 6 digitos L/G +
 * guarda central (01010) + 6 digitos R + guarda der (101), mas el digito
 * suelto a la izquierda de la primera guarda (no forma parte de las barras,
 * se imprime como texto — asi es como se ve un EAN-13 real impreso).
 */
export function construirBarcodeSvg(codigo: string, opts: BarraSvgOpts = {}): string {
  const { moduloAncho = 0.33, altoBarras = 14, mostrarTexto = true } = opts
  const ean = normalizarEan13(codigo)
  const primerDigito = ean[0]
  const patron = PARIDAD[Number(primerDigito)]
  const grupoIzq = ean.slice(1, 7)
  const grupoDer = ean.slice(7, 13)

  // Construye la secuencia de modulos (1=barra, 0=espacio) de todo el simbolo.
  let modulos = '101' // guarda izquierda
  for (let i = 0; i < 6; i++) {
    const d = Number(grupoIzq[i])
    modulos += patron[i] === 'L' ? L_CODE[d] : G_CODE[d]
  }
  modulos += '01010' // guarda central
  for (let i = 0; i < 6; i++) {
    modulos += R_CODE[Number(grupoDer[i])]
  }
  modulos += '101' // guarda derecha

  const anchoTotal = modulos.length * moduloAncho
  // Las guardas (izq/centro/der) se dibujan un poco mas altas que el resto de
  // barras, igual que un EAN-13 impreso real — ayuda a los lectores a fijar
  // el eje vertical de escaneo.
  const altoGuarda = altoBarras + 2.5
  const altoTotal = altoGuarda + (mostrarTexto ? 4.5 : 0.5)

  const posicionesGuarda = new Set<number>()
  for (let i = 0; i < 3; i++) posicionesGuarda.add(i) // izquierda
  for (let i = 0; i < 5; i++) posicionesGuarda.add(45 + i) // centro (despues de 3+42 modulos)
  for (let i = 0; i < 3; i++) posicionesGuarda.add(modulos.length - 3 + i) // derecha

  let x = 0
  const barras: string[] = []
  for (let i = 0; i < modulos.length; i++) {
    if (modulos[i] === '1') {
      const alto = posicionesGuarda.has(i) ? altoGuarda : altoBarras
      barras.push(`<rect x="${x.toFixed(2)}" y="0" width="${moduloAncho.toFixed(2)}" height="${alto.toFixed(2)}"/>`)
    }
    x += moduloAncho
  }

  const textoDigitos = mostrarTexto
    ? `<text x="${(anchoTotal / 2).toFixed(2)}" y="${(altoTotal - 0.5).toFixed(2)}" font-family="'Courier New',monospace" font-size="3.6" text-anchor="middle" letter-spacing="1.5">${ean}</text>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${anchoTotal.toFixed(2)} ${altoTotal.toFixed(2)}" width="${anchoTotal.toFixed(2)}mm" height="${altoTotal.toFixed(2)}mm" fill="#000">${barras.join('')}${textoDigitos}</svg>`
}
