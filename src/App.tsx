import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { CajaProvider } from '@/context/CajaContext'
import { ToastProvider } from '@/components/ui/Toast'
import { AppShell } from '@/components/layout/AppShell'
import { Spinner } from '@/components/ui/Button'
import { Login } from '@/pages/Login'
import { Dashboard } from '@/pages/Dashboard'
import { POS } from '@/pages/POS'
import { Inventario } from '@/pages/Inventario'
import { Ventas } from '@/pages/Ventas'
import { Clientes } from '@/pages/Clientes'
import { Caja } from '@/pages/Caja'
import { Proveedores } from '@/pages/Proveedores'
import { Compras } from '@/pages/Compras'
import { Mermas } from '@/pages/Mermas'
import { Egresos } from '@/pages/Egresos'
import { AuditoriaCajeros } from '@/pages/AuditoriaCajeros'
import { Rentabilidad } from '@/pages/Rentabilidad'
import { Configuracion } from '@/pages/Configuracion'
import { sincronizarNegocio } from '@/hooks/useConfiguracionNegocio'
import { useNegocio } from '@/config/negocio'
import { precargarQr } from '@/utils/qrTermico'
import { reconectarImpresoraGuardada } from '@/utils/bluetoothPrinter'
import { tieneAcceso } from '@/utils/roles'
import type { Rol } from '@/types/database'
import type { ReactNode } from 'react'

function Cargando() {
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-50">
      <Spinner className="size-7 text-ink-400" />
    </div>
  )
}

/**
 * Mantiene sincronizados los datos del negocio (nombre, DNI/RUC, QR de Yape)
 * con Supabase mientras haya sesion: al iniciar sesion y cada vez que la app
 * vuelve a primer plano (asi un cajero con el POS abierto todo el dia ve los
 * cambios que hizo el administrador sin recargar).
 */
function SincronizarNegocio() {
  const { session } = useAuth()
  const { yapeQrUrl } = useNegocio()
  const haySesion = !!session

  useEffect(() => {
    if (!haySesion) return
    sincronizarNegocio()
    const alVolver = () => {
      if (document.visibilityState === 'visible') sincronizarNegocio()
    }
    document.addEventListener('visibilitychange', alVolver)
    return () => document.removeEventListener('visibilitychange', alVolver)
  }, [haySesion])

  // Deja lista la impresora Bluetooth usada la ultima vez (sin selector; si
  // esta apagada simplemente queda desconectada y se reconecta al imprimir).
  useEffect(() => {
    if (haySesion) reconectarImpresoraGuardada()
  }, [haySesion])

  // Descarga el QR de Yape ya convertido a blanco y negro para que se pueda
  // imprimir en el ticket aunque despues se pierda la conexion a internet.
  useEffect(() => {
    if (haySesion) precargarQr(yapeQrUrl)
  }, [haySesion, yapeQrUrl])

  return null
}

/** Exige sesion activa. Sin sesion -> Login. */
function Privado({ children }: { children: ReactNode }) {
  const { session, cargando } = useAuth()
  if (cargando) return <Cargando />
  if (!session) return <Navigate to="/login" replace />
  return <AppShell>{children}</AppShell>
}

/** Exige un rol minimo (cajero < supervisor < administrador). Sin acceso -> POS. */
function SoloRol({ minRol, children }: { minRol: Rol; children: ReactNode }) {
  const { perfil, cargando } = useAuth()
  if (cargando) return <Cargando />
  if (!tieneAcceso(perfil?.rol, minRol)) return <Navigate to="/pos" replace />
  return <>{children}</>
}

function Rutas() {
  const { session, cargando } = useAuth()

  return (
    <Routes>
      <Route
        path="/login"
        element={
          cargando ? (
            <Cargando />
          ) : session ? (
            <Navigate to="/" replace />
          ) : (
            <Login />
          )
        }
      />

      <Route
        path="/"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Dashboard />
            </SoloRol>
          </Privado>
        }
      />
      <Route
        path="/pos"
        element={
          <Privado>
            <POS />
          </Privado>
        }
      />
      <Route
        path="/inventario"
        element={
          <Privado>
            <Inventario />
          </Privado>
        }
      />
      <Route
        path="/ventas"
        element={
          <Privado>
            <Ventas />
          </Privado>
        }
      />
      <Route
        path="/caja"
        element={
          <Privado>
            <Caja />
          </Privado>
        }
      />
      <Route
        path="/rentabilidad"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Rentabilidad />
            </SoloRol>
          </Privado>
        }
      />
      <Route
        path="/clientes"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Clientes />
            </SoloRol>
          </Privado>
        }
      />
      <Route
        path="/proveedores"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Proveedores />
            </SoloRol>
          </Privado>
        }
      />
      <Route
        path="/compras"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Compras />
            </SoloRol>
          </Privado>
        }
      />
      <Route
        path="/mermas"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Mermas />
            </SoloRol>
          </Privado>
        }
      />

      <Route
        path="/egresos"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <Egresos />
            </SoloRol>
          </Privado>
        }
      />

      <Route
        path="/auditoria"
        element={
          <Privado>
            <SoloRol minRol="supervisor">
              <AuditoriaCajeros />
            </SoloRol>
          </Privado>
        }
      />

      <Route
        path="/configuracion"
        element={
          <Privado>
            <SoloRol minRol="administrador">
              <Configuracion />
            </SoloRol>
          </Privado>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CajaProvider>
          <ToastProvider>
            <SincronizarNegocio />
            <Rutas />
          </ToastProvider>
        </CajaProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
