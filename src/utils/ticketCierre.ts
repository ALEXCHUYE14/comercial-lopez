// Ticket termico (80mm) de CIERRE DE TURNO — arqueo de caja del cajero.
// Mismo patron que utils/ticket.ts (venta): documento HTML standalone,
// abierto en una ventana nueva y dedicada, con @page 80mm auto. Comparten la
// misma tipografia/plantilla visual para que ambos tickets impriman siempre
// igual de nitidos y reconocibles como del mismo sistema.
//
// IMPORTANTE (arqueo a ciegas): este ticket solo debe construirse DESPUES de
// que el cajero ya declaro su conteo fisico y el cierre fue confirmado en el
// servidor (ver hooks/useCaja.ts -> cerrar(), que llama al RPC
// cerrar_caja_arqueo). Nunca se debe mostrar/imprimir el desglose de este
// ticket ANTES de esa confirmacion — eso filtraria el efectivo esperado y
// arruinaria el proposito del arqueo a ciegas.
import { money, fechaHora, horaCorta, escaparHtml } from '@/utils/format'
import { getNegocio, textoDocumento } from '@/config/negocio'
import type { CajaRegistro, ResultadoArqueo } from '@/types/database'

const ETIQUETA_ESTADO: Record<ResultadoArqueo, string> = {
  ok: 'CONFORME',
  observado: 'OBSERVADO',
  critico: 'ALERTA DE FALTANTE',
}

// Conversion numerica segura — Supabase puede devolver NUMERIC como string
const toNum = (v: unknown): number => Number(v ?? 0)

export interface TotalesTicketCierre {
  totalVentasDirectas: number
  totalCobros: number
  totalEgresos: number
  balanceNeto: number
}

function calcularTotales(c: CajaRegistro): TotalesTicketCierre {
  const totalVentasDirectas = toNum(c.total_efectivo) + toNum(c.total_yape)
  const totalCobros = toNum(c.total_cobros_efectivo) + toNum(c.total_cobros_yape)
  const totalEgresos = toNum(c.total_egresos_efectivo) + toNum(c.total_egresos_otros)
  const balanceNeto =
    toNum(c.monto_inicial) + totalVentasDirectas + totalCobros - totalEgresos
  return { totalVentasDirectas, totalCobros, totalEgresos, balanceNeto }
}

/**
 * Arma el HTML del ticket de cierre de turno. Requiere una caja YA CERRADA
 * (estado='cerrada', con resultado_arqueo/diferencia_arqueo/esperado_efectivo
 * ya calculados por el servidor) — construirlo con una caja abierta expondria
 * el efectivo esperado antes de tiempo.
 */
