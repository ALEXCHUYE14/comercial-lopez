// Generador de comandos ESC/POS crudos para impresoras termicas — usado por
// la impresion Bluetooth (Web Bluetooth no tiene dialogo de impresion del
// sistema operativo: hay que enviarle a la impresora los bytes ESC/POS
// directamente). Reutiliza el MISMO contenido que construirTicketHtml (sin
// logo, igual al ticket que ya se ve en pantalla) para que ambas vias de
// impresion muestren siempre la misma informacion.
import { money, fechaHora } from '@/utils/format'
import { BRAND } from '@/config/brand'
import type { TicketDatos, TicketLinea } from '@/utils/ticket'

const ETIQUETA_METODO: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
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
  '¿': 0xa8, '¡': 0xad, '°': 0xf8,
}

function textoABytes(texto: string): number[] {
  const bytes: number[] = []
  for (const ch of texto) {
    const mapeado = MAPA_CP850[ch]
    if (mapeado !== undefined) {
      bytes.push(mapeado)
    } else {
      const code = ch.codePointAt(0) ?? 0x3f
      // Fuera de ASCII imprimible y sin mapeo conocido -> "?" en vez de
      // bytes UTF-8 multibyte, que la impresora interpretaria como basura.
      bytes.push(code < 0x20 || code > 0x7e ? 0x3f : code)
    }
  }
  return bytes
}

class ConstructorTicket {
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
    return this.raw([...CMD.alinearCentro]).linea(texto).raw([...CMD.alinearIzq])
  }

  negrita(texto: string) {
    return this.raw([...CMD.negritaOn]).linea(texto).raw([...CMD.negritaOff])
  }

  tituloGrande(texto: string) {
    return this.raw([...CMD.alinearCentro, ...CMD.negritaOn, ...CMD.altoDobleOn])
      .linea(texto)
      .raw([...CMD.altoDobleOff, ...CMD.negritaOff, ...CMD.alinearIzq])
  }

  texto(texto = '') {
    return this.linea(texto)
  }

  /** Dos columnas: izquierda pegada al borde, derecha alineada a la derecha. */
  fila(izq: string, der: string) {
    const espacio = COLUMNAS - izq.length - der.length
    if (espacio >= 1) {
      return this.linea(izq + ' '.repeat(espacio) + der)
    }
    // La izquierda no cabe junto con la derecha en una sola linea: se corta
    // en su propia linea y la derecha va alineada a la derecha debajo,
    // evitando que la impresora la envuelva a mitad de palabra.
    return this.linea(izq).linea(' '.repeat(Math.max(0, COLUMNAS - der.length)) + der)
  }

  /** Como fila(), pero en negrita y a doble alto — para la linea de TOTAL. */
  filaDestacada(izq: string, der: string) {
    return this.raw([...CMD.negritaOn, ...CMD.altoDobleOn])
      .fila(izq, der)
      .raw([...CMD.altoDobleOff, ...CMD.negritaOff])
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
 * construirTicketHtml (sin logo), listo para enviarse por Bluetooth.
 */
export function construirTicketEscPos(venta: TicketDatos, lineas: TicketLinea[]): Uint8Array<ArrayBuffer> {
  const t = new ConstructorTicket()

  t.tituloGrande(BRAND.nombre.toUpperCase())
  t.centro(fechaHora(venta.creadoEn))
  t.centro(`Cajero: ${venta.cajeroNombre ?? '-'}`)
  // numero=0 = venta registrada offline, aun sin numero correlativo real
  // (ver hooks/useVentasOffline.ts).
  t.centro(venta.numero > 0 ? `Ticket N° ${venta.numero}` : 'Ticket (pendiente de sincronizar)')

  if (venta.anulada) {
    t.saltar(1).negrita('*** COMPROBANTE ANULADO ***')
  }

  t.saltar(1).separador('=')

  for (const l of lineas) {
    const nombre = `${l.cantidadTexto} ${l.nombre}${l.tag ? ` [${l.tag}]` : ''}`
    if (nombre.length + l.montoTexto.length + 1 <= COLUMNAS) {
      t.fila(nombre, l.montoTexto)
    } else {
      // Nombre largo: va en su propia linea y el monto alineado a la
      // derecha debajo, igual que el ticket HTML lo envuelve con flexbox.
      t.texto(nombre).fila('', l.montoTexto)
    }
  }

  t.separador('-')
  t.fila('Subtotal', money(venta.subtotal))
  if (venta.descuento > 0) t.fila('Descuento', `- ${money(venta.descuento)}`)
  t.fila('IGV (18%)', money(venta.igv))

  t.separador('=')
  t.filaDestacada('TOTAL', money(venta.total))
  t.separador('-')

  t.negrita(`${ETIQUETA_METODO[venta.metodo] ?? venta.metodo}  ${money(venta.pagoRecibido)}`)
  if (venta.metodo === 'efectivo' && venta.vuelto > 0) {
    t.fila('Vuelto', money(venta.vuelto))
  }
  if (venta.clienteNombre) {
    t.fila('Fiado a', venta.clienteNombre)
  }

  t.separador('-')
  t.saltar(1)
  t.centro('¡Gracias por su compra!')
  t.centro('Vuelva pronto')

  return t.finalizar()
}
