// Generador de tickets termicos (80mm / 58mm) — usado tanto al confirmar una
// venta nueva (Receipt) como al reimprimir un comprobante desde el historial
// (Ventas). Comparten esta misma plantilla para que ambos casos impriman
// siempre igual de nitidos.
//
// IMPORTANTE: el ticket SIEMPRE se imprime en un documento standalone,
// abierto en una ventana nueva y dedicada — nunca reutilizando el DOM de la
// app con reglas @media print / visibility:hidden. Esa tecnica deja el
// resultado a merced de modales, overlays y animaciones de la interfaz
// (justo lo que causaba paginas en blanco o mal recortadas al reimprimir
// desde Ventas). Un documento aislado es lo que garantiza nitidez y
// consistencia sin importar desde donde se dispare la impresion.
import { money, escaparHtml } from '@/utils/format'
import { getNegocio, textoDocumento } from '@/config/negocio'
import type { QrTermico } from '@/utils/qrTermico'
import { admiteVuelto, lineasPago } from '@/utils/pagos'
import type { PagoVenta } from '@/types/database'

const ETIQUETA_METODO: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
  mixto: 'Mixto',
  transferencia: 'Transferencia',
  otro: 'Otro',
}

export interface TicketLinea {
  /** Cantidad sin sufijo: "2" o "1.5 kg". */
  cantidadTexto: string
  nombre: string
  tag?: string
  /** Precio unitario ya formateado ("S/ 3.50"). */
  precioUnitarioTexto?: string
  montoTexto: string
}

/**
 * Linea secundaria (opcional) bajo el nombre del producto: presentacion y
 * precio unitario, ej. "Docena · P.U. S/ 10.00". Se omite cuando no aporta
 * nada (1 unidad sin presentacion: el P.U. seria igual al importe), para que
 * el listado quede limpio — una sola linea por producto en el caso comun.
 */
export function subLinea(l: TicketLinea): string | null {
  const partes: string[] = []
  if (l.tag) partes.push(l.tag)
  if (l.precioUnitarioTexto && l.cantidadTexto !== '1') partes.push(`P.U. ${l.precioUnitarioTexto}`)
  return partes.length ? partes.join(' · ') : null
}

export interface TicketDatos {
  numero: number
  creadoEn: string
  cajeroNombre: string | null
  subtotal: number
  descuento: number
  igv: number
  total: number
  metodo: string
  pagoRecibido: number
  vuelto: number
  /** Desglose cuando metodo = 'mixto' (efectivo + yape). */
  pagos?: PagoVenta[] | null
  clienteNombre?: string | null
  anulada?: boolean
}

/**
 * Estilos base compartidos por los tickets termicos HTML (venta y cierre de
 * turno), pensados para que la impresora termica los reproduzca nitidos:
 *  - Sans-serif en negrita (Arial): Courier New es de trazo muy fino y en
 *    papel termico sale tenue y "comido"; un trazo grueso se lee sin esfuerzo.
 *  - Solo negro puro: los grises/colores el driver los convierte en un tramado
 *    de puntos (dithering) que se ve borroso.
 *  - Sin `size` en @page (el anterior "80mm auto" era invalido y el navegador
 *    lo ignoraba): el ancho lo pone el papel del driver (80 o 58 mm) y el
 *    contenido ocupa el 100% con 5 mm de margen seguro a cada lado, en vez de
 *    un ancho fijo de 80 mm que en papel de 58 mm se encoge (letra diminuta)
 *    o queda cortado en los bordes.
 */
