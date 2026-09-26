// Pagos de una venta. Una venta normalmente se cobra con UN método (efectivo,
// yape o fiado), pero un cliente puede pagar parte en efectivo y parte en Yape:
// el "pago mixto". En ese caso `metodo` vale 'mixto' y el desglose vive en
// `pagos` ([{metodo:'efectivo',monto:30},{metodo:'yape',monto:20}], siempre
// sumando el total — lo valida registrar_venta en el servidor).
//
// TODO lo que necesite "cuánto se cobró por cada método" (caja, reportes,
// PDF de cierre, Dashboard) debe pasar por `pagosDe` / `montoPorMetodo` y no
// leer `venta.metodo` directo: así una venta mixta se reparte bien entre
// efectivo y yape en vez de perderse o contarse entera en un solo método.

import type { PagoVenta } from '@/types/database'

export const redondear2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

const toNum = (v: unknown): number => Number(v ?? 0)

type VentaConPagos = { metodo: string; total: number | string; pagos?: unknown }

/** Cuánto entró por cada método en esta venta. Una venta de un solo método
 * devuelve [{metodo, monto: total}]; una mixta, su desglose. Nunca lanza: un
 * `pagos` corrupto o ausente en una venta 'mixto' cae al total completo bajo
 * 'mixto' (que ningún total por método recoge, en vez de inventar un reparto). */
export function pagosDe(v: VentaConPagos): { metodo: string; monto: number }[] {
  if (v.metodo === 'mixto' && Array.isArray(v.pagos)) {
    const validos = (v.pagos as unknown[])
      .filter(
        (p): p is { metodo: string; monto: unknown } =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as { metodo?: unknown }).metodo === 'string' &&
          Number.isFinite(toNum((p as { monto?: unknown }).monto)) &&
          toNum((p as { monto?: unknown }).monto) > 0,
      )
      .map((p) => ({ metodo: p.metodo, monto: toNum(p.monto) }))
    if (validos.length > 0) return validos
  }
  return [{ metodo: v.metodo, monto: toNum(v.total) }]
}

/** Suma lo cobrado por un método en un conjunto de ventas (reparte las mixtas). */
export function montoPorMetodo(ventas: VentaConPagos[], metodo: string): number {
  let s = 0
  for (const v of ventas) {
    for (const p of pagosDe(v)) if (p.metodo === metodo) s += p.monto
  }
  return redondear2(s)
}

export type ResultadoPagoMixto =
  | {
      ok: true
      efectivo: number
      yape: number
      /** Efectivo entregado por el cliente (>= efectivo). */
      efectivoRecibido: number
      vuelto: number
      /** Lo que se envía como p_pago_recibido: efectivo entregado + yape. */
      pagoRecibido: number
      pagos: PagoVenta[]
    }
  | { ok: false; error: string }

/** Valida y arma un pago mixto (efectivo + yape) para `total`. Las dos partes
 * deben ser mayores a 0 (si el cliente paga todo con un método, se elige ese
 * método, no "mixto"). El yape es siempre el resto exacto del efectivo, para
 * que sumen el total al centavo. `efectivoRecibido` (opcional) permite dar
 * vuelto sobre la parte en efectivo. */
export function armarPagoMixto(
  total: number,
  efectivoParte: number,
  efectivoRecibido?: number,
): ResultadoPagoMixto {
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, error: 'El total a cobrar no es válido.' }
  }
  if (!Number.isFinite(efectivoParte)) {
    return { ok: false, error: 'Indica cuánto paga en efectivo.' }
  }
  const efectivo = redondear2(efectivoParte)
  const yape = redondear2(total - efectivo)
  if (efectivo <= 0) return { ok: false, error: 'El monto en efectivo debe ser mayor a 0.' }
  if (yape <= 0) {
    return {
      ok: false,
      error: 'El efectivo cubre todo el total: cobra con "Efectivo" en lugar de "Mixto".',
    }
  }
  const recibido = efectivoRecibido === undefined ? efectivo : efectivoRecibido
  if (!Number.isFinite(recibido)) return { ok: false, error: 'El efectivo recibido no es válido.' }
  if (recibido < efectivo - 0.004) {
    return { ok: false, error: 'El efectivo recibido es menor a la parte en efectivo.' }
  }
  const efectivoRecibido2 = redondear2(Math.max(recibido, efectivo))
  return {
    ok: true,
    efectivo,
    yape,
    efectivoRecibido: efectivoRecibido2,
    vuelto: redondear2(efectivoRecibido2 - efectivo),
    pagoRecibido: redondear2(efectivoRecibido2 + yape),
    pagos: [
      { metodo: 'efectivo', monto: efectivo },
      { metodo: 'yape', monto: yape },
    ],
  }
}

/** Líneas "método / monto" del bloque de pago de un ticket. Una venta de un
 * solo método da una línea (con lo recibido); una mixta da Efectivo (lo
 * entregado, para que cuadre con el vuelto de abajo) y Yape. */
export function lineasPago(
  d: { metodo: string; pagoRecibido: number; vuelto: number; pagos?: unknown },
  etiqueta: (metodo: string) => string,
): { etiqueta: string; monto: number }[] {
  if (d.metodo === 'mixto' && Array.isArray(d.pagos)) {
    const partes = pagosDe({ metodo: 'mixto', total: 0, pagos: d.pagos })
    const ef = partes.find((p) => p.metodo === 'efectivo')
    const ye = partes.find((p) => p.metodo === 'yape')
    if (ef && ye) {
      return [
        { etiqueta: etiqueta('efectivo'), monto: redondear2(ef.monto + Math.max(toNum(d.vuelto), 0)) },
        { etiqueta: etiqueta('yape'), monto: ye.monto },
      ]
    }
  }
  return [{ etiqueta: etiqueta(d.metodo), monto: d.pagoRecibido }]
}

/** ¿Este método puede haber generado vuelto? (efectivo, o mixto con parte en efectivo) */
export const admiteVuelto = (metodo: string): boolean => metodo === 'efectivo' || metodo === 'mixto'

/** Método a usar para decidir si el ticket lleva el QR de Yape: una venta
 * mixta con parte en yape también lo lleva (el cliente paga esa parte así). */
export function metodoParaQr(metodo: string, pagos?: unknown): string {
  if (metodo === 'mixto' && pagosDe({ metodo, total: 0, pagos }).some((p) => p.metodo === 'yape')) {
    return 'yape'
  }
  return metodo
}

/** Texto corto del desglose, ej. "Efectivo S/ 30.00 + Yape S/ 20.00". */
export function textoPagos(
  v: VentaConPagos,
  etiqueta: (metodo: string) => string,
  formato: (n: number) => string,
): string {
  const partes = pagosDe(v)
  if (partes.length === 1) return etiqueta(partes[0].metodo)
  return partes.map((p) => `${etiqueta(p.metodo)} ${formato(p.monto)}`).join(' + ')
}
