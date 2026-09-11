// Comandos ESC/POS crudos del ticket de CIERRE DE TURNO — para impresion
// Bluetooth directa (ver utils/bluetoothPrinter.ts). Reutiliza el mismo
// ConstructorTicket que ya usa escpos.ts (venta), con el mismo contenido que
// construirTicketCierreHtml (ver utils/ticketCierre.ts) para que ambas vias
// de impresion muestren siempre la misma informacion.
import { money, fechaHora, horaCorta } from '@/utils/format'
import { BRAND } from '@/config/brand'
import { ConstructorTicket } from '@/utils/escpos'
import type { CajaRegistro, ResultadoArqueo } from '@/types/database'

const ETIQUETA_ESTADO: Record<ResultadoArqueo, string> = {
  ok: 'CONFORME',
  observado: 'OBSERVADO',
  critico: 'ALERTA DE FALTANTE',
}

const toNum = (v: unknown): number => Number(v ?? 0)

/**
 * Arma los bytes ESC/POS del ticket de cierre de turno — mismo contenido que
 * construirTicketCierreHtml, listo para enviarse por Bluetooth. Requiere una
 * caja YA CERRADA (ver nota de arqueo a ciegas en ticketCierre.ts).
 */
export function construirTicketCierreEscPos(caja: CajaRegistro): Uint8Array<ArrayBuffer> {
  if (caja.estado !== 'cerrada' || caja.resultado_arqueo === null) {
    throw new Error('El ticket de cierre solo puede generarse despues de confirmar el arqueo.')
  }

  const totalVentasDirectas = toNum(caja.total_efectivo) + toNum(caja.total_yape)
  const totalCobros = toNum(caja.total_cobros_efectivo) + toNum(caja.total_cobros_yape)
  const totalEgresos = toNum(caja.total_egresos_efectivo) + toNum(caja.total_egresos_otros)
  const balanceNeto = toNum(caja.monto_inicial) + totalVentasDirectas + totalCobros - totalEgresos
  const esperado = toNum(caja.esperado_efectivo)
  const real = toNum(caja.monto_real)
  const diferencia = toNum(caja.diferencia_arqueo)
  const idTurnoCorto = caja.id.slice(0, 8).toUpperCase()

  const t = new ConstructorTicket()

  t.tituloGrande(BRAND.nombre.toUpperCase())
  if (BRAND.ruc) t.centro(`RUC: ${BRAND.ruc}`)
  if (BRAND.direccion) t.centro(BRAND.direccion)
  t.centro('CIERRE DE TURNO')
  t.centro(fechaHora(caja.cerrada_en ?? new Date().toISOString()))

  t.saltar(1).separador('=')
  t.fila('N. Turno', idTurnoCorto)
  t.fila('Cajero', caja.cajero_nombre ?? '-')
  t.fila('Apertura', horaCorta(caja.abierta_en))
  t.fila('Cierre', horaCorta(caja.cerrada_en ?? new Date().toISOString()))

  t.separador('-')
  t.negrita('RESUMEN CONTABLE')
  t.fila('Fondo inicial', money(toNum(caja.monto_inicial)))
  t.fila('Ventas efectivo', money(toNum(caja.total_efectivo)))
  t.fila('Ventas Yape/digital', money(toNum(caja.total_yape)))
  t.fila('Ventas fiado/credito', money(toNum(caja.total_fiado)))
  t.fila('Cobros de deuda', money(totalCobros))
  t.fila('Egresos/gastos', `- ${money(totalEgresos)}`)

  t.separador('=')
  t.filaDestacada('BALANCE NETO', money(balanceNeto))
  t.separador('=')

  t.negrita('RESULTADO DEL ARQUEO')
  t.fila('Efectivo esperado', money(esperado))
  t.fila('Efectivo contado', money(real))
  t.filaDestacada(
    diferencia < 0 ? 'FALTANTE' : diferencia > 0 ? 'SOBRANTE' : 'DIFERENCIA',
    diferencia === 0 ? '—' : `${diferencia > 0 ? '+' : ''}${money(diferencia)}`,
  )

  t.separador('-')
  t.centro(`*** ${ETIQUETA_ESTADO[caja.resultado_arqueo]} ***`)
  t.separador('-')

  t.saltar(2)
  t.centro('Firma del Cajero')
  t.saltar(2)
  t.centro('Firma del Administrador / Auditor')
  t.saltar(1)
  t.centro(BRAND.nombre)
  t.centro('Documento de uso interno')

  return t.finalizar()
}
