// Reporte PDF del cierre de caja: se GENERA Y DESCARGA como archivo .pdf (ya no
// se abre una ventana ni el dialogo de impresion). Este modulo no toca
// Supabase ni el DOM salvo `cargarLogoDataUrl` (solo navegador): recibe los
// datos ya cargados y devuelve el documento, por eso se puede probar en Node.
//
// jsPDF + autotable se cargan con import() dinamico: pesan bastante y solo se
// necesitan al cerrar caja, asi el resto de la app no los descarga al iniciar.

import { money, fechaHora, horaCorta } from '@/utils/format'
import { montoPorMetodo, redondear2, textoPagos } from '@/utils/pagos'
import type { Egreso, PagoCredito, Venta } from '@/types/database'
import type { jsPDF } from 'jspdf'

const toNum = (v: unknown): number => Number(v ?? 0)

const ETIQUETA: Record<string, string> = {
  efectivo: 'Efectivo',
  yape: 'Yape',
  fiado: 'Fiado',
  mixto: 'Mixto',
}
const etiqueta = (m: string): string => ETIQUETA[m] ?? m

// ─── Resumen financiero (calculo puro) ───────────────────────────────────────

export interface ResumenFinanciero {
  montoInicial: number
  totalEfectivo: number
  totalYape: number
  totalFiado: number
  /** Suma de TODAS las ventas validas (efectivo + yape + fiado, mixtas incluidas). */
  totalGeneral: number
  totalCobros: number
  cobrosEfectivo: number
  egresosEfectivo: number
  totalEgresos: number
  /** Efectivo fisico esperado: fondo + ventas efectivo + cobros efectivo - egresos efectivo. */
  esperadoEfectivo: number
  montoContado: number
  /** contado - esperado (positivo = sobrante, negativo = faltante). */
  diferencia: number
  /** (fondo + ventas directas + cobros de deuda) - egresos. */
  balanceNeto: number
}

/** Calcula los totales del cierre a partir de las filas del turno. Las ventas
 * de pago mixto se reparten entre efectivo y yape (ver utils/pagos.ts). Las
 * ventas anuladas deben venir ya excluidas de `ventasValidas`. */
export function calcularResumenFinanciero(datos: {
  montoInicial: number
  ventasValidas: Venta[]
  cobros: Pick<PagoCredito, 'metodo' | 'monto'>[]
  egresos: Pick<Egreso, 'metodo' | 'monto'>[]
  montoContado: number
}): ResumenFinanciero {
  const { ventasValidas, cobros, egresos } = datos
  const montoInicial = toNum(datos.montoInicial)

  const totalEfectivo = montoPorMetodo(ventasValidas, 'efectivo')
  const totalYape = montoPorMetodo(ventasValidas, 'yape')
  const totalFiado = montoPorMetodo(ventasValidas, 'fiado')
  const totalGeneral = redondear2(ventasValidas.reduce((s, v) => s + toNum(v.total), 0))

  const cobrosEfectivo = redondear2(
    cobros.filter((p) => p.metodo === 'efectivo').reduce((s, p) => s + toNum(p.monto), 0),
  )
  const cobrosOtros = redondear2(
    cobros.filter((p) => p.metodo !== 'efectivo').reduce((s, p) => s + toNum(p.monto), 0),
  )
  const egresosEfectivo = redondear2(
    egresos.filter((e) => e.metodo === 'efectivo').reduce((s, e) => s + toNum(e.monto), 0),
  )
  const egresosOtros = redondear2(
    egresos.filter((e) => e.metodo !== 'efectivo').reduce((s, e) => s + toNum(e.monto), 0),
  )

  const totalCobros = redondear2(cobrosEfectivo + cobrosOtros)
  const totalEgresos = redondear2(egresosEfectivo + egresosOtros)
  const esperadoEfectivo = redondear2(montoInicial + totalEfectivo + cobrosEfectivo - egresosEfectivo)
  const montoContado = toNum(datos.montoContado)

  return {
    montoInicial,
    totalEfectivo,
    totalYape,
    totalFiado,
    totalGeneral,
    totalCobros,
    cobrosEfectivo,
    egresosEfectivo,
    totalEgresos,
    esperadoEfectivo,
    montoContado,
    diferencia: redondear2(montoContado - esperadoEfectivo),
    balanceNeto: redondear2(montoInicial + totalEfectivo + totalYape + totalCobros - totalEgresos),
  }
}

