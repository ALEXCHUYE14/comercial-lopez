// Supabase (PostgREST) devuelve como MAXIMO 1000 filas por consulta, aunque
// se pida .limit(3000) o .limit(20000): el resto se descarta EN SILENCIO, sin
// error. En reportes por semana/mes (historial de ventas, rentabilidad,
// dashboard, auditoria) eso hacia "desaparecer" ventas y daba totales menores
// a los reales. Esta funcion trae TODAS las filas pidiendolas de a paginas.
//
// IMPORTANTE para quien la use: la consulta debe tener un orden estable y
// creciente (ej. .order('creado_en').order('id')) para que una venta nueva
// registrada mientras se pagina no desplace filas entre paginas; de todos
// modos se descartan duplicados por "id".

const TAM_PAGINA = 1000
// Tope de seguridad (200.000 filas) para no colgar el navegador ante un
// error de programacion que repita siempre la misma pagina.
const MAX_PAGINAS = 200

type Respuesta<T> = { data: T[] | null; error: { message: string } | null }

export async function traerTodas<T>(
  consulta: (desde: number, hasta: number) => PromiseLike<Respuesta<T>>,
): Promise<T[]> {
  const todas: T[] = []
  const vistos = new Set<unknown>()
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const desde = pagina * TAM_PAGINA
    const { data, error } = await consulta(desde, desde + TAM_PAGINA - 1)
    if (error) throw new Error(error.message)
    const filas = data ?? []
    for (const fila of filas) {
      const id = (fila as { id?: unknown })?.id
      if (id !== undefined) {
        if (vistos.has(id)) continue
        vistos.add(id)
      }
      todas.push(fila)
    }
    if (filas.length < TAM_PAGINA) break
  }
  return todas
}
