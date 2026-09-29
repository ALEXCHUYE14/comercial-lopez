import { useState } from 'react'
import { Upload, CheckCircle2, XCircle, FileSpreadsheet, Download } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { leerInventarioExcel, descargarPlantillaInventario, type FilaInventario } from '@/utils/inventarioExcel'

type ResultadoFila = { fila: number; sku: string; accion: string; mensaje: string | null }

export function ImportarInventario({
  open,
  onClose,
  onListo,
}: {
  open: boolean
  onClose: () => void
  onListo: () => void
}) {
  const toast = useToast()
  const [archivo, setArchivo] = useState<File | null>(null)
  const [filas, setFilas] = useState<FilaInventario[] | null>(null)
  const [leyendo, setLeyendo] = useState(false)
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoFila[] | null>(null)

  function cerrar() {
    setArchivo(null)
    setFilas(null)
    setResultado(null)
    onClose()
  }

  async function elegirArchivo(f: File) {
    setArchivo(f)
    setResultado(null)
    setLeyendo(true)
    try {
      const leidas = await leerInventarioExcel(f)
      setFilas(leidas)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo leer el archivo. ¿Es un .xlsx válido?')
      setArchivo(null)
      setFilas(null)
    } finally {
      setLeyendo(false)
    }
  }

  async function importar() {
    if (!filas || filas.length === 0) return
    setImportando(true)
    try {
      const { data, error } = await supabase.rpc('importar_productos', { p_filas: filas })
      if (error) throw new Error(error.message)
      const filasResultado = (data ?? []) as ResultadoFila[]
      setResultado(filasResultado)
      const creados = filasResultado.filter((r) => r.accion === 'creado').length
      const actualizados = filasResultado.filter((r) => r.accion === 'actualizado').length
      const errores = filasResultado.filter((r) => r.accion === 'error').length
      onListo()
      if (errores === 0) {
        toast.exito(`Importación lista: ${creados} creado(s), ${actualizados} actualizado(s).`)
      } else {
        toast.error(`Importación con ${errores} fila(s) con error — revisa el detalle abajo.`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo importar el archivo')
    } finally {
      setImportando(false)
    }
  }

  const creados = resultado?.filter((r) => r.accion === 'creado').length ?? 0
  const actualizados = resultado?.filter((r) => r.accion === 'actualizado').length ?? 0
  const errores = resultado?.filter((r) => r.accion === 'error') ?? []

  return (
    <Sheet
      open={open}
      onClose={cerrar}
      title="Importar inventario desde Excel"
      maxWidth="max-w-lg"
      footer={
        !resultado ? (
          <Button
            className="w-full"
            disabled={!filas || filas.length === 0 || leyendo}
            loading={importando}
            onClick={importar}
          >
            <Upload className="size-4" />
            {filas ? `Importar ${filas.length} fila(s)` : 'Importar'}
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
                Sube un archivo <b>.xlsx</b> con las mismas columnas que genera el botón
                "Exportar Excel" del inventario — es la forma más segura de editarlo, porque ya
                trae el formato correcto.
              </p>
              <p className="mt-1.5">
                El <b>SKU</b> identifica cada fila: si ya existe un producto con ese SKU se{' '}
                <b>actualiza</b>; si no existe, se <b>crea</b>. Una celda vacía nunca borra un
                dato existente, solo lo deja tal cual.
              </p>
              <button
                type="button"
                onClick={() => {
                  descargarPlantillaInventario().catch(() =>
                    toast.error('No se pudo generar la plantilla'),
                  )
                }}
                className="mt-2 flex items-center gap-1.5 font-semibold text-accent-700 hover:underline"
              >
                <Download className="size-3.5" /> Descargar plantilla de ejemplo
              </button>
            </div>

            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-ink-200 px-4 py-8 text-center hover:border-accent-400 hover:bg-accent-50/40">
              <input
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) elegirArchivo(f)
                  e.target.value = ''
                }}
              />
              <FileSpreadsheet className="size-7 text-ink-300" />
              {archivo ? (
                <span className="text-sm font-semibold text-ink-700">{archivo.name}</span>
              ) : (
                <span className="text-sm text-ink-400">Toca para elegir un archivo .xlsx</span>
              )}
              {leyendo && <span className="text-xs text-ink-400">Leyendo archivo...</span>}
            </label>

            {filas && filas.length > 0 && (
              <p className="text-center text-sm text-ink-500">
                Se leyeron <b className="text-ink-800">{filas.length}</b> fila(s). Revisa el
                nombre del archivo y toca "Importar" para continuar.
              </p>
            )}
          </>
        )}

        {resultado && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-accent-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-accent-700">{creados}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-accent-600">Creados</p>
              </div>
              <div className="rounded-xl bg-sky-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-sky-700">{actualizados}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-sky-600">Actualizados</p>
              </div>
              <div className="rounded-xl bg-red-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-red-600">{errores.length}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-red-500">Con error</p>
              </div>
            </div>

            {errores.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-ink-500">Filas que no se importaron:</p>
                <ul className="max-h-52 space-y-1 overflow-y-auto">
                  {errores.map((e, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-xs text-red-700"
                    >
                      <XCircle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Fila {e.fila}
                        {e.sku && <> ({e.sku})</>}: {e.mensaje}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-ink-400">
                  Corrige esas filas en el Excel y vuelve a subir solo ese archivo — las filas
                  que sí se importaron no se van a duplicar ni a repetir.
                </p>
              </div>
            )}
            {errores.length === 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-accent-200 bg-accent-50 px-3.5 py-2.5 text-sm text-accent-700">
                <CheckCircle2 className="size-4 shrink-0" />
                Todas las filas se importaron correctamente.
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}
