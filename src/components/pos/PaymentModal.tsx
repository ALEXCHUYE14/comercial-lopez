import { useEffect, useMemo, useState } from 'react'
import { Banknote, Smartphone, HandCoins, Check, Search, ArrowLeftRight, UserPlus } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { money, cx } from '@/utils/format'
import { armarPagoMixto, redondear2 } from '@/utils/pagos'
import { LIMITE_CREDITO_CAJERO } from '@/hooks/useClientes'
import { useNegocio } from '@/config/negocio'
import type { ClienteCredito, MetodoPago, PagoVenta } from '@/types/database'

interface Props {
  open: boolean
  onClose: () => void
  total: number
  procesando: boolean
  clientes: ClienteCredito[]
  /** `pagos` solo viene con metodo 'mixto' (efectivo + yape); en ese caso
   * `pagoRecibido` = efectivo entregado + yape. */
  onConfirmar: (
    metodo: MetodoPago,
    pagoRecibido: number,
    clienteId?: string,
    pagos?: PagoVenta[],
  ) => void
  /** Alta rápida de un cliente nuevo sin salir del cobro (ver
   * useClientes.crearParaFiado). Si no se pasa, se muestra el aviso de ir a
   * Clientes como antes. */
  onCrearCliente?: (datos: { nombre: string; telefono: string; limite: number }) => Promise<ClienteCredito>
  /** true = puede fijar el límite de crédito del cliente nuevo (administrador);
   * false = queda con el límite inicial (LIMITE_CREDITO_CAJERO). */
  puedeFijarLimite?: boolean
  /** Sin conexión: oculta "Fiado" (requiere validar el límite de crédito
   * actualizado en el servidor, ver hooks/useVentasOffline.ts) y "Mixto"
   * (se valida en el servidor y no entra a la cola offline). */
  offline?: boolean
}

const METODOS: { id: MetodoPago; label: string; icon: typeof Banknote; desc: string }[] = [
  { id: 'efectivo', label: 'Efectivo', icon: Banknote, desc: 'Pago con billetes/monedas' },
  { id: 'yape', label: 'Yape', icon: Smartphone, desc: 'Transferencia instantánea' },
  { id: 'fiado', label: 'Fiado', icon: HandCoins, desc: 'Apuntar a cuenta del cliente' },
  { id: 'mixto', label: 'Mixto', icon: ArrowLeftRight, desc: 'Parte en efectivo, parte en Yape' },
]

const RAPIDOS = [10, 20, 50, 100, 200]

