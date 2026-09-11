import { useEffect, useState } from 'react'
import { Printer, Bluetooth, CheckCircle2, AlertTriangle, Info, Users, ShieldCheck, ShieldAlert } from 'lucide-react'
import { Card, Button, Badge, Spinner } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { BRAND } from '@/config/brand'
import { cx, money } from '@/utils/format'
import { construirTicketEscPos } from '@/utils/escpos'
import { bluetoothDisponible, imprimirPorBluetooth } from '@/utils/bluetoothPrinter'
import { useConfiguracionCaja } from '@/hooks/useConfiguracionCaja'
import type { Perfil, Rol } from '@/types/database'

const ETIQUETA_ROL: Record<Rol, string> = {
  administrador: 'Administrador',
  supervisor: 'Supervisor',
  cajero: 'Cajero',
}

function GestionUsuarios() {
  const { perfil: perfilPropio } = useAuth()
  const toast = useToast()
  const [usuarios, setUsuarios] = useState<Perfil[]>([])
  const [cargando, setCargando] = useState(true)
  const [actualizandoId, setActualizandoId] = useState<string | null>(null)

  async function cargar() {
    setCargando(true)
    const { data, error } = await supabase.from('perfiles').select('*').order('nombre')
    if (error) toast.error('No se pudo cargar la lista de usuarios')
    setUsuarios(data ?? [])
    setCargando(false)
  }

  useEffect(() => {
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function cambiarRol(u: Perfil, rol: Rol) {
    setActualizandoId(u.id)
    try {
      const { error } = await supabase.from('perfiles').update({ rol }).eq('id', u.id)
      if (error) throw error
      setUsuarios((prev) => prev.map((x) => (x.id === u.id ? { ...x, rol } : x)))
      toast.exito(`${u.nombre} ahora es ${ETIQUETA_ROL[rol]}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cambiar el rol')
    } finally {
      setActualizandoId(null)
    }
  }

  async function alternarActivo(u: Perfil) {
    setActualizandoId(u.id)
    try {
      const { error } = await supabase
        .from('perfiles')
        .update({ activo: !u.activo })
        .eq('id', u.id)
      if (error) throw error
      setUsuarios((prev) => prev.map((x) => (x.id === u.id ? { ...x, activo: !u.activo } : x)))
      toast.exito(u.activo ? `${u.nombre} desactivado` : `${u.nombre} reactivado`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo actualizar')
    } finally {
      setActualizandoId(null)
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
          <Users className="size-[18px]" /> Usuarios y roles
        </h2>
        <p className="mt-0.5 text-sm text-ink-400">
          Administrador: acceso total. Supervisor: puede ver reportes (Rentabilidad, Compras,
          Mermas, Clientes, Proveedores, Resumen) pero no crear, editar ni eliminar nada. Cajero:
          solo Punto de venta, Inventario, Ventas y Caja.
        </p>
      </div>
      {cargando ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-ink-400" />
        </div>
      ) : (
        <ul className="divide-y divide-ink-100">
          {usuarios.map((u) => {
            const esUnoMismo = u.id === perfilPropio?.id
            return (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
                    {u.nombre}
                    {esUnoMismo && <ShieldCheck className="size-3.5 text-accent-500" />}
                    {!u.activo && <Badge tone="danger">Inactivo</Badge>}
                  </p>
                  <p className="text-xs text-ink-400">{ETIQUETA_ROL[u.rol]}</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className="input py-1.5 text-xs disabled:opacity-40"
                    value={u.rol}
                    disabled={esUnoMismo || actualizandoId === u.id}
                    title={esUnoMismo ? 'No puedes cambiar tu propio rol' : undefined}
                    onChange={(e) => cambiarRol(u, e.target.value as Rol)}
                  >
                    <option value="cajero">Cajero</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="administrador">Administrador</option>
                  </select>
                  <button
                    disabled={esUnoMismo || actualizandoId === u.id}
                    title={esUnoMismo ? 'No puedes desactivar tu propia cuenta' : undefined}
                    onClick={() => alternarActivo(u)}
                    className={cx(
                      'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-40',
                      u.activo
                        ? 'bg-red-50 text-red-600 hover:bg-red-100'
                        : 'bg-accent-50 text-accent-700 hover:bg-accent-100',
                    )}
                  >
                    {u.activo ? 'Desactivar' : 'Reactivar'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

// Politicas de tolerancia del arqueo a ciegas — ver RPC cerrar_caja_arqueo en
// supabase/schema.sql. El cajero nunca ve estos umbrales (romperia el
// proposito del arqueo a ciegas); solo el administrador los edita aqui.
function PoliticasTolerancia() {
  const { perfil } = useAuth()
  const toast = useToast()
  const { config, cargando, guardando, guardar } = useConfiguracionCaja()
  const [tolerancia, setTolerancia] = useState('')
  const [critica, setCritica] = useState('')
  const [editado, setEditado] = useState(false)

  useEffect(() => {
    if (editado) return
    setTolerancia(String(config.umbral_tolerancia_faltante))
    setCritica(String(config.umbral_alerta_critica))
  }, [config, editado])

  async function guardarCambios() {
    const t = parseFloat(tolerancia)
    const c = parseFloat(critica)
    if (isNaN(t) || t < 0 || isNaN(c) || c < 0) {
      toast.error('Ingresa montos válidos mayores o iguales a 0.')
      return
    }
    if (c <= t) {
      toast.error('El umbral de alerta crítica debe ser mayor que el umbral de tolerancia.')
      return
    }
    try {
      await guardar(t, c, perfil?.id ?? null)
      setEditado(false)
      toast.exito('Políticas de tolerancia actualizadas')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar la configuración')
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
          <ShieldAlert className="size-[18px]" /> Políticas de tolerancia de caja
        </h2>
        <p className="mt-0.5 text-sm text-ink-400">
          Umbrales que evalúa el arqueo a ciegas al cerrar cada turno (ver módulo Caja). Se aplican
          siempre en el servidor — nunca se muestran al cajero antes de que declare su conteo.
        </p>
      </div>
      {cargando ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-ink-400" />
        </div>
      ) : (
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label mb-1.5 block">Tolerancia de faltante/sobrante (S/)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                className="input tabular"
                value={tolerancia}
                onChange={(e) => { setTolerancia(e.target.value); setEditado(true) }}
              />
              <p className="mt-1 text-xs text-ink-400">
                Diferencia dentro de este rango se considera cuadrado ("CONFORME").
              </p>
            </label>
            <label className="block">
              <span className="label mb-1.5 block">Umbral de alerta crítica (S/)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                className="input tabular"
                value={critica}
                onChange={(e) => { setCritica(e.target.value); setEditado(true) }}
              />
              <p className="mt-1 text-xs text-ink-400">
                Faltante por encima de este monto genera una alerta crítica de auditoría.
              </p>
            </label>
          </div>
          <div className="rounded-xl bg-ink-50 p-4 text-xs text-ink-500">
            <p>
              Con los valores actuales: un cierre queda <b>CONFORME</b> si la diferencia está entre
              -{money(parseFloat(tolerancia) || 0)} y +{money(parseFloat(tolerancia) || 0)};{' '}
              <b>OBSERVADO</b> fuera de ese rango; y <b>ALERTA DE FALTANTE</b> si el faltante supera
              {' '}{money(parseFloat(critica) || 0)}.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            {config.actualizado_en && (
              <p className="text-xs text-ink-400">
                Última actualización: {new Date(config.actualizado_en).toLocaleString('es-PE')}
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              disabled={!editado}
              loading={guardando}
              onClick={guardarCambios}
            >
              Guardar cambios
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

// Ticket de prueba compartido por "Imprimir por cable" y "Probar Bluetooth":
// mismos datos, para que ambas vias se puedan comparar en igualdad de
// condiciones.
const VENTA_PRUEBA = {
  numero: 0,
  creadoEn: new Date().toISOString(),
  cajeroNombre: 'Prueba',
  subtotal: 34.32,
  descuento: 0,
  igv: 6.18,
  total: 40.5,
  metodo: 'efectivo',
  pagoRecibido: 40.5,
  vuelto: 0,
}
const LINEAS_PRUEBA = [
  { cantidadTexto: '1x', nombre: 'Producto A', montoTexto: 'S/ 10.00' },
  { cantidadTexto: '1x', nombre: 'Producto B', montoTexto: 'S/ 25.50' },
  { cantidadTexto: '1x', nombre: 'Producto C', montoTexto: 'S/ 5.00' },
]

export function Configuracion() {
  const toast = useToast()
  const [estadoImpresion, setEstadoImpresion] = useState<'idle' | 'ok' | 'error'>('idle')
  const [probandoBt, setProbandoBt] = useState(false)

  async function probarImpresionBluetooth() {
    if (!bluetoothDisponible()) {
      toast.error(
        'Este navegador no soporta impresión Bluetooth. Usa Chrome/Edge en Android, Windows o Mac (Safari/iPhone no lo soportan).',
      )
      return
    }
    setProbandoBt(true)
    try {
      await imprimirPorBluetooth(construirTicketEscPos(VENTA_PRUEBA, LINEAS_PRUEBA))
      toast.exito('Ticket de prueba enviado a la impresora Bluetooth')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo imprimir por Bluetooth')
    } finally {
      setProbandoBt(false)
    }
  }

  function probarImpresion() {
    const w = window.open('', '_blank', 'width=380,height=520,menubar=no,toolbar=no')
    if (!w) {
      setEstadoImpresion('error')
      return
    }

    const ahora = new Date().toLocaleString('es-PE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })

    w.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <title>Prueba de Impresión</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Courier New',Courier,monospace; font-size:12px; width:80mm; padding:4mm; }
    .center { text-align:center; }
    .bold { font-weight:bold; }
    .line { border-top:1px dashed #000; margin:4px 0; }
    .row { display:flex; justify-content:space-between; }
    @media print { body { width:80mm; } }
  </style>
</head>
<body>
  <div class="center bold" style="font-size:14px;margin-bottom:4px;">${BRAND.nombre.toUpperCase()}</div>
  <div class="center" style="font-size:10px;margin-bottom:8px;">Sistema de Gestión Comercial</div>
  <div class="line"></div>
  <div class="center bold" style="margin:6px 0;">*** TICKET DE PRUEBA ***</div>
  <div class="line"></div>
  <div style="margin:6px 0;">
    <div class="row"><span>Fecha/Hora:</span><span>${ahora}</span></div>
    <div class="row"><span>Sistema:</span><span>${BRAND.nombre}</span></div>
    <div class="row"><span>Estado:</span><span>Operativo</span></div>
  </div>
  <div class="line"></div>
  <div style="margin:6px 0;">
    <div class="row"><span>Producto A</span><span>S/ 10.00</span></div>
    <div class="row"><span>Producto B</span><span>S/ 25.50</span></div>
    <div class="row"><span>Producto C</span><span>S/ 5.00</span></div>
  </div>
  <div class="line"></div>
  <div class="row bold" style="margin:4px 0;font-size:13px;">
    <span>TOTAL</span><span>S/ 40.50</span>
  </div>
  <div class="line"></div>
  <div class="center" style="margin-top:8px;font-size:10px;">Si ves este ticket, la impresora</div>
  <div class="center" style="font-size:10px;">esta configurada correctamente.</div>
  <div class="center bold" style="margin-top:6px;">¡Gracias por su compra!</div>
</body>
</html>`)
    w.document.close()
    w.focus()
    setTimeout(() => {
      w.print()
      setEstadoImpresion('ok')
    }, 400)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Configuración</h1>
        <p className="text-sm text-ink-400">Ajustes del sistema y herramientas de diagnóstico</p>
      </div>

      {/* Sección: Usuarios y roles */}
      <GestionUsuarios />

      {/* Sección: Políticas de tolerancia del arqueo de caja */}
      <PoliticasTolerancia />

      {/* Sección: Impresora */}
      <Card className="overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4">
          <h2 className="font-display font-bold text-ink-900">Impresora de tickets</h2>
          <p className="mt-0.5 text-sm text-ink-400">
            Prueba la conexión con tu impresora térmica o Bluetooth
          </p>
        </div>
        <div className="space-y-4 p-5">
          <div className="flex items-start gap-3 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              "Imprimir por cable" abre una ventana con un ticket de prueba y lanza el diálogo de
              impresión del navegador (sirve para impresoras USB, de red, o Bluetooth ya instaladas
              como impresora del sistema). Asegúrate de que los popups estén habilitados para este sitio.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={probarImpresion}>
              <Printer className="size-4" /> Imprimir por cable
            </Button>
            <Button variant="secondary" onClick={probarImpresionBluetooth} loading={probandoBt}>
              <Bluetooth className="size-4" /> Probar Bluetooth
            </Button>
            {estadoImpresion === 'ok' && (
              <span className="flex items-center gap-1.5 text-sm font-medium text-accent-700">
                <CheckCircle2 className="size-4" /> Ventana abierta correctamente
              </span>
            )}
            {estadoImpresion === 'error' && (
              <span className="flex items-center gap-1.5 text-sm font-medium text-red-600">
                <AlertTriangle className="size-4" /> Popup bloqueado — habilita los popups
              </span>
            )}
          </div>

          <div className="rounded-xl bg-ink-50 p-4 text-sm text-ink-600">
            <p className="mb-2 font-semibold text-ink-800">Bluetooth directo (recomendado en tablet/celular):</p>
            <ol className="list-decimal list-inside space-y-1 text-ink-500">
              <li>Enciende la impresora térmica y activa su modo Bluetooth</li>
              <li>Toca <strong>"Probar Bluetooth"</strong> (o el botón Bluetooth al imprimir un ticket)</li>
              <li>Elige la impresora en la lista que muestra el navegador — no hace falta instalar ningún driver</li>
              <li>Disponible solo en <strong>Chrome o Edge</strong> (Android, Windows o Mac); Safari/iPhone no lo soportan</li>
            </ol>
          </div>

          <div className="rounded-xl bg-ink-50 p-4 text-sm text-ink-600">
            <p className="mb-2 font-semibold text-ink-800">Para impresoras Bluetooth instaladas como impresora del sistema:</p>
            <ol className="list-decimal list-inside space-y-1 text-ink-500">
              <li>Vincula la impresora al dispositivo desde Configuración → Bluetooth</li>
              <li>Instala el driver o app de la impresora si es necesario</li>
              <li>Selecciona la impresora en el diálogo de "Imprimir por cable"</li>
              <li>Ajusta el tamaño de papel a <strong>80 mm</strong> (papel térmico estándar)</li>
            </ol>
          </div>
        </div>
      </Card>

      {/* Sección: Información del sistema */}
      <Card className="overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4">
          <h2 className="font-display font-bold text-ink-900">Información del sistema</h2>
        </div>
        <div className="divide-y divide-ink-50">
          {[
            { k: 'Aplicación', v: `${BRAND.nombre} POS` },
            { k: 'Versión', v: import.meta.env.VITE_APP_VERSION ?? '1.0.0' },
            { k: 'Entorno', v: import.meta.env.MODE === 'production' ? 'Producción' : 'Desarrollo' },
            { k: 'Navegador', v: navigator.userAgent.split(' ').slice(-2).join(' ') },
          ].map(({ k, v }) => (
            <div key={k} className="flex justify-between px-5 py-3 text-sm">
              <span className="text-ink-500">{k}</span>
              <span className="font-medium text-ink-800">{v}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