export const ESTILOS_BASE_TICKET = `
    @page { margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: #fff; color: #000; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body {
      font-family: Arial, 'Helvetica Neue', Helvetica, 'Liberation Sans', sans-serif;
      font-size: 11pt;
      font-weight: 700;
      line-height: 1.35;
      font-variant-numeric: tabular-nums;
      text-rendering: geometricPrecision;
    }
    .ticket { width: 100%; max-width: 80mm; padding: 3mm 5mm 8mm; }
    .header { text-align: center; margin-bottom: 2mm; }
    .nombre-negocio { font-size: 16pt; font-weight: 900; line-height: 1.2; word-break: break-word; }
    .sub-header { font-size: 10pt; margin-top: 0.8mm; word-break: break-word; }
    .sep-dash { border: none; border-top: 1.5px dashed #000; margin: 2.5mm 0; }
    .sep-solid { border: none; border-top: 2.5px solid #000; margin: 2.5mm 0; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; font-size: 11pt; line-height: 1.55; }
    .row > span:first-child { flex: 1; min-width: 0; word-break: break-word; }
    .row > span:last-child { flex-shrink: 0; max-width: 65%; text-align: right; word-break: break-word; }
    .row-total { display: flex; justify-content: space-between; align-items: baseline; gap: 3mm; font-size: 17pt; font-weight: 900; line-height: 1.3; margin: 1mm 0; }
    .row-total > span:last-child { flex-shrink: 0; text-align: right; }
    .footer { text-align: center; margin-top: 3mm; font-size: 10.5pt; line-height: 1.5; }
`

/* ── Helpers de presentacion compartidos ──────────────────────────────────────
   Los usan el ticket HTML, el ESC/POS (Bluetooth) y las vistas previas en
   pantalla, para que las tres muestren exactamente lo mismo. Son funciones
   puras: solo formatean datos de una venta ya registrada. */

/** Cliente a mostrar en el ticket: "Público General" si la venta no tiene uno. */
export const CLIENTE_POR_DEFECTO = 'Público General'
export function clienteTicket(nombre: string | null | undefined): string {
  const limpio = (nombre ?? '').trim()
  return limpio || CLIENTE_POR_DEFECTO
}

/** Cajero a mostrar: "-" si la venta no lo tiene registrado. */
export function cajeroTicket(nombre: string | null | undefined): string {
  return (nombre ?? '').trim() || '-'
}

/**
 * Numero correlativo de la nota de venta. numero=0 es la señal de una venta
 * registrada offline (ver hooks/useVentasOffline.ts) que aun no tiene el
 * numero real que le asigna el servidor al sincronizar.
 */
export function numeroNotaVenta(numero: number): string {
  return Number(numero) > 0 ? `N° ${numero}` : 'N° pendiente de sincronizar'
}

/**
 * Fecha y hora con formato fijo e independiente del navegador:
 * { fecha: "06/11/2026", hora: "08:04 p. m." }. Se arma a mano (no con
 * toLocaleString) porque cada motor escribe distinto el "p. m." y algunos
 * meten espacios Unicode que la impresora termica imprime como "?".
 */
export function fechaHoraTicket(iso: string): { fecha: string; hora: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { fecha: String(iso ?? ''), hora: '' }
  const dos = (n: number) => String(n).padStart(2, '0')
  const h24 = d.getHours()
  const h12 = h24 % 12 || 12
  return {
    fecha: `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}`,
    hora: `${dos(h12)}:${dos(d.getMinutes())} ${h24 < 12 ? 'a. m.' : 'p. m.'}`,
  }
}

/** Mensaje final, en dos lineas para que no se parta feo en papel de 58 mm. */
export const MENSAJE_GRACIAS = ['¡Gracias por su compra!', 'Vuelva pronto'] as const

/**
 * Ticket de venta interno (nota de venta; no es un comprobante electronico).
 * `qr` es el QR de Yape ya convertido a blanco y negro (ver qrParaTicket en
 * utils/qrTermico.ts), o null/undefined si el ticket no lleva QR.
 */
