// Generador de comandos ESC/POS crudos para impresoras termicas — usado por
// la impresion Bluetooth (Web Bluetooth no tiene dialogo de impresion del
// sistema operativo: hay que enviarle a la impresora los bytes ESC/POS
// directamente). Reutiliza el MISMO contenido que construirTicketHtml (sin
// logo, igual al ticket que ya se ve en pantalla) para que ambas vias de
// impresion muestren siempre la misma informacion.
import { money, fechaHora } from '@/utils/format'
import { getNegocio, textoDocumento } from '@/config/negocio'
import type { QrTermico } from '@/utils/qrTermico'
import { subLinea, type TicketDatos, type TicketLinea } from '@/utils/ticket'
import { admiteVuelto, lineasPago } from '@/utils/pagos'

const ETIQUETA_METODO: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
  mixto: 'Mixto',
  transferencia: 'Transferencia',
  otro: 'Otro',
}

// Ancho de la impresora termica en columnas de fuente monoespaciada. 32 es el
// estandar para papel de 58mm; las de 80mm suelen dar ~42-48. Se deja fijo en
// 32 porque es el minimo comun y evita que el texto se corte en impresoras
// mas angostas (a costa de dejar margen de sobra en las de 80mm).
const COLUMNAS = 32

// --- Comandos ESC/POS -------------------------------------------------------
const ESC = 0x1b
const GS = 0x1d

const CMD = {
  init: [ESC, 0x40],
  alinearIzq: [ESC, 0x61, 0x00],
  alinearCentro: [ESC, 0x61, 0x01],
  negritaOn: [ESC, 0x45, 0x01],
  negritaOff: [ESC, 0x45, 0x00],
  // GS ! n: solo el bit de altura (0x01) — a proposito NO se usa 0x11 (alto
  // + ancho dobles), que reduciria a la mitad las columnas disponibles y
  // desalinearia el padding de fila()/COLUMNAS (pensado para ancho normal),
  // ademas de arriesgar que el nombre del negocio o un total grande se corte
  // a la mitad de una palabra en impresoras que no auto-envuelven bien.
  altoDobleOn: [GS, 0x21, 0x01],
  altoDobleOff: [GS, 0x21, 0x00],
  // Alto + ancho dobles: SOLO para una linea corta centrada (el monto del
  // TOTAL), nunca dentro de fila(), por lo explicado arriba.
  dobleOn: [GS, 0x21, 0x11],
  feed: (n: number) => [ESC, 0x64, n],
  cortarParcial: [GS, 0x56, 0x01],
  // Selecciona tabla de caracteres CP850 (Multilingual Latin-1), la que mejor
  // cubre los acentos y ñ del español entre las tablas ESC/POS estandar.
  codepagePC850: [ESC, 0x74, 0x02],
} as const

// Mapa de caracteres especiales del español -> byte en CP850. El resto del
// texto (ASCII basico) se codifica igual en CP850 y en UTF-8, asi que no
// necesita mapeo. Sin esto, la mayoria de impresoras termicas (que no hablan
// UTF-8) imprimirian simbolos ilegibles en vez de "á, é, í, ó, ú, ñ, ¿, ¡, °".
const MAPA_CP850: Record<string, number> = {
  á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3,
  Á: 0xb5, É: 0x90, Í: 0xd6, Ó: 0xe0, Ú: 0xe9,
  ñ: 0xa4, Ñ: 0xa5,
  ü: 0x81, Ü: 0x9a,
  '¿': 0xa8, '¡': 0xad, '°': 0xf8, '·': 0xfa,
}