// ─── Construccion del PDF ────────────────────────────────────────────────────

export interface DatosReporteCierre {
  negocio: { nombre: string; subtitulo: string }
  cajeroNombre: string
  abiertaEn: string
  cerradaEn: string
  generadoEn: string
  /** Todas las ventas del turno; las anuladas solo se cuentan, no se listan ni suman. */
  ventas: Venta[]
  cobros: (Pick<PagoCredito, 'metodo' | 'monto' | 'nota' | 'creado_en'> & { clienteNombre?: string })[]
  egresos: Pick<Egreso, 'metodo' | 'monto' | 'concepto' | 'proveedor_nombre' | 'creado_en'>[]
  resumen: ResumenFinanciero
  /** Logo como data URL (ver cargarLogoDataUrl); opcional. */
  logoDataUrl?: string | null
}

/** Las fuentes estandar de PDF solo cubren Latin-1 (tildes y ñ si; emojis,
 * guiones largos o comillas tipograficas no): un caracter fuera de ese rango
 * saldria como basura, asi que se sustituye por "?". Ademas colapsa los
 * espacios raros (NBSP, U+202F de la hora en es-PE) a un espacio comun. */
export function textoPdf(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    // Bandera u: un emoji es UN caracter (par sustituto UTF-16), no dos.
    .replace(/[^ -~¡-ÿ]/gu, '?')
    .trim()
}

const NEGRO: [number, number, number] = [14, 14, 13]
const GRIS_FONDO: [number, number, number] = [240, 240, 239]
const VERDE: [number, number, number] = [6, 95, 70]
const ROJO: [number, number, number] = [153, 27, 27]