export function construirTicketCierreHtml(caja: CajaRegistro): string {
  if (caja.estado !== 'cerrada' || caja.resultado_arqueo === null) {
    throw new Error('El ticket de cierre solo puede generarse despues de confirmar el arqueo.')
  }

  const { totalCobros, totalEgresos, balanceNeto } = calcularTotales(caja)
  const esperado = toNum(caja.esperado_efectivo)
  const real = toNum(caja.monto_real)
  const diferencia = toNum(caja.diferencia_arqueo)
  const estado = ETIQUETA_ESTADO[caja.resultado_arqueo]
  const tonoEstado =
    caja.resultado_arqueo === 'ok' ? '#065f46' : caja.resultado_arqueo === 'observado' ? '#92400e' : '#991b1b'

  const idTurnoCorto = caja.id.slice(0, 8).toUpperCase()
  const negocio = getNegocio()
  const encabezadoDireccion = [textoDocumento(negocio), negocio.direccion]
    .filter(Boolean)
    .map((l) => `<div class="sub-header">${escaparHtml(l)}</div>`)
    .join('')

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Cierre de turno ${idTurnoCorto}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
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
    .header { text-align: center; margin-bottom: 3mm; }
    .nombre-negocio { font-size: 15pt; font-weight: 900; letter-spacing: 0.5px; line-height: 1.3; }
    .sub-header { font-size: 10pt; margin-top: 1mm; line-height: 1.5; }
    .titulo-ticket { font-size: 12pt; font-weight: 900; margin-top: 2mm; letter-spacing: 0.5px; }
    .sep-dash { border: none; border-top: 1px dashed #000; margin: 3mm 0; }
    .sep-solid { border: none; border-top: 2px solid #000; margin: 3mm 0; }
    .seccion-titulo { font-size: 10pt; font-weight: 900; text-transform: uppercase; letter-spacing: 0.5px; margin: 3mm 0 1.5mm; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 4px; font-size: 10pt; line-height: 1.7; }
    .row span:first-child { flex: 1; }
    .row span:last-child { flex-shrink: 0; text-align: right; font-weight: 600; }
    .row-total { display: flex; justify-content: space-between; align-items: baseline; gap: 4px; font-size: 13pt; font-weight: 900; letter-spacing: 0.3px; line-height: 1.5; margin: 1mm 0; }
    .estado-box { margin: 3mm 0; text-align: center; font-size: 12pt; font-weight: 900; letter-spacing: 0.5px; border: 2px solid ${tonoEstado}; color: ${tonoEstado}; padding: 2mm; border-radius: 2px; }
    .firma { margin-top: 10mm; text-align: center; font-size: 9.5pt; }
    .firma-linea { border-top: 1px solid #000; margin: 10mm 4mm 1.5mm; }
    .footer { text-align: center; margin-top: 5mm; font-size: 9pt; line-height: 1.6; color: #333; }
    @page { size: 80mm auto; margin: 0; }
    @media print { body { width: 80mm; } }
  </style>
</head>
<body>

  <div class="header">
    <div class="nombre-negocio">${escaparHtml(negocio.nombre.toUpperCase())}</div>
    ${encabezadoDireccion}
    <div class="titulo-ticket">CIERRE DE TURNO</div>
    <div class="sub-header">${fechaHora(caja.cerrada_en ?? new Date().toISOString())}</div>
  </div>

  <hr class="sep-solid"/>

  <div class="row"><span>N° Turno</span><span>${idTurnoCorto}</span></div>
  <div class="row"><span>Cajero</span><span>${escaparHtml(caja.cajero_nombre ?? '-')}</span></div>
  <div class="row"><span>Apertura</span><span>${horaCorta(caja.abierta_en)}</span></div>
  <div class="row"><span>Cierre</span><span>${horaCorta(caja.cerrada_en ?? new Date().toISOString())}</span></div>

  <hr class="sep-dash"/>

  <div class="seccion-titulo">Resumen contable</div>
  <div class="row"><span>Fondo inicial</span><span>${money(toNum(caja.monto_inicial))}</span></div>
  <div class="row"><span>Ventas efectivo</span><span>${money(toNum(caja.total_efectivo))}</span></div>
  <div class="row"><span>Ventas Yape/digital</span><span>${money(toNum(caja.total_yape))}</span></div>
  <div class="row"><span>Ventas fiado/credito</span><span>${money(toNum(caja.total_fiado))}</span></div>
  <div class="row"><span>Cobros de deuda</span><span>${money(totalCobros)}</span></div>
  <div class="row"><span>Egresos/gastos</span><span>- ${money(totalEgresos)}</span></div>

  <hr class="sep-dash"/>

  <div class="row-total"><span>BALANCE NETO</span><span>${money(balanceNeto)}</span></div>

  <hr class="sep-solid"/>

  <div class="seccion-titulo">Resultado del arqueo</div>
  <div class="row"><span>Efectivo esperado</span><span>${money(esperado)}</span></div>
  <div class="row"><span>Efectivo contado</span><span>${money(real)}</span></div>
  <div class="row-total">
    <span>${diferencia < 0 ? 'FALTANTE' : diferencia > 0 ? 'SOBRANTE' : 'DIFERENCIA'}</span>
    <span>${diferencia === 0 ? '—' : `${diferencia > 0 ? '+' : ''}${money(diferencia)}`}</span>
  </div>

  <div class="estado-box">${estado}</div>

  <div class="firma">
    <div class="firma-linea"></div>
    <div>Firma del Cajero</div>
    <div class="firma-linea"></div>
    <div>Firma del Administrador / Auditor</div>
  </div>

  <div class="footer">
    <div>${escaparHtml(negocio.nombre)}</div>
    <div>Documento de uso interno — control de caja</div>
  </div>

</body>
</html>`
}

/**
 * Abre una ventana dedicada solo al ticket de cierre, la puebla y dispara la
 * impresion — mismo mecanismo que imprimirTicketHtml (ver utils/ticket.ts),
 * duplicado aqui a proposito para no acoplar este archivo (datos de un turno)
 * con el de ventas (datos de un carrito).
 */
export function imprimirTicketCierreHtml(html: string): void {
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

  let cerrada = false
  const cerrar = () => {
    if (cerrada) return
    cerrada = true
    w.close()
  }
  w.addEventListener('afterprint', cerrar)
  setTimeout(cerrar, 60000)

  setTimeout(() => {
    w.print()
  }, 350)
}
