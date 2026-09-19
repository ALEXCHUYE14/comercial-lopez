import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  Printer, Bluetooth, CheckCircle2, AlertTriangle, Info, Users, ShieldCheck, ShieldAlert,
  UserPlus, Eye, EyeOff, Store, QrCode, Upload, Trash2, Image as ImageIcon,
} from 'lucide-react'
import { Card, Button, Badge, Spinner } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { useAuth } from '@/context/AuthContext'
import { supabase } from '@/lib/supabase'
import { useNegocio, documentoValido } from '@/config/negocio'
import { cx, money } from '@/utils/format'
import { construirTicketEscPos } from '@/utils/escpos'
import { construirTicketHtml, imprimirTicketHtml } from '@/utils/ticket'
import { qrParaTicket } from '@/utils/qrTermico'
import {
  bluetoothDisponible,
  imprimirPorBluetooth,
  conectarImpresora,
  desconectarImpresoraBluetooth,
  olvidarImpresoraBluetooth,
  useImpresoraBluetooth,
} from '@/utils/bluetoothPrinter'
import { mensajeErrorFuncion } from '@/utils/errors'
import { useConfiguracionCaja } from '@/hooks/useConfiguracionCaja'
import { useConfiguracionNegocio } from '@/hooks/useConfiguracionNegocio'
import type { Perfil, Rol } from '@/types/database'

const ETIQUETA_ROL: Record<Rol, string> = {
  administrador: 'Administrador',
  supervisor: 'Supervisor',
  cajero: 'Cajero',
}

