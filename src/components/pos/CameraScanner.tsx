import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { CameraOff, Loader2, Keyboard } from 'lucide-react'
import { sonidoScanner } from '@/utils/beep'

interface Props {
  onScan: (codigo: string) => void
  activo: boolean
}

// Lentes traseras de iPhone que NO queremos usar para leer codigos de barra:
// el gran angular / ultra-wide muestra el codigo diminuto y desenfocado a la
// distancia normal de escaneo (10-15cm), por lo que zxing casi nunca decodifica
// ahi, aunque la camara se vea "activa" y con buena imagen a simple vista.
const LENTE_NO_DESEADA = /ultra ?wide|tele ?photo|gran ?angular|zoom/i
const LENTE_TRASERA = /back|rear|trasera|environment/i

/**
 * Elige la mejor camara trasera disponible evitando lentes ultra-wide/tele.
 * En iPhones con multiples lentes, pedir solo "facingMode: environment" deja
 * que Safari elija cualquiera de ellas (a veces la ultra-wide), lo que hace
 * que los codigos de barra 1D salgan demasiado pequeños para decodificar.
 * Devuelve null si no se puede enumerar (entonces se usa el fallback por
 * facingMode, que sigue funcionando bien en Android).
 */
async function elegirCamaraTrasera(): Promise<string | null> {
  try {
    const camaras = await Html5Qrcode.getCameras()
    if (!camaras || camaras.length === 0) return null
    if (camaras.length === 1) return camaras[0].id

    const buena = camaras.find(
      (c) => LENTE_TRASERA.test(c.label) && !LENTE_NO_DESEADA.test(c.label),
    )
    if (buena) return buena.id

    // Si ninguna etiqueta es reconocible (algunos navegadores dan labels
    // genericos), no forzamos nada: mejor dejar que decida facingMode.
    return null
  } catch {
    return null
  }
}

/**
 * Escaner de camara nativo (movil/tablet) usando html5-qrcode.
 * Lee QR y los principales formatos de codigo de barras de retail.
 */
