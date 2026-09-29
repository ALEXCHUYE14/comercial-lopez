// Exportacion/importacion del inventario completo en formato .xlsx real (no
// CSV): un archivo de Excel autentico abre siempre sin avisos de formato,
// a diferencia de un .csv renombrado o de un .csv con delimitador/codificacion
// que no coincide con la configuracion regional de Excel del usuario.
//
// "xlsx" pesa varios cientos de KB minificado y la gran mayoria de las
// sesiones del POS nunca tocan Importar/Exportar Excel en todo el dia — se
// carga con import() dinamico (nunca "import * as XLSX" arriba del archivo)
// para que quede en su propio chunk y solo se descargue la primera vez que
// alguien de verdad usa uno de estos botones, en vez de sumarse al bundle
// principal que se descarga siempre al abrir la app.
import { ymd } from '@/utils/format'
import type { Producto } from '@/types/database'

const HOJA = 'Inventario'

// Encabezados EXACTOS que genera exportarInventarioExcel — son tambien los
// que reconoce leerInventarioExcel al volver a subir el archivo, asi que el
// propio archivo descargado sirve de plantilla para editar o agregar filas.
const ENCABEZADOS = [
  'SKU', 'Nombre', 'Categoria', 'Tipo de venta', 'Unidad',
  'Precio compra', 'Precio venta', 'Precio venta caja',
  'Stock actual', 'Stock minimo',
  'Tiene caja (SI/NO)', 'Unidades por caja',
  'Tiene saco (SI/NO)', 'Kg por saco', 'Precio venta saco',
  'Vence (AAAA-MM-DD)', 'Activo (SI/NO)',
] as const

function siNo(v: boolean): string {
  return v ? 'SI' : 'NO'
}

/** Descarga el inventario completo como .xlsx, con todas las columnas que
 * usa el sistema — pensado tanto para respaldo como para volver a subirlo
 * despues de editarlo (agregar filas nuevas, corregir precios, etc.). No
 * incluye la foto del producto (es un archivo aparte, no una celda de Excel)
 * ni las presentaciones adicionales (arroba, docena, ...), que son una
 * configuracion mas compleja que una sola celda — esas se siguen editando
 * desde "Nuevo producto"/"Editar" en el propio sistema. */
export async function exportarInventarioExcel(productos: Producto[]): Promise<void> {
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ...productos.map((p) => [
      p.sku,
      p.nombre,
      p.categorias?.nombre ?? '',
      p.tipo_venta === 'granel' ? 'granel' : 'unidad',
      p.unidad,
      p.precio_compra,
      p.precio_venta,
      p.precio_venta_caja ?? '',
      p.stock_actual,
      p.stock_minimo,
      siNo(p.tiene_caja),
      p.unidades_por_caja ?? '',
      siNo(p.tiene_saco),
      p.kg_por_saco ?? '',
      p.precio_venta_saco ?? '',
      p.fecha_vencimiento ?? '',
      siNo(p.activo),
    ]),
  ]
  const hoja = XLSX.utils.aoa_to_sheet(filas)
  // Ancho de columna aproximado por contenido, para que se pueda leer sin
  // tener que ajustar manualmente cada columna al abrirlo.
  hoja['!cols'] = ENCABEZADOS.map((h) => ({ wch: Math.max(h.length, 14) }))
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, HOJA)
  XLSX.writeFile(libro, `inventario_${ymd(new Date())}.xlsx`)
}

export type FilaInventario = {
  fila: number
  sku: string | null
  nombre: string | null
  categoria: string | null
  tipo_venta: string | null
  unidad: string | null
  precio_compra: number | null
  precio_venta: number | null
  precio_venta_caja: number | null
  stock_actual: number | null
  stock_minimo: number | null
  tiene_caja: boolean | null
  unidades_por_caja: number | null
  tiene_saco: boolean | null
  kg_por_saco: number | null
  precio_venta_saco: number | null
  vence: string | null
  activo: boolean | null
}

// Alias de encabezado reconocidos (normalizados: sin tildes, minusculas, sin
// espacios de mas) — para que el archivo siga leyendose bien aunque alguien
// lo edite y cambie ligeramente el texto de una columna.
const ALIAS: Record<string, keyof FilaInventario> = {
  sku: 'sku',
  nombre: 'nombre',
  categoria: 'categoria',
  'tipo de venta': 'tipo_venta',
  tipoventa: 'tipo_venta',
  unidad: 'unidad',
  'precio compra': 'precio_compra',
  'precio de compra': 'precio_compra',
  'precio venta': 'precio_venta',
  'precio de venta': 'precio_venta',
  'precio venta caja': 'precio_venta_caja',
  'precio caja': 'precio_venta_caja',
  'stock actual': 'stock_actual',
  stock: 'stock_actual',
  'stock minimo': 'stock_minimo',
  'tiene caja (si/no)': 'tiene_caja',
  'tiene caja': 'tiene_caja',
  'unidades por caja': 'unidades_por_caja',
  'tiene saco (si/no)': 'tiene_saco',
  'tiene saco': 'tiene_saco',
  'kg por saco': 'kg_por_saco',
  'precio venta saco': 'precio_venta_saco',
  'precio saco': 'precio_venta_saco',
  'vence (aaaa-mm-dd)': 'vence',
  vence: 'vence',
  'fecha vencimiento': 'vence',
  'activo (si/no)': 'activo',
  activo: 'activo',
}

