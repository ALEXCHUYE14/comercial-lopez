import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Wallet, ArrowDownCircle, ChevronDown } from 'lucide-react'
import { useEgresos, ETIQUETA_CATEGORIA_EGRESO, ETIQUETA_METODO_EGRESO } from '@/hooks/useEgresos'
import { useProveedores } from '@/hooks/useProveedores'
import { useAuth } from '@/context/AuthContext'
import { Button, Card, Badge } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { money, fechaHora, cx } from '@/utils/format'
import type { CategoriaEgreso, MetodoEgreso } from '@/types/database'

const CATEGORIAS: CategoriaEgreso[] = [
  'proveedor',
  'servicios',
  'alquiler',
  'planilla',
  'transporte',
  'mantenimiento',
  'otro',
]

const METODOS: MetodoEgreso[] = ['efectivo', 'yape', 'transferencia', 'otro']

const TONO_CATEGORIA: Record<CategoriaEgreso, 'danger' | 'warning' | 'info' | 'success' | 'neutral'> = {
  proveedor: 'info',
  servicios: 'warning',
  alquiler: 'danger',
  planilla: 'success',
  transporte: 'neutral',
  mantenimiento: 'neutral',
  otro: 'neutral',
}

function inicioMes(): Date {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

function finHoy(): Date {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d
}

export function Egresos() {
  // useRef: estos Date se crean una sola vez — evita el loop infinito que
  // causaria llamar inicioMes()/finHoy() inline en cada render.
  const desdeRef = useRef(inicioMes())
  const hastaRef = useRef(finHoy())
  const { egresos, cargando, registrar, eliminar, totalMes } = useEgresos(desdeRef.current, hastaRef.current)
  const { proveedores } = useProveedores()
  const { esAdmin, perfil, session } = useAuth()
  const toast = useToast()

  const [formOpen, setFormOpen] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [eliminandoId, setEliminandoId] = useState<string | null>(null)
  const [f, setF] = useState({
    concepto: '',
    categoria: 'otro' as CategoriaEgreso,
    monto: '',
    metodo: 'efectivo' as MetodoEgreso,
    proveedor_id: '',
    notas: '',
  })

  function resetForm() {
    setF({ concepto: '', categoria: 'otro', monto: '', metodo: 'efectivo', proveedor_id: '', notas: '' })
  }

  async function guardar() {
    if (!f.concepto.trim()) {
      toast.error('Escribe el concepto del gasto.')
      return
    }
    const monto = parseFloat(f.monto) || 0
    if (monto <= 0) {
      toast.error('El monto debe ser mayor a 0.')
      return
    }
    const proveedor = proveedores.find((p) => p.id === f.proveedor_id) ?? null
    setGuardando(true)
    try {
      await registrar({
        concepto: f.concepto.trim(),
        categoria: f.categoria,
        monto,
        metodo: f.metodo,
        proveedor_id: proveedor?.id ?? null,
        proveedor_nombre: proveedor?.nombre ?? null,
        notas: f.notas.trim() || null,
        usuario_id: session?.user?.id ?? null,
        usuario_nombre: perfil?.nombre ?? null,
      })
      toast.exito('Egreso registrado')
      setFormOpen(false)
      resetForm()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al registrar el egreso')
    } finally {
      setGuardando(false)
    }
  }

  async function eliminarEgreso(id: string, concepto: string) {
    const ok = window.confirm(`Eliminar el egreso "${concepto}"? Esta accion no se puede deshacer.`)
    if (!ok) return
    setEliminandoId(id)
    try {
      await eliminar(id)
      toast.exito('Egreso eliminado')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo eliminar el egreso')
    } finally {
      setEliminandoId(null)
    }
  }

  // Resumen agrupado por categoria, para el mismo mes cargado
  const resumenCategoria = useMemo(() => {
    const mapa = new Map<CategoriaEgreso, number>()
    CATEGORIAS.forEach((c) => mapa.set(c, 0))
    egresos.forEach((e) => {
      mapa.set(e.categoria, (mapa.get(e.categoria) ?? 0) + Number(e.monto))
    })
    return [...mapa.entries()].filter(([, monto]) => monto > 0).sort((a, b) => b[1] - a[1])
  }, [egresos])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Egresos</h1>
          <p className="text-sm text-ink-400">
            Gastos operativos del negocio — mes actual
          </p>
        </div>
        {esAdmin && (
          <Button variant="primary" onClick={() => { resetForm(); setFormOpen(true) }}>
            <Plus className="size-[18px]" />
            <span className="hidden sm:inline">Registrar egreso</span>
          </Button>
        )}
      </div>

      {/* KPIs del mes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
          <div className="mb-2 grid size-8 place-items-center rounded-lg bg-red-100">
            <Wallet className="size-[18px] text-red-600" />
          </div>
          <p className="tabular font-display text-xl font-bold text-red-700">{money(totalMes)}</p>
          <p className="text-xs font-medium text-red-400">Total gastado (mes)</p>
        </div>
        {resumenCategoria.slice(0, 3).map(([categoria, monto]) => (
          <div key={categoria} className="card p-4">
            <div className="mb-2">
              <Badge tone={TONO_CATEGORIA[categoria]}>{ETIQUETA_CATEGORIA_EGRESO[categoria]}</Badge>
            </div>
            <p className="tabular font-display text-xl font-bold text-ink-900">{money(monto)}</p>
          </div>
        ))}
      </div>

      {/* Tabla de egresos */}
      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[1fr_auto_auto_auto_auto] gap-4 border-b border-ink-100 px-4 py-2.5 text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400 lg:grid">
          <span>Concepto</span>
          <span className="w-32 text-center">Categoria</span>
          <span className="w-24 text-center">Metodo</span>
          <span className="w-28 text-right">Monto</span>
          <span className="w-40">Fecha</span>
        </div>

        {cargando ? (
          <SkeletonList />
        ) : egresos.length === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <Wallet className="mb-3 size-8 text-ink-300" />
            <p className="text-sm font-medium text-ink-500">Sin egresos registrados este mes</p>
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {egresos.map((e) => (
              <li
                key={e.id}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3.5 lg:grid-cols-[1fr_auto_auto_auto_auto] lg:gap-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-red-50">
                    <ArrowDownCircle className="size-[18px] text-red-500" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">{e.concepto}</p>
                    {(e.proveedor_nombre || e.notas) && (
                      <p className="truncate text-xs text-ink-400">
                        {e.proveedor_nombre ?? e.notas}
                      </p>
                    )}
                  </div>
                </div>

                <div className="hidden w-32 justify-center lg:flex">
                  <Badge tone={TONO_CATEGORIA[e.categoria]}>{ETIQUETA_CATEGORIA_EGRESO[e.categoria]}</Badge>
                </div>
                <span className="tabular hidden w-24 text-center text-sm font-medium text-ink-600 lg:block">
                  {ETIQUETA_METODO_EGRESO[e.metodo]}
                </span>
                <span className="tabular hidden w-28 text-right text-sm font-bold text-red-700 lg:block">
                  {money(Number(e.monto))}
                </span>
                <div className="hidden w-40 items-center justify-between gap-2 lg:flex">
                  <span className="text-xs text-ink-400">{fechaHora(e.creado_en)}</span>
                  {esAdmin && (
                    <button
                      onClick={() => eliminarEgreso(e.id, e.concepto)}
                      disabled={eliminandoId === e.id}
                      className="text-ink-300 hover:text-red-600 disabled:opacity-40"
                      aria-label="Eliminar egreso"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>

                {/* Movil */}
                <div className="flex flex-col items-end gap-1 text-right lg:hidden">
                  <Badge tone={TONO_CATEGORIA[e.categoria]}>{ETIQUETA_CATEGORIA_EGRESO[e.categoria]}</Badge>
                  <span className="tabular text-sm font-bold text-red-700">{money(Number(e.monto))}</span>
                  {esAdmin && (
                    <button
                      onClick={() => eliminarEgreso(e.id, e.concepto)}
                      disabled={eliminandoId === e.id}
                      className="text-xs text-ink-400 hover:text-red-600 disabled:opacity-40"
                    >
                      Eliminar
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Sheet: registrar egreso */}
      <Sheet
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="Registrar egreso"
        maxWidth="max-w-md"
        footer={
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-red-700">
              {money(parseFloat(f.monto || '0'))}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                Cancelar
              </Button>
              <Button variant="secondary" loading={guardando} onClick={guardar}>
                Registrar
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-3">
          <Campo label="Concepto *">
            <input
              className="input"
              value={f.concepto}
              onChange={(e) => setF((p) => ({ ...p, concepto: e.target.value }))}
              placeholder="Ej. Pago de luz agosto"
              autoFocus
            />
          </Campo>

          <div className="grid grid-cols-2 gap-3">
            <Campo label="Categoria">
              <div className="relative">
                <select
                  className="input appearance-none pr-9"
                  value={f.categoria}
                  onChange={(e) => setF((p) => ({ ...p, categoria: e.target.value as CategoriaEgreso }))}
                >
                  {CATEGORIAS.map((c) => (
                    <option key={c} value={c}>
                      {ETIQUETA_CATEGORIA_EGRESO[c]}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
              </div>
            </Campo>
            <Campo label="Monto (S/)">
              <input
                type="number"
                min={0}
                step={0.01}
                className="input tabular"
                value={f.monto}
                onChange={(e) => setF((p) => ({ ...p, monto: e.target.value }))}
                placeholder="0.00"
              />
            </Campo>
          </div>

          <Campo label="Metodo de pago">
            <div className="relative">
              <select
                className="input appearance-none pr-9"
                value={f.metodo}
                onChange={(e) => setF((p) => ({ ...p, metodo: e.target.value as MetodoEgreso }))}
              >
                {METODOS.map((m) => (
                  <option key={m} value={m}>
                    {ETIQUETA_METODO_EGRESO[m]}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
            </div>
          </Campo>

          {f.categoria === 'proveedor' && (
            <Campo label="Proveedor (opcional)">
              <div className="relative">
                <select
                  className="input appearance-none pr-9"
                  value={f.proveedor_id}
                  onChange={(e) => setF((p) => ({ ...p, proveedor_id: e.target.value }))}
                >
                  <option value="">Sin vincular</option>
                  {proveedores.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
              </div>
            </Campo>
          )}

          <Campo label="Notas (opcional)">
            <input
              className="input"
              value={f.notas}
              onChange={(e) => setF((p) => ({ ...p, notas: e.target.value }))}
              placeholder="Detalle adicional..."
            />
          </Campo>
        </div>
      </Sheet>
    </div>
  )
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}

function SkeletonList() {
  return (
    <ul className="divide-y divide-ink-100">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i} className={cx('flex items-center gap-3 px-4 py-3.5')}>
          <div className="size-9 animate-pulse rounded-xl bg-ink-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-48 animate-pulse rounded bg-ink-100" />
            <div className="h-3 w-24 animate-pulse rounded bg-ink-100" />
          </div>
        </li>
      ))}
    </ul>
  )
}
