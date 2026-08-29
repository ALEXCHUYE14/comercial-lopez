import { useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { CameraScanner } from '@/components/pos/CameraScanner'
import { useKeyboardScanner } from '@/hooks/useKeyboardScanner'
import { supabase } from '@/lib/supabase'
import { cx } from '@/utils/format'
import { beepExito, beepError } from '@/utils/beep'
import type { Producto } from '@/types/database'

interface Props {
  open: boolean
  onClose: () => void
  productos: Producto[]
  onListo: () => void
  /** Se llama cuando un código escaneado no coincide con ningún producto,
   * para ofrecer crearlo al vuelo con ese SKU ya precargado. */
  onNoEncontrado?: (codigo: string) => void
}

interface Registro {
  id: string
  ok: boolean
  texto: string
  hora: string
  /** Solo en registros "no encontrado": el código crudo, para el botón "Crear producto". */
  codigoNoEncontrado?: string
}

/**
 * Ingreso rapido de stock apuntando la camara al codigo de barras: cada
 * lectura exitosa suma 1 unidad al producto y queda guardada de inmediato
 * (sin boton de confirmacion por item), pensado para recibir mercaderia
 * escaneando caja por caja. El anti-rebote del CameraScanner (1.2s) evita
 * que la misma lectura se cuente dos veces mientras el codigo sigue en cuadro.
 */
export function ScanEntrada({ open, onClose, productos, onListo, onNoEncontrado }: Props) {
  const [registros, setRegistros] = useState<Registro[]>([])
  const procesando = useRef(new Set<string>())

  // Lector fisico Bluetooth/USB (funciona igual en iPhone y Android: el
  // telefono lo ve como un teclado externo) - alternativa 100% confiable
  // cuando la lectura por camara falla por foco, lente o luz.
  useKeyboardScanner(onScan)

  async function onScan(codigo: string) {
    // Evita doble envio si el usuario escanea muy rapido antes de que
    // termine de guardarse la peticion anterior del mismo codigo.
    if (procesando.current.has(codigo)) return
    procesando.current.add(codigo)

    const producto = productos.find((p) => p.sku === codigo.trim())
    const hora = new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    if (!producto) {
      beepError()
      agregarRegistro({
        id: crypto.randomUUID(),
        ok: false,
        texto: `No encontrado: ${codigo}`,
        hora,
        codigoNoEncontrado: codigo.trim(),
      })
      procesando.current.delete(codigo)
      return
    }

    try {
      const { error } = await supabase.rpc('ajustar_stock', {
        p_producto_id: producto.id,
        p_cantidad: 1,
        p_tipo: 'entrada',
        p_motivo: 'Ingreso rápido (escaneo)',
      })
      if (error) throw error
      if ('vibrate' in navigator) navigator.vibrate(40)
      beepExito()
      agregarRegistro({
        id: crypto.randomUUID(),
        ok: true,
        texto: `+1 ${producto.nombre}`,
        hora,
      })
      onListo()
    } catch (e) {
      beepError()
      agregarRegistro({
        id: crypto.randomUUID(),
        ok: false,
        texto: `Error con "${producto.nombre}": ${e instanceof Error ? e.message : 'no se pudo guardar'}`,
        hora,
      })
    } finally {
      procesando.current.delete(codigo)
    }
  }

  function agregarRegistro(r: Registro) {
    setRegistros((prev) => [r, ...prev].slice(0, 20))
  }

  function cerrar() {
    setRegistros([])
    onClose()
  }

  return (
    <Sheet open={open} onClose={cerrar} title="Ingreso rápido por escaneo" maxWidth="max-w-md">
      <div className="space-y-3">
        <p className="text-xs text-ink-400">
          Cada código escaneado suma <b>+1 unidad</b> al stock y se guarda de inmediato. Ideal para
          recibir mercadería escaneando caja por caja.
        </p>

        <CameraScanner activo={open} onScan={onScan} />

        {registros.length > 0 && (
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {registros.map((r) => (
              <li
                key={r.id}
                className={cx(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs',
                  r.ok ? 'bg-accent-50 text-accent-700' : 'bg-red-50 text-red-700',
                )}
              >
                {r.ok ? (
                  <CheckCircle2 className="size-3.5 shrink-0" />
                ) : (
                  <XCircle className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{r.texto}</span>
                {r.codigoNoEncontrado && onNoEncontrado && (
                  <button
                    onClick={() => onNoEncontrado(r.codigoNoEncontrado!)}
                    className="shrink-0 rounded-md bg-red-100 px-1.5 py-0.5 font-semibold text-red-800 hover:bg-red-200"
                  >
                    Crear producto
                  </button>
                )}
                <span className="shrink-0 tabular opacity-60">{r.hora}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  )
}
