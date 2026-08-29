// Generador de tickets termicos (80mm) — usado tanto al confirmar una venta
// nueva (Receipt) como al reimprimir un comprobante desde el historial
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
import { money, fechaHora } from '@/utils/format'
import { BRAND } from '@/config/brand'

const ETIQUETA_METODO: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
  transferencia: 'Transferencia',
  otro: 'Otro',
}

export interface TicketLinea {
  /** "2x" o "1.5 kg" */
  cantidadTexto: string
  nombre: string
  tag?: string
  montoTexto: string
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
  clienteNombre?: string | null
  anulada?: boolean
}

export function construirTicketHtml(venta: TicketDatos, lineas: TicketLinea[]): string {
  const filas = lineas
    .map(
      (l) => `
        <div class="item">
          <div class="item-nombre">${l.cantidadTexto} ${l.nombre}${l.tag ? ` <span class="tag">[${l.tag}]</span>` : ''}</div>
          <div class="item-precio">${l.montoTexto}</div>
        </div>`,
    )
    .join('')

  const descuentoLine =
    venta.descuento > 0
      ? `<div class="row"><span>Descuento</span><span>- ${money(venta.descuento)}</span></div>`
      : ''

  const vueltoLine =
    venta.metodo === 'efectivo' && venta.vuelto > 0
      ? `<div class="row"><span>Vuelto</span><span>${money(venta.vuelto)}</span></div>`
      : ''

  const clienteLine = venta.clienteNombre
    ? `<div class="row"><span>Fiado a</span><span>${venta.clienteNombre}</span></div>`
    : ''

  const anuladaBanner = venta.anulada
    ? `<div class="anulada">*** COMPROBANTE ANULADO ***</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Ticket #${venta.numero}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 11pt;
      line-height: 1.6;
      width: 80mm;
      padding: 5mm 4mm 8mm 4mm;
      color: #000000;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }

    /* Encabezado */
    .header {
      text-align: center;
      margin-bottom: 3mm;
    }
    .nombre-negocio {
      font-size: 15pt;
      font-weight: 900;
      letter-spacing: 0.5px;
      line-height: 1.3;
    }
    .sub-header {
      font-size: 10pt;
      margin-top: 1mm;
      line-height: 1.5;
    }
    .ticket-num {
      font-size: 11pt;
      font-weight: bold;
      margin-top: 1mm;
    }

    /* Aviso de comprobante anulado */
    .anulada {
      margin: 2mm 0;
      text-align: center;
      font-size: 11pt;
      font-weight: 900;
      letter-spacing: 0.5px;
      border: 1.5px solid #000;
      padding: 1.5mm;
    }

    /* Separadores */
    .sep-dash {
      border: none;
      border-top: 1px dashed #000;
      margin: 3mm 0;
    }
    .sep-solid {
      border: none;
      border-top: 2px solid #000;
      margin: 3mm 0;
    }

    /* Items del carrito */
    .item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 4px;
      margin-bottom: 2mm;
    }
    .item-nombre {
      flex: 1;
      font-size: 10.5pt;
      font-weight: 600;
      word-break: break-word;
      line-height: 1.4;
    }
    .tag {
      font-size: 9pt;
      font-weight: 700;
    }
    .item-precio {
      flex-shrink: 0;
      font-size: 10.5pt;
      font-weight: 700;
      text-align: right;
    }

    /* Filas de resumen */
    .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 4px;
      font-size: 10pt;
      line-height: 1.7;
    }
    .row span:first-child {
      flex: 1;
    }
    .row span:last-child {
      flex-shrink: 0;
      text-align: right;
      font-weight: 600;
    }

    /* Fila TOTAL destacada */
    .row-total {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 4px;
      font-size: 15pt;
      font-weight: 900;
      letter-spacing: 0.5px;
      line-height: 1.5;
      margin: 1mm 0;
    }

    /* Metodo de pago */
    .row-pago {
      display: flex;
      justify-content: space-between;
      font-size: 11pt;
      font-weight: 700;
      line-height: 1.7;
    }

    /* Pie */
    .footer {
      text-align: center;
      margin-top: 4mm;
      font-size: 10pt;
      line-height: 1.6;
    }

    @page {
      size: 80mm auto;
      margin: 0;
    }

    @media print {
      body {
        width: 80mm;
      }
    }
  </style>
</head>
<body>

  <div class="header">
    <div class="nombre-negocio">${BRAND.nombre.toUpperCase()}</div>
    <div class="sub-header">${fechaHora(venta.creadoEn)}</div>
    <div class="sub-header">Cajero: ${venta.cajeroNombre ?? '-'}</div>
    <div class="ticket-num">Ticket N° ${venta.numero}</div>
  </div>

  ${anuladaBanner}

  <hr class="sep-solid"/>

  <div class="items">
    ${filas}
  </div>

  <hr class="sep-dash"/>

  <div class="row"><span>Subtotal</span><span>${money(venta.subtotal)}</span></div>
  ${descuentoLine}
  <div class="row"><span>IGV (18%)</span><span>${money(venta.igv)}</span></div>

  <hr class="sep-solid"/>

  <div class="row-total">
    <span>TOTAL</span>
    <span>${money(venta.total)}</span>
  </div>

  <hr class="sep-dash"/>

  <div class="row-pago">
    <span>${ETIQUETA_METODO[venta.metodo] ?? venta.metodo}</span>
    <span>${money(venta.pagoRecibido)}</span>
  </div>
  ${vueltoLine}
  ${clienteLine}

  <hr class="sep-dash"/>

  <div class="footer">
    <div>¡Gracias por su compra!</div>
    <div>Vuelva pronto</div>
  </div>

</body>
</html>`
}

/**
 * Abre una ventana dedicada solo al ticket, la puebla y dispara la
 * impresion. Lanza un Error (con mensaje para mostrar en un toast) si el
 * navegador bloquea el popup.
 */
export function imprimirTicketHtml(html: string): void {
  const w = window.open('', '_blank', 'width=400,height=700,menubar=no,toolbar=no,scrollbars=no')
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
  // llamar a print() -como se hacia antes- deja la vista previa en blanco:
  // en navegadores modernos print() no bloquea la ejecucion, asi que el
  // cierre ocurria mientras el navegador todavia estaba renderizando el
  // contenido para imprimir.
  let cerrada = false
  const cerrar = () => {
    if (cerrada) return
    cerrada = true
    w.close()
  }
  w.addEventListener('afterprint', cerrar)
  // Respaldo por si el navegador no dispara "afterprint" (pasa en algunos
  // flujos de impresion a impresoras termicas/Bluetooth).
  setTimeout(cerrar, 60000)

  setTimeout(() => {
    w.print()
  }, 350)
}
