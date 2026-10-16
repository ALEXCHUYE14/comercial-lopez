// Backup de mermas en Excel (.xlsx): exportar todo el historial e importarlo
// de vuelta. Mismo enfoque que utils/inventarioExcel.ts: "xlsx" se carga con
// import() dinamico (solo al usar estos botones) y el propio archivo exportado
// sirve de plantilla para volver a subirlo.
//
// Regla clave (ver importar_mermas en supabase/mermas_excel.sql):
//   - Filas CON ID (salen del archivo exportado) = backup: se restauran como
//     registro historico SIN tocar el stock, y si ya existen se omiten.
//   - Filas SIN ID (mermas nuevas escritas a mano) = se registran como merma
//     real y SI descuentan stock del producto.
import { supabase } from '@/lib/supabase'
import { aNumero, normalizarEncabezado, numeroSeguro, textoSeguro } from '@/utils/inventarioExcel'
import { ymd } from '@/utils/format'
import { ETIQUETA_MOTIVO } from '@/hooks/useMermas'
import type { Merma, MotivoMerma } from '@/types/database'

const HOJA = 'Mermas'
const TAM_PAGINA = 1000

const ENCABEZADOS = [
  'ID (NO EDITAR)', 'Fecha (AAAA-MM-DD HH:MM)', 'SKU', 'Producto', 'Cantidad',
  'Costo unitario', 'Costo total', 'Motivo', 'Descripcion', 'Registrado por', 'ID usuario (NO EDITAR)',
] as const

type MermaExport = Merma & {
  productos: { sku: string } | null
  perfiles: { nombre: string } | null
}

export type FilaMerma = {
  fila: number
  id: string | null
  fecha: string | null
  sku: string | null
  producto: string | null
  cantidad: number | null
  costo_unitario: number | null
  costo_total: number | null
  /** Clave del enum (vencido, danado, ...) o el texto original si no se reconocio
   * (el servidor lo rechaza con un mensaje claro para esa fila). */
  motivo: string | null
  descripcion: string | null
  usuario_id: string | null
}

const ALIAS: Record<string, keyof FilaMerma> = {
  id: 'id',
  'id (no editar)': 'id',
  fecha: 'fecha',
  'fecha (aaaa-mm-dd hh:mm)': 'fecha',
  sku: 'sku',
  producto: 'producto',
  nombre: 'producto',
  cantidad: 'cantidad',
  'costo unitario': 'costo_unitario',
  costo: 'costo_unitario',
  'costo total': 'costo_total',
  motivo: 'motivo',
  descripcion: 'descripcion',
  'id usuario (no editar)': 'usuario_id',
}

const CAMPOS_NUMERICOS = new Set<keyof FilaMerma>(['cantidad', 'costo_unitario', 'costo_total'])

function dos(n: number): string {
  return String(n).padStart(2, '0')
}

