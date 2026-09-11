import { useEffect, useMemo, useState } from 'react'
import {
  ShieldAlert,
  ShieldCheck,
  Trophy,
  Download,
  Bell,
  BellOff,
  CheckCheck,
  Filter,
  TrendingDown,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAlertasArqueo } from '@/hooks/useAlertasArqueo'
import { Card, Badge, Button, Spinner } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { money, fechaHora, ymd, cx } from '@/utils/format'
import { descargarCSV } from '@/utils/csv'
import type { CajaRegistro, ResultadoArqueo, Venta } from '@/types/database'

const ETIQUETA_RESULTADO: Record<ResultadoArqueo, string> = {
  ok: 'CONFORME',
  observado: 'OBSERVADO',
  critico: 'ALERTA DE FALTANTE',
}
const TONO_RESULTADO: Record<ResultadoArqueo, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  observado: 'warning',
  critico: 'danger',
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

// Conversión numérica segura — Supabase puede devolver NUMERIC como string
const toNum = (v: unknown): number => Number(v ?? 0)

interface RankingCajero {
  cajero_id: string | null
  cajero_nombre: string
  totalVendido: number
  transacciones: number
}

interface DescuadreCajero {
  cajero_id: string | null
  cajero_nombre: string
  cierres: number
  conformes: number
  observados: number
  criticos: number
  sumaDiferencias: number
  peorFaltante: number
}

