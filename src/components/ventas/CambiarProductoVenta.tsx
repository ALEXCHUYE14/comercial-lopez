import { useEffect, useMemo, useState } from 'react'
import { Plus, Repeat, Search, Trash2 } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { supabase } from '@/lib/supabase'
import { money, cantidad as formatoCantidad, ETIQUETA_PAGO } from '@/utils/format'
import { armarPagoMixto, pagosDe, redondear2 } from '@/utils/pagos'
import { opcionesVenta, precioModalidad } from '@/utils/presentaciones'
import {
  claveLinea,
  lineasDesdeDetalle,
  requiereEntero,
  textoDiferencia,
  totalesEdicion,
  validarEdicion,
  type LineaEdicion,
} from '@/utils/cambioVenta'
import type { DetalleVenta, Producto, Venta } from '@/types/database'

interface Props {
  venta: Venta
  detalle: DetalleVenta[]
  onClose: () => void
  /** Se llama tras guardar con exito (el padre recarga la lista). */
  onGuardada: () => void
}

/** Corrige una venta YA registrada: cambia el producto (o la presentación / la
 * cantidad) de sus líneas sin anularla ni crear otro comprobante. El servidor
 * (RPC modificar_venta) devuelve el stock anterior, aplica el nuevo, recalcula
 * el total y ajusta la caja o la deuda por la diferencia, todo en una sola
 * transacción. Esta pantalla solo arma y valida el cambio. */