export function construirTicketHtml(
  venta: TicketDatos,
  lineas: TicketLinea[],
  qr?: QrTermico | null,
): string {
  const negocio = getNegocio()
  const { fecha, hora } = fechaHoraTicket(venta.creadoEn)

  const encabezadoNegocio = [textoDocumento(negocio), negocio.direccion]
    .filter(Boolean)
    .map((l) => `<div class="sub-header">${escaparHtml(l)}</div>`)
    .join('')

  // Listado en tabla de 3 columnas alineadas (CANT | DESCRIPCION | IMPORTE),
  // una fila por producto. El nombre nunca se recorta: si es largo pasa a la
  // linea siguiente dentro de su columna. La linea secundaria (presentacion /
  // precio unitario) solo aparece cuando aporta informacion (ver subLinea).
  const filas = lineas
    .map((l) => {
      const sub = subLinea(l)
      return `
      <tr>
        <td class="c-cant">${escaparHtml(l.cantidadTexto)}</td>
        <td class="c-desc">${escaparHtml(l.nombre)}${sub ? `<div class="sub">${escaparHtml(sub)}</div>` : ''}</td>
        <td class="c-imp">${escaparHtml(l.montoTexto)}</td>
      </tr>`
    })
    .join('')

  // El dataUrl lo genera la propia app (canvas -> PNG); igual se escapa para
  // que nunca pueda romper el atributo.
  const qrBloque = qr
    ? `<div class="qr">
    <div>Escanea con Yape</div>
    <img src="${escaparHtml(qr.dataUrl)}" alt="QR de Yape"/>
  </div>`
    : ''

  // Subtotal y descuento solo cuando hubo descuento: sin descuento el
  // subtotal solo repetiria el total.
  const descuentoLineas =
    venta.descuento > 0
      ? `<div class="row"><span>Subtotal</span><span>${money(venta.subtotal)}</span></div>
  <div class="row"><span>Descuento</span><span>- ${money(venta.descuento)}</span></div>`
      : ''

  // Una linea por metodo de pago: una sola en ventas normales; en pago mixto,
  // Efectivo (lo entregado) y Yape.
  const pagoLineas = lineasPago(venta, (m) => ETIQUETA_METODO[m] ?? m)
    .map(
      (l) =>
        `<div class="row row-pago"><span>${escaparHtml(l.etiqueta)}</span><span>${money(l.monto)}</span></div>`,
    )
    .join('\n  ')

  const vueltoLine =
    admiteVuelto(venta.metodo) && venta.vuelto > 0
      ? `<div class="row"><span>Vuelto</span><span>${money(venta.vuelto)}</span></div>`
      : ''

  const horaLine = hora
    ? `<div class="row"><span>Hora</span><span>${escaparHtml(hora)}</span></div>`
    : ''

  const anuladaAviso = venta.anulada ? `<div class="anulada">*** VENTA ANULADA ***</div>` : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${escaparHtml(venta.numero > 0 ? `Nota de venta N° ${venta.numero}` : 'Nota de venta')}</title>
  <style>${ESTILOS_BASE_TICKET}
    /* Titulo del documento: texto libre y centrado, sin marco */
    .doc-titulo { margin-top: 3mm; text-align: center; font-size: 13pt; font-weight: 900; letter-spacing: 0.06em; }
    .doc-numero { text-align: center; font-size: 11.5pt; font-weight: 900; }

    /* Datos de la venta */
    .datos .row { font-size: 10.5pt; line-height: 1.45; }

    /* Aviso de venta anulada */
    .anulada { margin-top: 2mm; text-align: center; font-size: 12pt; font-weight: 900; }

    /* Listado de productos */
    .items { width: 100%; border-collapse: collapse; table-layout: auto; }
    .items th {
      font-size: 9pt;
      font-weight: 900;
      text-align: left;
      padding: 0 0 1.2mm;
      border-bottom: 1.5px solid #000;
    }
    .items th.c-imp { text-align: right; }
    .items td { font-size: 10.5pt; font-weight: 700; line-height: 1.3; padding: 1.2mm 0 0; vertical-align: top; }
    .items tr { break-inside: avoid; }
    .items .c-cant { width: 1%; white-space: nowrap; padding-right: 2.5mm; }
    .items .c-desc { word-break: break-word; overflow-wrap: anywhere; }
    .items .c-imp { width: 1%; white-space: nowrap; text-align: right; padding-left: 2.5mm; }
    .items .sub { font-size: 9pt; font-weight: 700; margin-top: 0.3mm; }

    /* Metodo de pago */
    .row-pago { font-weight: 900; }

    .gracias { text-align: center; margin-top: 3mm; font-size: 10.5pt; font-weight: 700; }

    /* QR de Yape (opcional, se activa en Configuracion): bitmap 1-bit sin
       suavizado, para que el celular lo lea a la primera. */
    .qr { text-align: center; margin-top: 3mm; font-size: 10pt; font-weight: 900; break-inside: avoid; }
    .qr img {
      display: block;
      width: 40mm;
      max-width: 100%;
      height: auto;
      margin: 1.5mm auto 0;
      image-rendering: crisp-edges;
      image-rendering: pixelated;
    }
  </style>
</head>
<body>
<div class="ticket">

  <div class="header">
    <div class="nombre-negocio">${escaparHtml(negocio.nombre.toUpperCase())}</div>
    ${encabezadoNegocio}
    <div class="doc-titulo">NOTA DE VENTA</div>
    <div class="doc-numero">${escaparHtml(numeroNotaVenta(venta.numero))}</div>
    ${anuladaAviso}
  </div>

  <hr class="sep-dash"/>

  <div class="datos">
    <div class="row"><span>Fecha</span><span>${escaparHtml(fecha)}</span></div>
    ${horaLine}
    <div class="row"><span>Cajero</span><span>${escaparHtml(cajeroTicket(venta.cajeroNombre))}</span></div>
    <div class="row"><span>Cliente</span><span>${escaparHtml(clienteTicket(venta.clienteNombre))}</span></div>
  </div>

  <hr class="sep-dash"/>

  <table class="items">
    <thead>
      <tr><th class="c-cant">CANT</th><th class="c-desc">DESCRIPCIÓN</th><th class="c-imp">IMPORTE</th></tr>
    </thead>
    <tbody>${filas}
    </tbody>
  </table>

  <hr class="sep-dash"/>

  ${descuentoLineas}
  <div class="row-total">
    <span>TOTAL</span>
    <span>${money(venta.total)}</span>
  </div>

  <hr class="sep-dash"/>

  ${pagoLineas}
  ${vueltoLine}

  <hr class="sep-dash"/>

  <div class="gracias">${MENSAJE_GRACIAS.map((l) => `<div>${escaparHtml(l)}</div>`).join('')}</div>

  ${qrBloque}

</div>
</body>
</html>`
}

/**
 * Abre una ventana dedicada solo al ticket, la puebla y dispara la
 * impresion. Lanza un Error (con mensaje para mostrar en un toast) si el
 * navegador bloquea el popup. La usan todos los tickets HTML (venta y
 * cierre de turno).
 */
export function imprimirTicketHtml(html: string): void {
  const w = window.open('', '_blank', 'width=400,height=700,menubar=no,toolbar=no,scrollbars=yes')
  if (!w) {
    throw new Error(
      'El navegador bloqueó la ventana de impresión. Habilita los popups para este sitio e intenta nuevamente.',
    )
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
  w.focus()

  // Cierra la ventana solo cuando el navegador termina con el dialogo de
  // impresion (evento "afterprint"), no antes. Cerrarla justo despues de
  // llamar a print() deja la vista previa en blanco: en navegadores modernos
  // print() no bloquea la ejecucion, asi que el cierre ocurria mientras el
  // navegador todavia estaba renderizando el contenido para imprimir.
  let cerrada = false
  const cerrar = () => {
    if (cerrada) return
    cerrada = true
    try {
      if (!w.closed) w.close()
    } catch {
      // ventana ya cerrada por el usuario
    }
  }
  w.addEventListener('afterprint', cerrar)
  // Respaldo por si el navegador no dispara "afterprint" (pasa en algunos
  // flujos de impresion a impresoras termicas/Bluetooth).
  setTimeout(cerrar, 60000)

  // Imprime cuando terminaron de cargar las imagenes (el QR de Yape) y las
  // fuentes: llamar a print() antes las dejaria en blanco o con la letra de
  // respaldo. Tope de 3 s para que algo que nunca carga no deje el ticket sin
  // imprimir.
  const imagenes = Array.from(w.document.images).filter((img) => !img.complete)
  const fuentes = w.document.fonts?.ready.then(() => undefined) ?? Promise.resolve()
  const listo = Promise.race([
    Promise.all([
      fuentes,
      ...imagenes.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve())
            img.addEventListener('error', () => resolve())
          }),
      ),
    ]),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ])
  listo
    .catch(() => undefined)
    .then(() => {
      setTimeout(() => {
        // La ventana pudo cerrarse mientras tanto (el cajero la cerro a mano).
        if (!cerrada && !w.closed) w.print()
      }, 300)
    })
}
