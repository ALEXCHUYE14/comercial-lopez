import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { inicioDelDia, finDelDia, money } from '@/utils/format'
import type { CajaRegistro, ResultadoArqueo } from '@/types/database'

export interface ResumenCierre {
  monto_inicial: number
  total_efectivo: number
  total_yape: number
  total_fiado: number
  // Cobros de deuda (abonos de clientes) acreditados a esta caja, por metodo.
  total_cobros_efectivo: number
  total_cobros_yape: number
  // Egresos restados de esta caja, por metodo.
  total_egresos_efectivo: number
  total_egresos_otros: number
  // Agregados / formula de cierre:
  //   Total en caja = (Fondo inicial + Ventas directas + Cobros de deuda) - Egresos
  total_ventas_directas: number // efectivo + yape (sin fiado: no entra dinero a la caja)
  total_cobros: number          // total_cobros_efectivo + total_cobros_yape
  total_egresos: number         // total_egresos_efectivo + total_egresos_otros
  balance_neto: number          // formula completa de arriba
  esperado_efectivo: number     // fisico: fondo + ventas efectivo + cobros efectivo - egresos efectivo
  ingresado_real: number
  diferencia: number
  // Veredicto del arqueo a ciegas, calculado en servidor (ver RPC
  // cerrar_caja_arqueo) contra los umbrales de configuracion_caja.
  resultado_arqueo: ResultadoArqueo
  // Fila completa de la caja ya cerrada — la usan los tickets de cierre
  // (utils/ticketCierre.ts / utils/escposCierre.ts), que necesitan mas
  // campos (id de turno, cajero, horas) que los que trae este resumen.
  caja: CajaRegistro
}

export interface AperturaResultado {
  caja: CajaRegistro
  /** Ventas de hoy que estaban sin caja (se vendio sin abrir caja) y se vincularon a esta apertura */
  ventasVinculadas: number
  montoVinculado: number
  /** Abonos de clientes de hoy sin caja que se vincularon a esta apertura */
  cobrosVinculados: number
  montoCobrosVinculado: number
  /** Egresos de hoy sin caja que se vincularon a esta apertura */
  egresosVinculados: number
  montoEgresosVinculado: number
}

// Arma el mensaje de confirmación al abrir caja, mencionando cualquier venta,
// cobro de deuda o egreso de hoy que se registró sin caja abierta y ahora
// quedó vinculado a esta apertura (evita repetir esta lógica en cada pantalla
// que abre caja — Caja.tsx y POS.tsx).
export function mensajeVinculacion(r: AperturaResultado): string {
  const partes: string[] = []
  if (r.ventasVinculadas > 0) {
    partes.push(`${r.ventasVinculadas} venta${r.ventasVinculadas === 1 ? '' : 's'} (${money(r.montoVinculado)})`)
  }
  if (r.cobrosVinculados > 0) {
    partes.push(`${r.cobrosVinculados} cobro${r.cobrosVinculados === 1 ? '' : 's'} de deuda (${money(r.montoCobrosVinculado)})`)
  }
  if (r.egresosVinculados > 0) {
    partes.push(`${r.egresosVinculados} egreso${r.egresosVinculados === 1 ? '' : 's'} (${money(r.montoEgresosVinculado)})`)
  }
  if (partes.length === 0) return 'Caja abierta correctamente.'
  return `Caja abierta. Se vincularon registros de hoy sin caja: ${partes.join(', ')}.`
}

// Clave de localStorage para persistir el ID de caja activa entre recargas
const CAJA_KEY = 'bodeguita_caja_activa_id'

// Convierte de forma segura cualquier valor de BD a número.
// Supabase REST puede devolver columnas NUMERIC/DECIMAL como string;
// sin esta conversión el operador + concatena en lugar de sumar.
const toNum = (v: unknown): number => Number(v ?? 0)

