import { useState } from 'react'
import { Upload, CheckCircle2, XCircle, FileSpreadsheet, Download } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import {
  leerInventarioExcel,
  descargarPlantillaInventario,
  prepararFilasInventario,
  contarStockDistinto,
  type FilaLeida,
  type StockExistente,
} from '@/utils/inventarioExcel'

type ResultadoFila = { fila: number; sku: string; accion: string; mensaje: string | null }

const TAM_PAGINA = 1000

/** SKU -> stock vigente de TODOS los productos del sistema (activos o no: la
 * importacion tambien actualiza los inactivos). */
async function traerStockExistente(): Promise<StockExistente> {
  const mapa: StockExistente = new Map()
  for (let desde = 0; ; desde += TAM_PAGINA) {
    const { data, error } = await supabase
      .from('productos')
      .select('sku, stock_actual')
      .order('id')
      .range(desde, desde + TAM_PAGINA - 1)
    if (error) throw new Error(`No se pudo consultar el inventario actual: ${error.message}`)
    for (const p of data ?? []) mapa.set(String(p.sku).trim(), Number(p.stock_actual) || 0)
    if (!data || data.length < TAM_PAGINA) return mapa
  }
}

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
  const [filas, setFilas] = useState<FilaLeida[] | null>(null)
  const [existentes, setExistentes] = useState<StockExistente | null>(null)
  const [restaurarStock, setRestaurarStock] = useState(false)
  const [leyendo, setLeyendo] = useState(false)
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoFila[] | null>(null)

  function cerrar() {
    if (importando) return
    setArchivo(null)
    setFilas(null)
    setExistentes(null)
    setRestaurarStock(false)
    setResultado(null)
    onClose()
  }

  async function elegirArchivo(f: File) {
    setArchivo(f)
    setResultado(null)
    setFilas(null)
    setExistentes(null)
    setRestaurarStock(false)
    setLeyendo(true)
    try {
      const [leidas, stock] = await Promise.all([leerInventarioExcel(f), traerStockExistente()])
      setFilas(leidas)
      setExistentes(stock)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo leer el archivo. ¿Es un .xlsx válido?')
      setArchivo(null)
      setFilas(null)
      setExistentes(null)
    } finally {
      setLeyendo(false)
    }
  }

  async function importar() {
    if (!filas || filas.length === 0 || !existentes || importando) return
    // "Restaurar stock" deja el stock EXACTAMENTE como en el archivo: todo lo
    // vendido despues de descargarlo vuelve al inventario (ej. 50 avenas, se
    // venden 20, se importa el Excel de antes y vuelven a ser 50). Solo es
    // para migrar/restaurar un respaldo, asi que se pide confirmacion.
    if (restaurarStock) {
      const distintos = contarStockDistinto(filas, existentes)
      const ok = window.confirm(
        `Vas a REEMPLAZAR el stock de los productos por el del archivo "${archivo?.name ?? ''}".\n\n` +
          (distintos > 0
            ? `${distintos} producto(s) tienen hoy en el sistema un stock distinto al del archivo: ese stock se perderá. `
            : '') +
          'Todo lo vendido después de descargar este archivo volverá al inventario.\n\n' +
          'Hazlo SOLO si estás restaurando un respaldo o migrando a otra cuenta. ¿Continuar?',
      )
      if (!ok) return
    }
    setImportando(true)
    try {
      const { data, error } = await supabase.rpc('importar_productos', {
        p_filas: prepararFilasInventario(filas, existentes, restaurarStock),
      })
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

  const nuevosEnArchivo =
    filas && existentes ? filas.filter((f) => f.sku && !existentes.has(f.sku.trim())).length : 0
  const stockDistinto = filas && existentes ? contarStockDistinto(filas, existentes) : 0

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
            disabled={!filas || filas.length === 0 || !existentes || leyendo}
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

            {filas && filas.length > 0 && existentes && (
              <div className="space-y-2.5">
                <p className="text-center text-sm text-ink-500">
                  Se leyeron <b className="text-ink-800">{filas.length}</b> fila(s):{' '}
                  <b className="text-ink-800">{nuevosEnArchivo}</b> producto(s) nuevo(s) (se crean con
                  el stock del archivo) y <b className="text-ink-800">{filas.length - nuevosEnArchivo}</b>{' '}
                  que ya existen (se actualizan).
                </p>

                {filas.length - nuevosEnArchivo > 0 && (
                  <label
                    className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs ${
                      stockDistinto > 0
                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                        : 'border-ink-200 bg-ink-50 text-ink-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-amber-600"
                      checked={restaurarStock}
                      onChange={(e) => setRestaurarStock(e.target.checked)}
                    />
                    <span>
                      <b className="block text-sm">Restaurar stock del archivo</b>
                      Úsalo al <b>restaurar un respaldo o migrar a otra cuenta</b>: el stock de todos los
                      productos queda exactamente como en el Excel. Déjalo desmarcado en el uso diario
                      (si no editaste el stock en el Excel, se conserva el del sistema y no se pierde lo
                      vendido después de descargarlo).
                      {stockDistinto > 0 && (
                        <span className="mt-1.5 block font-semibold">
                          {stockDistinto} producto(s) tienen en el sistema un stock distinto al del
                          archivo. Si los ves "agotados" por una importación anterior, marca esta opción.
                        </span>
                      )}
                    </span>
                  </label>
                )}
              </div>
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