export function CameraScanner({ onScan, activo }: Props) {
  const contenedorId = useRef(`scanner-${Math.random().toString(36).slice(2)}`)
  const scannerRef = useRef<Html5Qrcode | null>(null)
  const ultimoScan = useRef<{ codigo: string; t: number }>({ codigo: '', t: 0 })
  const [estado, setEstado] = useState<'iniciando' | 'activo' | 'error'>('iniciando')
  const [mensajeError, setMensajeError] = useState<string>('')
  const [manualAbierto, setManualAbierto] = useState(false)
  const [manualCodigo, setManualCodigo] = useState('')

  useEffect(() => {
    if (!activo) return
    let cancelado = false

    // Safari en iOS no expone mediaDevices si la pagina no esta en HTTPS
    // (o localhost) o si el navegador es muy antiguo: sin esto, el intento
    // de start() de abajo lanzaria un TypeError poco claro para el usuario.
    if (!navigator.mediaDevices?.getUserMedia) {
      setMensajeError(
        'Este navegador no permite usar la cámara aquí. En iPhone, abre la página con Safari (no dentro de otra app) y verifica que la URL empiece con https://.',
      )
      setEstado('error')
      return
    }

    const scanner = new Html5Qrcode(contenedorId.current, {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
      ],
      verbose: false,
    })
    scannerRef.current = scanner

    const config = {
      fps: 12,
      qrbox: (w: number, h: number) => {
        const lado = Math.floor(Math.min(w, h) * 0.7)
        return { width: lado, height: Math.floor(lado * 0.62) }
      },
      aspectRatio: 1.2,
      // Deja que el navegador use el detector de codigos de barra nativo
      // (mas rapido y preciso) cuando esta disponible - hoy solo Chrome/
      // Edge en Android. En Safari/iOS no existe, asi que ahi simplemente
      // se ignora y sigue usando el decodificador JS (zxing) de siempre.
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    }

    // En iPhone/Safari, si no se piden dimensiones explicitas la camara
    // trasera puede entregar un stream de baja resolucion, insuficiente para
    // decodificar codigos de barra 1D (EAN-13, UPC-A, etc. tienen barras muy
    // finas). Se pide con "ideal" (no "exact"/"min"): si el dispositivo no la
    // soporta, el navegador entrega la mas cercana en vez de fallar, nunca
    // truena por pedir de mas.
    const resolucion = { width: { ideal: 3840 }, height: { ideal: 2160 } }

    elegirCamaraTrasera().then((deviceId) => {
      if (cancelado) return
      const videoConstraints = deviceId
        ? { deviceId: { exact: deviceId }, ...resolucion }
        : { facingMode: 'environment', ...resolucion }

      scanner
        .start(
          { facingMode: 'environment' },
          { ...config, videoConstraints },
          (texto) => {
            // Anti-rebote: ignora la misma lectura por 1.2s
            const ahora = Date.now()
            if (
              ultimoScan.current.codigo === texto &&
              ahora - ultimoScan.current.t < 1200
            )
              return
            ultimoScan.current = { codigo: texto, t: ahora }
            if ('vibrate' in navigator) navigator.vibrate(40)
            sonidoScanner()
            onScan(texto)
          },
          () => {
            /* fallos de frame: silenciar */
          },
        )
        .then(() => {
          if (cancelado) return
          setEstado('activo')
        })
        .catch((err: unknown) => {
          if (cancelado) return
          const nombre = err instanceof Error ? err.name : ''
          const texto =
            nombre === 'NotAllowedError'
              ? 'Permiso de cámara denegado. En iPhone: Ajustes → Safari → Cámara → Permitir (o el candado 🔒 en la barra de direcciones), y vuelve a intentar.'
              : nombre === 'NotFoundError'
              ? 'No se encontró una cámara trasera en este dispositivo.'
              : nombre === 'NotReadableError'
              ? 'La cámara está siendo usada por otra app. Cierra otras apps que la usen e intenta de nuevo.'
              : 'No se pudo acceder a la cámara. Revisa los permisos del navegador y que uses HTTPS, o usa la entrada manual de abajo.'
          setMensajeError(texto)
          setEstado('error')
        })
    })

    return () => {
      cancelado = true
      const s = scannerRef.current
      if (s && s.isScanning) {
        s.stop()
          .then(() => s.clear())
          .catch(() => {})
      }
    }
  }, [activo, onScan])

  function confirmarManual(e: FormEvent) {
    e.preventDefault()
    const codigo = manualCodigo.trim()
    if (!codigo) return
    onScan(codigo)
    setManualCodigo('')
  }

  if (!activo) return null

  return (
    <div className="space-y-2">
      <div className="relative overflow-hidden rounded-2xl bg-ink-950">
        <div id={contenedorId.current} className="aspect-[4/3] w-full [&>video]:object-cover" />

        {/* Overlay de mira */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="relative h-[42%] w-[72%]">
            <span className="absolute left-0 top-0 size-6 rounded-tl-lg border-l-2 border-t-2 border-accent-400" />
            <span className="absolute right-0 top-0 size-6 rounded-tr-lg border-r-2 border-t-2 border-accent-400" />
            <span className="absolute bottom-0 left-0 size-6 rounded-bl-lg border-b-2 border-l-2 border-accent-400" />
            <span className="absolute bottom-0 right-0 size-6 rounded-br-lg border-b-2 border-r-2 border-accent-400" />
            <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-accent-400/70 shadow-[0_0_12px_2px] shadow-accent-400/60" />
          </div>
        </div>

        {estado === 'iniciando' && (
          <div className="absolute inset-0 grid place-items-center bg-ink-950/70 text-white">
            <div className="flex flex-col items-center gap-2 text-sm">
              <Loader2 className="size-6 animate-spin" />
              Activando cámara...
            </div>
          </div>
        )}
        {estado === 'error' && (
          <div className="absolute inset-0 grid place-items-center bg-ink-950/85 px-6 text-center text-white">
            <div className="flex flex-col items-center gap-2">
              <CameraOff className="size-7 text-red-400" />
              <p className="text-sm font-medium">No se pudo acceder a la cámara.</p>
              <p className="text-xs text-white/60">{mensajeError}</p>
            </div>
          </div>
        )}
      </div>

      {/* Respaldo manual: por si la camara no lee (lente, foco, permisos, o
          cualquier equipo/navegador con soporte irregular de la API). Nunca
          debe quedar bloqueado el flujo de trabajo por un problema de camara. */}
      <div className="rounded-xl border border-ink-100 bg-ink-50 px-3 py-2">
        {manualAbierto ? (
          <form onSubmit={confirmarManual} className="flex gap-2">
            <input
              autoFocus
              inputMode="numeric"
              className="input flex-1 text-sm"
              placeholder="Código de barras / SKU"
              value={manualCodigo}
              onChange={(e) => setManualCodigo(e.target.value)}
            />
            <button
              type="submit"
              className="rounded-lg bg-accent-500 px-3 text-sm font-semibold text-white"
            >
              Agregar
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setManualAbierto(true)}
            className="flex w-full items-center justify-center gap-1.5 py-0.5 text-xs font-medium text-ink-500"
          >
            <Keyboard className="size-3.5" />
            ¿La cámara no lee el código? Ingrésalo manualmente
          </button>
        )}
      </div>
    </div>
  )
}
