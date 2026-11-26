// Seccion "Boleta / Factura electronica" de una venta. Se usa al entregar la
// venta (Receipt, en el POS) y desde el historial (Ventas). Muestra el
// formulario para emitir, o el estado del comprobante ya emitido.
//
// No se muestra nada si la facturacion esta desactivada o si aun no se
// ejecuto el SQL en Supabase: el resto del sistema sigue igual que antes.
import { useCallback, useEffect, useState } from 'react'
import { FileText, RefreshCw, ExternalLink, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { supabase } from '@/lib/supabase'
import { cx, money } from '@/utils/format'
import {
  ETIQUETA_TIPO,
  MONTO_BOLETA_CON_DNI,
  abrirEnlaceComprobante,
  consultarComprobante,
  emitirComprobante,
  numeroComprobante,
  validarCliente,
  type ClienteComprobante,
} from '@/utils/comprobantes'
import type { Comprobante, TipoComprobante, TipoDocCliente, Venta } from '@/types/database'

interface Props {
  venta: Pick<Venta, 'id' | 'numero' | 'total' | 'anulada' | 'metodo' | 'cliente_nombre'>
  /** Avisa al padre si la venta tiene comprobante vigente (para ocultar Anular/Cambiar). */
  onComprobante?: (c: Comprobante | null) => void
  /**
   * Tipo elegido desde afuera (selector Nota de venta / Boleta / Factura del
   * POS). Si se pasa, se oculta el selector propio de este formulario.
   */
  tipo?: TipoComprobante
}

const VACIO: ClienteComprobante = { tipo_doc: '-', num_doc: '', denominacion: '', direccion: '' }

export function ComprobanteElectronico({ venta, onComprobante, tipo: tipoExterno }: Props) {
  const toast = useToast()
  const [activo, setActivo] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [comp, setComp] = useState<Comprobante | null>(null)
  const [tipo, setTipo] = useState<TipoComprobante>(tipoExterno ?? 'boleta')
  const [cliente, setCliente] = useState<ClienteComprobante>({
    ...VACIO,
    tipo_doc: tipoExterno === 'factura' ? '6' : VACIO.tipo_doc,
    denominacion: venta.cliente_nombre ?? '',
  })
  const [enviando, setEnviando] = useState(false)
  const [consultando, setConsultando] = useState(false)
  const total = Number(venta.total)

  const publicar = useCallback(
    (c: Comprobante | null) => {
      setComp(c)
      onComprobante?.(c)
    },
    [onComprobante],
  )

  useEffect(() => {
    let vivo = true
    async function cargar() {
      setCargando(true)
      try {
        const [{ data: cfg }, { data: c }] = await Promise.all([
          supabase.from('facturacion_config').select('activo').eq('id', 1).maybeSingle(),
          venta.numero > 0
            ? supabase.from('comprobantes').select('*').eq('venta_id', venta.id).maybeSingle()
            : Promise.resolve({ data: null }),
        ])
        if (!vivo) return
        setActivo(!!cfg?.activo)
        const existente = (c as Comprobante | null) ?? null
        publicar(existente)
        if (existente) {
          setTipo(existente.tipo)
          setCliente({
            tipo_doc: existente.cliente_tipo_doc,
            num_doc: existente.cliente_num_doc === '-' ? '' : existente.cliente_num_doc,
            denominacion: existente.cliente_denominacion,
            direccion: existente.cliente_direccion ?? '',
          })
        }
      } catch {
        // Sin conexion o SQL aun no ejecutado: la seccion simplemente no se muestra.
      } finally {
        if (vivo) setCargando(false)
      }
    }
    cargar()
    return () => {
      vivo = false
    }
    // Solo al cambiar de venta (publicar es estable salvo que cambie el callback).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venta.id, venta.numero])

  function cambiarTipo(t: TipoComprobante) {
    setTipo(t)
    // La factura siempre va con RUC; la boleta conserva lo elegido.
    if (t === 'factura') setCliente((c) => ({ ...c, tipo_doc: '6' }))
  }

  // Tipo controlado desde afuera: se sigue mientras no exista un comprobante
  // (uno ya reservado conserva su tipo; el servidor tampoco deja cambiarlo).
  useEffect(() => {
    if (tipoExterno && !comp && tipoExterno !== tipo) cambiarTipo(tipoExterno)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipoExterno])

  const errorCliente = validarCliente(tipo, cliente, total)
  const bloqueoFiado = tipo === 'factura' && venta.metodo === 'fiado'

  async function emitir() {
    if (enviando) return
    if (!navigator.onLine) {
      toast.error('Sin conexión a internet. Emite el comprobante cuando vuelva la conexión.')
      return
    }
    if (bloqueoFiado) {
      toast.error('La factura al crédito (fiado) aún no está disponible. Emite una boleta.')
      return
    }
    if (errorCliente) {
      toast.error(errorCliente)
      return
    }
    const esReintento = !!comp
    if (!esReintento) {
      const quien =
        cliente.tipo_doc === '-'
          ? 'Clientes varios'
          : `${cliente.denominacion.trim()} (${cliente.tipo_doc === '1' ? 'DNI' : 'RUC'} ${cliente.num_doc.replace(/\D/g, '')})`
      const ok = window.confirm(
        `¿Emitir ${ETIQUETA_TIPO[tipo].toUpperCase()} por ${money(total)} a nombre de ${quien}?\n\n` +
          'Una vez enviada a SUNAT ya no se puede anular ni cambiar la venta (se requiere una Nota de Crédito).',
      )
      if (!ok) return
    }
    setEnviando(true)
    try {
      const r = await emitirComprobante(venta.id, tipo, cliente)
      publicar(r.comprobante)
      if (r.aviso) toast.info(r.aviso)
      else if (r.comprobante) toast.exito(`${ETIQUETA_TIPO[r.comprobante.tipo]} ${numeroComprobante(r.comprobante)} emitida`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo emitir el comprobante')
      // El servidor pudo haber guardado el rechazo: se recarga el estado real.
      const { data } = await supabase.from('comprobantes').select('*').eq('venta_id', venta.id).maybeSingle()
      publicar((data as Comprobante | null) ?? null)
    } finally {
      setEnviando(false)
    }
  }

  async function actualizarEstado() {
    if (consultando) return
    setConsultando(true)
    try {
      const r = await consultarComprobante(venta.id)
      publicar(r.comprobante)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo consultar el estado')
    } finally {
      setConsultando(false)
    }
  }

  function verPdf() {
    if (!comp || !abrirEnlaceComprobante(comp)) {
      toast.error('El PDF aún no está disponible. Usa "Actualizar estado" en un momento.')
    }
  }

  if (cargando) return null
  // Sin facturacion activa y sin comprobante previo: no se muestra nada.
  if (!activo && !comp) return null
  if (venta.anulada && !comp) return null

  if (venta.numero <= 0) {
    return (
      <p className="mb-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
        Esta venta aún no se sincroniza. Podrás emitir su boleta o factura desde <strong>Ventas</strong> cuando
        vuelva la conexión.
      </p>
    )
  }

  // ── Comprobante ya enviado ───────────────────────────────────────────────
  if (comp && (comp.estado === 'emitido' || comp.estado === 'aceptado')) {
    const aceptado = comp.estado === 'aceptado'
    return (
      <div className="mb-4 rounded-xl border border-ink-200 p-3">
        <div className="flex items-start gap-2">
          {aceptado ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent-700" />
          ) : (
            <Clock className="mt-0.5 size-4 shrink-0 text-amber-600" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-900">
              {ETIQUETA_TIPO[comp.tipo]} {numeroComprobante(comp)}
            </p>
            <p className="break-words text-xs text-ink-500">
              {comp.cliente_denominacion}
              {comp.cliente_num_doc !== '-' && ` · ${comp.cliente_tipo_doc === '1' ? 'DNI' : 'RUC'} ${comp.cliente_num_doc}`}
            </p>
            <p className={cx('mt-1 text-xs', aceptado ? 'text-accent-700' : 'text-amber-700')}>
              {aceptado ? 'Aceptada por SUNAT' : 'Enviada · SUNAT aún no confirma'}
              {comp.sunat_descripcion ? ` — ${comp.sunat_descripcion}` : ''}
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={verPdf}>
            <ExternalLink className="size-4" /> Ver / imprimir PDF
          </Button>
          {!aceptado && (
            <Button variant="outline" size="sm" className="flex-1" loading={consultando} onClick={actualizarEstado}>
              <RefreshCw className="size-4" /> Actualizar estado
            </Button>
          )}
        </div>
      </div>
    )
  }

  // ── Formulario (nuevo, pendiente o rechazado) ───────────────────────────
  const pendiente = comp?.estado === 'pendiente'
  const rechazado = comp?.estado === 'rechazado'
  // Un comprobante pendiente se reenvia tal cual (pudo haber llegado a
  // Nubefact): no se permite cambiar sus datos.
  const bloqueado = pendiente || enviando
  const tipoFijo = !!comp

  return (
    <div className="mb-4 rounded-xl border border-ink-200 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink-900">
        <FileText className="size-4" />{' '}
        {tipoExterno ? `Datos del cliente · ${tipo === 'factura' ? 'Factura' : 'Boleta'}` : 'Boleta / Factura electrónica'}
      </p>

      {pendiente && (
        <p className="mb-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
          {numeroComprobante(comp)} quedó pendiente
          {comp.error_mensaje ? ` (${comp.error_mensaje})` : ''}. Toca <strong>Reintentar</strong>: se reenvía el
          mismo número, sin duplicarlo.
        </p>
      )}
      {rechazado && (
        <p className="mb-2 flex gap-1.5 rounded-lg bg-red-50 p-2 text-xs text-red-700">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">
            Rechazada: {comp.error_mensaje ?? 'datos inválidos'}. Corrige los datos y reintenta.
          </span>
        </p>
      )}

      {!tipoExterno && (
      <div className="mb-2 grid grid-cols-2 gap-2">
        {(['boleta', 'factura'] as const).map((t) => (
          <button
            key={t}
            type="button"
            disabled={tipoFijo || bloqueado}
            onClick={() => cambiarTipo(t)}
            className={cx(
              'rounded-lg border px-3 py-2 text-sm font-semibold transition disabled:opacity-60',
              tipo === t ? 'border-accent-600 bg-accent-50 text-accent-700' : 'border-ink-200 text-ink-600',
            )}
          >
            {t === 'boleta' ? 'Boleta' : 'Factura'}
          </button>
        ))}
      </div>
      )}

      <div className="space-y-2">
        {tipo === 'boleta' && (
          <select
            className="input text-base sm:text-sm"
            disabled={bloqueado}
            value={cliente.tipo_doc}
            onChange={(e) => setCliente((c) => ({ ...c, tipo_doc: e.target.value as TipoDocCliente }))}
          >
            <option value="-">Sin documento (clientes varios)</option>
            <option value="1">DNI</option>
            <option value="6">RUC</option>
          </select>
        )}
        {cliente.tipo_doc !== '-' && (
          <input
            className="input tabular text-base sm:text-sm"
            inputMode="numeric"
            autoComplete="off"
            disabled={bloqueado}
            maxLength={cliente.tipo_doc === '1' ? 8 : 11}
            placeholder={cliente.tipo_doc === '1' ? 'DNI (8 dígitos)' : 'RUC (11 dígitos)'}
            value={cliente.num_doc}
            onChange={(e) => setCliente((c) => ({ ...c, num_doc: e.target.value.replace(/\D/g, '') }))}
          />
        )}
        <input
          className="input text-base sm:text-sm"
          autoComplete="off"
          autoCapitalize="words"
          disabled={bloqueado}
          maxLength={200}
          placeholder={tipo === 'factura' ? 'Razón social' : cliente.tipo_doc === '-' ? 'Nombre (opcional)' : 'Nombre del cliente'}
          value={cliente.denominacion}
          onChange={(e) => setCliente((c) => ({ ...c, denominacion: e.target.value }))}
        />
        {tipo === 'factura' && (
          <input
            className="input text-base sm:text-sm"
            autoComplete="off"
            disabled={bloqueado}
            maxLength={250}
            placeholder="Dirección fiscal (opcional)"
            value={cliente.direccion}
            onChange={(e) => setCliente((c) => ({ ...c, direccion: e.target.value }))}
          />
        )}
      </div>

      {tipo === 'boleta' && cliente.tipo_doc === '-' && total >= MONTO_BOLETA_CON_DNI && (
        <p className="mt-2 text-xs text-red-600">
          Desde S/ {MONTO_BOLETA_CON_DNI}.00 SUNAT exige el DNI del cliente.
        </p>
      )}
      {bloqueoFiado && (
        <p className="mt-2 text-xs text-red-600">La factura al crédito (fiado) aún no está disponible.</p>
      )}

      <Button
        className="mt-3 w-full"
        size="sm"
        loading={enviando}
        disabled={(!pendiente && !!errorCliente) || bloqueoFiado}
        onClick={emitir}
      >
        {comp ? (
          <>
            <RefreshCw className="size-4" /> Reintentar
          </>
        ) : (
          <>Emitir {tipo === 'boleta' ? 'boleta' : 'factura'}</>
        )}
      </Button>
    </div>
  )
}