/** Arma el documento PDF (A4). No lo descarga: el llamador usa `doc.save(...)`. */
export async function construirReporteCierrePdf(d: DatosReporteCierre): Promise<jsPDF> {
  const [{ jsPDF: JsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = autoTableMod.default

  const doc = new JsPDF({ unit: 'mm', format: 'a4' })
  const M = 14
  const ANCHO = doc.internal.pageSize.getWidth()
  const ALTO = doc.internal.pageSize.getHeight()
  const t = textoPdf

  const finalY = (): number =>
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 0

  // ── Encabezado ──
  let y = 14
  let xTexto = M
  if (d.logoDataUrl) {
    try {
      const props = doc.getImageProperties(d.logoDataUrl)
      const h = 14
      const w = Math.min((h * props.width) / props.height, 40)
      doc.addImage(d.logoDataUrl, props.fileType, M, y - 2, w, h)
      xTexto = M + w + 4
    } catch {
      // Sin logo el reporte sale igual: nunca debe bloquear el cierre.
    }
  }
  doc.setTextColor(...NEGRO)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.text(t(d.negocio.nombre.toUpperCase()), xTexto, y + 5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(110, 110, 110)
  doc.text(t(`${d.negocio.subtitulo} - Reporte interno`), xTexto, y + 10)

  doc.setTextColor(...NEGRO)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.text('Reporte de Cierre de Caja', ANCHO - M, y + 4, { align: 'right' })
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(90, 90, 90)
  doc.text(t(`Cajero: ${d.cajeroNombre}`), ANCHO - M, y + 9, { align: 'right' })
  doc.text(t(`Generado: ${fechaHora(d.generadoEn)}`), ANCHO - M, y + 13, { align: 'right' })

  y += 18
  doc.setDrawColor(...NEGRO)
  doc.setLineWidth(0.6)
  doc.line(M, y, ANCHO - M, y)
  y += 6

  const validas = d.ventas.filter((v) => !v.anulada)
  const anuladas = d.ventas.length - validas.length

  const baseTabla = {
    theme: 'grid' as const,
    margin: { left: M, right: M, bottom: 16 },
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.8, lineColor: [225, 225, 225] as [number, number, number], lineWidth: 0.2, textColor: NEGRO },
    headStyles: { fillColor: NEGRO, textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const },
    footStyles: { fillColor: GRIS_FONDO, textColor: NEGRO, fontStyle: 'bold' as const },
    alternateRowStyles: { fillColor: [250, 250, 250] as [number, number, number] },
  }

  const titulo = (texto: string) => {
    if (y > ALTO - 40) {
      doc.addPage()
      y = 16
    }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...NEGRO)
    doc.text(t(texto.toUpperCase()), M, y)
    y += 2.5
  }

  // ── Informacion de la sesion ──
  titulo('Informacion de la sesion')
  autoTable(doc, {
    ...baseTabla,
    startY: y,
    head: [['Apertura', 'Cierre', 'Fondo inicial', 'Transacciones']],
    body: [
      [
        t(fechaHora(d.abiertaEn)),
        t(fechaHora(d.cerradaEn)),
        t(money(d.resumen.montoInicial)),
        `${validas.length} validas${anuladas > 0 ? ` - ${anuladas} anuladas` : ''}`,
      ],
    ],
  })
  y = finalY() + 7

  // ── Detalle de ventas ──
  titulo('Detalle de ventas del turno')
  autoTable(doc, {
    ...baseTabla,
    startY: y,
    head: [['Ticket', 'Hora', 'Metodo', 'Cliente', 'Total']],
    body:
      validas.length > 0
        ? validas.map((v) => [
            `#${String(v.numero).padStart(4, '0')}`,
            t(horaCorta(v.creado_en)),
            // Pago mixto: "Efectivo S/ 30.00 + Yape S/ 20.00"
            t(textoPagos(v, etiqueta, money)),
            t(v.cliente_nombre || '-'),
            t(money(toNum(v.total))),
          ])
        : [[{ content: 'Sin ventas registradas en este turno', colSpan: 5, styles: { halign: 'center' as const, textColor: [150, 150, 150] as [number, number, number] } }]],
    foot:
      validas.length > 0
        ? [[{ content: `TOTAL VENDIDO (${validas.length} ventas validas)`, colSpan: 4 }, t(money(d.resumen.totalGeneral))]]
        : undefined,
    columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 24 }, 2: { cellWidth: 58 }, 4: { halign: 'right' as const, cellWidth: 26 } },
    footStyles: { ...baseTabla.footStyles, halign: 'right' as const },
  })
  y = finalY() + 7

  // ── Cobros de deuda ──
  titulo('Cobros de deuda del turno')
  autoTable(doc, {
    ...baseTabla,
    startY: y,
    head: [['Hora', 'Cliente', 'Metodo', 'Nota', 'Monto']],
    body:
      d.cobros.length > 0
        ? d.cobros.map((p) => [
            t(horaCorta(p.creado_en)),
            t(p.clienteNombre || '-'),
            t(etiqueta(p.metodo)),
            t(p.nota || ''),
            t(money(toNum(p.monto))),
          ])
        : [[{ content: 'Sin cobros de deuda registrados en este turno', colSpan: 5, styles: { halign: 'center' as const, textColor: [150, 150, 150] as [number, number, number] } }]],
    foot:
      d.cobros.length > 0
        ? [[{ content: `TOTAL COBRADO (${d.cobros.length} abono${d.cobros.length === 1 ? '' : 's'})`, colSpan: 4 }, t(money(d.resumen.totalCobros))]]
        : undefined,
    columnStyles: { 4: { halign: 'right' as const, cellWidth: 26 } },
    footStyles: { ...baseTabla.footStyles, halign: 'right' as const },
  })
  y = finalY() + 7

  // ── Egresos ──
  titulo('Egresos del turno')
  autoTable(doc, {
    ...baseTabla,
    startY: y,
    head: [['Hora', 'Concepto', 'Metodo', 'Monto']],
    body:
      d.egresos.length > 0
        ? d.egresos.map((e) => [
            t(horaCorta(e.creado_en)),
            t(e.proveedor_nombre ? `${e.concepto} (${e.proveedor_nombre})` : e.concepto),
            t(e.metodo),
            t(money(toNum(e.monto))),
          ])
        : [[{ content: 'Sin egresos registrados en este turno', colSpan: 4, styles: { halign: 'center' as const, textColor: [150, 150, 150] as [number, number, number] } }]],
    foot:
      d.egresos.length > 0
        ? [[{ content: `TOTAL EGRESOS (${d.egresos.length})`, colSpan: 3 }, t(money(d.resumen.totalEgresos))]]
        : undefined,
    columnStyles: { 3: { halign: 'right' as const, cellWidth: 26 } },
    footStyles: { ...baseTabla.footStyles, halign: 'right' as const },
  })
  y = finalY() + 7

  // ── Resumen financiero ──
  const r = d.resumen
  const dif = r.diferencia
  const textoDif = Math.abs(dif) < 0.005 ? 'Cuadrado' : dif > 0 ? 'Sobrante' : 'Faltante'
  const filasResumen: { etiqueta: string; valor: string; destacar?: boolean; color?: [number, number, number] }[] = [
    { etiqueta: 'Ventas en efectivo', valor: money(r.totalEfectivo) },
    { etiqueta: 'Ventas Yape', valor: money(r.totalYape) },
    { etiqueta: 'Ventas al fiado', valor: money(r.totalFiado) },
    { etiqueta: 'TOTAL VENDIDO (efectivo + yape + fiado)', valor: money(r.totalGeneral), destacar: true },
    { etiqueta: 'Cobros de deuda', valor: money(r.totalCobros) },
    { etiqueta: 'Egresos', valor: `- ${money(r.totalEgresos)}` },
    { etiqueta: 'Efectivo esperado en caja', valor: money(r.esperadoEfectivo) },
    { etiqueta: 'Efectivo contado', valor: money(r.montoContado) },
    { etiqueta: `Diferencia (${textoDif})`, valor: `${dif > 0 ? '+' : ''}${money(dif)}`, destacar: true, color: dif >= 0 ? VERDE : ROJO },
    { etiqueta: 'BALANCE FINAL NETO (fondo + ventas directas + cobros de deuda - egresos)', valor: money(r.balanceNeto), destacar: true },
  ]
  titulo('Resumen financiero del dia')
  autoTable(doc, {
    ...baseTabla,
    startY: y,
    body: filasResumen.map((f) => [t(f.etiqueta), t(f.valor)]),
    columnStyles: { 1: { halign: 'right' as const, cellWidth: 40 } },
    didParseCell: (data) => {
      const fila = filasResumen[data.row.index]
      if (data.section !== 'body' || !fila) return
      if (fila.destacar) {
        data.cell.styles.fontStyle = 'bold'
        data.cell.styles.fillColor = GRIS_FONDO
      }
      if (fila.color) data.cell.styles.textColor = fila.color
    },
  })

  // ── Pie de pagina en todas las hojas ──
  const paginas = doc.getNumberOfPages()
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(150, 150, 150)
    doc.text(t(`${d.negocio.nombre} - Documento de uso interno - Generado el ${fechaHora(d.generadoEn)}`), M, ALTO - 8)
    doc.text(`Pagina ${i} de ${paginas}`, ANCHO - M, ALTO - 8, { align: 'right' })
  }

  return doc
}

/** Nombre del archivo: Cierre-de-caja_2026-09-26_maria-lopez.pdf */
export function nombreArchivoCierre(cajeroNombre: string | null | undefined, fechaIso: string): string {
  const cajero =
    String(cajeroNombre ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'cajero'
  const fecha = /^\d{4}-\d{2}-\d{2}/.test(fechaIso) ? fechaIso.slice(0, 10) : 'sin-fecha'
  return `Cierre-de-caja_${fecha}_${cajero}.pdf`
}

/** Logo del negocio como data URL para incrustarlo en el PDF (solo navegador);
 * null si no se puede cargar (offline, archivo ausente): el reporte sale sin logo. */
export async function cargarLogoDataUrl(url = '/img/logo.png'): Promise<string | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    const blob = await r.blob()
    if (!blob.type.startsWith('image/')) return null
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(fr.error)
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}
