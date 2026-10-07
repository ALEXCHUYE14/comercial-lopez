import { useState } from 'react'
import { Upload, CheckCircle2, XCircle, FileSpreadsheet } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { leerClientesExcel, type FilaCliente } from '@/utils/clientesExcel'

type ErrorFila = { fila: number; nombre: string; mensaje: string }
type ResultadoImportacion = {
  ok: boolean
  creados: number
  actualizados: number
  errores: ErrorFila[]
}

export function ImportarClientes({
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
  const [filas, setFilas] = useState<FilaCliente[] | null>(null)
  const [leyendo, setLeyendo] = useState(false)
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoImportacion | null>(null)

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
      setFilas(await leerClientesExcel(f))
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
      const payload = filas.map((f) => ({
        fila: f.fila,
        id: f.id,
        nombre: f.nombre,
        telefono: f.telefono,
        direccion: f.direccion,
        limite_credito: f.limite_credito,
        deuda_inicial: f.deuda_inicial,
        activo: f.activo,
      }))
      const { data, error } = await supabase.rpc('importar_clientes', { p_filas: payload })
      if (error) throw new Error(error.message)
      const res = data as unknown as ResultadoImportacion
      setResultado(res)
      if (res.ok) {
        onListo()
        toast.exito(`Importación lista: ${res.creados} creado(s), ${res.actualizados} actualizado(s).`)
      } else {
        toast.error(`No se guardó nada: ${res.errores.length} fila(s) con error.`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo importar el archivo')
    } finally {
      setImportando(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={cerrar}
      title="Importar clientes desde Excel"
      maxWidth="max-w-lg"
      footer={
        !resultado || !resultado.ok ? (
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={cerrar}>
              Cancelar
            </Button>
            <Button
              className="flex-1"
              disabled={!filas || filas.length === 0 || leyendo || importando}
              loading={importando}
              onClick={importar}
            >
              <Upload className="size-4" />
              {filas ? `Importar ${filas.length} fila(s)` : 'Importar'}
            </Button>
          </div>
        ) : (
          <Button variant="outline" className="w-full" onClick={cerrar}>
            Cerrar
          </Button>
        )
      }
    >
      <div className="space-y-4">
        {!resultado?.ok && (
          <>
            <div className="rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-3 text-xs text-ink-500">
              <p>
                Usa un archivo <b>.xlsx</b> con las columnas que genera "Exportar". Si una fila tiene
                <b> ID</b>, se actualiza ese cliente; si la columna ID está vacía, se crea uno nuevo.
              </p>
              <p className="mt-1.5">
                <b>Importación todo o nada:</b> si alguna fila tiene error, no se guarda ninguna y
                verás el detalle de cada una.
              </p>
              <p className="mt-1.5">
                Si el cliente <b>ya existe</b> (tiene ID), su deuda actual no se toca: se ignora a
                propósito para no alterar saldos. Si es un cliente <b>nuevo</b> (sin ID), puedes usar la
                columna <b>Deuda inicial</b> para traer el saldo que ya tenía (por ejemplo, al migrar
                desde otro sistema) sin registrar ninguna venta ni descontar stock.
              </p>
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
                Se leyeron <b className="text-ink-800">{filas.length}</b> fila(s). Toca "Importar" para
                continuar.
              </p>
            )}
          </>
        )}

        {resultado && !resultado.ok && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-red-700">
              No se guardó ningún cliente. Corrige estas filas en el Excel y vuelve a subirlo:
            </p>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {resultado.errores.map((e, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-xs text-red-700"
                >
                  <XCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Línea {e.fila}
                    {e.nombre && <> ({e.nombre})</>}: {e.mensaje}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {resultado?.ok && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl bg-accent-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-accent-700">{resultado.creados}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-accent-600">Creados</p>
              </div>
              <div className="rounded-xl bg-sky-50 px-2 py-2.5">
                <p className="font-display text-xl font-bold text-sky-700">{resultado.actualizados}</p>
                <p className="text-[0.7rem] font-semibold uppercase text-sky-600">Actualizados</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-accent-200 bg-accent-50 px-3.5 py-2.5 text-sm text-accent-700">
              <CheckCircle2 className="size-4 shrink-0" />
              Todas las filas se importaron correctamente.
            </div>
          </div>
        )}
      </div>
    </Sheet>
  )
}