export function AuditoriaCajeros() {
  const toast = useToast()
  const { alertas, cargando: cargandoAlertas, marcarLeida, noLeidas } = useAlertasArqueo(100)

  const [desde, setDesde] = useState(ymd(inicioMes()))
  const [hasta, setHasta] = useState(ymd(finHoy()))
  const [ventas, setVentas] = useState<Venta[]>([])
  const [cajasCerradas, setCajasCerradas] = useState<CajaRegistro[]>([])
  const [cargando, setCargando] = useState(true)
  const [marcandoId, setMarcandoId] = useState<string | null>(null)
  const [soloNoLeidas, setSoloNoLeidas] = useState(true)

  useEffect(() => {
    let activo = true
    async function cargar() {
      setCargando(true)
      const desdeIso = new Date(`${desde}T00:00:00`).toISOString()
      const hastaIso = new Date(`${hasta}T23:59:59.999`).toISOString()
      const [{ data: ventasData }, { data: cajasData }] = await Promise.all([
        supabase
          .from('ventas')
          .select('*')
          .eq('anulada', false)
          .gte('creado_en', desdeIso)
          .lte('creado_en', hastaIso),
        supabase
          .from('cajas')
          .select('*')
          .eq('estado', 'cerrada')
          .gte('cerrada_en', desdeIso)
          .lte('cerrada_en', hastaIso),
      ])
      if (!activo) return
      setVentas(ventasData ?? [])
      setCajasCerradas(cajasData ?? [])
      setCargando(false)
    }
    cargar()
    return () => {
      activo = false
    }
  }, [desde, hasta])

  // ── Ranking de cajeros por ventas ($ y N° transacciones) ──────────────────
  const ranking = useMemo<RankingCajero[]>(() => {
    const mapa = new Map<string, RankingCajero>()
    ventas.forEach((v) => {
      const key = v.cajero_id ?? v.cajero_nombre ?? 'sin-asignar'
      const actual = mapa.get(key) ?? {
        cajero_id: v.cajero_id,
        cajero_nombre: v.cajero_nombre ?? 'Sin asignar',
        totalVendido: 0,
        transacciones: 0,
      }
      actual.totalVendido += toNum(v.total)
      actual.transacciones += 1
      mapa.set(key, actual)
    })
    return [...mapa.values()].sort((a, b) => b.totalVendido - a.totalVendido)
  }, [ventas])

  // ── Comparativa de descuadres por cajero (histórico de faltantes/sobrantes) ─
  const descuadres = useMemo<DescuadreCajero[]>(() => {
    const mapa = new Map<string, DescuadreCajero>()
    cajasCerradas.forEach((c) => {
      const key = c.cajero_id ?? c.cajero_nombre ?? 'sin-asignar'
      const actual = mapa.get(key) ?? {
        cajero_id: c.cajero_id,
        cajero_nombre: c.cajero_nombre ?? 'Sin asignar',
        cierres: 0,
        conformes: 0,
        observados: 0,
        criticos: 0,
        sumaDiferencias: 0,
        peorFaltante: 0,
      }
      actual.cierres += 1
      const diferencia = toNum(c.diferencia_arqueo)
      actual.sumaDiferencias += diferencia
      if (diferencia < actual.peorFaltante) actual.peorFaltante = diferencia
      if (c.resultado_arqueo === 'ok') actual.conformes += 1
      else if (c.resultado_arqueo === 'observado') actual.observados += 1
      else if (c.resultado_arqueo === 'critico') actual.criticos += 1
      mapa.set(key, actual)
    })
    return [...mapa.values()].sort(
      (a, b) => b.criticos - a.criticos || a.sumaDiferencias - b.sumaDiferencias,
    )
  }, [cajasCerradas])

  const alertasFiltradas = useMemo(
    () => (soloNoLeidas ? alertas.filter((a) => !a.leida) : alertas),
    [alertas, soloNoLeidas],
  )

  async function marcarLeidaClick(id: string) {
    setMarcandoId(id)
    try {
      await marcarLeida(id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo marcar la alerta como leída')
    } finally {
      setMarcandoId(null)
    }
  }

  function exportarCSV() {
    const filas: (string | number)[][] = [
      ['Reporte de auditoría de cajeros', `${desde} a ${hasta}`],
      [],
      ['Ranking de ventas'],
      ['Cajero', 'Total vendido', 'Transacciones', 'Ticket promedio'],
      ...ranking.map((r) => [
        r.cajero_nombre,
        r.totalVendido.toFixed(2),
        r.transacciones,
        (r.transacciones ? r.totalVendido / r.transacciones : 0).toFixed(2),
      ]),
      [],
      ['Comparativa de descuadres'],
      ['Cajero', 'Cierres', 'Conformes', 'Observados', 'Críticos', 'Suma diferencias', 'Peor faltante'],
      ...descuadres.map((d) => [
        d.cajero_nombre,
        d.cierres,
        d.conformes,
        d.observados,
        d.criticos,
        d.sumaDiferencias.toFixed(2),
        d.peorFaltante.toFixed(2),
      ]),
    ]
    descargarCSV(`auditoria-cajeros_${desde}_a_${hasta}.csv`, filas)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-900">Auditoría de cajeros</h1>
          <p className="text-sm text-ink-400">
            Ranking de ventas, descuadres de arqueo y alertas de caja
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportarCSV}>
          <Download className="size-4" /> Exportar CSV
        </Button>
      </div>

      {/* Filtro de rango de fechas */}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Filter className="mb-2.5 size-4 text-ink-300" />
        <label className="block">
          <span className="label mb-1 block">Desde</span>
          <input
            type="date"
            className="input"
            value={desde}
            max={hasta}
            onChange={(e) => setDesde(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label mb-1 block">Hasta</span>
          <input
            type="date"
            className="input"
            value={hasta}
            min={desde}
            max={ymd(finHoy())}
            onChange={(e) => setHasta(e.target.value)}
          />
        </label>
        {[
          { l: 'Hoy', d: 0 },
          { l: 'Últ. 7 días', d: 7 },
          { l: 'Este mes', d: -1 },
        ].map((r) => (
          <button
            key={r.l}
            className="h-11 rounded-lg border border-ink-200 px-3 text-xs font-semibold text-ink-600 hover:bg-ink-50"
            onClick={() => {
              if (r.d === -1) {
                setDesde(ymd(inicioMes()))
                setHasta(ymd(finHoy()))
                return
              }
              const ini = new Date()
              if (r.d > 0) ini.setDate(ini.getDate() - r.d)
              setDesde(ymd(ini))
              setHasta(ymd(finHoy()))
            }}
          >
            {r.l}
          </button>
        ))}
      </Card>

      {/* Feed de alertas de arqueo */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-4 py-3">
          <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
            <ShieldAlert className="size-[18px]" /> Alertas de arqueo
            {noLeidas.length > 0 && <Badge tone="danger">{noLeidas.length}</Badge>}
          </h2>
          <button
            onClick={() => setSoloNoLeidas((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-ink-100 px-2.5 py-1.5 text-xs font-semibold text-ink-600 hover:bg-ink-200"
          >
            {soloNoLeidas ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
            {soloNoLeidas ? 'Solo no leídas' : 'Ver todas'}
          </button>
        </div>
        {cargandoAlertas ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-ink-400" />
          </div>
        ) : alertasFiltradas.length === 0 ? (
          <div className="grid place-items-center py-10 text-center text-ink-300">
            <ShieldCheck className="mb-2 size-7" />
            <p className="text-sm font-medium text-ink-500">
              {soloNoLeidas ? 'No hay alertas pendientes' : 'Sin alertas registradas'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {alertasFiltradas.map((a) => (
              <li
                key={a.id}
                className={cx(
                  'flex items-start gap-3 px-4 py-3',
                  !a.leida && a.tipo === 'critico' && 'bg-red-50/60',
                )}
              >
                <div
                  className={cx(
                    'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg',
                    a.tipo === 'critico' ? 'bg-red-100' : 'bg-amber-100',
                  )}
                >
                  <ShieldAlert
                    className={cx('size-4', a.tipo === 'critico' ? 'text-red-600' : 'text-amber-600')}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900">{a.mensaje}</p>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {fechaHora(a.creado_en)} · {a.cajero_nombre ?? 'Cajero'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={a.tipo === 'critico' ? 'danger' : 'warning'}>
                    {a.tipo === 'critico' ? 'Crítica' : 'Moderada'}
                  </Badge>
                  {!a.leida && (
                    <button
                      title="Marcar como leída"
                      disabled={marcandoId === a.id}
                      onClick={() => marcarLeidaClick(a.id)}
                      className="grid size-7 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-800 disabled:opacity-40"
                    >
                      <CheckCheck className="size-4" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Ranking de cajeros por ventas */}
        <Card className="overflow-hidden">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
              <Trophy className="size-[18px]" /> Ranking por ventas
            </h2>
          </div>
          {cargando ? (
            <div className="grid place-items-center py-10">
              <Spinner className="size-5 text-ink-400" />
            </div>
          ) : ranking.length === 0 ? (
            <div className="grid place-items-center py-10 text-center text-ink-300">
              <p className="text-sm font-medium">Sin ventas en el período</p>
            </div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {ranking.map((r, i) => (
                <li key={r.cajero_id ?? r.cajero_nombre} className="flex items-center gap-3 px-4 py-3">
                  <span
                    className={cx(
                      'grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                      i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-ink-100 text-ink-500',
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900">{r.cajero_nombre}</p>
                    <p className="text-xs text-ink-400">
                      {r.transacciones} venta{r.transacciones === 1 ? '' : 's'} · ticket prom.{' '}
                      {money(r.transacciones ? r.totalVendido / r.transacciones : 0)}
                    </p>
                  </div>
                  <span className="tabular shrink-0 font-display text-sm font-bold text-ink-900">
                    {money(r.totalVendido)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Comparativa de descuadres por cajero */}
        <Card className="overflow-hidden">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
              <TrendingDown className="size-[18px]" /> Descuadres por cajero
            </h2>
          </div>
          {cargando ? (
            <div className="grid place-items-center py-10">
              <Spinner className="size-5 text-ink-400" />
            </div>
          ) : descuadres.length === 0 ? (
            <div className="grid place-items-center py-10 text-center text-ink-300">
              <p className="text-sm font-medium">Sin cierres de caja en el período</p>
            </div>
          ) : (
            <ul className="divide-y divide-ink-100">
              {descuadres.map((d) => (
                <li key={d.cajero_id ?? d.cajero_nombre} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-ink-900">{d.cajero_nombre}</p>
                    <span className="tabular text-sm font-bold text-ink-900">
                      {d.sumaDiferencias >= 0 ? '+' : ''}
                      {money(d.sumaDiferencias)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge tone={TONO_RESULTADO.ok}>{d.conformes} {ETIQUETA_RESULTADO.ok}</Badge>
                    {d.observados > 0 && (
                      <Badge tone={TONO_RESULTADO.observado}>{d.observados} {ETIQUETA_RESULTADO.observado}</Badge>
                    )}
                    {d.criticos > 0 && (
                      <Badge tone={TONO_RESULTADO.critico}>{d.criticos} {ETIQUETA_RESULTADO.critico}</Badge>
                    )}
                    <span className="text-ink-400">
                      · {d.cierres} cierre{d.cierres === 1 ? '' : 's'}
                      {d.peorFaltante < 0 && ` · peor faltante ${money(d.peorFaltante)}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
