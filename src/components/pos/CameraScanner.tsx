import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import { CameraOff, Loader2 } from 'lucide-react'

interface Props {
  onScan: (codigo: string) => void
  activo: boolean
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

    scanner
      .start(
        { facingMode: 'environment' },
        {
          fps: 12,
          qrbox: (w, h) => {
            const lado = Math.floor(Math.min(w, h) * 0.7)
            return { width: lado, height: Math.floor(lado * 0.62) }
          },
          aspectRatio: 1.2,
          // En iPhone/Safari, si no se piden dimensiones explicitas la camara
          // trasera suele entregar un stream de baja resolucion (~640x480),
          // insuficiente para decodificar codigos de barra 1D (EAN-13, UPC-A,
          // etc. tienen barras muy finas). Pedir una resolucion alta con
          // "ideal" (no "exact"/"min") es un requisito flexible: si el
          // dispositivo no la soporta, el navegador entrega la mas cercana en
          // vez de fallar. NOTA: al definir "videoConstraints" la libreria
          // ignora por completo el primer argumento (facingMode de arriba),
          // por eso hay que repetirlo aqui tambien.
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
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
          onScan(texto)
        },
        () => {
          /* fallos de frame: silenciar */
        },
      )
      .then(() => !cancelado && setEstado('activo'))
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
            : 'No se pudo acceder a la cámara. Revisa los permisos del navegador y que uses HTTPS.'
        setMensajeError(texto)
        setEstado('error')
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

  if (!activo) return null

  return (
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
            Activando camara...
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
  )
}