function textoABytes(texto: string): number[] {
  const bytes: number[] = []
  for (const ch of texto) {
    const mapeado = MAPA_CP850[ch]
    if (mapeado !== undefined) {
      bytes.push(mapeado)
    } else if (/\s/.test(ch)) {
      // Espacios Unicode (NBSP, espacio fino de "a. m." en fechas, etc.) ->
      // espacio comun; si no, la impresora los mostraria como "?".
      bytes.push(0x20)
    } else {
      const code = ch.codePointAt(0) ?? 0x3f
      // Fuera de ASCII imprimible y sin mapeo conocido -> "?" en vez de
      // bytes UTF-8 multibyte, que la impresora interpretaria como basura.
      bytes.push(code < 0x20 || code > 0x7e ? 0x3f : code)
    }
  }
  return bytes
}

/** Parte un texto en lineas de a lo sumo `ancho` columnas sin cortar palabras
 * (salvo palabras mas largas que el ancho). Sin esto la impresora envuelve
 * por su cuenta a mitad de palabra, y un nombre de negocio o direccion largos
 * — ahora editables — saldrian cortados feo. */
function envolver(texto: string, ancho = COLUMNAS): string[] {
  const lineas: string[] = []
  let actual = ''
  for (const palabraOriginal of texto.split(/\s+/).filter(Boolean)) {
    let palabra = palabraOriginal
    while (palabra.length > ancho) {
      if (actual) {
        lineas.push(actual)
        actual = ''
      }
      lineas.push(palabra.slice(0, ancho))
      palabra = palabra.slice(ancho)
    }
    if (!actual) actual = palabra
    else if (actual.length + 1 + palabra.length <= ancho) actual += ' ' + palabra
    else {
      lineas.push(actual)
      actual = palabra
    }
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : ['']
}

/**
 * Listado de productos en 3 columnas alineadas (CANT | DESCRIPCION |
 * IMPORTE), igual que la tabla del ticket HTML. El ancho de CANT e IMPORTE se
 * ajusta a los valores de este ticket y DESCRIPCION usa el resto; el nombre
 * se envuelve por palabras dentro de su columna (nunca se recorta) y la
 * linea secundaria (presentacion / P.U.) va sangrada bajo la descripcion.
 * Cantidades y montos nunca se recortan (un dato truncado seria un cobro
 * ilegible); con valores normales cada linea mide a lo sumo COLUMNAS.
 */
function tablaProductos(lineas: TicketLinea[]): { cabecera: string; filas: string[] } {
  const anchoCant = Math.min(10, Math.max(4, ...lineas.map((l) => l.cantidadTexto.length)))
  const anchoImp = Math.min(14, Math.max(7, ...lineas.map((l) => l.montoTexto.length)))
  const anchoDesc = COLUMNAS - anchoCant - anchoImp - 2
  const sangria = ' '.repeat(anchoCant + 1)

  const cabecera =
    'CANT'.padEnd(anchoCant) + ' ' + 'DESCRIPCION'.slice(0, anchoDesc).padEnd(anchoDesc) + ' ' + 'IMPORTE'.padStart(anchoImp)

  const filas: string[] = []
  for (const l of lineas) {
    const desc = envolver(l.nombre, anchoDesc)
    filas.push(
      l.cantidadTexto.padEnd(anchoCant) + ' ' + desc[0].padEnd(anchoDesc) + ' ' +
        l.montoTexto.padStart(anchoImp),
    )
    for (const extra of desc.slice(1)) filas.push(sangria + extra)
    const sub = subLinea(l)
    if (sub) for (const extra of envolver(sub, COLUMNAS - sangria.length)) filas.push(sangria + extra)
  }
  return { cabecera, filas }
}

// Exportada (ademas de usarse internamente en este archivo) para que otros
// tickets termicos del sistema — ej. el cierre de turno en ticketCierre.ts —
// puedan reutilizar exactamente los mismos comandos ESC/POS y helpers de
// alineacion/columnas, en vez de duplicar esta clase.
export class ConstructorTicket {
  private partes: number[][] = [[...CMD.init], [...CMD.codepagePC850]]

  private raw(bytes: number[]) {
    this.partes.push(bytes)
    return this
  }

  private linea(texto = '') {
    this.partes.push(textoABytes(texto))
    this.partes.push([0x0a])
    return this
  }

  centro(texto: string) {
    this.raw([...CMD.alinearCentro])
    for (const l of envolver(texto)) this.linea(l)
    return this.raw([...CMD.alinearIzq])
  }

  negrita(texto: string) {
    // Si cabe en una linea se envia tal cual (conserva espacios de alineacion,
    // ej. la cabecera de columnas); si no, se envuelve por palabras.
    this.raw([...CMD.negritaOn])
    if (texto.length <= COLUMNAS) this.linea(texto)
    else this.parrafo(texto)
    return this.raw([...CMD.negritaOff])
  }

  /** Centrado y en negrita (ej. aviso de comprobante anulado). */
  centroNegrita(texto: string) {
    return this.raw([...CMD.negritaOn]).centro(texto).raw([...CMD.negritaOff])
  }

  tituloGrande(texto: string) {
    this.raw([...CMD.alinearCentro, ...CMD.negritaOn, ...CMD.altoDobleOn])
    for (const l of envolver(texto)) this.linea(l)
    return this.raw([...CMD.altoDobleOff, ...CMD.negritaOff, ...CMD.alinearIzq])
  }

  /** Imagen 1-bit (ya en blanco y negro, ver utils/qrTermico.ts) centrada,
   * con el comando raster GS v 0. Se centra porque el bitmap del QR es mas
   * angosto que el papel. */
  imagen(img: QrTermico) {
    const { anchoBytes, alto, datos } = img
    return this.raw([...CMD.alinearCentro])
      .raw([
        GS, 0x76, 0x30, 0x00,
        anchoBytes & 0xff, (anchoBytes >> 8) & 0xff,
        alto & 0xff, (alto >> 8) & 0xff,
      ])
      .raw(Array.from(datos))
      .raw([...CMD.alinearIzq])
  }

  texto(texto = '') {
    return this.linea(texto)
  }

  /** Texto alineado a la izquierda, envuelto por palabras (sin que la
   * impresora lo corte a mitad de palabra). */
  parrafo(texto: string) {
    for (const l of envolver(texto)) this.linea(l)
    return this
  }

  /** Dos columnas: izquierda pegada al borde, derecha alineada a la derecha. */
  fila(izq: string, der: string) {
    const espacio = COLUMNAS - izq.length - der.length
    if (espacio >= 1) {
      return this.linea(izq + ' '.repeat(espacio) + der)
    }
    // No caben juntas en una sola linea: la izquierda va envuelta en sus
    // propias lineas y la derecha alineada a la derecha debajo (tambien
    // envuelta si por si sola excede el ancho, ej. un nombre de cliente largo).
    if (izq) this.parrafo(izq)
    for (const l of envolver(der)) this.linea(' '.repeat(Math.max(0, COLUMNAS - l.length)) + l)
    return this
  }

  /** Linea corta centrada a doble alto y doble ancho (ej. monto del TOTAL).
   * Si no cabe a doble ancho (COLUMNAS/2), cae a doble alto solamente. */
  centroGrande(texto: string) {
    const cabeDoble = texto.length <= Math.floor(COLUMNAS / 2)
    this.raw([...CMD.alinearCentro, ...CMD.negritaOn, ...(cabeDoble ? CMD.dobleOn : CMD.altoDobleOn)])
    this.linea(texto)
    return this.raw([...CMD.altoDobleOff, ...CMD.negritaOff, ...CMD.alinearIzq])
  }

  /** Como fila(), pero en negrita y a doble alto — para la linea de TOTAL. */
  filaDestacada(izq: string, der: string) {
    return this.raw([...CMD.negritaOn, ...CMD.altoDobleOn])
      .fila(izq, der)
      .raw([...CMD.altoDobleOff, ...CMD.negritaOff])
  }

  /** Como fila(), pero en negrita (sin doble alto) — para la linea de metodo
   * de pago, que en el ticket HTML tambien va en negrita con el monto
   * alineado al borde derecho (ver .row-pago en ticket.ts). */
  filaNegrita(izq: string, der: string) {
    return this.raw([...CMD.negritaOn])
      .fila(izq, der)
      .raw([...CMD.negritaOff])
  }

  separador(caracter: '-' | '=' = '-') {
    return this.linea(caracter.repeat(COLUMNAS))
  }

  saltar(n = 1) {
    return this.raw([...CMD.feed(n)])
  }

  /** Concatena todo lo acumulado y corta el papel al final. */
  finalizar(): Uint8Array<ArrayBuffer> {
    this.raw([...CMD.feed(3)]).raw([...CMD.cortarParcial])
    const total = this.partes.reduce((s, p) => s + p.length, 0)
    const salida = new Uint8Array(total)
    let offset = 0
    for (const p of this.partes) {
      salida.set(p, offset)
      offset += p.length
    }
    return salida
  }
}

/**
 * Arma los bytes ESC/POS del ticket de venta — mismo contenido que
 * construirTicketHtml (sin logo), listo para enviarse por Bluetooth. `qr` es
 * el QR de Yape ya convertido a blanco y negro (ver qrParaTicket en
 * utils/qrTermico.ts), o null/undefined si el ticket no lleva QR.
 */
export function construirTicketEscPos(
  venta: TicketDatos,
  lineas: TicketLinea[],
  qr?: QrTermico | null,
): Uint8Array<ArrayBuffer> {
  const t = new ConstructorTicket()
  const negocio = getNegocio()

  t.tituloGrande(negocio.nombre.toUpperCase())
  const documento = textoDocumento(negocio)
  if (documento) t.centro(documento)
  if (negocio.direccion) t.centro(negocio.direccion)
  // numero=0 = venta registrada offline, aun sin numero correlativo real
  // (ver hooks/useVentasOffline.ts).
  t.centroNegrita(venta.numero > 0 ? `TICKET N° ${venta.numero}` : 'TICKET (pendiente de sincronizar)')
  t.centro(fechaHora(venta.creadoEn))
  t.centro(`Cajero: ${venta.cajeroNombre ?? '-'}`)

  if (venta.anulada) {
    t.saltar(1).centroNegrita('*** COMPROBANTE ANULADO ***')
  }

  t.separador('=')
  const tabla = tablaProductos(lineas)
  t.negrita(tabla.cabecera)
  t.separador('-')
  for (const l of tabla.filas) t.negrita(l)

  t.separador('-')
  t.fila('Subtotal', money(venta.subtotal))
  if (venta.descuento > 0) t.fila('Descuento', `- ${money(venta.descuento)}`)
  t.fila('IGV (18%)', money(venta.igv))

  t.separador('=')
  t.centroNegrita('TOTAL A PAGAR')
  t.centroGrande(money(venta.total))
  t.separador('=')

  // fila() en vez de negrita() con texto concatenado: asi el monto queda
  // alineado al borde derecho, igual que en el ticket HTML (.row-pago usa
  // justify-between) y que las filas de Vuelto/Fiado a de abajo.
  // Una linea por metodo (pago mixto: Efectivo y Yape).
  for (const l of lineasPago(venta, (m) => ETIQUETA_METODO[m] ?? m)) {
    t.filaNegrita(l.etiqueta, money(l.monto))
  }
  if (admiteVuelto(venta.metodo) && venta.vuelto > 0) {
    t.filaNegrita('Vuelto', money(venta.vuelto))
  }
  if (venta.clienteNombre) {
    t.fila('Fiado a', venta.clienteNombre)
  }

  t.separador('-')
  t.saltar(1)
  t.centro('¡Gracias por su compra!')
  t.centro('Vuelva pronto')

  if (qr) {
    t.saltar(1).centro('Escanea con Yape').imagen(qr)
  }

  return t.finalizar()
}
