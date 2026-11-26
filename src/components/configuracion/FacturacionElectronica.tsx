// Configuracion > Facturacion electronica (solo administrador): activar la
// emision de boletas/facturas via Nubefact y fijar las series. El TOKEN de
// Nubefact NO se ingresa aqui: vive como secreto en Supabase (ver
// supabase/functions/emitir-comprobante).
import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { Card, Button, Badge, Spinner } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { supabase } from '@/lib/supabase'
import { cx } from '@/utils/format'

const SERIE_B = /^B[A-Z0-9]{3}$/
const SERIE_F = /^F[A-Z0-9]{3}$/

function aEntero(texto: string): number | null {
  const t = texto.trim()
  if (t === '') return null
  return /^\d{1,8}$/.test(t) ? Number(t) : NaN
}

export function FacturacionElectronica() {
  const toast = useToast()
  const [cargando, setCargando] = useState(true)
  const [instalado, setInstalado] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [activo, setActivo] = useState(false)
  const [serieB, setSerieB] = useState('BBB1')
  const [serieF, setSerieF] = useState('FFF1')
  const [ultimoB, setUltimoB] = useState('')
  const [ultimoF, setUltimoF] = useState('')
  const [actualB, setActualB] = useState(0)
  const [actualF, setActualF] = useState(0)

  async function cargar() {
    setCargando(true)
    const { data: cfg, error } = await supabase.from('facturacion_config').select('*').eq('id', 1).maybeSingle()
    if (error || !cfg) {
      setInstalado(false)
      setCargando(false)
      return
    }
    setInstalado(true)
    setActivo(cfg.activo)
    setSerieB(cfg.serie_boleta)
    setSerieF(cfg.serie_factura)
    const { data: series } = await supabase
      .from('series_correlativo')
      .select('*')
      .in('serie', [cfg.serie_boleta, cfg.serie_factura])
    const ult = (s: string) => series?.find((x) => x.serie === s)?.ultimo ?? 0
    setActualB(ult(cfg.serie_boleta))
    setActualF(ult(cfg.serie_factura))
    setUltimoB('')
    setUltimoF('')
    setCargando(false)
  }

  useEffect(() => {
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const serieBOk = SERIE_B.test(serieB)
  const serieFOk = SERIE_F.test(serieF)
  const nB = aEntero(ultimoB)
  const nF = aEntero(ultimoF)
  const numerosOk = !Number.isNaN(nB) && !Number.isNaN(nF)

  async function guardar() {
    if (!serieBOk || !serieFOk) {
      toast.error('Las series deben tener 4 caracteres: boleta empieza con B y factura con F (ej. B001, F001).')
      return
    }
    if (!numerosOk) {
      toast.error('El último número usado debe ser un número entero.')
      return
    }
    if (activo) {
      const ok = window.confirm(
        `Se emitirán comprobantes con las series ${serieB} (boleta) y ${serieF} (factura). ` +
          'Verifica que coincidan con "Locales y Series" de Nubefact. ¿Continuar?',
      )
      if (!ok) return
    }
    setGuardando(true)
    const { error } = await supabase.rpc('guardar_config_facturacion', {
      p_activo: activo,
      p_serie_boleta: serieB,
      p_serie_factura: serieF,
      p_ultimo_boleta: nB,
      p_ultimo_factura: nF,
    })
    setGuardando(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.exito('Facturación electrónica actualizada')
    cargar()
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
          <FileText className="size-[18px]" /> Facturación electrónica (Nubefact)
        </h2>
        <p className="mt-0.5 text-sm text-ink-400">
          Boletas y facturas enviadas a SUNAT. La RUTA y el TOKEN se guardan como secretos en Supabase, no aquí.
        </p>
      </div>
      {cargando ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-ink-400" />
        </div>
      ) : !instalado ? (
        <p className="p-5 text-sm text-amber-700">
          Falta actualizar la base de datos: ejecuta <strong>supabase/facturacion_electronica.sql</strong> en Supabase
          (SQL Editor) y recarga esta página.
        </p>
      ) : (
        <div className="space-y-4 p-5">
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-ink-800">Emitir boletas y facturas</span>
            <input
              type="checkbox"
              className="size-5 accent-emerald-600"
              checked={activo}
              onChange={(e) => setActivo(e.target.checked)}
            />
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              { t: 'Boleta', serie: serieB, set: setSerieB, ok: serieBOk, ult: ultimoB, setUlt: setUltimoB, actual: actualB },
              { t: 'Factura', serie: serieF, set: setSerieF, ok: serieFOk, ult: ultimoF, setUlt: setUltimoF, actual: actualF },
            ].map((x) => (
              <div key={x.t} className="space-y-2 rounded-xl bg-ink-50 p-3">
                <p className="flex items-center justify-between text-sm font-semibold text-ink-800">
                  {x.t} <Badge tone="neutral">último: {x.actual}</Badge>
                </p>
                <label className="block">
                  <span className="label mb-1 block">Serie</span>
                  <input
                    className={cx('input uppercase tabular', !x.ok && 'border-red-300')}
                    maxLength={4}
                    value={x.serie}
                    onChange={(e) => x.set(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  />
                </label>
                <label className="block">
                  <span className="label mb-1 block">Último número ya usado (opcional)</span>
                  <input
                    className="input tabular"
                    inputMode="numeric"
                    maxLength={8}
                    placeholder={`Dejar vacío = ${x.actual}`}
                    value={x.ult}
                    onChange={(e) => x.setUlt(e.target.value.replace(/\D/g, ''))}
                  />
                </label>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-400">
            Solo llena "último número ya usado" si emitiste comprobantes con esa serie fuera de este sistema (por ejemplo
            desde la web de Nubefact). En modo DEMO, Nubefact suele usar las series BBB1 y FFF1.
          </p>

          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              loading={guardando}
              disabled={!serieBOk || !serieFOk || !numerosOk}
              onClick={guardar}
            >
              Guardar
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
