import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { AlertCircle, Eye, EyeOff } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { Spinner } from '@/components/ui/Button'
import { BRAND } from '@/config/brand'
import { useNegocio } from '@/config/negocio'

const urlSoporte = (nombreNegocio: string) =>
  `https://wa.me/${BRAND.whatsappSoporte}?text=Hola,%20tengo%20problemas%20para%20acceder%20al%20sistema%20de%20${encodeURIComponent(nombreNegocio)}.`

/* Ultimo correo usado en este equipo: solo una comodidad local. Si el
   almacenamiento no esta disponible (modo privado, bloqueado) se ignora. */
const CLAVE_CORREO = 'login:ultimoCorreo'
function leerCorreoGuardado(): string {
  try {
    return localStorage.getItem(CLAVE_CORREO) ?? ''
  } catch {
    return ''
  }
}
function guardarCorreo(correo: string) {
  try {
    localStorage.setItem(CLAVE_CORREO, correo)
  } catch {
    /* sin almacenamiento: no pasa nada */
  }
}

/* Foto del local para el panel de marca. Esta en /img, que el service worker
   no precachea a proposito (ver vite.config.ts): se descarga solo en el login. */
const FOTO_LOCAL = '/img/fondo-login.jpg'

/* Velo inferior: da contraste a la fecha y la hora sobre la foto. */
const veloInferior: CSSProperties = {
  background:
    'linear-gradient(180deg, rgba(14,14,13,0) 0%, rgba(14,14,13,0.55) 45%, rgba(14,14,13,0.88) 100%)',
}

