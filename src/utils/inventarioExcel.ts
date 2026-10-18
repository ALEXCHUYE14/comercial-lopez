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

// Columna de referencia (no se edita): el stock que tenia cada producto en el
// momento de descargar el archivo. Al volver a subirlo, si "Stock actual" no
// se modifico (sigue igual a esta referencia), el stock NO se toca. Sin esto,
// un archivo descargado en la mañana y subido en la tarde (para cambiar
// precios, por ejemplo) devolvia el stock al valor de la mañana y "borraba"
// todo lo vendido en el dia — stock desactualizado.
const ENCABEZADO_STOCK_EXPORTADO = 'Stock al descargar (NO EDITAR)'

// Encabezados EXACTOS que genera exportarInventarioExcel — son tambien los
// que reconoce leerInventarioExcel al volver a subir el archivo, asi que el
// propio archivo descargado sirve de plantilla para editar o agregar filas.
const ENCABEZADOS = [
  'SKU', 'Nombre', 'Categoria', 'Tipo de venta', 'Unidad',
  'Precio compra', 'Precio venta', 'Precio venta caja',
  'Stock actual', 'Stock minimo',
  'Tiene caja (SI/NO)', 'Unidades por caja',
  'Tiene saco (SI/NO)', 'Kg por saco', 'Precio venta saco',
  'Presentaciones (JSON)',
  'Vence (AAAA-MM-DD)', 'Activo (SI/NO)',
  ENCABEZADO_STOCK_EXPORTADO,
] as const

function siNo(v: boolean): string {
  return v ? 'SI' : 'NO'
}

