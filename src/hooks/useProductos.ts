import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import type { Categoria, Producto } from '@/types/database'

// Supabase (PostgREST) devuelve como maximo 1000 filas por consulta: con mas
// productos que eso, los que quedaban fuera simplemente no aparecian (ni se
// actualizaban) en el POS. Se piden en paginas hasta traerlos todos.
const TAM_PAGINA = 1000

// Plan Free de Supabase (trafico y mensajes limitados): mientras el tiempo
// real funcione, los cambios de precio/stock llegan solos y recargar la lista
// completa es trafico desperdiciado. Solo se recarga todo cuando la vista PUDO
// quedar desactualizada: el canal se cayo (internet intermitente, equipo
// suspendido) o se recupero la conexion. Como red de seguridad, al volver a la
// pantalla se recarga tambien si la ultima carga completa tiene mas de 30 min.
const RECARGA_RESPALDO_MS = 30 * 60_000

async function traerTodosLosProductos(): Promise<Producto[]> {
  const todos: Producto[] = []
  for (let desde = 0; ; desde += TAM_PAGINA) {
    const { data, error } = await supabase
      .from('productos')
      .select('*, categorias(*)')
      .eq('activo', true)
      .order('nombre')
      .order('id')
      .range(desde, desde + TAM_PAGINA - 1)
    if (error) throw error
    todos.push(...((data ?? []) as Producto[]))
    if (!data || data.length < TAM_PAGINA) return todos
  }
}

/** true si `a` es una version MAS NUEVA que `b` del mismo producto. */
function esMasNuevo(a: Producto, b: Producto): boolean {
  const ta = Date.parse(a.actualizado_en)
  const tb = Date.parse(b.actualizado_en)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb
}

export function useProductos() {
  const [productos, setProductos] = useState<Producto[]>([])
  const [categorias, setCategorias] = useState<Categoria[]>([])
  const [cargando, setCargando] = useState(true)
  const categoriasRef = useRef<Categoria[]>([])
  const ultimaRecargaRef = useRef(0)
  // true = pudieron perderse cambios en tiempo real desde la ultima carga.
  const desfaseRef = useRef(false)
  const peticionRef = useRef(0)

  const cargar = useCallback(async () => {
    const id = ++peticionRef.current
    ultimaRecargaRef.current = Date.now()
    try {
      const [prods, catRes] = await Promise.all([
        traerTodosLosProductos(),
        supabase.from('categorias').select('*').order('nombre'),
      ])
      // Una recarga mas reciente ya esta en camino: esta respuesta es vieja.
      if (id !== peticionRef.current) return
      desfaseRef.current = false
      if (!catRes.error) {
        categoriasRef.current = catRes.data ?? []
        setCategorias(catRes.data ?? [])
      }
      setProductos((prev) => {
        // Un cambio que llego por realtime MIENTRAS esta consulta viajaba es
        // mas nuevo que lo que trajo la consulta: no se debe pisar con el dato
        // viejo (seria justo un precio/stock "desactualizado").
        const previos = new Map(prev.map((p) => [p.id, p]))
        return prods.map((p) => {
          const actual = previos.get(p.id)
          return actual && esMasNuevo(actual, p) ? { ...actual, categorias: p.categorias } : p
        })
      })
    } catch {
      // Sin conexion o error del servidor: se CONSERVA la lista que ya habia
      // (antes se vaciaba y el POS quedaba sin productos). Se reintenta al
      // volver la conexion o al regresar a la app.
    } finally {
      if (id === peticionRef.current) setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()

    let suscritoAntes = false
    // Nombre unico por instancia: varias pantallas montadas a la vez no deben
    // compartir (ni cerrarse entre si) el mismo canal.
    const canal = supabase
      .channel(`rt-productos-${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'productos' },
        (payload) => {
          setProductos((prev) => {
            if (payload.eventType === 'DELETE') {
              return prev.filter((p) => p.id !== (payload.old as Producto).id)
            }
            const nuevo = payload.new as Producto
            if (!nuevo?.id) return prev
            if (!nuevo.activo) return prev.filter((p) => p.id !== nuevo.id)
            const previo = prev.find((p) => p.id === nuevo.id)
            // Un evento atrasado nunca debe revertir un dato mas reciente.
            if (previo && esMasNuevo(previo, nuevo)) return prev
            // El evento no trae la categoria embebida: se toma de la lista de
            // categorias (por si cambio de categoria) o se conserva la previa.
            const categoria =
              categoriasRef.current.find((c) => c.id === nuevo.categoria_id) ??
              (previo?.categoria_id === nuevo.categoria_id ? previo?.categorias : null) ??
              null
            const fusion = { ...nuevo, categorias: categoria }
            return previo
              ? prev.map((p) => (p.id === nuevo.id ? fusion : p))
              : [...prev, fusion].sort((a, b) => a.nombre.localeCompare(b.nombre))
          })
        },
      )
      .subscribe((estado) => {
        // Mientras el canal estuvo caido (internet intermitente, equipo
        // suspendido, pestaña en segundo plano) los cambios de precio/stock
        // de ese lapso se PERDIERON — realtime no los reenvia. Al volver a
        // suscribirse se recarga todo para no quedarse con datos viejos.
        if (estado === 'SUBSCRIBED') {
          if (suscritoAntes || desfaseRef.current) cargar()
          suscritoAntes = true
        } else if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT' || estado === 'CLOSED') {
          desfaseRef.current = true
        }
      })

    function recargarSiHaceFalta() {
      if (document.visibilityState !== 'visible') return
      const vieja = Date.now() - ultimaRecargaRef.current > RECARGA_RESPALDO_MS
      if (desfaseRef.current || vieja) cargar()
    }
    function alRecuperarInternet() {
      desfaseRef.current = true
      recargarSiHaceFalta()
    }
    document.addEventListener('visibilitychange', recargarSiHaceFalta)
    window.addEventListener('online', alRecuperarInternet)
    window.addEventListener('focus', recargarSiHaceFalta)

    return () => {
      document.removeEventListener('visibilitychange', recargarSiHaceFalta)
      window.removeEventListener('online', alRecuperarInternet)
      window.removeEventListener('focus', recargarSiHaceFalta)
      supabase.removeChannel(canal)
    }
  }, [cargar])

  return { productos, categorias, cargando, recargar: cargar }
}