/* ── Reloj de turno ───────────────────────────────────────────────────────── */
const fmtFecha = new Intl.DateTimeFormat('es-PE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})
/** "8:05" (reloj de 12 horas, sin sufijo). */
function horaTexto(d: Date) {
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`
}

function useAhora() {
  const [ahora, setAhora] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setAhora(new Date()), 15_000)
    return () => window.clearInterval(id)
  }, [])
  return ahora
}

function capitalizar(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/* ── Pagina ───────────────────────────────────────────────────────────────── */
export function Login() {
  const { signIn } = useAuth()
  const { nombre: nombreNegocio } = useNegocio()
  const ahora = useAhora()

  const [correoInicial] = useState(leerCorreoGuardado)
  const [email, setEmail] = useState(correoInicial)
  const [password, setPassword] = useState('')
  const [verPass, setVerPass] = useState(false)
  const [mayusculas, setMayusculas] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)

  const refPassword = useRef<HTMLInputElement>(null)
  const anio = ahora.getFullYear()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (cargando) return
    setError(null)
    setCargando(true)
    const correo = email.trim()
    const { error } = await signIn(correo, password)
    setCargando(false)
    if (error) {
      setError(error)
      refPassword.current?.select()
      return
    }
    guardarCorreo(correo)
  }

  function detectarMayusculas(e: KeyboardEvent<HTMLInputElement>) {
    if (typeof e.getModifierState === 'function') {
      setMayusculas(e.getModifierState('CapsLock'))
    }
  }

  const campo =
    'block h-12 w-full rounded-[10px] border border-ink-200 bg-white px-3.5 text-[16px] text-ink-900 ' +
    'placeholder:text-ink-300 transition-[border-color,box-shadow] duration-150 ' +
    'hover:border-ink-300 focus:border-ink-900 focus:outline-none focus:ring-4 focus:ring-ink-900/[0.07] ' +
    'disabled:bg-ink-50 disabled:text-ink-400'

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white lg:flex-row">
      {/* ═══ Panel de marca con la foto del local (escritorio) ═══ */}
      <aside
        aria-hidden="true"
        className="relative hidden min-h-[100dvh] w-1/2 shrink-0 overflow-hidden bg-ink-950 lg:block"
      >
        <img
          src={FOTO_LOCAL}
          alt=""
          draggable={false}
          decoding="async"
          className="absolute inset-0 size-full select-none object-cover"
          style={{ objectPosition: '50% 35%' }}
          onError={(e) => {
            e.currentTarget.style.display = 'none'
          }}
        />
        <div className="absolute inset-x-0 bottom-0 h-[38%]" style={veloInferior} />

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-6 px-10 pb-9 text-white">
          <div>
            <p className="font-display text-[15px] font-semibold">
              {capitalizar(fmtFecha.format(ahora))}
            </p>
            <p className="mt-0.5 text-[13px] text-white/70">Abre tu turno al ingresar</p>
          </div>
          <p className="font-display text-[44px] font-semibold leading-none tracking-[-0.03em] tabular">
            {horaTexto(ahora)}
            <span className="ml-1.5 align-top text-[15px] font-medium tracking-normal text-white/70">
              {ahora.getHours() < 12 ? 'a. m.' : 'p. m.'}
            </span>
          </p>
        </div>
      </aside>

      {/* ═══ Formulario ═══ */}
      <main className="flex min-h-[100dvh] flex-1 flex-col">
        {/* Movil y tablet: franja con la foto del local */}
        <div
          aria-hidden="true"
          className="relative h-[clamp(160px,38vw,300px)] shrink-0 overflow-hidden bg-ink-950 lg:hidden"
        >
          <img
            src={FOTO_LOCAL}
            alt=""
            draggable={false}
            decoding="async"
            className="size-full select-none object-cover"
            style={{ objectPosition: '50% 30%' }}
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-10">
          <div className="w-full max-w-[368px]">
            <div className="mb-9">
              <p className="font-display text-[15px] font-semibold leading-snug text-ink-900">
                {nombreNegocio}
              </p>
            </div>

            <h1 className="font-display text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-ink-950">
              Inicia sesión
            </h1>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-500">
              Usa el correo y la contraseña que te asignó el administrador.
            </p>

            <form onSubmit={onSubmit} className="mt-8 space-y-5">
              <div>
                <label htmlFor="login-email" className="mb-1.5 block text-sm font-medium text-ink-700">
                  Correo electrónico
                </label>
                <input
                  id="login-email"
                  type="email"
                  inputMode="email"
                  className={campo}
                  placeholder="nombre@correo.com"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus={!correoInicial}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={cargando}
                  aria-invalid={error ? true : undefined}
                  required
                />
              </div>

              <div>
                <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium text-ink-700">
                  Contraseña
                </label>
                <div className="relative">
                  <input
                    id="login-password"
                    ref={refPassword}
                    type={verPass ? 'text' : 'password'}
                    className={`${campo} pr-12`}
                    autoComplete="current-password"
                    autoFocus={!!correoInicial}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={detectarMayusculas}
                    onKeyUp={detectarMayusculas}
                    onBlur={() => setMayusculas(false)}
                    disabled={cargando}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={mayusculas ? 'login-mayus' : undefined}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setVerPass((v) => !v)}
                    className="absolute right-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-ink-50 hover:text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900/20"
                    aria-label={verPass ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    aria-pressed={verPass}
                  >
                    {verPass ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
                  </button>
                </div>
                {mayusculas && (
                  <p id="login-mayus" className="mt-1.5 text-[13px] text-amber-700">
                    Bloq Mayús está activado.
                  </p>
                )}
              </div>

              <div aria-live="assertive">
                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-snug text-red-800 motion-safe:animate-fade-up"
                  >
                    <AlertCircle className="mt-px size-4 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={cargando}
                className="flex h-12 w-full items-center justify-center gap-2.5 rounded-[10px] bg-ink-900 text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-ink-800 active:bg-ink-950 disabled:cursor-wait disabled:bg-ink-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ink-900/20"
              >
                {cargando ? (
                  <>
                    <Spinner className="size-4" />
                    Verificando…
                  </>
                ) : (
                  'Ingresar'
                )}
              </button>
            </form>

            <p className="mt-8 text-sm text-ink-500">
              ¿No puedes entrar?{' '}
              <a
                href={urlSoporte(nombreNegocio)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
              >
                Escríbenos por WhatsApp
              </a>
            </p>
          </div>
        </div>

        <footer className="safe-bottom px-5 pb-6 text-center text-xs text-ink-400 sm:px-10 lg:text-left">
          © {anio} {nombreNegocio}. Acceso solo para personal autorizado.
        </footer>
      </main>
    </div>
  )
}