const CAMPOS_BOOLEANOS = new Set<keyof FilaInventario>(['tiene_caja', 'tiene_saco', 'activo'])
const CAMPOS_NUMERICOS = new Set<keyof FilaInventario>([
  'precio_compra', 'precio_venta', 'precio_venta_caja',
  'stock_actual', 'stock_minimo', 'unidades_por_caja', 'kg_por_saco', 'precio_venta_saco',
])

function normalizarEncabezado(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita tildes
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function aBooleano(v: unknown): boolean | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().toLowerCase()
  if (s === '') return null
  if (['si', 'sí', 'yes', 'true', 'verdadero', '1', 'x'].includes(s)) return true
  if (['no', 'false', 'falso', '0'].includes(s)) return false
  return null // valor no reconocido: se trata como "no indicado", no como error
}

function aNumero(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '') return null
  // admite "1234,56" (coma decimal) ademas de "1234.56"
  const n = Number(s.replace(/\./g, '').replace(',', '.')) || Number(s)
  return Number.isFinite(n) ? n : null
}

function aFecha(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return ymd(v)
  const s = String(v).trim()
  if (s === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : ymd(d)
}

function aTexto(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Lee un archivo .xlsx/.xls subido por el usuario y devuelve las filas ya
 * normalizadas, listas para mandar al RPC importar_productos. No valida
 * reglas de negocio aqui (eso lo hace el servidor, fila por fila) — solo
 * interpreta el archivo: encabezados, numeros con coma decimal, SI/NO,
 * fechas, y celdas vacias como null (nunca como texto vacio). */
export async function leerInventarioExcel(archivo: File): Promise<FilaInventario[]> {
  const XLSX = await import('xlsx')
  const buffer = await archivo.arrayBuffer()
  const libro = XLSX.read(buffer, { type: 'array', cellDates: true })
  const nombreHoja = libro.SheetNames[0]
  if (!nombreHoja) throw new Error('El archivo no tiene hojas.')
  const hoja = libro.Sheets[nombreHoja]
  const registros = XLSX.utils.sheet_to_json<Record<string, unknown>>(hoja, { defval: null, raw: true })
  if (registros.length === 0) {
    throw new Error('El archivo no tiene filas de datos (solo encabezado, o está vacío).')
  }

  return registros.map((registro, i) => {
    const fila: FilaInventario = {
      fila: i + 2, // fila 1 = encabezado
      sku: null, nombre: null, categoria: null, tipo_venta: null, unidad: null,
      precio_compra: null, precio_venta: null, precio_venta_caja: null,
      stock_actual: null, stock_minimo: null,
      tiene_caja: null, unidades_por_caja: null,
      tiene_saco: null, kg_por_saco: null, precio_venta_saco: null,
      vence: null, activo: null,
    }
    for (const [encabezadoOriginal, valor] of Object.entries(registro)) {
      const campo = ALIAS[normalizarEncabezado(encabezadoOriginal)]
      if (!campo || campo === 'fila') continue
      if (campo === 'tipo_venta') {
        const t = aTexto(valor)
        fila.tipo_venta = t ? t.toLowerCase() : null
      } else if (campo === 'vence') {
        fila.vence = aFecha(valor)
      } else if (CAMPOS_BOOLEANOS.has(campo)) {
        ;(fila[campo] as boolean | null) = aBooleano(valor)
      } else if (CAMPOS_NUMERICOS.has(campo)) {
        ;(fila[campo] as number | null) = aNumero(valor)
      } else {
        ;(fila[campo] as string | null) = aTexto(valor)
      }
    }
    return fila
  })
}

/** Genera un .xlsx de ejemplo con una fila de muestra, para quien todavía no
 * tiene productos que exportar y quiere ver el formato esperado. */
export async function descargarPlantillaInventario(): Promise<void> {
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ['7501055300464', 'Coca Cola 500ml', 'Bebidas', 'unidad', 'unidad', 1.8, 3, '', 48, 12, 'NO', '', 'NO', '', '', '', 'SI'],
  ]
  const hoja = XLSX.utils.aoa_to_sheet(filas)
  hoja['!cols'] = ENCABEZADOS.map((h) => ({ wch: Math.max(h.length, 14) }))
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, HOJA)
  XLSX.writeFile(libro, 'plantilla_inventario.xlsx')
}
