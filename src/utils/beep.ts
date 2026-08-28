/**
 * Feedback auditivo del escáner — Web Audio API, sin archivos externos.
 *
 * beepExito : 1000 Hz / 100 ms — lectura exitosa (caja registradora real)
 * beepError : 250 Hz  / 200 ms — código no encontrado en inventario
 */

function crearBeep(hz: number, duracion: number, volumen = 0.2): void {
  try {
    const AudioCtx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return

    const ctx  = new AudioCtx()
    const osc  = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = 'sine'
    osc.frequency.setValueAtTime(hz, ctx.currentTime)

    // Volumen inicial → caída exponencial suave (sin chasquidos)
    gain.gain.setValueAtTime(volumen, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + duracion)

    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + duracion)
    osc.onended = () => ctx.close()
  } catch {
    // Silenciar errores de autoplay/contexto cerrado
  }
}

/** Pitido de éxito: 1000 Hz, 100 ms — emula caja registradora POS real */
export function beepExito(): void {
  crearBeep(1000, 0.1, 0.2)
}

/** Pitido de error: 250 Hz, 200 ms — código no encontrado en inventario */
export function beepError(): void {
  crearBeep(250, 0.2, 0.25)
}

/** Alias de compatibilidad (usada por CameraScanner y useKeyboardScanner) */
export const beepEscaner = beepExito

// --- Sonido grabado del escaner (camara) ---------------------------------
// A diferencia de los beeps sintetizados de arriba (que indican un
// resultado de negocio: producto encontrado/no encontrado), este es el
// "click" audible que confirma que la camara decodifico un codigo de
// barras/QR, igual que un lector fisico de supermercado. Se dispara en
// CameraScanner en el instante mismo de la lectura, antes de saber si el
// producto existe en el sistema.
let audioScanner: HTMLAudioElement | null = null

function obtenerAudioScanner(): HTMLAudioElement {
  if (!audioScanner) {
    audioScanner = new Audio(`${import.meta.env.BASE_URL}audio/scanner.mp3`)
    audioScanner.preload = 'auto'
  }
  return audioScanner
}

/** Reproduce public/audio/scanner.mp3. Nunca lanza: un fallo de audio
 * (autoplay bloqueado, archivo ausente, navegador sin soporte) no debe
 * interrumpir el flujo de escaneo. */
export function sonidoScanner(): void {
  try {
    const audio = obtenerAudioScanner()
    // Reinicia el playback por si el usuario escanea muy rapido y el clip
    // anterior todavia estaba sonando.
    audio.currentTime = 0
    void audio.play().catch(() => {
      // Autoplay bloqueado u otro error de reproduccion: silenciar.
    })
  } catch {
    // Entorno sin soporte de Audio: silenciar.
  }
}

/**
 * "Desbloquea" la reproduccion de scanner.mp3 para el resto de la sesion.
 * Safari/iOS solo deja reproducir un <audio> por script si play() se llamo
 * antes al menos una vez de forma sincronica dentro de un gesto del usuario
 * (clic/tap); despues de eso, ese mismo elemento se puede reproducir desde
 * cualquier callback asincrono (como la deteccion de un codigo dentro de
 * CameraScanner, que ocurre bastante despues del clic que abrio la camara).
 * Debe llamarse en el propio manejador onClick del boton que abre la
 * camara (nunca en un efecto o promesa) para que cuente como gesto.
 */
export function desbloquearAudioScanner(): void {
  try {
    const audio = obtenerAudioScanner()
    audio.muted = true
    const promesa = audio.play()
    if (promesa && typeof promesa.then === 'function') {
      promesa
        .then(() => {
          audio.pause()
          audio.currentTime = 0
          audio.muted = false
        })
        .catch(() => {
          audio.muted = false
        })
    } else {
      audio.pause()
      audio.currentTime = 0
      audio.muted = false
    }
  } catch {
    // Silenciar: si esto falla, sonidoScanner() simplemente no sonara mas
    // tarde en navegadores estrictos, pero el resto del flujo sigue igual.
  }
}