export function CambiarProductoVenta({ venta, detalle, onClose, onGuardada }: Props) {
  const toast = useToast()
  const [productos, setProductos] = useState<Producto[] | null>(null)
  const [lineas, setLineas] = useState<LineaEdicion[]>([])
  const [eligiendo, setEligiendo] = useState<string | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [motivo, setMotivo] = useState('')
  const [guardando, setGuardando] = useState(false)

  const esMixto = venta.metodo === 'mixto'
  const efectivoAnterior = useMemo(
    () => pagosDe(venta).find((p) => p.metodo === 'efectivo')?.monto ?? 0,
    [venta],
  )
  const [efectivoMixto, setEfectivoMixto] = useState(String(efectivoAnterior || ''))

  // Productos frescos al abrir (stock y precios de este momento). Se carga una
  // sola vez, sin suscripcion en tiempo real: el servidor valida de todas formas.
  useEffect(() => {
    let vigente = true
    supabase
      .from('productos')
      .select('*')
      .eq('activo', true)
      .order('nombre')
      .then(({ data, error }) => {
        if (!vigente) return
        if (error || !data) {
          toast.error('No se pudieron cargar los productos.')
          onClose()
          return
        }
        setProductos(data)
        setLineas(lineasDesdeDetalle(detalle, data))
      })
    return () => {
      vigente = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const descuento = Number(venta.descuento ?? 0)
  const totalAnterior = Number(venta.total)
  const tot = useMemo(() => totalesEdicion(lineas, descuento), [lineas, descuento])
  const delta = redondear2(tot.total - totalAnterior)
  const validacion = useMemo(() => validarEdicion(lineas, detalle, descuento), [lineas, detalle, descuento])

  // ¿Hay algo distinto a lo ya guardado? (si no, no tiene sentido guardar)
  const hayCambios = useMemo(() => {
    const firma = (xs: { id: string | null; mod: string; cant: number }[]) =>
      JSON.stringify(xs.map((x) => `${x.id}|${x.mod}|${x.cant}`).sort())
    return (
      firma(detalle.map((d) => ({ id: d.producto_id, mod: String(d.modalidad), cant: Number(d.cantidad) }))) !==
      firma(lineas.map((l) => ({ id: l.producto?.id ?? null, mod: String(l.modalidad), cant: parseFloat(l.cantidad) })))
    )
  }, [detalle, lineas])

  // Pago mixto con cambio de total: hay que decir como se reparte el nuevo total.
  const necesitaReparto = esMixto && delta !== 0
  const mixto = useMemo(
    () => (necesitaReparto ? armarPagoMixto(tot.total, parseFloat(efectivoMixto)) : null),
    [necesitaReparto, tot.total, efectivoMixto],
  )

  const puedeGuardar = validacion.ok && hayCambios && (!necesitaReparto || (mixto?.ok ?? false)) && !guardando

  const coincidencias = useMemo(() => {
    if (!productos) return []
    const q = busqueda.trim().toLowerCase()
    const lista = q
      ? productos.filter((p) => p.nombre.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      : productos
    return lista.slice(0, 40)
  }, [productos, busqueda])

  function cambiarLinea(clave: string, cambios: Partial<LineaEdicion>) {
    setLineas((prev) => prev.map((l) => (l.clave === clave ? { ...l, ...cambios } : l)))
  }

  function agregarLinea() {
    const clave = claveLinea()
    setLineas((prev) => [...prev, { clave, producto: null, modalidad: 'unidad', cantidad: '1' }])
    setBusqueda('')
    setEligiendo(clave)
  }

  function elegirProducto(clave: string, p: Producto) {
    cambiarLinea(clave, { producto: p, modalidad: 'unidad', cantidad: '1' })
    setEligiendo(null)
    setBusqueda('')
  }

  async function guardar() {
    if (!validacion.ok) return
    const ok = window.confirm(
      `Guardar el cambio en el comprobante #${venta.numero}?\nTotal ${money(totalAnterior)} → ${money(tot.total)}. ${textoDiferencia(venta.metodo, delta, money)}`,
    )
    if (!ok) return
    setGuardando(true)
    const { error } = await supabase.rpc('modificar_venta', {
      p_venta_id: venta.id,
      p_items: validacion.items,
      // Solo en pago mixto con cambio de total (ver el RPC): en el resto el
      // servidor lo rechazaria por no aplicar.
      ...(necesitaReparto && mixto?.ok ? { p_pagos: mixto.pagos } : {}),
      p_motivo: motivo.trim() || null,
    })
    setGuardando(false)
    if (error) {
      toast.error(error.message || 'No se pudo guardar el cambio')
      return
    }
    toast.exito(`Comprobante #${venta.numero} corregido`)
    onGuardada()
  }

  return (
    <Sheet
      open
      onClose={() => !guardando && onClose()}
      title={`Cambiar productos · #${venta.numero}`}
      maxWidth="max-w-lg"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" disabled={guardando} onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="secondary" className="flex-1" loading={guardando} disabled={!puedeGuardar} onClick={guardar}>
            Guardar cambio
          </Button>
        </div>
      }
    >
      {!productos ? (
        <p className="py-10 text-center text-sm text-ink-400">Cargando productos...</p>
      ) : (
        <div className="space-y-4">
          <p className="rounded-xl bg-ink-50 px-3.5 py-2.5 text-xs text-ink-500">
            Se corrige <b>esta misma venta</b>: no se anula ni se crea un comprobante nuevo. El stock y
            {venta.metodo === 'fiado' ? ' la deuda del cliente' : ' la caja'} se ajustan solos por la diferencia.
          </p>

          <ul className="space-y-2.5">
            {lineas.map((l, i) => {
              const opts = l.producto ? opcionesVenta(l.producto) : []
              const c = parseFloat(l.cantidad)
              const sub =
                l.producto && Number.isFinite(c) && c > 0 ? redondear2(precioModalidad(l.producto, l.modalidad) * c) : 0
              const modalidadListada = opts.some((o) => o.modalidad === l.modalidad)
              return (
                <li key={l.clave} className="rounded-xl border border-ink-100 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-ink-400">Línea {i + 1}</p>
                      <p className="truncate text-sm font-semibold text-ink-800">
                        {l.producto ? l.producto.nombre : 'Elige un producto'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setBusqueda('')
                          setEligiendo(eligiendo === l.clave ? null : l.clave)
                        }}
                      >
                        <Repeat className="size-3.5" /> {l.producto ? 'Cambiar' : 'Elegir'}
                      </Button>
                      <button
                        type="button"
                        disabled={lineas.length === 1}
                        onClick={() => setLineas((prev) => prev.filter((x) => x.clave !== l.clave))}
                        className="grid size-8 place-items-center rounded-lg text-ink-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                        aria-label={`Quitar línea ${i + 1}`}
                        title={lineas.length === 1 ? 'La venta necesita al menos un producto' : 'Quitar esta línea'}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>

                  {eligiendo === l.clave && (
                    <div className="mt-2.5 rounded-lg bg-ink-50 p-2.5">
                      <div className="relative mb-2">
                        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-300" />
                        <input
                          className="input pl-9"
                          autoFocus
                          value={busqueda}
                          onChange={(e) => setBusqueda(e.target.value)}
                          placeholder="Buscar por nombre o código..."
                        />
                      </div>
                      <ul className="max-h-52 divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-100 bg-white">
                        {coincidencias.map((p) => (
                          <li key={p.id}>
                            <button
                              type="button"
                              onClick={() => elegirProducto(l.clave, p)}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-ink-50"
                            >
                              <span className="min-w-0 truncate text-sm text-ink-800">{p.nombre}</span>
                              <span className="tabular shrink-0 text-xs text-ink-500">
                                {money(p.precio_venta)} · stock {formatoCantidad(p.stock_actual)}
                              </span>
                            </button>
                          </li>
                        ))}
                        {coincidencias.length === 0 && (
                          <li className="px-3 py-4 text-center text-sm text-ink-400">Sin resultados</li>
                        )}
                      </ul>
                    </div>
                  )}

                  {l.producto && (
                    <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                      <label className="block">
                        <span className="label mb-1 block">Presentación</span>
                        <select
                          className="input"
                          value={l.modalidad}
                          onChange={(e) => cambiarLinea(l.clave, { modalidad: e.target.value })}
                        >
                          {opts.map((o) => (
                            <option key={o.modalidad} value={o.modalidad}>
                              {o.etiqueta} · {money(o.precio)}
                            </option>
                          ))}
                          {!modalidadListada && <option value={l.modalidad}>{String(l.modalidad)} (no disponible)</option>}
                        </select>
                      </label>
                      <label className="block">
                        <span className="label mb-1 block">Cantidad</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={requiereEntero(l.producto, l.modalidad) ? 1 : 0.001}
                          className="input tabular"
                          value={l.cantidad}
                          onChange={(e) => cambiarLinea(l.clave, { cantidad: e.target.value })}
                        />
                      </label>
                    </div>
                  )}
                  {l.producto && (
                    <p className="tabular mt-2 text-right text-xs text-ink-500">
                      Subtotal de la línea: <b className="text-ink-800">{money(sub)}</b>
                    </p>
                  )}
                </li>
              )
            })}
          </ul>

          <Button variant="outline" className="w-full" onClick={agregarLinea}>
            <Plus className="size-4" /> Agregar otro producto
          </Button>

          {!validacion.ok && (
            <p className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-600">{validacion.error}</p>
          )}

          {/* Resumen: total anterior, nuevo y lo que implica la diferencia */}
          <div className="space-y-1.5 rounded-xl bg-ink-900 px-4 py-3.5 text-sm text-white">
            <div className="flex justify-between text-white/60">
              <span>Total anterior ({ETIQUETA_PAGO[venta.metodo] ?? venta.metodo})</span>
              <span className="tabular">{money(totalAnterior)}</span>
            </div>
            {descuento > 0 && (
              <div className="flex justify-between text-white/60">
                <span>Descuento de la venta</span>
                <span className="tabular">- {money(tot.descuento)}</span>
              </div>
            )}
            <div className="flex justify-between font-display text-lg font-bold">
              <span>Total nuevo</span>
              <span className="tabular">{money(tot.total)}</span>
            </div>
            <p className="border-t border-white/15 pt-2 text-xs font-semibold text-amber-300">
              {textoDiferencia(venta.metodo, delta, money)}
              {delta !== 0 && ' (' + (delta > 0 ? '+' : '-') + money(Math.abs(delta)) + ')'}
            </p>
          </div>

          {necesitaReparto && (
            <div className="space-y-2 rounded-xl border border-ink-100 p-3">
              <p className="text-sm font-semibold text-ink-800">¿Cómo se paga ahora el nuevo total?</p>
              <label className="block">
                <span className="label mb-1 block">Parte en efectivo (S/)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  className="input tabular"
                  value={efectivoMixto}
                  onChange={(e) => setEfectivoMixto(e.target.value)}
                  placeholder="0.00"
                />
              </label>
              {mixto?.ok ? (
                <p className="text-sm text-ink-600">
                  Efectivo <b>{money(mixto.efectivo)}</b> + Yape <b>{money(mixto.yape)}</b> (el resto)
                </p>
              ) : (
                <p className="text-sm text-red-600">{mixto?.error}</p>
              )}
            </div>
          )}

          <label className="block">
            <span className="label mb-1 block">Motivo del cambio (opcional)</span>
            <input
              className="input"
              value={motivo}
              maxLength={200}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Ej. El cliente prefirió otra marca"
            />
          </label>

          {!hayCambios && validacion.ok && (
            <p className="text-center text-xs text-ink-400">Todavía no hay cambios que guardar.</p>
          )}
        </div>
      )}
    </Sheet>
  )
}
