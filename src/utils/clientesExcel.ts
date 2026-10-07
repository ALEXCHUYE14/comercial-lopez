// Exportacion/importacion de clientes con fiado en .xlsx real. Las columnas
// reflejan los campos que existen en la tabla clientes_credito. La validacion
// de reglas de negocio vive en el servidor (importar_clientes en schema.sql),
// no aqui: asi hay una sola fuente de verdad y no pueden divergir.
//
// "xlsx" se carga con import() dinamico, igual que en inventarioExcel.ts.
import { ymd } from '@/utils/format'
import type { ClienteCredito } from '@/types/database'

const HOJA = 'Clientes'

const ENCABEZADOS = [
  'ID',
  'Nombre',
  'Telefono',
  'Direccion',
  'Limite de credito',
  'Deuda inicial (solo clientes nuevos)',
  'Deuda actual (solo lectura)',
  'Activo (SI/NO)',
  'Fecha de registro (solo lectura)',
] as const

export type FilaCliente = {
  fila: number
  id: string | null
  nombre: string | null
  telefono: string | null
  direccion: string | null
  limite_credito: string | null
  /** Solo se aplica al CREAR un cliente (fila sin ID): permite migrar el
   * saldo que un cliente ya tenia (ej. traspaso de otro proyecto) sin
   * simular una venta fiado, que descontaria stock del inventario. En una
   * fila con ID (actualizacion) el servidor la ignora, igual que la columna
   * "Deuda actual" — nunca pisa el saldo real de un cliente existente. Se
   * exporta precargada con la deuda actual de cada cliente para que, si
   * alguna vez se recrea (ID vacio), el saldo viaje solo. */
  deuda_inicial: string | null
  activo: boolean | null
}

// El .xlsx es XML por dentro: caracteres de control invisibles (pegados desde
// otra fuente) dejan el archivo corrupto para Excel. Se limpian antes de escribir.
function textoSeguro(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function numeroSeguro(v: number): number {
  return Number.isFinite(v) ? v : 0
}

/** Descarga la lista de clientes como .xlsx. Deuda actual y fecha de registro
 * se incluyen solo como referencia: al importar se ignoran a proposito. */
export async function exportarClientesExcel(clientes: ClienteCredito[]): Promise<void> {
  const XLSX = await import('xlsx')
  const filas = [
    ENCABEZADOS as unknown as string[],
    ...clientes.map((c) => [
      c.id,
      textoSeguro(c.nombre),
      textoSeguro(c.telefono ?? ''),
      textoSeguro(c.direccion ?? ''),
      numeroSeguro(c.limite_credito),
      numeroSeguro(c.deuda_actual),
      numeroSeguro(c.deuda_actual),
      c.activo ? 'SI' : 'NO',
      ymd(new Date(c.creado_en)),
    ]),
  ]
  const hoja = XLSX.utils.aoa_to_sheet(filas)
  hoja['!cols'] = ENCABEZADOS.map((h) => ({ wch: Math.max(h.length, 14) }))
  const libro = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(libro, hoja, HOJA)
  XLSX.writeFile(libro, `clientes_${ymd(new Date())}.xlsx`)
}

const ALIAS: Record<string, keyof Omit<FilaCliente, 'fila'>> = {
  id: 'id',
  nombre: 'nombre',
  telefono: 'telefono',
  direccion: 'direccion',
  'limite de credito': 'limite_credito',
  'limite credito': 'limite_credito',
  'deuda inicial (solo clientes nuevos)': 'deuda_inicial',
  'deuda inicial': 'deuda_inicial',
  'activo (si/no)': 'activo',
  activo: 'activo',
}

const COLUMNAS_REQUERIDAS = ['nombre', 'limite de credito'] as const

function normalizarEncabezado(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function aTexto(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function aBooleano(v: unknown): boolean | null {
  const s = aTexto(v)?.toLowerCase()
  if (!s) return null
  if (['si', 'sí', 'yes', 'true', '1', 'x'].includes(s)) return true
  if (['no', 'false', '0'].includes(s)) return false
  return null
}

// "1234,56" (coma decimal) y "1234.56" (punto decimal). Solo se quita el punto
// como separador de miles cuando hay coma: "1.8" debe quedar en 1.8.
function aNumeroTexto(v: unknown): string | null {
  const s = aTexto(v)
  if (s === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  return s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s
}

/** Lee el .xlsx subido y devuelve las filas tal cual vienen, sin validar reglas
 * de negocio (eso lo hace el servidor). Lanza error solo si el archivo no tiene
 * las columnas minimas o no tiene filas. */
export async function leerClientesExcel(archivo: File): Promise<FilaCliente[]> {
  const XLSX = await import('xlsx')
  const libro = XLSX.read(await archivo.arrayBuffer(), { type: 'array', cellDates: true })
  const nombreHoja = libro.SheetNames[0]
  if (!nombreHoja) throw new Error('El archivo no tiene hojas.')
  const registros = XLSX.utils.sheet_to_json<Record<string, unknown>>(libro.Sheets[nombreHoja], {
    defval: null,
    raw: true,
  })
  if (registros.length === 0) {
    throw new Error('El archivo no tiene filas de datos (solo encabezado, o está vacío).')
  }

  const encabezados = new Set(Object.keys(registros[0]).map(normalizarEncabezado))
  const faltantes = COLUMNAS_REQUERIDAS.filter((c) => !encabezados.has(c))
  if (faltantes.length > 0) {
    throw new Error(`Faltan columnas obligatorias: ${faltantes.join(', ')}. Usa el archivo que genera "Exportar".`)
  }

  return registros.map((registro, i) => {
    const fila: FilaCliente = {
      fila: i + 2,
      id: null,
      nombre: null,
      telefono: null,
      direccion: null,
      limite_credito: null,
      deuda_inicial: null,
      activo: null,
    }
    for (const [encabezado, valor] of Object.entries(registro)) {
      const campo = ALIAS[normalizarEncabezado(encabezado)]
      if (!campo) continue
      if (campo === 'activo') fila.activo = aBooleano(valor)
      else if (campo === 'limite_credito') fila.limite_credito = aNumeroTexto(valor)
      else if (campo === 'deuda_inicial') fila.deuda_inicial = aNumeroTexto(valor)
      else if (campo === 'id') fila.id = aTexto(valor)
      else if (campo === 'nombre') fila.nombre = aTexto(valor)
      else if (campo === 'telefono') fila.telefono = aTexto(valor)
      else fila.direccion = aTexto(valor)
    }
    return fila
  })
}