/** Fecha local legible y sin ambiguedad: "2026-10-16 14:30". */
function fechaCelda(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${ymd(d)} ${dos(d.getHours())}:${dos(d.getMinutes())}`
}

/** Celda de fecha -> ISO con zona horaria (o el texto original si no se
 * entiende: el servidor lo rechaza con un mensaje claro para esa fila). */
function aFechaIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  const s = String(v).trim()
  if (s === '') return null
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
    // new Date "corrige" fechas imposibles (31 de febrero -> marzo): se rechazan.
    if (d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3]) {
      return d.toISOString()
    }
    return s
  }
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/) // DD/MM/AAAA
  if (m2) {
    const d = new Date(+m2[3], +m2[2] - 1, +m2[1], +(m2[4] ?? 0), +(m2[5] ?? 0))
    if (d.getFullYear() === +m2[3] && d.getMonth() === +m2[2] - 1 && d.getDate() === +m2[1]) {
      return d.toISOString()
    }
  }
  return s
}

const MOTIVOS_POR_TEXTO: Record<string, MotivoMerma> = (() => {
  const mapa: Record<string, MotivoMerma> = {
    vencido: 'vencido',
    danado: 'danado',
    'consumo interno': 'consumo_interno',
    consumo_interno: 'consumo_interno',
    otro: 'otro',
  }
  for (const [clave, etiqueta] of Object.entries(ETIQUETA_MOTIVO) as [MotivoMerma, string][]) {
    mapa[normalizarEncabezado(etiqueta)] = clave
  }
  return mapa
})()

function aMotivo(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '') return null
  return MOTIVOS_POR_TEXTO[normalizarEncabezado(s)] ?? s
}

function aTexto(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Trae TODAS las mermas (todas las fechas), paginando de a 1000 filas. */
async function traerTodasLasMermas(): Promise<MermaExport[]> {
  const todas: MermaExport[] = []
  for (let desde = 0; ; desde += TAM_PAGINA) {
    const { data, error } = await supabase
      .from('mermas')
      .select('*, productos(sku), perfiles(nombre)')
      .order('creado_en', { ascending: true })
      .order('id', { ascending: true })
      .range(desde, desde + TAM_PAGINA - 1)
    if (error) throw new Error(error.message)
    todas.push(...((data ?? []) as unknown as MermaExport[]))
    if (!data || data.length < TAM_PAGINA) return todas
  }
}

/** Descarga el historial COMPLETO de mermas como .xlsx (backup). Devuelve la
 * cantidad de filas exportadas. */
export async function exportarMermasExcel(): Promise<number> {
  const mermas = await traerTodasLasMermas()
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ...mermas.map((m) => [
      m.id,
      fechaCelda(m.creado_en),
      textoSeguro(m.productos?.sku ?? ''),
      textoSeguro(m.producto_nombre ?? ''),
      numeroSeguro(Number(m.cantidad)),
      numeroSeguro(Number(m.costo_unitario)),
      numeroSeguro(Number(m.costo_total)),
      ETIQUETA_MOTIVO[m.motivo] ?? m.motivo,
      textoSeguro(m.descripcion ?? ''),
      textoSeguro(m.perfiles?.nombre ?? ''),
      m.usuario_id ?? '',
    ]),
  ]
  const hoja = XLSX.utils.aoa_to_sheet(filas)
  hoja['!cols'] = ENCABEZADOS.map((h, i) => ({ wch: i === 0 || i === 10 ? 38 : Math.max(h.length, 14) }))
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, HOJA)
  XLSX.writeFile(libro, `mermas_${ymd(new Date())}.xlsx`)
  return mermas.length
}

/** Lee el .xlsx subido y devuelve las filas normalizadas para importar_mermas.
 * Las reglas de negocio las valida el servidor fila por fila. */
export async function leerMermasExcel(archivo: File): Promise<FilaMerma[]> {
  const XLSX = await import('xlsx')
  const buffer = await archivo.arrayBuffer()
  const libro = XLSX.read(buffer, { type: 'array', cellDates: true })
  const nombreHoja = libro.SheetNames[0]
  if (!nombreHoja) throw new Error('El archivo no tiene hojas.')
  const registros = XLSX.utils.sheet_to_json<Record<string, unknown>>(libro.Sheets[nombreHoja], {
    defval: null,
    raw: true,
  })

  const filas: FilaMerma[] = []
  registros.forEach((registro, i) => {
    const fila: FilaMerma = {
      fila: i + 2, // fila 1 = encabezado
      id: null, fecha: null, sku: null, producto: null, cantidad: null,
      costo_unitario: null, costo_total: null, motivo: null, descripcion: null, usuario_id: null,
    }
    let reconocidas = 0
    for (const [encabezado, valor] of Object.entries(registro)) {
      const campo = ALIAS[normalizarEncabezado(encabezado)]
      if (!campo || campo === 'fila') continue
      reconocidas++
      if (campo === 'fecha') fila.fecha = aFechaIso(valor)
      else if (campo === 'motivo') fila.motivo = aMotivo(valor)
      else if (CAMPOS_NUMERICOS.has(campo)) (fila[campo] as number | null) = aNumero(valor)
      else (fila[campo] as string | null) = aTexto(valor)
    }
    if (reconocidas === 0) return
    // Fila totalmente vacia (Excel a veces deja filas "en blanco" con formato).
    const vacia = !fila.id && !fila.sku && !fila.producto && fila.cantidad === null && !fila.motivo
    if (!vacia) filas.push(fila)
  })

  if (filas.length === 0) {
    throw new Error(
      'El archivo no tiene filas de mermas. Usa el archivo de "Exportar Excel" o la plantilla de ejemplo.',
    )
  }
  return filas
}

/** .xlsx de ejemplo para registrar mermas nuevas desde Excel. */
export async function descargarPlantillaMermas(): Promise<void> {
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ['', `${ymd(new Date())} 09:00`, '7501055300464', 'Coca Cola 500ml', 2, 1.8, '', 'Producto vencido', 'Lote vencido', '', ''],
  ]
  const hoja = XLSX.utils.aoa_to_sheet(filas)
  hoja['!cols'] = ENCABEZADOS.map((h) => ({ wch: Math.max(h.length, 14) }))
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, HOJA)
  XLSX.writeFile(libro, 'plantilla_mermas.xlsx')
}