// El formato .xlsx es XML por dentro, y el estandar XML 1.0 prohibe casi
// todos los caracteres de control (0x00-0x1F salvo tab/salto de
// linea/retorno de carro) y 0x7F. Un solo caracter asi en una celda —
// tipico de un nombre pegado desde un escaneo de codigo de barras fallido o
// copiado de otra fuente con caracteres invisibles — basta para que el
// archivo quede mal formado: la libreria lo escribe tal cual sin avisar, y
// Excel (que valida estricto) lo rechaza con "Excel encontró un problema
// que le impide funcionar correctamente" en vez de abrirlo. Se limpia ANTES
// de escribir la celda, en cada campo de texto que puede venir de datos
// reales (nombre, SKU, categoria, unidad) — nunca en los que arma el propio
// codigo (SI/NO, "unidad"/"granel", fechas AAAA-MM-DD).
export function textoSeguro(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

// Un precio o stock corrupto en la base (NaN/Infinity, nunca deberia pasar
// por las validaciones del servidor, pero un dato viejo importado antes de
// esas validaciones es posible) tambien produce un .xlsx invalido: se
// escribe como numero pero "NaN"/"Infinity" no son valores numericos
// validos en el XML de la hoja. Se cambia a 0 en vez de dejarlo pasar.
export function numeroSeguro(v: number | null | undefined): number | '' {
  if (v === null || v === undefined) return ''
  return Number.isFinite(v) ? v : 0
}

// Las presentaciones adicionales (arroba, docena, Bolsa, Paquete Maestro...)
// son un arreglo, no un valor simple — se guardan como texto JSON en una sola
// celda. Un producto SIN presentaciones deja la celda vacia (no "[]"), para
// que una celda vacia siga significando "no tocar" al volver a importar —
// igual que el resto de columnas — y nunca borre presentaciones que se le
// hayan agregado al producto despues de exportar este archivo.
function presentacionesACelda(p: Producto): string {
  if (!p.presentaciones || p.presentaciones.length === 0) return ''
  return textoSeguro(JSON.stringify(p.presentaciones))
}

/** Descarga el inventario completo como .xlsx, con TODAS las columnas de
 * configuracion de cada producto — pensado tanto para respaldo como para
 * volver a subirlo despues de editarlo (agregar filas nuevas, corregir
 * precios, cambiar presentaciones, etc.) sin perder ningun dato. Lo unico
 * que no incluye es la foto del producto: es un archivo binario, no un
 * valor de celda, y ya tiene su propio respaldo dedicado ("Descargar fotos"
 * / "Subir fotos"), mas confiable que guardar solo la URL en una celda. */
export async function exportarInventarioExcel(productos: Producto[]): Promise<void> {
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ...productos.map((p) => [
      textoSeguro(p.sku),
      textoSeguro(p.nombre),
      textoSeguro(p.categorias?.nombre ?? ''),
      p.tipo_venta === 'granel' ? 'granel' : 'unidad',
      textoSeguro(p.unidad),
      numeroSeguro(p.precio_compra),
      numeroSeguro(p.precio_venta),
      numeroSeguro(p.precio_venta_caja),
      numeroSeguro(p.stock_actual),
      numeroSeguro(p.stock_minimo),
      siNo(p.tiene_caja),
      numeroSeguro(p.unidades_por_caja),
      siNo(p.tiene_saco),
      numeroSeguro(p.kg_por_saco),
      numeroSeguro(p.precio_venta_saco),
      presentacionesACelda(p),
      textoSeguro(p.fecha_vencimiento ?? ''),
      siNo(p.activo),
      numeroSeguro(p.stock_actual),
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
  /** Texto JSON tal cual venia en la celda (ej. '[{"clave":"arroba",...}]'),
   * o null si la celda estaba vacia ("no tocar" al actualizar). Se valida y
   * se convierte a jsonb en el servidor (ver importar_productos en
   * schema.sql), no aqui — asi una presentacion mal formada se reporta como
   * el error de ESA fila en vez de tumbar la lectura de todo el archivo. */
  presentaciones: string | null
  vence: string | null
  activo: boolean | null
}

/** Fila tal como se leyo del archivo: incluye la columna de referencia
 * "Stock al descargar", que NO se envia al servidor. */
export type FilaLeida = FilaInventario & { stock_al_descargar: number | null }

/** Producto ya existente en el sistema (por SKU) con su stock vigente. */
export type StockExistente = Map<string, number>

/**
 * Decide que stock se envia por cada fila y quita la columna de referencia:
 *  - SKU que NO existe en el sistema (producto nuevo, o base de datos nueva
 *    al migrar/restaurar un respaldo): se usa SIEMPRE el "Stock actual" del
 *    archivo. Antes una fila sin editar se mandaba como "no tocar" y, como el
 *    producto no existia, quedaba con stock 0 — todo el inventario "agotado".
 *  - `restaurarStock` = true (opcion "Restaurar stock del archivo"): se usa
 *    el stock del archivo para todos los productos.
 *  - SKU existente y "Stock actual" igual a "Stock al descargar" (no se
 *    edito): no se toca, para no borrar lo vendido despues de descargar.
 *  - SKU existente con el stock editado en el archivo: se aplica (queda en
 *    el kardex como ajuste).
 */
export function prepararFilasInventario(
  filas: FilaLeida[],
  existentes: StockExistente,
  restaurarStock: boolean,
): FilaInventario[] {
  return filas.map(({ stock_al_descargar, ...fila }) => {
    const existe = fila.sku !== null && existentes.has(fila.sku.trim())
    const sinEditar =
      fila.stock_actual !== null &&
      stock_al_descargar !== null &&
      Math.abs(fila.stock_actual - stock_al_descargar) < 1e-9
    if (existe && !restaurarStock && sinEditar) return { ...fila, stock_actual: null }
    return fila
  })
}

/** Cuantas filas de productos YA existentes no editaron el stock pero el
 * sistema tiene un stock distinto al del archivo (ventas posteriores, o una
 * importacion previa que los dejo en 0). Sirve para avisar y ofrecer
 * "Restaurar stock del archivo". */
export function contarStockDistinto(filas: FilaLeida[], existentes: StockExistente): number {
  let n = 0
  for (const f of filas) {
    if (f.sku === null || f.stock_actual === null || f.stock_al_descargar === null) continue
    const actual = existentes.get(f.sku.trim())
    if (actual === undefined) continue
    if (Math.abs(f.stock_actual - f.stock_al_descargar) < 1e-9 && Math.abs(actual - f.stock_actual) > 1e-9) n++
  }
  return n
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
  'presentaciones (json)': 'presentaciones',
  presentaciones: 'presentaciones',
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

const ENCABEZADO_STOCK_EXPORTADO_NORM = normalizarEncabezado(ENCABEZADO_STOCK_EXPORTADO)

export function normalizarEncabezado(s: string): string {
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

/** Convierte una celda a numero. Las celdas numericas de Excel ya llegan como
 * number; esto cubre las que vienen como TEXTO ("3.50", "3,50", "S/ 1,234.50",
 * "1.234,5"). Antes se borraban todos los puntos antes de convertir, asi que un
 * precio "3.50" escrito como texto se guardaba como 350 (y un stock "1.5" como
 * 15). Regla: si hay punto y coma, el que aparece AL FINAL es el decimal; si
 * hay un solo tipo de separador, es decimal salvo que se repita (miles, ej.
 * "1.234.567") o que la coma vaya seguida de exactamente 3 digitos (miles,
 * ej. "1,234"). */
export function aNumero(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v).trim().replace(/^s\/\.?\s*/i, '').replace(/\s/g, '')
  if (s === '') return null
  const ultPunto = s.lastIndexOf('.')
  const ultComa = s.lastIndexOf(',')
  if (ultPunto >= 0 && ultComa >= 0) {
    const decimal = ultPunto > ultComa ? '.' : ','
    const miles = decimal === '.' ? ',' : '.'
    s = s.split(miles).join('').replace(decimal, '.')
  } else if (ultComa >= 0) {
    const partes = s.split(',')
    const esMiles = partes.length > 2 || /^-?\d{1,3},\d{3}$/.test(s)
    s = esMiles ? partes.join('') : s.replace(',', '.')
  } else if (ultPunto >= 0 && s.split('.').length > 2) {
    s = s.split('.').join('')
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null
  const n = Number(s)
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
export async function leerInventarioExcel(archivo: File): Promise<FilaLeida[]> {
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
      presentaciones: null,
      vence: null, activo: null,
    }
    let stockExportado: number | null = null
    for (const [encabezadoOriginal, valor] of Object.entries(registro)) {
      const encabezado = normalizarEncabezado(encabezadoOriginal)
      if (encabezado === ENCABEZADO_STOCK_EXPORTADO_NORM) {
        stockExportado = aNumero(valor)
        continue
      }
      const campo = ALIAS[encabezado]
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
    // La decision de si el stock se aplica o se conserva se toma recien al
    // importar (ver prepararFilasInventario), cuando ya se sabe que SKUs
    // existen en el sistema — aqui todavia no se sabe.
    return { ...fila, stock_al_descargar: stockExportado }
  })
}

/** Genera un .xlsx de ejemplo con una fila de muestra, para quien todavía no
 * tiene productos que exportar y quiere ver el formato esperado. */
export async function descargarPlantillaInventario(): Promise<void> {
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ['7501055300464', 'Coca Cola 500ml', 'Bebidas', 'unidad', 'unidad', 1.8, 3, '', 48, 12, 'NO', '', 'NO', '', '', '', '', 'SI', ''],
  ]
  const hoja = XLSX.utils.aoa_to_sheet(filas)
  hoja['!cols'] = ENCABEZADOS.map((h) => ({ wch: Math.max(h.length, 14) }))
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, HOJA)
  XLSX.writeFile(libro, 'plantilla_inventario.xlsx')
}
