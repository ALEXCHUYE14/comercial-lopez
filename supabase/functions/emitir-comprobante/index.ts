// Edge Function: emite una BOLETA o FACTURA electronica a traves de NUBEFACT.
//
// Por que en el servidor: el TOKEN de Nubefact permite emitir comprobantes a
// nombre del RUC del negocio. Si estuviera en el navegador, cualquiera podria
// leerlo del codigo de la app. Aqui se lee de los secretos de Supabase:
//   NUBEFACT_RUTA   -> la RUTA de "Api (Integracion)" en Nubefact
//   NUBEFACT_TOKEN  -> el TOKEN de "Api (Integracion)" en Nubefact
//
// Deploy: Supabase Dashboard -> Edge Functions -> Deploy a new function ->
// nombre "emitir-comprobante" -> pega este archivo -> Deploy.
// Requiere haber ejecutado supabase/facturacion_electronica.sql.
//
// Acciones (body JSON):
//   { accion: 'emitir', venta_id, tipo: 'boleta'|'factura',
//     cliente: { tipo_doc: '1'|'6'|'-', num_doc, denominacion, direccion } }
//   { accion: 'consultar', venta_id }   -> refresca el estado ante SUNAT
//
// Reglas clave (para no generar errores ni duplicados):
//  - Los MONTOS salen de la venta registrada en la base, nunca del navegador.
//  - Serie y numero los asigna la base (reservar_comprobante) en una
//    transaccion: dos cajas a la vez nunca obtienen el mismo numero.
//  - Si Nubefact no responde (internet, timeout), el comprobante queda
//    'pendiente' y el reintento reenvia EXACTAMENTE el mismo numero: si
//    Nubefact ya lo tenia, se consulta en vez de duplicarlo.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TIMEOUT_MS = 30000
const IGV = 0.18
const MAX_REASIGNACIONES = 5

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const f2 = (n: number) => r2(n).toFixed(2)

/** Fecha de hoy en Peru, formato dd-mm-aaaa (el que pide Nubefact). */
function fechaHoyLima(): string {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date())
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? ''
  return `${v('day')}-${v('month')}-${v('year')}`
}

