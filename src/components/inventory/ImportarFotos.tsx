import { useMemo, useState } from 'react'
import { Upload, CheckCircle2, XCircle, ImageIcon, AlertTriangle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useProductoImagen } from '@/hooks/useProductoImagen'
import { leerArchivosFotos, type FotoLeida } from '@/utils/inventarioFotos'
import type { Producto } from '@/types/database'

type Emparejada = FotoLeida & { producto: Producto | null }
type ResultadoFoto = { sku: string; ok: boolean; mensaje?: string }

export function ImportarFotos({
  open,
  onClose,
  productos,
  onListo,
}: {
  open: boolean
  onClose: () => void
  productos: Producto[]
  onListo: () => void
}) {
  const toast = useToast()
  const { subir } = useProductoImagen()
  const [leyendo, setLeyendo] = useState(false)
  const [leidas, setLeidas] = useState<FotoLeida[] | null>(null)
  const [subiendo, setSubiendo] = useState(false)
  const [progreso, setProgreso] = useState(0)
  const [resultado, setResultado] = useState<ResultadoFoto[] | null>(null)

  const porSku = useMemo(() => {
    const m = new Map<string, Producto>()
    for (const p of productos) m.set(p.sku.trim().toLowerCase(), p)
    return m
  }, [productos])

  const emparejadas: Emparejada[] = useMemo(
    () => (leidas ?? []).map((f) => ({ ...f, producto: porSku.get(f.sku.trim().toLowerCase()) ?? null })),
    [leidas, porSku],
  )
  const encontradas = emparejadas.filter((e) => e.producto)
  const sinCoincidencia = emparejadas.filter((e) => !e.producto)

  function cerrar() {
    setLeidas(null)
    setResultado(null)
    setProgreso(0)
    onClose()
  }

  async function elegirArchivos(files: File[]) {
    setResultado(null)
    setLeyendo(true)
    try {
      const leidas = await leerArchivosFotos(files)
      if (leidas.length === 0) {
        toast.error('No se encontró ninguna imagen en lo que elegiste (¿es un .zip vacío o sin fotos?).')
        setLeidas(null)
        return
      }
      setLeidas(leidas)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo leer el archivo')
      setLeidas(null)
    } finally {
      setLeyendo(false)
    }
  }

  async function subirTodas() {
    if (encontradas.length === 0) return
    setSubiendo(true)
    setProgreso(0)
    const filaResultado: ResultadoFoto[] = []
    try {
      for (const e of encontradas) {
        const producto = e.producto as Producto
        try {
          const archivo = new File([e.blob], e.nombreArchivo, { type: e.blob.type || 'image/jpeg' })
          const url = await subir(archivo, producto.id)
          const { error } = await supabase.from('productos').update({ image_url: url }).eq('id', producto.id)
          if (error) throw new Error(error.message)
          filaResultado.push({ sku: e.sku, ok: true })
        } catch (err) {
          filaResultado.push({ sku: e.sku, ok: false, mensaje: err instanceof Error ? err.message : 'Error al subir' })
        }
        setProgreso((p) => p + 1)
      }
      setResultado(filaResultado)
      onListo()
      const errores = filaResultado.filter((r) => !r.ok).length
      if (errores === 0) toast.exito(`${filaResultado.length} foto(s) actualizadas`)
      else toast.error(`${errores} foto(s) con error — revisa el detalle`)
    } finally {
      setSubiendo(false)
    }
  }

  const exitosas = resultado?.filter((r) => r.ok).length ?? 0
  const fallidas = resultado?.filter((r) => !r.ok) ?? []

  return (
    <Sheet
      open={open}
      onClose={cerrar}
      title="Subir fotos del inventario"
      maxWidth="max-w-lg"
      footer={
        !resultado ? (
          <Button
            className="w-full"
            disabled={encontradas.length === 0 || leyendo}
            loading={subiendo}
            onClick={subirTodas}
          >
            <Upload className="size-4" />
            {subiendo
              ? `Subiendo ${progreso}/${encontradas.length}...`
              : encontradas.length > 0
                ? `Subir ${encontradas.length} foto(s)`
                : 'Subir'}
          </Button>
        ) : (
          <Button variant="outline" className="w-full" onClick={cerrar}>
            Cerrar
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {!resultado && (
          <>
            <div className="rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-3 text-xs text-ink-500">
              <p>
                Sube el <b>.zip</b> que descargaste con "Descargar fotos", o varias imágenes
                sueltas. Cada foto vuelve a su producto por su <b>nombre de archivo</b> (sin la
                extensión) — por eso el .zip descargado ya trae cada foto nombrada con el SKU
                correcto. Si renombras un archivo, asegúrate de dejarle el SKU exacto.
              </p>
            </div>

            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-ink-200 px-4 py-8 text-center hover:border-accent-400 hover:bg-accent-50/40">
              <input
                type="file"
                accept="image/*,.zip"
                multiple
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length > 0) elegirArchivos(files)
                  e.target.value = ''
                }}
              />
              <ImageIcon className="size-7 text-ink-300" />
              <span className="text-sm text-ink-400">
                Toca para elegir un .zip o varias fotos
              </span>
              {leyendo && <span className="text-xs text-ink-400">Leyendo archivo(s)...</span>}
            </label>

            {leidas && leidas.length > 0 && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-xl bg-accent-50 px-2 py-2.5">
                    <p className="font-display text-xl font-bold text-accent-700">{encontradas.length}</p>
                    <p className="text-[0.7rem] font-semibold uppercase text-accent-600">
                      Con producto encontrado
                    </p>
                  </div>
                  <div className="rounded-xl bg-amber-50 px-2 py-2.5">
                    <p className="font-display text-xl font-bold text-amber-700">{sinCoincidencia.length}</p>
                    <p className="text-[0.7rem] font-semibold uppercase text-amber-600">
                      Sin coincidencia
                    </p>
                  </div>
                </div>
                {sinCoincidencia.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
                      <AlertTriangle className="size-3.5" /> Ningún producto tiene este SKU:
                    </p>
                    <ul className="max-h-32 overflow-y-auto text-xs text-ink-500">
                      {sinCoincidencia.map((e, i) => (
                        <li key={i} className="truncate">
                          {e.nombreArchivo} → "{e.sku}"
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {resultado && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-accent-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-accent-700">{exitosas}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-accent-600">Actualizadas</p>
              </div>
              <div className="rounded-xl bg-red-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-red-600">{fallidas.length}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-red-500">Con error</p>
              </div>
            </div>
            {fallidas.length > 0 ? (
              <ul className="max-h-52 space-y-1 overflow-y-auto">
                {fallidas.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-xs text-red-700"
                  >
                    <XCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{r.sku}: {r.mensaje}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-accent-200 bg-accent-50 px-3.5 py-2.5 text-sm text-accent-700">
                <CheckCircle2 className="size-4 shrink-0" />
                Todas las fotos se actualizaron correctamente.
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}