// Formulario para que un administrador cree la cuenta de un cajero/supervisor
// nuevo (correo + contraseña) sin salir del sistema — antes solo se podia
// crear usuarios manualmente desde el Dashboard de Supabase. La creacion
// real ocurre en la Edge Function "crear-usuario" (ver
// supabase/functions/crear-usuario/index.ts): crear un usuario con contraseña
// arbitraria requiere la service role key, que nunca debe tocar el navegador,
// asi que ese paso vive en el servidor. El perfil (tabla perfiles) de la
// cuenta nueva lo crea el trigger on_auth_user_created ya existente — no se
// duplica esa logica aqui.
function CrearUsuarioSheet({ open, onClose, onCreado }: {
  open: boolean
  onClose: () => void
  onCreado: () => void
}) {
  const toast = useToast()
  const [nombre, setNombre] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [verPass, setVerPass] = useState(false)
  const [rol, setRol] = useState<Rol>('cajero')
  const [creando, setCreando] = useState(false)

  function limpiarYCerrar() {
    setNombre('')
    setEmail('')
    setPassword('')
    setVerPass(false)
    setRol('cajero')
    onClose()
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 6) {
      toast.error('La contraseña debe tener al menos 6 caracteres.')
      return
    }
    setCreando(true)
    try {
      const { error } = await supabase.functions.invoke('crear-usuario', {
        body: { nombre: nombre.trim(), email: email.trim(), password, rol },
      })
      if (error) throw error
      toast.exito(`Cuenta creada para ${nombre.trim()}`)
      onCreado()
      limpiarYCerrar()
    } catch (e) {
      toast.error(await mensajeErrorFuncion(e, 'No se pudo crear el usuario'))
    } finally {
      setCreando(false)
    }
  }

  return (
    <Sheet open={open} onClose={limpiarYCerrar} title="Nuevo usuario" maxWidth="max-w-md">
      <form id="form-crear-usuario" onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="label mb-1.5 block">Nombre completo</span>
          <input
            className="input"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1.5 block">Correo electrónico</span>
          <input
            type="email"
            className="input"
            placeholder="cajero@ejemplo.com"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="label mb-1.5 block">Contraseña</span>
          <div className="relative">
            <input
              type={verPass ? 'text' : 'password'}
              className="input pr-11"
              placeholder="Mínimo 6 caracteres"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
            <button
              type="button"
              onClick={() => setVerPass((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-600"
              aria-label={verPass ? 'Ocultar contraseña' : 'Mostrar contraseña'}
            >
              {verPass ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-400">
            Compártela con el cajero por un medio seguro — no vuelve a mostrarse después de crear la cuenta.
          </p>
        </label>
        <label className="block">
          <span className="label mb-1.5 block">Rol</span>
          <select className="input" value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
            <option value="cajero">Cajero</option>
            <option value="supervisor">Supervisor</option>
            <option value="administrador">Administrador</option>
          </select>
        </label>
      </form>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="secondary" className="flex-1" onClick={limpiarYCerrar}>
          Cancelar
        </Button>
        <Button type="submit" form="form-crear-usuario" className="flex-1" loading={creando}>
          Crear usuario
        </Button>
      </div>
    </Sheet>
  )
}

function GestionUsuarios() {
  const { perfil: perfilPropio } = useAuth()
  const toast = useToast()
  const [usuarios, setUsuarios] = useState<Perfil[]>([])
  const [cargando, setCargando] = useState(true)
  const [actualizandoId, setActualizandoId] = useState<string | null>(null)
  const [sheetAbierto, setSheetAbierto] = useState(false)

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
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
            <Users className="size-[18px]" /> Usuarios y roles
          </h2>
          <p className="mt-0.5 text-sm text-ink-400">
            Administrador: acceso total. Supervisor: puede ver reportes (Rentabilidad, Compras,
            Mermas, Clientes, Proveedores, Resumen) pero no crear, editar ni eliminar nada. Cajero:
            solo Punto de venta, Inventario, Ventas y Caja.
          </p>
        </div>
        <Button size="sm" onClick={() => setSheetAbierto(true)}>
          <UserPlus className="size-4" /> Nuevo usuario
        </Button>
      </div>
      <CrearUsuarioSheet
        open={sheetAbierto}
        onClose={() => setSheetAbierto(false)}
        onCreado={cargar}
      />
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

// Datos del negocio que se imprimen en el encabezado de todos los tickets
// (venta, cierre de turno) y se muestran en el sistema. Se guardan en la tabla
// configuracion_negocio (ver supabase/schema.sql); solo el administrador puede
// editarlos — la ruta /configuracion ya es exclusiva de ese rol y ademas el
// servidor lo exige con RLS.
function DatosNegocio() {
  const { perfil } = useAuth()
  const toast = useToast()
  const { negocio, cargando, guardando, guardar } = useConfiguracionNegocio()
  const [nombre, setNombre] = useState('')
  const [documento, setDocumento] = useState('')
  const [direccion, setDireccion] = useState('')
  const [editado, setEditado] = useState(false)

  // Mientras el usuario no haya tocado nada, el formulario sigue a la
  // configuracion vigente (llega de forma asincrona); una vez que edita, no se
  // le pisa lo que escribio.
  useEffect(() => {
    if (editado) return
    setNombre(negocio.nombre)
    setDocumento(negocio.documento)
    setDireccion(negocio.direccion)
  }, [negocio, editado])

  const documentoOk = documentoValido(documento)
  const etiquetaDoc = documento.length === 8 ? 'DNI' : documento.length === 11 ? 'RUC' : null

  async function guardarCambios() {
    if (!nombre.trim()) {
      toast.error('Ingresa el nombre del negocio.')
      return
    }
    if (!documentoOk) {
      toast.error('El DNI debe tener 8 dígitos o el RUC 11 dígitos (solo números).')
      return
    }
    try {
      await guardar({ nombre, documento, direccion }, perfil?.id ?? null)
      setEditado(false)
      toast.exito('Datos del negocio actualizados')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar')
    }
  }

  const docPreview = documento && documentoOk ? `${etiquetaDoc}: ${documento}` : ''

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
          <Store className="size-[18px]" /> Datos del negocio
        </h2>
        <p className="mt-0.5 text-sm text-ink-400">
          Aparecen en el encabezado de los tickets y en el sistema.
        </p>
      </div>
      {cargando ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-ink-400" />
        </div>
      ) : (
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="label mb-1.5 block">Nombre del negocio</span>
            <input
              className="input"
              value={nombre}
              maxLength={80}
              onChange={(e) => { setNombre(e.target.value); setEditado(true) }}
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="label mb-1.5 block">DNI / RUC del negocio</span>
              <input
                className={cx('input tabular', !documentoOk && 'border-red-300 focus:border-red-400')}
                inputMode="numeric"
                maxLength={11}
                placeholder="8 dígitos (DNI) u 11 dígitos (RUC)"
                value={documento}
                onChange={(e) => { setDocumento(e.target.value.replace(/\D/g, '')); setEditado(true) }}
              />
              <p className={cx('mt-1 text-xs', documentoOk ? 'text-ink-400' : 'text-red-600')}>
                {documentoOk
                  ? etiquetaDoc
                    ? `Se imprimirá como ${etiquetaDoc}.`
                    : 'Opcional. Déjalo vacío si no quieres imprimirlo.'
                  : `Faltan dígitos: el DNI tiene 8 y el RUC 11 (llevas ${documento.length}).`}
              </p>
            </label>
            <label className="block">
              <span className="label mb-1.5 block">Dirección (opcional)</span>
              <input
                className="input"
                maxLength={120}
                value={direccion}
                onChange={(e) => { setDireccion(e.target.value); setEditado(true) }}
              />
            </label>
          </div>

          <div className="rounded-xl bg-ink-50 p-4 text-center font-mono text-xs text-ink-600">
            <p className="text-[0.7rem] uppercase tracking-wider text-ink-400">Así se verá en el ticket</p>
            <p className="mt-1 text-sm font-black text-ink-900">
              {(nombre.trim() || negocio.nombre).toUpperCase()}
            </p>
            {docPreview && <p>{docPreview}</p>}
            {direccion.trim() && <p>{direccion.trim()}</p>}
          </div>

          <div className="flex items-center justify-between gap-3">
            {editado && <p className="text-xs text-amber-600">Tienes cambios sin guardar</p>}
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              disabled={!editado || !documentoOk}
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

// QR de Yape del negocio: se muestra al cobrar con Yape (POS) y, si esta
// activada la opcion, se imprime en los tickets de ventas pagadas con Yape.
function QrYape() {
  const { perfil } = useAuth()
  const toast = useToast()
  const { negocio, subiendoQr, subirQr, quitarQr, cambiarImprimirQr } = useConfiguracionNegocio()
  const inputRef = useRef<HTMLInputElement>(null)
  const [cambiandoOpcion, setCambiandoOpcion] = useState(false)
  const [previewRoto, setPreviewRoto] = useState(false)

  useEffect(() => {
    setPreviewRoto(false)
  }, [negocio.yapeQrUrl])

  async function alElegirArchivo(e: ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0]
    // Se limpia el input para poder volver a elegir el mismo archivo despues.
    e.target.value = ''
    if (!archivo) return
    try {
      await subirQr(archivo, perfil?.id ?? null)
      toast.exito('QR de Yape guardado')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir el QR')
    }
  }

  async function alQuitar() {
    if (!window.confirm('¿Quitar el QR de Yape? Dejará de mostrarse al cobrar y de imprimirse en los tickets.')) {
      return
    }
    try {
      await quitarQr(perfil?.id ?? null)
      toast.exito('QR de Yape eliminado')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo quitar el QR')
    }
  }

  async function alCambiarOpcion(valor: boolean) {
    setCambiandoOpcion(true)
    try {
      await cambiarImprimirQr(valor, perfil?.id ?? null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la opción')
    } finally {
      setCambiandoOpcion(false)
    }
  }

  const tieneQr = !!negocio.yapeQrUrl

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-display font-bold text-ink-900">
          <QrCode className="size-[18px]" /> QR de Yape
        </h2>
        <p className="mt-0.5 text-sm text-ink-400">
          Sube la imagen de tu código QR de Yape: se mostrará al cobrar con Yape y podrá imprimirse en el ticket.
        </p>
      </div>
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-start gap-5">
          <div className="grid size-40 shrink-0 place-items-center overflow-hidden rounded-2xl border border-dashed border-ink-200 bg-white">
            {tieneQr && !previewRoto ? (
              <img
                src={negocio.yapeQrUrl ?? undefined}
                alt="QR de Yape"
                className="size-full object-contain p-2"
                onError={() => setPreviewRoto(true)}
              />
            ) : (
              <div className="px-3 text-center text-xs text-ink-400">
                <ImageIcon className="mx-auto mb-1 size-6 text-ink-300" />
                {tieneQr ? 'No se pudo cargar la imagen' : 'Aún no hay un QR cargado'}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={alElegirArchivo}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={subiendoQr}
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="size-4" /> {tieneQr ? 'Cambiar imagen' : 'Subir imagen del QR'}
              </Button>
              {tieneQr && (
                <Button variant="outline" size="sm" disabled={subiendoQr} onClick={alQuitar}>
                  <Trash2 className="size-4" /> Quitar
                </Button>
              )}
            </div>
            <p className="text-xs text-ink-400">
              Usa una imagen que muestre solo el código QR (recórtala si es una captura de pantalla), PNG o JPG
              de hasta 8 MB. Para que se imprima nítido en la térmica, el QR debe verse con buen contraste.
            </p>
            <label
              className={cx(
                'flex items-start gap-2.5 text-sm text-ink-700',
                !tieneQr && 'opacity-50',
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 rounded border-ink-300"
                checked={negocio.imprimirQrYape}
                disabled={!tieneQr || cambiandoOpcion}
                onChange={(e) => alCambiarOpcion(e.target.checked)}
              />
              <span>Imprimir el QR en los tickets de ventas pagadas con Yape</span>
            </label>
          </div>
        </div>
      </div>
    </Card>
  )
}

// Estado y control de la impresora Bluetooth (ver utils/bluetoothPrinter.ts).
// El navegador exige elegir la impresora en su selector nativo la primera vez;
// desde ahi queda recordada y se reconecta sola al imprimir o al abrir el
// sistema.
function ImpresoraBluetooth({ onProbar, probando }: { onProbar: () => void; probando: boolean }) {
  const toast = useToast()
  const impresora = useImpresoraBluetooth()
  const [accion, setAccion] = useState<'conectar' | 'cambiar' | null>(null)
  const soportado = bluetoothDisponible()

  async function conectar(elegirNueva: boolean) {
    setAccion(elegirNueva ? 'cambiar' : 'conectar')
    try {
      await conectarImpresora(elegirNueva)
      toast.exito('Impresora Bluetooth conectada')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo conectar la impresora')
    } finally {
      setAccion(null)
    }
  }

  async function olvidar() {
    if (!window.confirm('¿Olvidar esta impresora? Tendrás que elegirla de nuevo para imprimir por Bluetooth.')) return
    await olvidarImpresoraBluetooth()
    toast.exito('Impresora olvidada')
  }

  if (!soportado) {
    return (
      <div className="flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>
          Este navegador no soporta impresión Bluetooth directa. Usa Chrome o Edge en Android, Windows o
          Mac (Safari/iPhone no la soportan) o imprime por cable.
        </span>
      </div>
    )
  }

  const estadoTexto = impresora.conectada
    ? `Conectada${impresora.nombre ? ` · ${impresora.nombre}` : ''}`
    : impresora.conectando
      ? 'Conectando…'
      : impresora.nombre
        ? `Desconectada · ${impresora.nombre}`
        : 'Sin impresora conectada'

  return (
    <div className="space-y-3 rounded-xl border border-ink-100 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-800">
          <Bluetooth className="size-4" /> Impresora Bluetooth
        </p>
        <span
          className={cx(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            impresora.conectada
              ? 'bg-accent-50 text-accent-700'
              : impresora.conectando
                ? 'bg-amber-50 text-amber-700'
                : 'bg-ink-100 text-ink-500',
          )}
        >
          <span
            className={cx(
              'size-1.5 rounded-full',
              impresora.conectada ? 'bg-accent-500' : impresora.conectando ? 'bg-amber-500' : 'bg-ink-300',
            )}
          />
          {estadoTexto}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {!impresora.conectada && (
          <Button
            size="sm"
            loading={accion === 'conectar' || impresora.conectando}
            onClick={() => conectar(!impresora.nombre)}
          >
            <Bluetooth className="size-4" /> {impresora.nombre ? 'Reconectar' : 'Conectar impresora'}
          </Button>
        )}
        {impresora.conectada && (
          <Button variant="outline" size="sm" onClick={desconectarImpresoraBluetooth}>
            Desconectar
          </Button>
        )}
        {(impresora.nombre || impresora.conectada) && (
          <Button
            variant="outline"
            size="sm"
            loading={accion === 'cambiar'}
            onClick={() => conectar(true)}
          >
            Cambiar impresora
          </Button>
        )}
        <Button variant="secondary" size="sm" loading={probando} onClick={onProbar}>
          <Printer className="size-4" /> Imprimir ticket de prueba
        </Button>
        {impresora.nombre && (
          <Button variant="outline" size="sm" onClick={olvidar}>
            Olvidar
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-400">
        Conéctala una vez: el sistema la recuerda en este equipo y se reconecta sola al imprimir. Si la
        impresora se apaga, al encenderla vuelve a conectarse en el siguiente ticket.
      </p>
    </div>
  )
}

// Ticket de prueba compartido por "Imprimir por cable" y "Imprimir ticket de
// prueba" (Bluetooth): mismos datos y misma plantilla que un ticket real, para
// que ambas vias se puedan comparar en igualdad de condiciones. Si hay un QR
// de Yape cargado, la prueba se hace como pago Yape para verlo impreso.
function ventaPrueba(conQr: boolean) {
  return {
    numero: 0,
    creadoEn: new Date().toISOString(),
    cajeroNombre: 'Prueba',
    subtotal: 34.32,
    descuento: 0,
    igv: 6.18,
    total: 40.5,
    metodo: conQr ? 'yape' : 'efectivo',
    pagoRecibido: 40.5,
    vuelto: 0,
  }
}
const LINEAS_PRUEBA = [
  { cantidadTexto: '1x', nombre: 'Producto A', montoTexto: 'S/ 10.00' },
  { cantidadTexto: '1x', nombre: 'Producto B', montoTexto: 'S/ 25.50' },
  { cantidadTexto: '1x', nombre: 'Producto C', montoTexto: 'S/ 5.00' },
]

export function Configuracion() {
  const toast = useToast()
  const negocio = useNegocio()
  const [estadoImpresion, setEstadoImpresion] = useState<'idle' | 'ok' | 'error'>('idle')
  const [probandoBt, setProbandoBt] = useState(false)
  const [probandoCable, setProbandoCable] = useState(false)

  async function probarImpresionBluetooth() {
    if (!bluetoothDisponible()) {
      toast.error(
        'Este navegador no soporta impresión Bluetooth. Usa Chrome/Edge en Android, Windows o Mac (Safari/iPhone no lo soportan).',
      )
      return
    }
    setProbandoBt(true)
    try {
      const datos = ventaPrueba(!!negocio.yapeQrUrl)
      const { qr, fallo } = await qrParaTicket(datos.metodo)
      if (fallo) toast.info('No se pudo cargar el QR de Yape: el ticket de prueba se imprime sin QR.')
      await imprimirPorBluetooth(construirTicketEscPos(datos, LINEAS_PRUEBA, qr))
      toast.exito('Ticket de prueba enviado a la impresora Bluetooth')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo imprimir por Bluetooth')
    } finally {
      setProbandoBt(false)
    }
  }

  async function probarImpresion() {
    setProbandoCable(true)
    try {
      const datos = ventaPrueba(!!negocio.yapeQrUrl)
      const { qr, fallo } = await qrParaTicket(datos.metodo)
      if (fallo) toast.info('No se pudo cargar el QR de Yape: el ticket de prueba se imprime sin QR.')
      imprimirTicketHtml(construirTicketHtml(datos, LINEAS_PRUEBA, qr))
      setEstadoImpresion('ok')
    } catch {
      setEstadoImpresion('error')
    } finally {
      setProbandoCable(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-900">Configuración</h1>
        <p className="text-sm text-ink-400">Ajustes del sistema y herramientas de diagnóstico</p>
      </div>

      {/* Sección: Datos del negocio (nombre, DNI/RUC, dirección) */}
      <DatosNegocio />

      {/* Sección: QR de Yape */}
      <QrYape />

      {/* Sección: Impresora */}
      <Card className="overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4">
          <h2 className="font-display font-bold text-ink-900">Impresora de tickets</h2>
          <p className="mt-0.5 text-sm text-ink-400">
            Conecta tu impresora térmica por Bluetooth para imprimir los tickets directamente
          </p>
        </div>
        <div className="space-y-4 p-5">
          <ImpresoraBluetooth onProbar={probarImpresionBluetooth} probando={probandoBt} />

          <div className="flex items-start gap-3 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              "Imprimir por cable" abre una ventana con un ticket de prueba y lanza el diálogo de
              impresión del navegador (sirve para impresoras USB, de red, o Bluetooth ya instaladas
              como impresora del sistema). Asegúrate de que los popups estén habilitados para este sitio.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={probarImpresion} loading={probandoCable}>
              <Printer className="size-4" /> Imprimir por cable
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
              <li>Toca <strong>"Conectar impresora"</strong> y elige la impresora en la lista que muestra el navegador — no hace falta instalar ningún driver</li>
              <li>Desde ese momento los botones <strong>Bluetooth</strong> de cada ticket imprimen directo, sin volver a elegirla</li>
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

      {/* Sección: Usuarios y roles */}
      <GestionUsuarios />

      {/* Sección: Políticas de tolerancia del arqueo de caja */}
      <PoliticasTolerancia />

      {/* Sección: Información del sistema */}
      <Card className="overflow-hidden">
        <div className="border-b border-ink-100 px-5 py-4">
          <h2 className="font-display font-bold text-ink-900">Información del sistema</h2>
        </div>
        <div className="divide-y divide-ink-50">
          {[
            { k: 'Aplicación', v: `${negocio.nombre} POS` },
            { k: 'Versión', v: import.meta.env.VITE_APP_VERSION ?? '1.0.0' },
            { k: 'Entorno', v: import.meta.env.MODE === 'production' ? 'Producción' : 'Desarrollo' },
            { k: 'Navegador', v: navigator.userAgent.split(' ').slice(-2).join(' ') },
          ].map(({ k, v }) => (
            <div key={k} className="flex justify-between gap-4 px-5 py-3 text-sm">
              <span className="text-ink-500">{k}</span>
              <span className="text-right font-medium text-ink-800">{v}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