export function PaymentModal({
  open,
  onClose,
  total,
  procesando,
  clientes,
  onConfirmar,
  offline,
  onCrearCliente,
  puedeFijarLimite = false,
}: Props) {
  const [metodo, setMetodo] = useState<MetodoPago>('efectivo')
  const [recibido, setRecibido] = useState('')
  const [busqCliente, setBusqCliente] = useState('')
  const [clienteId, setClienteId] = useState<string | null>(null)
  // Pago mixto: cuanto de la venta paga en efectivo (el yape es el resto) y,
  // opcional, cuanto efectivo entrega para calcular el vuelto.
  const [efectivoParte, setEfectivoParte] = useState('')
  const [efectivoEntregado, setEfectivoEntregado] = useState('')
  // Alta rapida de cliente para fiado (sin salir del cobro).
  const [nuevoAbierto, setNuevoAbierto] = useState(false)
  const [nuevo, setNuevo] = useState({ nombre: '', telefono: '', limite: String(LIMITE_CREDITO_CAJERO) })
  const [creando, setCreando] = useState(false)
  const [errorNuevo, setErrorNuevo] = useState<string | null>(null)
  const { yapeQrUrl } = useNegocio()
  // URL cuyo QR fallo al cargar (sin internet, archivo borrado): se oculta la
  // imagen rota y el cobro sigue funcionando igual, sin QR en pantalla.
  const [qrRoto, setQrRoto] = useState<string | null>(null)

  const metodosDisponibles = useMemo(
    () => (offline ? METODOS.filter((m) => m.id !== 'fiado' && m.id !== 'mixto') : METODOS),
    [offline],
  )

  // Si se cae la conexion con "Fiado" ya seleccionado, se vuelve a efectivo
  // de inmediato — sin esto, el boton de confirmar quedaria mostrando un
  // metodo que ya no aparece en la lista de arriba.
  useEffect(() => {
    if (offline && (metodo === 'fiado' || metodo === 'mixto')) {
      setMetodo('efectivo')
      setClienteId(null)
    }
  }, [offline, metodo])

  const esEfectivo = metodo === 'efectivo'
  const esFiado = metodo === 'fiado'
  const esMixto = metodo === 'mixto'
  const pago = parseFloat(recibido) || 0
  const vuelto = useMemo(() => Math.max(pago - total, 0), [pago, total])
  const suficienteEfectivo = pago >= total
  const clienteSeleccionado = clientes.find((c) => c.id === clienteId) ?? null

  // Validacion de credito para fiado
  const creditoDisponible = clienteSeleccionado
    ? clienteSeleccionado.limite_credito - clienteSeleccionado.deuda_actual
    : 0
  const superaLimite = esFiado && clienteSeleccionado && total > creditoDisponible
  const sinCliente = esFiado && !clienteSeleccionado

  // Pago mixto: la validacion (partes > 0, suma exacta, efectivo alcanza)
  // vive en armarPagoMixto — la misma funcion que arma lo que se envia.
  const mixto = useMemo(
    () =>
      armarPagoMixto(
        total,
        parseFloat(efectivoParte),
        efectivoEntregado.trim() === '' ? undefined : parseFloat(efectivoEntregado),
      ),
    [total, efectivoParte, efectivoEntregado],
  )

  const puedeConfirmar =
    !sinCliente &&
    !superaLimite &&
    (!esEfectivo || suficienteEfectivo) &&
    (!esMixto || mixto.ok)

  const clientesFiltrados = useMemo(() => {
    const q = busqCliente.trim().toLowerCase()
    return q
      ? clientes.filter(
          (c) =>
            c.nombre.toLowerCase().includes(q) ||
            (c.telefono ?? '').includes(q),
        )
      : clientes
  }, [clientes, busqCliente])

  function abrirNuevo() {
    // Si ya escribio un nombre en el buscador, se aprovecha como nombre nuevo.
    setNuevo({ nombre: busqCliente.trim(), telefono: '', limite: String(LIMITE_CREDITO_CAJERO) })
    setErrorNuevo(null)
    setNuevoAbierto(true)
  }

  async function crearCliente() {
    if (!onCrearCliente || creando) return
    const nombre = nuevo.nombre.trim()
    if (nombre.length < 2) {
      setErrorNuevo('Escribe el nombre del cliente (mínimo 2 letras).')
      return
    }
    const limite = puedeFijarLimite ? parseFloat(nuevo.limite) : LIMITE_CREDITO_CAJERO
    if (!Number.isFinite(limite) || limite < 0) {
      setErrorNuevo('El límite de crédito no es válido.')
      return
    }
    setCreando(true)
    setErrorNuevo(null)
    try {
      const cliente = await onCrearCliente({ nombre, telefono: nuevo.telefono, limite })
      // Queda seleccionado de inmediato: el cobro al fiado sigue sin interrupciones.
      setClienteId(cliente.id)
      setBusqCliente('')
      setNuevoAbierto(false)
    } catch (e) {
      setErrorNuevo(e instanceof Error ? e.message : 'No se pudo registrar al cliente.')
    } finally {
      setCreando(false)
    }
  }

  function seleccionar(id: string) {
    setClienteId(id)
    setBusqCliente('')
  }

  function confirmar() {
    if (esMixto) {
      if (!mixto.ok) return
      onConfirmar('mixto', mixto.pagoRecibido, undefined, mixto.pagos)
      return
    }
    const pagoFinal = esEfectivo ? pago : total
    onConfirmar(metodo, pagoFinal, esFiado ? clienteId ?? undefined : undefined)
  }

  function reset() {
    setMetodo('efectivo')
    setRecibido('')
    setBusqCliente('')
    setClienteId(null)
    setEfectivoParte('')
    setEfectivoEntregado('')
    setNuevoAbierto(false)
    setErrorNuevo(null)
  }

  function handleClose() {
    reset()
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={handleClose}
      title="Cobrar venta"
      maxWidth="max-w-md"
      footer={
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          disabled={!puedeConfirmar}
          loading={procesando}
          onClick={confirmar}
        >
          <Check className="size-5" />
          Confirmar cobro · {money(total)}
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Total */}
        <div className="rounded-2xl bg-ink-900 px-5 py-4 text-white">
          <p className="text-xs font-medium uppercase tracking-wider text-white/50">
            Total a cobrar
          </p>
          <p className="tabular font-display text-3xl font-bold">{money(total)}</p>
        </div>

        {/* Selección de método */}
        <div>
          <p className="label mb-2">Método de pago</p>
          {offline && (
            <p className="mb-2 text-xs text-amber-600">
              Sin conexión: "Fiado" no está disponible, se sincronizará cuando vuelva internet.
            </p>
          )}
          <div className="grid grid-cols-4 gap-2">
            {metodosDisponibles.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  setMetodo(id)
                  setClienteId(null)
                  setRecibido('')
                  setEfectivoParte('')
                  setEfectivoEntregado('')
                  setNuevoAbierto(false)
                  setErrorNuevo(null)
                }}
                className={cx(
                  'flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-semibold transition focusable',
                  metodo === id
                    ? 'border-accent-500 bg-accent-50 text-accent-700'
                    : 'border-ink-200 text-ink-500 hover:border-ink-300',
                )}
              >
                <Icon className="size-5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Panel: Efectivo */}
        {esEfectivo && (
          <div className="space-y-3 animate-fade-up">
            <div>
              <p className="label mb-2">¿Con cuánto paga?</p>
              <input
                type="number"
                inputMode="decimal"
                autoFocus
                value={recibido}
                onChange={(e) => setRecibido(e.target.value)}
                placeholder="0.00"
                className="input tabular text-lg"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setRecibido(total.toFixed(2))}
                className="rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
              >
                Exacto
              </button>
              {RAPIDOS.filter((m) => m >= total).map((m) => (
                <button
                  key={m}
                  onClick={() => setRecibido(String(m))}
                  className="rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
                >
                  S/ {m}
                </button>
              ))}
            </div>
            {pago > 0 && (
              <div
                className={cx(
                  'flex items-center justify-between rounded-xl px-4 py-3',
                  suficienteEfectivo ? 'bg-accent-50' : 'bg-red-50',
                )}
              >
                <span className="text-sm font-medium text-ink-600">Vuelto</span>
                <span
                  className={cx(
                    'tabular font-display text-xl font-bold',
                    suficienteEfectivo ? 'text-accent-700' : 'text-red-600',
                  )}
                >
                  {suficienteEfectivo ? money(vuelto) : 'Falta ' + money(total - pago)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Panel: Mixto (parte en efectivo, el resto en Yape) */}
        {esMixto && (
          <div className="animate-fade-up space-y-3">
            <div>
              <p className="label mb-2">¿Cuánto paga en efectivo?</p>
              <input
                type="number"
                inputMode="decimal"
                autoFocus
                min={0}
                step={0.01}
                value={efectivoParte}
                onChange={(e) => setEfectivoParte(e.target.value)}
                placeholder="0.00"
                className="input tabular text-lg"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {[25, 50, 75].map((p) => (
                <button
                  key={p}
                  onClick={() => setEfectivoParte(redondear2((total * p) / 100).toFixed(2))}
                  className="rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
                >
                  {p}% efectivo
                </button>
              ))}
            </div>
            {mixto.ok ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl bg-accent-50 px-3.5 py-2.5">
                    <p className="text-xs text-accent-700">Efectivo</p>
                    <p className="tabular font-display text-lg font-bold text-accent-700">
                      {money(mixto.efectivo)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-blue-50 px-3.5 py-2.5">
                    <p className="text-xs text-blue-700">Yape (el resto)</p>
                    <p className="tabular font-display text-lg font-bold text-blue-700">
                      {money(mixto.yape)}
                    </p>
                  </div>
                </div>
                <div>
                  <p className="label mb-1.5">Efectivo que entrega (opcional, para el vuelto)</p>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={efectivoEntregado}
                    onChange={(e) => setEfectivoEntregado(e.target.value)}
                    placeholder={mixto.efectivo.toFixed(2)}
                    className="input tabular"
                  />
                </div>
                {mixto.vuelto > 0 && (
                  <div className="flex items-center justify-between rounded-xl bg-accent-50 px-4 py-3">
                    <span className="text-sm font-medium text-ink-600">Vuelto</span>
                    <span className="tabular font-display text-xl font-bold text-accent-700">
                      {money(mixto.vuelto)}
                    </span>
                  </div>
                )}
                <p className="text-xs text-blue-500">
                  Confirma que el cliente ya envió los {money(mixto.yape)} por Yape antes de procesar.
                </p>
              </div>
            ) : (
              efectivoParte.trim() !== '' && (
                <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{mixto.error}</div>
              )
            )}
            {yapeQrUrl && qrRoto !== yapeQrUrl && mixto.ok && (
              <div className="flex flex-col items-center gap-1.5">
                <img
                  src={yapeQrUrl}
                  alt="Código QR de Yape del negocio"
                  className="size-44 max-w-full rounded-xl border border-blue-100 bg-white object-contain p-2"
                  onError={() => setQrRoto(yapeQrUrl)}
                />
                <p className="text-xs text-blue-500">El cliente escanea este código con Yape</p>
              </div>
            )}
          </div>
        )}

        {/* Panel: Yape */}
        {metodo === 'yape' && (
          <div className="animate-fade-up rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <Smartphone className="mb-1 size-4 text-blue-500" />
            <p className="font-semibold">Pago con Yape por {money(total)}</p>
            <p className="mt-0.5 text-xs text-blue-500">
              Confirma que el cliente haya completado la transferencia antes de procesar.
            </p>
            {yapeQrUrl && qrRoto !== yapeQrUrl && (
              <div className="mt-3 flex flex-col items-center gap-1.5">
                <img
                  src={yapeQrUrl}
                  alt="Código QR de Yape del negocio"
                  className="size-52 max-w-full rounded-xl border border-blue-100 bg-white object-contain p-2"
                  onError={() => setQrRoto(yapeQrUrl)}
                />
                <p className="text-xs text-blue-500">El cliente escanea este código con Yape</p>
              </div>
            )}
          </div>
        )}

        {/* Panel: Fiado */}
        {esFiado && (
          <div className="animate-fade-up space-y-3">
            {nuevoAbierto ? (
              <div className="space-y-3 rounded-xl border border-ink-200 bg-ink-50 p-3.5">
                <p className="text-sm font-semibold text-ink-800">Registrar cliente nuevo</p>
                <label className="block">
                  <span className="label mb-1 block">Nombre *</span>
                  <input
                    className="input"
                    autoFocus
                    maxLength={80}
                    value={nuevo.nombre}
                    onChange={(e) => setNuevo((p) => ({ ...p, nombre: e.target.value }))}
                    placeholder="Ej. Rosa Mendoza"
                  />
                </label>
                <label className="block">
                  <span className="label mb-1 block">Teléfono (opcional)</span>
                  <input
                    className="input"
                    inputMode="tel"
                    maxLength={20}
                    value={nuevo.telefono}
                    onChange={(e) => setNuevo((p) => ({ ...p, telefono: e.target.value }))}
                    placeholder="987 654 321"
                  />
                </label>
                {puedeFijarLimite ? (
                  <label className="block">
                    <span className="label mb-1 block">Límite de crédito (S/)</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      className="input tabular"
                      value={nuevo.limite}
                      onChange={(e) => setNuevo((p) => ({ ...p, limite: e.target.value }))}
                    />
                  </label>
                ) : (
                  <p className="rounded-lg bg-white px-3 py-2 text-xs text-ink-500">
                    Límite de crédito inicial: <b className="text-ink-800">{money(LIMITE_CREDITO_CAJERO)}</b>. Un
                    administrador puede ampliarlo después en Clientes.
                  </p>
                )}
                {(() => {
                  const limite = puedeFijarLimite ? parseFloat(nuevo.limite) : LIMITE_CREDITO_CAJERO
                  return Number.isFinite(limite) && limite < total ? (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Este cobro es de {money(total)} y el límite es {money(limite)}: con ese límite no se podrá
                      apuntar al fiado.
                    </p>
                  ) : null
                })()}
                {errorNuevo && (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{errorNuevo}</p>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" disabled={creando} onClick={() => setNuevoAbierto(false)}>
                    Cancelar
                  </Button>
                  <Button variant="secondary" className="flex-1" loading={creando} onClick={crearCliente}>
                    Guardar y usar
                  </Button>
                </div>
              </div>
            ) : clientes.length === 0 ? (
              <div className="space-y-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                <p>Todavía no hay clientes con fiado registrados.</p>
                {onCrearCliente ? (
                  <Button variant="secondary" size="sm" onClick={abrirNuevo}>
                    <UserPlus className="size-4" /> Registrar cliente ahora
                  </Button>
                ) : (
                  <p>
                    Ve a <strong>Clientes</strong> para registrar uno.
                  </p>
                )}
              </div>
            ) : clienteSeleccionado ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5">
                  <div>
                    <p className="text-sm font-semibold text-ink-800">{clienteSeleccionado.nombre}</p>
                    <p className="text-xs text-ink-400">
                      Deuda: {money(clienteSeleccionado.deuda_actual)} ·{' '}
                      Límite: {money(clienteSeleccionado.limite_credito)}
                    </p>
                  </div>
                  <button
                    onClick={() => setClienteId(null)}
                    className="text-xs text-ink-400 hover:text-red-600"
                  >
                    Cambiar
                  </button>
                </div>
                {superaLimite && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                    <strong>Límite de crédito superado.</strong> Disponible:{' '}
                    {money(creditoDisponible)}, necesario: {money(total)}.
                  </div>
                )}
                {!superaLimite && (
                  <div className="rounded-xl bg-accent-50 px-3.5 py-2.5 text-sm text-accent-700">
                    Disponible: {money(creditoDisponible)} ·{' '}
                    Tras la venta quedará: {money(clienteSeleccionado.deuda_actual + total)}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="label">Seleccionar cliente</p>
                  {onCrearCliente && (
                    <button
                      type="button"
                      onClick={abrirNuevo}
                      className="inline-flex items-center gap-1 rounded-lg bg-accent-50 px-2.5 py-1 text-xs font-semibold text-accent-700 hover:bg-accent-100"
                    >
                      <UserPlus className="size-3.5" /> Cliente nuevo
                    </button>
                  )}
                </div>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-300" />
                  <input
                    className="input pl-9"
                    value={busqCliente}
                    onChange={(e) => setBusqCliente(e.target.value)}
                    placeholder="Buscar por nombre o teléfono..."
                    autoFocus
                  />
                </div>
                <ul className="max-h-48 overflow-y-auto divide-y divide-ink-100 rounded-xl border border-ink-200">
                  {clientesFiltrados.map((c) => {
                    const pct = c.limite_credito > 0 ? (c.deuda_actual / c.limite_credito) * 100 : 0
                    const bloqueado = c.deuda_actual + total > c.limite_credito
                    return (
                      <li key={c.id}>
                        <button
                          disabled={bloqueado}
                          onClick={() => seleccionar(c.id)}
                          className={cx(
                            'flex w-full items-center justify-between px-3.5 py-2.5 text-left transition',
                            bloqueado
                              ? 'cursor-not-allowed opacity-40'
                              : 'hover:bg-ink-50',
                          )}
                        >
                          <div>
                            <p className="text-sm font-semibold text-ink-800">{c.nombre}</p>
                            <p className="text-xs text-ink-400">{c.telefono ?? 'Sin teléfono'}</p>
                          </div>
                          <div className="text-right">
                            <p className="tabular text-xs font-semibold text-ink-700">
                              {money(c.deuda_actual)} / {money(c.limite_credito)}
                            </p>
                            <div className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-ink-100">
                              <div
                                className={cx(
                                  'h-full rounded-full',
                                  pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-400' : 'bg-accent-500',
                                )}
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                          </div>
                        </button>
                      </li>
                    )
                  })}
                  {clientesFiltrados.length === 0 && (
                    <li className="px-3.5 py-4 text-center text-sm text-ink-400">
                      Sin resultados
                      {onCrearCliente && busqCliente.trim().length >= 2 && (
                        <button
                          type="button"
                          onClick={abrirNuevo}
                          className="mt-2 block w-full rounded-lg bg-accent-50 px-3 py-2 text-sm font-semibold text-accent-700 hover:bg-accent-100"
                        >
                          Registrar "{busqCliente.trim()}" como cliente nuevo
                        </button>
                      )}
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}