export function useCaja(cajeroId: string | null) {
  const [caja, setCaja] = useState<CajaRegistro | null>(null)
  const [historial, setHistorial] = useState<CajaRegistro[]>([])
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    if (!cajeroId) {
      setCargando(false)
      return
    }
    setCargando(true)
    try {
      // Sin restricción de fecha: busca cualquier caja abierta del cajero.
      // El filtro por fecha causaba pérdida de estado al recargar cuando había
      // diferencia entre zona horaria local y UTC del servidor.
      const { data: cajaAbierta } = await supabase
        .from('cajas')
        .select('*')
        .eq('cajero_id', cajeroId)
        .eq('estado', 'abierta')
        .order('abierta_en', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (cajaAbierta) {
        localStorage.setItem(CAJA_KEY, cajaAbierta.id)
        setCaja(cajaAbierta)
        setCargando(false)
        return
      }

      // Fallback: intenta restaurar desde localStorage si la consulta no encontró nada
      const storedId = localStorage.getItem(CAJA_KEY)
      if (storedId) {
        const { data: cajaPorId } = await supabase
          .from('cajas')
          .select('*')
          .eq('id', storedId)
          .eq('cajero_id', cajeroId)
          .eq('estado', 'abierta')
          .maybeSingle()

        if (cajaPorId) {
          setCaja(cajaPorId)
        } else {
          localStorage.removeItem(CAJA_KEY)
          setCaja(null)
        }
      } else {
        setCaja(null)
      }
    } catch {
      setCaja(null)
    } finally {
      setCargando(false)
    }
  }, [cajeroId])

  const cargarHistorial = useCallback(async () => {
    if (!cajeroId) return
    const { data } = await supabase
      .from('cajas')
      .select('*')
      .eq('cajero_id', cajeroId)
      .order('abierta_en', { ascending: false })
      .limit(30)
    setHistorial(data ?? [])
  }, [cajeroId])

  useEffect(() => {
    cargar()
    cargarHistorial()
  }, [cargar, cargarHistorial])

  async function abrir(montoInicial: number, cajeroNombre: string): Promise<AperturaResultado> {
    if (!cajeroId) throw new Error('No hay sesion activa.')

    const desde = inicioDelDia().toISOString()
    const hasta = finDelDia().toISOString()

    // Registros "huerfanos": se registraron hoy con este cajero pero sin caja
    // abierta (ej. se olvido aperturar caja y aun asi se vendio/cobro/gasto).
    // Los RPC correspondientes los guardan igual con caja_id = null, asi que
    // nunca se pierden — pero tampoco quedan reflejados en ningun cierre de
    // caja. Se buscan aqui, antes de crear la caja, para poder incluirlos en
    // la apertura y que el cuadre del dia salga correcto.
    const [{ data: huerfanas }, { data: cobrosHuerfanos }, { data: egresosHuerfanos }] =
      await Promise.all([
        supabase
          .from('ventas')
          .select('id, metodo, total')
          .eq('cajero_id', cajeroId)
          .is('caja_id', null)
          .eq('anulada', false)
          .gte('creado_en', desde)
          .lte('creado_en', hasta),
        supabase
          .from('pagos_credito')
          .select('id, metodo, monto')
          .eq('cajero_id', cajeroId)
          .is('caja_id', null)
          .gte('creado_en', desde)
          .lte('creado_en', hasta),
        supabase
          .from('egresos')
          .select('id, metodo, monto')
          .eq('usuario_id', cajeroId)
          .is('caja_id', null)
          .gte('creado_en', desde)
          .lte('creado_en', hasta),
      ])

    const listaHuerfanas = huerfanas ?? []
    const sumaPorMetodo = (m: string) =>
      listaHuerfanas
        .filter((v) => v.metodo === m)
        .reduce((s, v) => s + toNum(v.total), 0)

    const totalEfectivoInicial = sumaPorMetodo('efectivo')
    const totalYapeInicial = sumaPorMetodo('yape')
    const totalFiadoInicial = sumaPorMetodo('fiado')

    const listaCobrosHuerfanos = cobrosHuerfanos ?? []
    const cobrosEfectivoInicial = listaCobrosHuerfanos
      .filter((p) => p.metodo === 'efectivo')
      .reduce((s, p) => s + toNum(p.monto), 0)
    const cobrosYapeInicial = listaCobrosHuerfanos
      .filter((p) => p.metodo !== 'efectivo')
      .reduce((s, p) => s + toNum(p.monto), 0)

    const listaEgresosHuerfanos = egresosHuerfanos ?? []
    const egresosEfectivoInicial = listaEgresosHuerfanos
      .filter((e) => e.metodo === 'efectivo')
      .reduce((s, e) => s + toNum(e.monto), 0)
    const egresosOtrosInicial = listaEgresosHuerfanos
      .filter((e) => e.metodo !== 'efectivo')
      .reduce((s, e) => s + toNum(e.monto), 0)

    const { data, error } = await supabase
      .from('cajas')
      .insert({
        cajero_id: cajeroId,
        cajero_nombre: cajeroNombre,
        monto_inicial: toNum(montoInicial),
        total_efectivo: totalEfectivoInicial,
        total_yape: totalYapeInicial,
        total_fiado: totalFiadoInicial,
        total_cobros_efectivo: cobrosEfectivoInicial,
        total_cobros_yape: cobrosYapeInicial,
        total_egresos_efectivo: egresosEfectivoInicial,
        total_egresos_otros: egresosOtrosInicial,
        estado: 'abierta',
      })
      .select()
      .single()
    if (error) throw error

    // Vincula los registros huerfanos a la caja recien creada (requiere rol
    // administrador por RLS). Si la vinculacion falla por permisos, la
    // apertura de caja igual continua: los totales iniciales ya quedaron
    // sumados arriba, solo no se re-etiquetan esos registros con el caja_id.
    await Promise.all([
      listaHuerfanas.length > 0
        ? supabase.from('ventas').update({ caja_id: data.id }).in('id', listaHuerfanas.map((v) => v.id))
        : Promise.resolve(),
      listaCobrosHuerfanos.length > 0
        ? supabase.from('pagos_credito').update({ caja_id: data.id }).in('id', listaCobrosHuerfanos.map((p) => p.id))
        : Promise.resolve(),
      listaEgresosHuerfanos.length > 0
        ? supabase.from('egresos').update({ caja_id: data.id }).in('id', listaEgresosHuerfanos.map((e) => e.id))
        : Promise.resolve(),
    ])

    localStorage.setItem(CAJA_KEY, data.id)
    setCaja(data)
    setHistorial((prev) => [data, ...prev])
    return {
      caja: data,
      ventasVinculadas: listaHuerfanas.length,
      montoVinculado: totalEfectivoInicial + totalYapeInicial + totalFiadoInicial,
      cobrosVinculados: listaCobrosHuerfanos.length,
      montoCobrosVinculado: cobrosEfectivoInicial + cobrosYapeInicial,
      egresosVinculados: listaEgresosHuerfanos.length,
      montoEgresosVinculado: egresosEfectivoInicial + egresosOtrosInicial,
    }
  }

  async function cerrar(montoReal: number): Promise<ResumenCierre> {
    if (!caja) throw new Error('No hay caja abierta')

    const montoRealNum = toNum(montoReal)

    // El arqueo (efectivo esperado, diferencia, resultado OK/observado/
    // critico) se calcula SIEMPRE en el servidor — ver RPC
    // cerrar_caja_arqueo en supabase/schema.sql. Ni este hook ni la pantalla
    // de cierre calculan ni conocen el efectivo esperado antes de que el
    // cajero declare su conteo fisico y lo envie: eso es lo que hace posible
    // el arqueo a ciegas (antes se computaba aqui mismo, en el cliente, lo
    // que permitia ver el "esperado" antes de escribir el conteo real).
    const { data, error } = await supabase.rpc('cerrar_caja_arqueo', {
      p_caja_id: caja.id,
      p_monto_real: montoRealNum,
    })
    if (error) throw error
    const cerrada = data as CajaRegistro

    localStorage.removeItem(CAJA_KEY)
    setCaja(null)
    setHistorial((prev) => prev.map((x) => (x.id === cerrada.id ? cerrada : x)))

    // Conversión explícita antes de operar para evitar concatenación de strings
    const montoInicial       = toNum(cerrada.monto_inicial)
    const totalEfectivo      = toNum(cerrada.total_efectivo)
    const totalYape          = toNum(cerrada.total_yape)
    const totalFiado         = toNum(cerrada.total_fiado)
    const cobrosEfectivo     = toNum(cerrada.total_cobros_efectivo)
    const cobrosYape         = toNum(cerrada.total_cobros_yape)
    const egresosEfectivo    = toNum(cerrada.total_egresos_efectivo)
    const egresosOtros       = toNum(cerrada.total_egresos_otros)

    const totalVentasDirectas = totalEfectivo + totalYape
    const totalCobros         = cobrosEfectivo + cobrosYape
    const totalEgresos        = egresosEfectivo + egresosOtros
    const balanceNeto         = montoInicial + totalVentasDirectas + totalCobros - totalEgresos

    return {
      monto_inicial:          montoInicial,
      total_efectivo:         totalEfectivo,
      total_yape:             totalYape,
      total_fiado:            totalFiado,
      total_cobros_efectivo:  cobrosEfectivo,
      total_cobros_yape:      cobrosYape,
      total_egresos_efectivo: egresosEfectivo,
      total_egresos_otros:    egresosOtros,
      total_ventas_directas:  totalVentasDirectas,
      total_cobros:           totalCobros,
      total_egresos:          totalEgresos,
      balance_neto:           balanceNeto,
      esperado_efectivo:      toNum(cerrada.esperado_efectivo),
      ingresado_real:         toNum(cerrada.monto_real),
      diferencia:             toNum(cerrada.diferencia_arqueo),
      resultado_arqueo:       cerrada.resultado_arqueo ?? 'ok',
      caja:                   cerrada,
    }
  }

  function campoDe(metodo: 'efectivo' | 'yape' | 'fiado'): keyof CajaRegistro {
    return metodo === 'efectivo' ? 'total_efectivo' : metodo === 'yape' ? 'total_yape' : 'total_fiado'
  }

  // Actualizacion optimista local, SIN tocar el servidor. Existe por separado
  // de sumarVenta (que hace ambas cosas) para el modo offline del POS: al
  // encolar una venta sin conexion se aplica esto de inmediato (para que el
  // total de caja en pantalla ya refleje la venta), y cuando esa venta se
  // sincroniza despues se llama a confirmarVentaRemota (solo RPC) — nunca a
  // sumarVenta completo, que volveria a sumar el monto una segunda vez en el
  // estado local (el RPC en el servidor solo se ejecuta una vez, pero el
  // estado en pantalla quedaria duplicado si se reaplicara el optimista).
  function aplicarVentaLocal(
    cajaId: string,
    metodo: 'efectivo' | 'yape' | 'fiado',
    monto: number,
  ): void {
    const campo = campoDe(metodo)
    setCaja((prev) =>
      prev && prev.id === cajaId
        ? { ...prev, [campo]: toNum(prev[campo]) + toNum(monto) }
        : prev,
    )
  }

  // Solo el RPC remoto, sin actualizacion optimista — para confirmar en el
  // servidor una venta que ya se conto localmente via aplicarVentaLocal.
  async function confirmarVentaRemota(
    cajaId: string,
    metodo: 'efectivo' | 'yape' | 'fiado',
    monto: number,
  ): Promise<void> {
    // supabase-js devuelve el error del RPC en vez de lanzarlo: sin este
    // chequeo una suma a caja rechazada (caja cerrada, caja ajena) pasaba en
    // silencio y el total en pantalla quedaba distinto al del servidor. Los
    // llamadores (sumarVenta / POS / sincronizacion offline) ya esperan que
    // esto lance para avisar al usuario.
    const { error } = await supabase.rpc('incrementar_caja', {
      p_caja_id: cajaId,
      p_metodo: metodo,
      p_monto: toNum(monto),
    } as never)
    if (error) throw new Error(error.message)
  }

  // Incrementa los totales de la caja tras una venta EN LINEA — llamado
  // desde POS. Hace ambas cosas: RPC remoto + actualizacion optimista local.
  async function sumarVenta(
    cajaId: string,
    metodo: 'efectivo' | 'yape' | 'fiado',
    monto: number,
  ): Promise<void> {
    await confirmarVentaRemota(cajaId, metodo, monto)
    aplicarVentaLocal(cajaId, metodo, monto)
  }

  // Efectivo en caja = fondo inicial + ventas en efectivo + cobros en
  // efectivo - egresos en efectivo (lo que deberia haber fisicamente ahora).
  const total = caja
    ? toNum(caja.monto_inicial) +
      toNum(caja.total_efectivo) +
      toNum(caja.total_cobros_efectivo) -
      toNum(caja.total_egresos_efectivo)
    : 0

  return {
    caja,
    historial,
    cargando,
    abrir,
    cerrar,
    sumarVenta,
    aplicarVentaLocal,
    confirmarVentaRemota,
    total,
    recargar: cargar,
    recargarHistorial: cargarHistorial,
  }
}
