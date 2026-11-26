// Boletas y facturas electronicas (Nubefact). El envio real ocurre en la
// Edge Function "emitir-comprobante" (el TOKEN de Nubefact nunca llega al
// navegador). Aqui solo: validar en pantalla para avisar rapido (el servidor
// vuelve a validar todo), llamar a la funcion y leer el resultado.
import { supabase } from '@/lib/supabase'
import { mensajeErrorFuncion } from '@/utils/errors'
import type { Comprobante, TipoComprobante, TipoDocCliente } from '@/types/database'

export interface ClienteComprobante {
  tipo_doc: TipoDocCliente
  num_doc: string
  denominacion: string
  direccion: string
}

/** Monto desde el que SUNAT exige el DNI del cliente en una boleta. */
export const MONTO_BOLETA_CON_DNI = 700

export const ETIQUETA_TIPO: Record<TipoComprobante, string> = {
  boleta: 'Boleta de venta electrónica',
  factura: 'Factura electrónica',
}

export function numeroComprobante(c: Pick<Comprobante, 'serie' | 'numero'>): string {
  return `${c.serie}-${String(c.numero).padStart(8, '0')}`
}

const RUC_VALIDO = /^(10|15|16|17|20)\d{9}$/

/** Mismas reglas que reservar_comprobante (servidor). null = todo bien. */
export function validarCliente(tipo: TipoComprobante, c: ClienteComprobante, total: number): string | null {
  const doc = c.num_doc.replace(/\D/g, '')
  const nombre = c.denominacion.trim()
  if (tipo === 'factura') {
    if (c.tipo_doc !== '6' || !RUC_VALIDO.test(doc)) return 'Para factura se requiere el RUC del cliente (11 dígitos, empieza con 10 o 20).'
    if (nombre.length < 2) return 'Para factura se requiere la razón social del cliente.'
    return null
  }
  if (c.tipo_doc === '1' && !/^\d{8}$/.test(doc)) return 'El DNI debe tener 8 dígitos.'
  if (c.tipo_doc === '6' && !RUC_VALIDO.test(doc)) return 'El RUC debe tener 11 dígitos y empezar con 10 o 20.'
  if (c.tipo_doc === '-' && total >= MONTO_BOLETA_CON_DNI) {
    return `Para boletas de S/ ${MONTO_BOLETA_CON_DNI}.00 o más, SUNAT exige el DNI del cliente.`
  }
  if (c.tipo_doc !== '-' && nombre.length < 2) return 'Ingresa el nombre del cliente.'
  return null
}

export interface ResultadoEmision {
  comprobante: Comprobante | null
  /** Aviso no fatal (ej. Nubefact no respondio y quedo pendiente). */
  aviso?: string
}

async function invocar(body: Record<string, unknown>): Promise<ResultadoEmision> {
  const { data, error } = await supabase.functions.invoke('emitir-comprobante', { body })
  if (error) {
    const msg = await mensajeErrorFuncion(error, 'No se pudo conectar con el servicio de facturación.')
    if (/not found|404|failed to send/i.test(msg)) {
      throw new Error('El servicio de facturación no está instalado en Supabase (Edge Function "emitir-comprobante").')
    }
    throw new Error(msg)
  }
  const r = (data ?? {}) as { comprobante?: Comprobante; aviso?: string; error?: string }
  if (r.error) throw new Error(r.error)
  return { comprobante: r.comprobante ?? null, aviso: r.aviso }
}

export function emitirComprobante(ventaId: string, tipo: TipoComprobante, cliente: ClienteComprobante) {
  return invocar({ accion: 'emitir', venta_id: ventaId, tipo, cliente })
}

export function consultarComprobante(ventaId: string) {
  return invocar({ accion: 'consultar', venta_id: ventaId })
}

export interface DatosDocumento {
  encontrado: boolean
  nombre?: string
  direccion?: string
  /** Solo RUC: estado y condicion del contribuyente en SUNAT. */
  estado?: string
  condicion?: string
}

/**
 * Nombre del DNI (RENIEC) o razon social y direccion del RUC (SUNAT), via la
 * Edge Function "consultar-documento" (el token nunca llega al navegador).
 * Lanza un Error con mensaje legible si el servicio no esta disponible.
 */
export async function consultarDocumento(tipo: 'dni' | 'ruc', numero: string): Promise<DatosDocumento> {
  const { data, error } = await supabase.functions.invoke('consultar-documento', { body: { tipo, numero } })
  if (error) {
    const msg = await mensajeErrorFuncion(error, 'No se pudo consultar el documento.')
    if (/not found|404|failed to send/i.test(msg)) {
      throw new Error('La consulta automática no está instalada (Edge Function "consultar-documento").')
    }
    throw new Error(msg)
  }
  const r = (data ?? {}) as DatosDocumento & { error?: string }
  if (r.error) throw new Error(r.error)
  return {
    encontrado: !!r.encontrado,
    nombre: typeof r.nombre === 'string' ? r.nombre : undefined,
    direccion: typeof r.direccion === 'string' ? r.direccion : undefined,
    estado: typeof r.estado === 'string' ? r.estado : undefined,
    condicion: typeof r.condicion === 'string' ? r.condicion : undefined,
  }
}

/**
 * Abre el PDF/enlace de Nubefact solo si es https y del dominio de Nubefact
 * (nunca un enlace arbitrario guardado en la base).
 */
export function abrirEnlaceComprobante(c: Pick<Comprobante, 'enlace_pdf' | 'enlace'>): boolean {
  const url = c.enlace_pdf || (c.enlace ? `${c.enlace}.pdf` : null)
  if (!url) return false
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (u.protocol !== 'https:' || !(host === 'nubefact.com' || host.endsWith('.nubefact.com'))) return false
    window.open(u.toString(), '_blank', 'noopener,noreferrer')
    return true
  } catch {
    return false
  }
}
