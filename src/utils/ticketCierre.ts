// Ticket termico (80mm) de CIERRE DE TURNO — arqueo de caja del cajero.
// Mismo patron que utils/ticket.ts (venta): documento HTML standalone,
// abierto en una ventana nueva y dedicada. Comparten los mismos estilos base
// (ESTILOS_BASE_TICKET: negrita, solo negro puro, ancho segun el papel)
// para que ambos tickets impriman igual de nitidos.
//
// IMPORTANTE (arqueo a ciegas): este ticket solo debe construirse DESPUES de
// que el cajero ya declaro su conteo fisico y el cierre fue confirmado en el
// servidor (ver hooks/useCaja.ts -> cerrar(), que llama al RPC
// cerrar_caja_arqueo). Nunca se debe mostrar/imprimir el desglose de este
// ticket ANTES de esa confirmacion — eso filtraria el efectivo esperado y
// arruinaria el proposito del arqueo a ciegas.
import { money, fechaHora, horaCorta, escaparHtml } from '@/utils/format'
import { getNegocio, textoDocumento } from '@/config/negocio'
import { ESTILOS_BASE_TICKET, imprimirTicketHtml } from '@/utils/ticket'
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
  <style>${ESTILOS_BASE_TICKET}
    .titulo-ticket { display: inline-block; margin: 1.5mm 0 0.5mm; padding: 0.5mm 2.5mm; border: 2px solid #000; font-size: 12.5pt; font-weight: 900; }
    .seccion-titulo { font-size: 10.5pt; font-weight: 900; text-transform: uppercase; margin: 2.5mm 0 1mm; }
    .row-total { font-size: 14pt; }
    .estado-box { margin: 3mm 0; text-align: center; font-size: 13pt; font-weight: 900; border: 2.5px solid #000; padding: 2mm; }
    .firma { margin-top: 8mm; text-align: center; font-size: 10pt; }
    .firma-linea { border-top: 1.5px solid #000; margin: 10mm 4mm 1.5mm; }
    .footer { font-size: 9.5pt; }
  </style>
</head>
<body>
<div class="ticket">

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

</div>
</body>
</html>`
}

/**
 * Abre una ventana dedicada solo al ticket de cierre y dispara la impresion.
 * Usa el mismo mecanismo que el ticket de venta (imprimirTicketHtml), que
 * espera a que el documento este listo y no imprime si la ventana se cerro.
 */
export function imprimirTicketCierreHtml(html: string): void {
  imprimirTicketHtml(html)
}