/** Solo URLs https: nunca se guarda un enlace que no lo sea. */
function urlSegura(u: unknown): string | null {
  if (typeof u !== 'string' || !u) return null
  try {
    return new URL(u).protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

function texto(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

type Comprobante = {
  id: string
  venta_id: string
  tipo: 'boleta' | 'factura'
  serie: string
  numero: number
  cliente_tipo_doc: string
  cliente_num_doc: string
  cliente_denominacion: string
  cliente_direccion: string | null
  total: number
  estado: 'pendiente' | 'emitido' | 'aceptado' | 'rechazado'
  intentos: number
}

type RespuestaNubefact =
  | { tipo: 'ok'; data: Record<string, unknown> }
  | { tipo: 'rechazo'; mensaje: string; codigo: number | null }
  | { tipo: 'sin_respuesta'; mensaje: string }

async function llamarNubefact(ruta: string, token: string, payload: unknown): Promise<RespuestaNubefact> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ruta, {
      method: 'POST',
      headers: {
        Authorization: `Token token="${token}"`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    let data: Record<string, unknown> | null = null
    try {
      data = (await res.json()) as Record<string, unknown>
    } catch {
      data = null
    }
    if (data && data.errors) {
      const codigo = Number(data.codigo)
      return {
        tipo: 'rechazo',
        mensaje: String(data.errors).slice(0, 500),
        codigo: Number.isFinite(codigo) ? codigo : null,
      }
    }
    if (!res.ok || !data) {
      // Error del servidor de Nubefact sin detalle: no se sabe si lo registro.
      return { tipo: 'sin_respuesta', mensaje: `Nubefact respondió con error ${res.status}.` }
    }
    return { tipo: 'ok', data }
  } catch (e) {
    const abortado = e instanceof DOMException && e.name === 'AbortError'
    return {
      tipo: 'sin_respuesta',
      mensaje: abortado ? 'Nubefact no respondió a tiempo.' : 'No se pudo conectar con Nubefact.',
    }
  } finally {
    clearTimeout(timer)
  }
}

const codigoTipo = (t: Comprobante['tipo']) => (t === 'factura' ? 1 : 2)

/** Mensaje de Nubefact que indica que ese serie-numero ya existe alli. */
function esDuplicado(r: RespuestaNubefact): boolean {
  return r.tipo === 'rechazo' && (r.codigo === 23 || /ya existe|ya fue|existe un documento|duplicad/i.test(r.mensaje))
}

/** Campos de resultado a guardar a partir de una respuesta OK de Nubefact. */
function camposResultado(d: Record<string, unknown>) {
  const aceptado = d.aceptada_por_sunat === true || d.aceptada_por_sunat === 'true'
  return {
    estado: aceptado ? 'aceptado' : 'emitido',
    enlace: urlSegura(d.enlace),
    enlace_pdf: urlSegura(d.enlace_del_pdf),
    cadena_qr: texto(d.cadena_para_codigo_qr, 1000),
    codigo_hash: texto(d.codigo_hash, 200),
    sunat_descripcion: texto(d.sunat_description, 500),
    error_mensaje: texto(d.sunat_soap_error, 500),
    actualizado_en: new Date().toISOString(),
  }
}

async function guardar(admin: SupabaseClient, id: string, campos: Record<string, unknown>) {
  const { data, error } = await admin.from('comprobantes').update(campos).eq('id', id).select('*').single()
  if (error) throw new Error(`No se pudo guardar el comprobante: ${error.message}`)
  return data
}

type Detalle = {
  producto_nombre: string
  sku: string | null
  cantidad: number | string
  modalidad: string
  modalidad_nombre: string | null
  precio_unitario: number | string
  subtotal: number | string
  productos: { unidad: string | null } | null
}

/** Arma el JSON de Nubefact con los montos REGISTRADOS de la venta. */
function armarDocumento(
  comp: Comprobante,
  venta: Record<string, unknown>,
  detalle: Detalle[],
): { ok: true; doc: Record<string, unknown> } | { ok: false; mensaje: string } {
  if (detalle.length === 0) return { ok: false, mensaje: 'La venta no tiene productos.' }

  let sumaSub = 0
  let sumaTot = 0
  const items = detalle.map((d) => {
    const cantidad = Number(d.cantidad)
    const precio = Number(d.precio_unitario)
    const totalLinea = r2(Number(d.subtotal))
    const subLinea = r2(totalLinea / (1 + IGV))
    const igvLinea = r2(totalLinea - subLinea)
    sumaSub = r2(sumaSub + subLinea)
    sumaTot = r2(sumaTot + totalLinea)
    const unidad = (d.productos?.unidad ?? '').toLowerCase()
    const esKilo = d.modalidad === 'unidad' && /^(kg|kilo|kilos|kilogramo|kilogramos)$/.test(unidad)
    const presentacion =
      d.modalidad_nombre || (d.modalidad === 'caja' ? 'Caja' : d.modalidad === 'saco' ? 'Saco' : null)
    return {
      unidad_de_medida: esKilo ? 'KGM' : 'NIU',
      codigo: (d.sku ?? '').slice(0, 30),
      descripcion: `${d.producto_nombre}${presentacion ? ` (${presentacion})` : ''}`.slice(0, 250),
      cantidad: String(cantidad),
      valor_unitario: (precio / (1 + IGV)).toFixed(10),
      precio_unitario: precio.toFixed(10),
      descuento: '',
      subtotal: f2(subLinea),
      tipo_de_igv: '1', // Gravado - operacion onerosa (todos los productos pagan IGV)
      igv: f2(igvLinea),
      total: f2(totalLinea),
      anticipo_regularizacion: 'false',
      anticipo_documento_serie: '',
      anticipo_documento_numero: '',
    }
  })

  const total = r2(Number(venta.total))
  const descuento = r2(Number(venta.descuento) || 0)
  if (Math.abs(r2(sumaTot - descuento) - total) > 0.01) {
    return {
      ok: false,
      mensaje: `Los montos de la venta no cuadran (productos ${f2(sumaTot)} - descuento ${f2(descuento)} ≠ total ${f2(total)}).`,
    }
  }
  if (Math.abs(total - r2(Number(comp.total))) > 0.01) {
    return { ok: false, mensaje: 'El total de la venta cambió después de reservar el comprobante.' }
  }

  // Descuento global (afecta la base imponible): se expresa sin IGV.
  const descuentoBase = descuento > 0 ? r2(descuento / (1 + IGV)) : 0
  const totalGravada = r2(sumaSub - descuentoBase)
  const totalIgv = r2(total - totalGravada)

  const medio: Record<string, string> = {
    efectivo: 'EFECTIVO',
    yape: 'YAPE',
    mixto: 'EFECTIVO Y YAPE',
  }

  return {
    ok: true,
    doc: {
      operacion: 'generar_comprobante',
      tipo_de_comprobante: String(codigoTipo(comp.tipo)),
      serie: comp.serie,
      numero: String(comp.numero),
      sunat_transaction: '1',
      cliente_tipo_de_documento: comp.cliente_tipo_doc,
      cliente_numero_de_documento: comp.cliente_num_doc,
      cliente_denominacion: comp.cliente_denominacion,
      cliente_direccion: comp.cliente_direccion ?? '',
      cliente_email: '',
      cliente_email_1: '',
      cliente_email_2: '',
      fecha_de_emision: fechaHoyLima(),
      fecha_de_vencimiento: '',
      moneda: '1', // Soles
      tipo_de_cambio: '',
      porcentaje_de_igv: '18.00',
      descuento_global: descuentoBase > 0 ? f2(descuentoBase) : '',
      total_descuento: descuentoBase > 0 ? f2(descuentoBase) : '',
      total_anticipo: '',
      total_gravada: f2(totalGravada),
      total_inafecta: '',
      total_exonerada: '',
      total_igv: f2(totalIgv),
      total_gratuita: '',
      total_otros_cargos: '',
      total: f2(total),
      percepcion_tipo: '',
      percepcion_base_imponible: '',
      total_percepcion: '',
      total_incluido_percepcion: '',
      detraccion: 'false',
      observaciones: `Nota de venta interna N° ${venta.numero}`,
      documento_que_se_modifica_tipo: '',
      documento_que_se_modifica_serie: '',
      documento_que_se_modifica_numero: '',
      tipo_de_nota_de_credito: '',
      tipo_de_nota_de_debito: '',
      enviar_automaticamente_a_la_sunat: 'true',
      enviar_automaticamente_al_cliente: 'false',
      codigo_unico: '',
      condiciones_de_pago: '',
      medio_de_pago: medio[String(venta.metodo)] ?? '',
      placa_vehiculo: '',
      orden_compra_servicio: '',
      tabla_personalizada_codigo: '',
      formato_de_pdf: 'TICKET',
      items,
    },
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const ruta = (Deno.env.get('NUBEFACT_RUTA') ?? '').trim()
  const token = (Deno.env.get('NUBEFACT_TOKEN') ?? '').trim()
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: 'La función no está configurada correctamente en el servidor.' }, 500)
  }
  if (!ruta || !token || !urlSegura(ruta)) {
    return json(
      { error: 'Faltan los secretos NUBEFACT_RUTA y/o NUBEFACT_TOKEN en Supabase (o la RUTA no es https).' },
      500,
    )
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'No autorizado.' }, 401)

    // Cliente "como quien llama": las validaciones de permisos ocurren en la
    // base con SU sesion (auth.uid()), nunca con lo que diga el body.
    const llamador = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: userData, error: userError } = await llamador.auth.getUser()
    if (userError || !userData.user) return json({ error: 'Sesión inválida o expirada.' }, 401)

    const { data: perfil } = await llamador
      .from('perfiles')
      .select('activo')
      .eq('id', userData.user.id)
      .single()
    if (!perfil?.activo) return json({ error: 'Tu usuario está inactivo.' }, 403)

    // Service role: SOLO para guardar el resultado de Nubefact y leer la venta.
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ error: 'Cuerpo de la petición inválido.' }, 400)
    }
    const accion = body.accion === 'consultar' ? 'consultar' : 'emitir'
    const ventaId = typeof body.venta_id === 'string' ? body.venta_id : ''
    if (!/^[0-9a-f-]{36}$/i.test(ventaId)) return json({ error: 'Venta inválida.' }, 400)

    // ── Consultar estado ante SUNAT (solo lectura) ─────────────────────────
    if (accion === 'consultar') {
      const { data: comp } = await admin.from('comprobantes').select('*').eq('venta_id', ventaId).maybeSingle()
      if (!comp) return json({ error: 'Esta venta no tiene comprobante.' }, 404)
      if (comp.estado === 'rechazado') return json({ comprobante: comp }, 200)
      const r = await llamarNubefact(ruta, token, {
        operacion: 'consultar_comprobante',
        tipo_de_comprobante: String(codigoTipo(comp.tipo)),
        serie: comp.serie,
        numero: String(comp.numero),
      })
      if (r.tipo === 'ok') {
        const act = await guardar(admin, comp.id, camposResultado(r.data))
        return json({ comprobante: act }, 200)
      }
      return json({ error: r.mensaje, comprobante: comp }, r.tipo === 'rechazo' ? 400 : 502)
    }

    // ── Emitir ──────────────────────────────────────────────────────────────
    const tipo = body.tipo === 'factura' ? 'factura' : body.tipo === 'boleta' ? 'boleta' : null
    if (!tipo) return json({ error: 'Elige boleta o factura.' }, 400)
    const cli = (typeof body.cliente === 'object' && body.cliente) ? (body.cliente as Record<string, unknown>) : {}
    const argsReserva = {
      p_venta_id: ventaId,
      p_tipo: tipo,
      p_cli_tipo: typeof cli.tipo_doc === 'string' ? cli.tipo_doc : '-',
      p_cli_doc: typeof cli.num_doc === 'string' ? cli.num_doc : '',
      p_cli_nombre: typeof cli.denominacion === 'string' ? cli.denominacion : '',
      p_cli_dir: typeof cli.direccion === 'string' ? cli.direccion : '',
    }

    for (let vuelta = 0; vuelta <= MAX_REASIGNACIONES; vuelta++) {
      // Estado previo: ¿pudo un intento anterior haber llegado a Nubefact?
      const { data: previo } = await admin
        .from('comprobantes')
        .select('estado, intentos')
        .eq('venta_id', ventaId)
        .maybeSingle()
      const posiblementeEnviado = !!previo && previo.estado === 'pendiente' && previo.intentos > 0

      const { data: reservado, error: errReserva } = await llamador.rpc('reservar_comprobante', argsReserva)
      if (errReserva) return json({ error: errReserva.message }, 400)
      const comp = reservado as Comprobante
      if (comp.estado === 'emitido' || comp.estado === 'aceptado') return json({ comprobante: comp }, 200)

      const { data: venta, error: errVenta } = await admin
        .from('ventas')
        .select('numero, total, descuento, metodo, anulada')
        .eq('id', ventaId)
        .single()
      if (errVenta || !venta) return json({ error: 'No se pudo leer la venta.' }, 500)
      const { data: detalle, error: errDet } = await admin
        .from('detalle_ventas')
        .select('producto_nombre, sku, cantidad, modalidad, modalidad_nombre, precio_unitario, subtotal, productos(unidad)')
        .eq('venta_id', ventaId)
      if (errDet) return json({ error: 'No se pudo leer el detalle de la venta.' }, 500)

      const armado = armarDocumento(comp, venta, (detalle ?? []) as unknown as Detalle[])
      if (!armado.ok) {
        const act = await guardar(admin, comp.id, {
          estado: 'rechazado',
          error_mensaje: armado.mensaje,
          actualizado_en: new Date().toISOString(),
        })
        return json({ error: armado.mensaje, comprobante: act }, 400)
      }

      // Se registra el intento ANTES de enviar: si la funcion muere a mitad
      // de camino, el proximo reintento sabe que pudo haber llegado.
      await guardar(admin, comp.id, { intentos: comp.intentos + 1, actualizado_en: new Date().toISOString() })

      const r = await llamarNubefact(ruta, token, armado.doc)

      if (r.tipo === 'ok') {
        const act = await guardar(admin, comp.id, camposResultado(r.data))
        return json({ comprobante: act }, 200)
      }

      if (esDuplicado(r)) {
        if (posiblementeEnviado) {
          // Un intento anterior SI llego: se recupera en vez de duplicarlo.
          const c = await llamarNubefact(ruta, token, {
            operacion: 'consultar_comprobante',
            tipo_de_comprobante: String(codigoTipo(comp.tipo)),
            serie: comp.serie,
            numero: String(comp.numero),
          })
          if (c.tipo === 'ok') {
            const act = await guardar(admin, comp.id, camposResultado(c.data))
            return json({ comprobante: act }, 200)
          }
          const act = await guardar(admin, comp.id, {
            error_mensaje: c.mensaje,
            actualizado_en: new Date().toISOString(),
          })
          return json({ error: c.mensaje, comprobante: act }, 502)
        }
        // Ese numero ya lo uso otro documento (ej. emitido desde la web de
        // Nubefact). Se libera esta reserva (el contador ya avanzo) y se
        // reserva el siguiente numero automaticamente.
        await admin.from('comprobantes').delete().eq('id', comp.id)
        continue
      }

      if (r.tipo === 'rechazo') {
        const act = await guardar(admin, comp.id, {
          estado: 'rechazado',
          error_mensaje: r.mensaje,
          actualizado_en: new Date().toISOString(),
        })
        return json({ error: r.mensaje, comprobante: act }, 400)
      }

      // Sin respuesta: queda 'pendiente' para reintentar con el MISMO numero.
      const act = await guardar(admin, comp.id, {
        error_mensaje: r.mensaje,
        actualizado_en: new Date().toISOString(),
      })
      return json(
        { comprobante: act, aviso: `${r.mensaje} El comprobante quedó pendiente: vuelve a intentarlo en un momento.` },
        200,
      )
    }

    return json(
      { error: 'Los números de la serie ya están usados en Nubefact. Ajusta el "último número usado" en Configuración.' },
      409,
    )
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Error inesperado.' }, 500)
  }
})
