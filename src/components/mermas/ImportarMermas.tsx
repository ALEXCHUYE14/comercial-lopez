import { useState } from 'react'
import { Upload, CheckCircle2, XCircle, FileSpreadsheet, Download, AlertTriangle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { funcionNoExiste } from '@/hooks/useMermas'
import { leerMermasExcel, descargarPlantillaMermas, type FilaMerma } from '@/utils/mermasExcel'

type ResultadoFila = { fila: number; producto: string; accion: string; mensaje: string | null }

export function ImportarMermas({
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
  const [filas, setFilas] = useState<FilaMerma[] | null>(null)
  const [leyendo, setLeyendo] = useState(false)
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoFila[] | null>(null)

  function cerrar() {
    if (importando) return
    setArchivo(null)
    setFilas(null)
    setResultado(null)
    onClose()
  }

  async function elegirArchivo(f: File) {
    setArchivo(f)
    setResultado(null)
    setFilas(null)
    setLeyendo(true)
    try {
      setFilas(await leerMermasExcel(f))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo leer el archivo. ¿Es un .xlsx válido?')
      setArchivo(null)
    } finally {
      setLeyendo(false)
    }
  }

  async function importar() {
    if (!filas || filas.length === 0 || importando) return
    setImportando(true)
    try {
      const { data, error } = await supabase.rpc('importar_mermas', { p_filas: filas })
      if (error) {
        throw new Error(
          funcionNoExiste(error)
            ? 'Falta actualizar la base de datos: ejecuta el archivo supabase/mermas_excel.sql en el SQL Editor de Supabase.'
            : error.message,
        )
      }
      const r = (data ?? []) as ResultadoFila[]
      setResultado(r)
      onListo()
      const errores = r.filter((x) => x.accion === 'error').length
      if (errores === 0) toast.exito('Importación de mermas lista.')
      else toast.error(`Importación con ${errores} fila(s) con error — revisa el detalle.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo importar el archivo')
    } finally {
      setImportando(false)
    }
  }

  const conId = filas?.filter((f) => f.id).length ?? 0
  const sinId = (filas?.length ?? 0) - conId

  const cuenta = (accion: string) => resultado?.filter((r) => r.accion === accion).length ?? 0
  const errores = resultado?.filter((r) => r.accion === 'error') ?? []
  const avisos = resultado?.filter((r) => r.accion !== 'error' && r.mensaje) ?? []

  return (
    <Sheet
      open={open}
      onClose={cerrar}
      title="Importar mermas desde Excel"
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
            <div className="space-y-1.5 rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-3 text-xs text-ink-600">
              <p>
                Sube un archivo <b>.xlsx</b> con las columnas que genera <b>"Exportar Excel"</b> de
                Mermas.
              </p>
              <p>
                <b>Filas con ID</b> (del archivo exportado): se <b>restauran</b> como respaldo,{' '}
                <b>sin tocar el stock</b>. Si ya existen, se omiten — subir el mismo respaldo dos
                veces no duplica nada.
              </p>
              <p>
                <b>Filas sin ID</b> (mermas nuevas): se <b>registran</b> y{' '}
                <b>descuentan el stock</b> del producto (se busca por SKU, o por nombre exacto).
              </p>
              <button
                type="button"
                onClick={() => {
                  descargarPlantillaMermas().catch(() => toast.error('No se pudo generar la plantilla'))
                }}
                className="flex items-center gap-1.5 pt-1 font-semibold text-accent-700 hover:underline"
              >
                <Download className="size-3.5" /> Descargar plantilla de ejemplo
              </button>
            </div>

            <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-ink-200 px-4 py-8 text-center hover:border-accent-400 hover:bg-accent-50/40">
              <input
                type="file"
                accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                disabled={importando}
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
              <div className="space-y-2 text-sm text-ink-600">
                <p className="text-center">
                  Se leyeron <b className="text-ink-900">{filas.length}</b> fila(s):{' '}
                  <b className="text-ink-900">{conId}</b> de respaldo (no tocan stock) y{' '}
                  <b className="text-ink-900">{sinId}</b> nueva(s).
                </p>
                {sinId > 0 && (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span>
                      Las {sinId} merma(s) nuevas <b>descontarán stock</b>. Para evitar registrarlas
                      dos veces, ponles fecha: si ya existe una merma igual en la misma fecha, se
                      omite.
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {resultado && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 text-center">
              <Contador valor={cuenta('registrada')} etiqueta="Nuevas" tono="accent" />
              <Contador valor={cuenta('restaurada')} etiqueta="Restauradas" tono="sky" />
              <Contador valor={cuenta('omitida')} etiqueta="Omitidas" tono="ink" />
              <Contador valor={errores.length} etiqueta="Con error" tono="red" />
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
                        {e.producto && <> ({e.producto})</>}: {e.mensaje}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-ink-400">
                  Corrige esas filas y vuelve a subir el archivo: las que ya se importaron se
                  omiten (las de respaldo por su ID; las nuevas, si tienen fecha).
                </p>
              </div>
            )}

            {avisos.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto">
                {avisos.map((a, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Fila {a.fila}
                      {a.producto && <> ({a.producto})</>}: {a.mensaje}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {errores.length === 0 && (
              <div className="flex items-center gap-2 rounded-xl border border-accent-200 bg-accent-50 px-3.5 py-2.5 text-sm text-accent-700">
                <CheckCircle2 className="size-4 shrink-0" />
                Todas las filas se procesaron correctamente.
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  )
}

const TONOS = {
  accent: 'bg-accent-50 text-accent-700',
  sky: 'bg-sky-50 text-sky-700',
  ink: 'bg-ink-50 text-ink-700',
  red: 'bg-red-50 text-red-600',
} as const

function Contador({ valor, etiqueta, tono }: { valor: number; etiqueta: string; tono: keyof typeof TONOS }) {
  return (
    <div className={`rounded-xl px-1 py-2.5 ${TONOS[tono]}`}>
      <p className="font-display text-xl font-bold">{valor}</p>
      <p className="text-[0.62rem] font-semibold uppercase">{etiqueta}</p>
    </div>
  )
}
