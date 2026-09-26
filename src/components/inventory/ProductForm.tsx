import { useEffect, useRef, useState } from 'react'
import { Camera, Upload, X, ScanLine, Plus, Trash2 } from 'lucide-react'
import { Sheet } from '@/components/ui/Sheet'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { CameraScanner } from '@/components/pos/CameraScanner'
import { useProductoImagen } from '@/hooks/useProductoImagen'
import { supabase } from '@/lib/supabase'
import { cx, cantidad } from '@/utils/format'
import { beepExito, desbloquearAudioScanner } from '@/utils/beep'
import {
  CATALOGO_PRESENTACIONES,
  clavesDisponibles,
  clavePersonalizada,
  esClaveConocida,
  esClavePersonalizada,
  factorSugerido,
  filasFaltantesPlantillaHuevos,
  presentacionesDe,
} from '@/utils/presentaciones'
import type { Categoria, ClavePresentacion, Presentacion, Producto, TipoVenta } from '@/types/database'

const UNIDADES_GRANEL = ['kg', 'g', 'litro', 'ml', 'arroba', 'paquete']
// "paquete" aparece en ambas listas a propósito: puede ser una pieza entera
// (tipo_venta 'unidad', ej. una bolsa de fideos que se vende cerrada) o una
// unidad base fraccionable (tipo_venta 'granel', ej. medio/cuarto de paquete).
const UNIDADES_UNIDAD = ['unidad', 'paquete', 'caja', 'docena']

// Estado del formulario para las presentaciones adicionales (arroba, medio
// kilo, docena, ...): los campos se guardan como texto (como el resto del form)
// y se validan/convierten a número recién al guardar.
type EstadoPres = { on: boolean; factor: string; precio: string }
type EstadoPresentaciones = Record<ClavePresentacion, EstadoPres>

const presInicial = (): EstadoPresentaciones => ({
  arroba: { on: false, factor: '', precio: '' },
  medio_kilo: { on: false, factor: '', precio: '' },
  cuarto_kilo: { on: false, factor: '', precio: '' },
  octavo_kilo: { on: false, factor: '', precio: '' },
  paquete: { on: false, factor: '', precio: '' },
  medio_paquete: { on: false, factor: '', precio: '' },
  cuarto_paquete: { on: false, factor: '', precio: '' },
  docena: { on: false, factor: '', precio: '' },
  media_docena: { on: false, factor: '', precio: '' },
  cuarto_docena: { on: false, factor: '', precio: '' },
  media_caja: { on: false, factor: '', precio: '' },
})

function presDesdeProducto(p: Producto): EstadoPresentaciones {
  const estado = presInicial()
  for (const x of presentacionesDe(p)) {
    if (esClaveConocida(x.clave)) estado[x.clave] = { on: true, factor: String(x.factor), precio: String(x.precio) }
  }
  return estado
}

// ── Presentaciones personalizadas (jerarquías de empaque propias del negocio,
// ej. "Bolsa" = 10 unidades, "Paquete Maestro" = 5 bolsas = 50 unidades) ──
// A diferencia de las fijas de arriba (interruptores con claves conocidas de
// antemano), estas son filas libres: nombre, equivalencia y precio, todos
// escritos por quien registra el producto. `id` identifica la fila en el
// formulario; si la fila viene de una presentación YA guardada, `id` es su
// clave persistida (siempre empieza con "personalizada__", ver
// utils/presentaciones.ts) para no generar una clave nueva en cada edición.
// Si es una fila agregada en esta misma sesión, `id` es un contador local que
// nunca coincide con ese prefijo, y recién al guardar se le genera una clave
// estable con clavePersonalizada().
type FilaPersonalizada = { id: string; nombre: string; factor: string; precio: string }

let contadorFilaNueva = 0
function idFilaNueva(): string {
  contadorFilaNueva += 1
  return `nueva_${contadorFilaNueva}`
}

function personalizadasDesdeProducto(p: Producto): FilaPersonalizada[] {
  return presentacionesDe(p)
    .filter((x) => !esClaveConocida(x.clave))
    .map((x) => ({ id: x.clave, nombre: x.nombre, factor: String(x.factor), precio: String(x.precio) }))
}

interface Props {
  open: boolean
  onClose: () => void
  producto: Producto | null
  categorias: Categoria[]
  onGuardado: () => void
  /** Precarga el SKU al crear un producto nuevo (ej. desde un escaneo que no
   * encontró coincidencia). Se ignora si `producto` no es null (edición). */
  skuInicial?: string
}

function mensajeDeError(e: unknown): string {
  if (e instanceof Error) {
    const hint = (e as { hint?: string }).hint
    return hint ? `${e.message} (${hint})` : e.message
  }
  return 'Error al guardar'
}

const vacio = {
  sku: '',
  nombre: '',
  categoria_id: '',
  precio_compra: '',
  precio_venta: '',
  stock_actual: '',
  stock_minimo: '5',
  unidad: 'unidad',
  image_url: '',
  unidades_por_caja: '',
  precio_venta_caja: '',
  kg_por_saco: '',
  precio_venta_saco: '',
}

export function ProductForm({ open, onClose, producto, categorias, onGuardado, skuInicial }: Props) {
  const toast = useToast()
  const { subiendo, subir } = useProductoImagen()
  const nombreRef = useRef<HTMLInputElement>(null)
  const [f, setF] = useState(vacio)
  const [guardando, setGuardando] = useState(false)
  const [scannerSku, setScannerSku] = useState(false)
  const [tieneCaja, setTieneCaja] = useState(false)
  const [tieneSaco, setTieneSaco] = useState(false)
  const [tipoVenta, setTipoVenta] = useState<TipoVenta>('unidad')
  const [pres, setPres] = useState<EstadoPresentaciones>(presInicial)
  const [personalizadas, setPersonalizadas] = useState<FilaPersonalizada[]>([])
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [arrastrando, setArrastrando] = useState(false)

  const esGranel = tipoVenta === 'granel'

  useEffect(() => {
    if (producto) {
      setF({
        sku: producto.sku,
        nombre: producto.nombre,
        categoria_id: producto.categoria_id ?? '',
        precio_compra: String(producto.precio_compra),
        precio_venta: String(producto.precio_venta),
        stock_actual: String(producto.stock_actual),
        stock_minimo: String(producto.stock_minimo),
        unidad: producto.unidad,
        image_url: producto.image_url ?? '',
        unidades_por_caja: String(producto.unidades_por_caja ?? ''),
        precio_venta_caja: String(producto.precio_venta_caja ?? ''),
        kg_por_saco: String(producto.kg_por_saco ?? ''),
        precio_venta_saco: String(producto.precio_venta_saco ?? ''),
      })
      setTieneCaja(producto.tiene_caja)
      setTieneSaco(producto.tiene_saco)
      setTipoVenta(producto.tipo_venta ?? 'unidad')
      setPres(presDesdeProducto(producto))
      setPersonalizadas(personalizadasDesdeProducto(producto))
    } else {
      setF(skuInicial ? { ...vacio, sku: skuInicial } : vacio)
      setTieneCaja(false)
      setTieneSaco(false)
      setTipoVenta('unidad')
      setPres(presInicial())
      setPersonalizadas([])
      // Si llega un SKU precargado (viene de un escaneo sin coincidencia),
      // el usuario ya no necesita tocar ese campo: pasa el foco directo al
      // nombre, igual que hace onSkuDetectado tras escanear dentro del form.
      if (skuInicial) setTimeout(() => nombreRef.current?.focus(), 120)
    }
    setImageFile(null)
    setImagePreview(null)
    setScannerSku(false)
  }, [producto, open, skuInicial])

  function set<K extends keyof typeof vacio>(k: K, v: string) {
    setF((prev) => ({ ...prev, [k]: v }))
  }

  function elegirTipoVenta(t: TipoVenta) {
    setTipoVenta(t)
    if (t === 'granel') {
      // Un producto a granel no se vende ademas por caja: son dos formas
      // distintas de fraccionar el mismo stock.
      setTieneCaja(false)
      if (!UNIDADES_GRANEL.includes(f.unidad)) set('unidad', 'kg')
    } else {
      // "Venta por saco" solo aplica a granel.
      setTieneSaco(false)
      // "paquete" es valida en ambas listas (ver UNIDADES_GRANEL/UNIDADES_UNIDAD
      // arriba): solo se resetea la unidad si NO es valida para el nuevo tipo,
      // para no perder la eleccion del usuario al alternar el interruptor.
      if (!UNIDADES_UNIDAD.includes(f.unidad)) set('unidad', 'unidad')
    }
  }

  // Al activar una presentación se sugiere su equivalencia según la unidad base
  // (ej. arroba = 11.5 si la base es kg); si no hay sugerencia queda vacía para
  // que se escriba a mano.
  function alternarPres(clave: ClavePresentacion) {
    setPres((prev) => {
      const actual = prev[clave]
      if (actual.on) return { ...prev, [clave]: { ...actual, on: false } }
      // "Media caja" no tiene una equivalencia universal por unidad base (a
      // diferencia de arroba/docena): se sugiere la mitad del tamaño de caja
      // YA configurado para este producto (unidades_por_caja). Si ese campo
      // todavía está vacío, no hay nada que sugerir y se deja en blanco.
      let sugerido = factorSugerido(clave, f.unidad)
      if (clave === 'media_caja') {
        const upc = parseInt(f.unidades_por_caja, 10)
        sugerido = Number.isFinite(upc) && upc > 0 ? upc / 2 : null
      }
      return {
        ...prev,
        [clave]: { ...actual, on: true, factor: actual.factor || (sugerido !== null ? String(sugerido) : '') },
      }
    })
  }

  function setPresCampo(clave: ClavePresentacion, campo: 'factor' | 'precio', valor: string) {
    setPres((prev) => ({ ...prev, [clave]: { ...prev[clave], [campo]: valor } }))
  }

  function agregarPersonalizada() {
    setPersonalizadas((prev) => [...prev, { id: idFilaNueva(), nombre: '', factor: '', precio: '' }])
  }

  // Plantilla de huevos: activa Docena (12) y Media docena (6) — presentaciones
  // fijas que ya existían — y agrega como personalizadas Media plancha, Plancha,
  // Medio ciento, Ciento, Media jaba y Jaba (ver PLANTILLA_HUEVOS). Solo agrega
  // lo que falta: lo que ya estaba configurado (con sus precios) no se toca, y
  // aplicarla dos veces no duplica filas. Los precios quedan vacíos a propósito
  // (los define el negocio); al guardar, cada presentación exige su precio, y
  // las que no se vendan se quitan con el botón de basura.
  function aplicarPlantillaHuevos() {
    // Las equivalencias de la plantilla están en UNIDADES: con otra unidad base
    // (kg, paquete, ...) quedarían mal. El botón ya se oculta en esos casos;
    // esta guarda protege por si cambia la unidad con el formulario abierto.
    if (esGranel || f.unidad !== 'unidad') {
      toast.error('La plantilla de huevos requiere venta "Por unidad" con unidad base "unidad".')
      return
    }
    setPres((prev) => {
      const siguiente = { ...prev }
      for (const clave of ['docena', 'media_docena'] as const) {
        if (siguiente[clave].on) continue
        const sugerido = factorSugerido(clave, 'unidad')
        siguiente[clave] = {
          ...siguiente[clave],
          on: true,
          factor: siguiente[clave].factor || (sugerido !== null ? String(sugerido) : ''),
        }
      }
      return siguiente
    })
    setPersonalizadas((prev) => [
      ...prev,
      ...filasFaltantesPlantillaHuevos(prev.map((p) => p.nombre)).map((p) => ({
        id: idFilaNueva(),
        nombre: p.nombre,
        factor: String(p.factor),
        precio: '',
      })),
    ])
    toast.exito('Plantilla de huevos aplicada: completa el precio de cada presentación o quita las que no uses.')
  }

  function quitarPersonalizada(id: string) {
    setPersonalizadas((prev) => prev.filter((f) => f.id !== id))
  }

  function setCampoPersonalizada(id: string, campo: 'nombre' | 'factor' | 'precio', valor: string) {
    setPersonalizadas((prev) => prev.map((f) => (f.id === id ? { ...f, [campo]: valor } : f)))
  }

  function onSkuDetectado(codigo: string) {
    beepExito()
    set('sku', codigo.trim())
    setScannerSku(false)
    if ('vibrate' in navigator) navigator.vibrate([30, 30, 30])
    setTimeout(() => nombreRef.current?.focus(), 120)
  }

  function seleccionarImagen(file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error('Solo se aceptan archivos de imagen.')
      return
    }
    // Sin limite de peso: cualquier foto (incluso 10-15 MB de una camara de
    // celular moderna) se comprime automaticamente a ~80-150KB en subir()
    // (ver useProductoImagen.ts) antes de subirla. Bloquear aqui por tamano
    // del archivo original rechazaba justo las fotos de camara que esa
    // compresion existe para manejar.
    setImageFile(file)
    const prev = imagePreview
    if (prev) URL.revokeObjectURL(prev)
    setImagePreview(URL.createObjectURL(file))
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setArrastrando(false)
    const file = e.dataTransfer.files[0]
    if (file) seleccionarImagen(file)
  }

  async function guardar() {
    if (!f.sku.trim() || !f.nombre.trim()) {
      toast.error('SKU y nombre son obligatorios.')
      return
    }

    // Equivalencias (unidades por caja, kg por saco, etc.) y precios de cada
    // presentación: solo valores finitos y mayores a 0. Un 0 o un negativo aquí
    // se traduciría en ventas que descuentan mal el stock o cobran S/ 0.
    if (!esGranel && tieneCaja) {
      if (!((parseInt(f.unidades_por_caja) || 0) >= 1)) {
        toast.error('Indica cuántas unidades trae la caja (mínimo 1).')
        return
      }
      if (!((parseFloat(f.precio_venta_caja) || 0) > 0)) {
        toast.error('Indica el precio de la caja (mayor a 0).')
        return
      }
    }
    if (esGranel && tieneSaco) {
      if (!((parseFloat(f.kg_por_saco) || 0) > 0)) {
        toast.error(`Indica cuántos ${f.unidad} trae el saco (mayor a 0).`)
        return
      }
      if (!((parseFloat(f.precio_venta_saco) || 0) > 0)) {
        toast.error('Indica el precio del saco (mayor a 0).')
        return
      }
    }
    const presentaciones: Presentacion[] = []
    for (const clave of clavesDisponibles(tipoVenta, f.unidad, tieneCaja)) {
      const e = pres[clave]
      if (!e.on) continue
      const nombre = CATALOGO_PRESENTACIONES[clave].nombre
      // Se redondea ANTES de validar: un valor diminuto (ej. 1e-9) no debe
      // pasar como "mayor a 0" y luego guardarse como 0.
      const factor = Math.round(parseFloat(e.factor) * 1e6) / 1e6
      const precio = Math.round(parseFloat(e.precio) * 100) / 100
      if (!Number.isFinite(factor) || factor <= 0) {
        toast.error(`${nombre}: indica cuántos ${esGranel ? f.unidad : 'unidades'} contiene (mayor a 0).`)
        return
      }
      if (!Number.isFinite(precio) || precio <= 0) {
        toast.error(`${nombre}: indica el precio (mayor a 0).`)
        return
      }
      presentaciones.push({ clave, nombre, factor, precio })
    }

    // Presentaciones PERSONALIZADAS (jerarquías de empaque propias del
    // negocio: "Bolsa", "Paquete Maestro", ...). Antes de aceptarlas: nombre
    // no vacío, sin choque de nombre con otra opción ya ofrecida (evita dos
    // opciones idénticas confundiendo al cajero en el punto de venta), y la
    // misma validación de equivalencia/precio que las fijas de arriba.
    const nombresUsados = new Set<string>([(esGranel ? `por ${f.unidad}` : 'unidad').toLowerCase()])
    if (!esGranel && tieneCaja) nombresUsados.add('caja')
    if (esGranel && tieneSaco) nombresUsados.add('saco')
    for (const p of presentaciones) nombresUsados.add(p.nombre.toLowerCase())

    const clavesExistentes = new Set(presentaciones.map((p) => p.clave))
    for (const fila of personalizadas) {
      const nombreFila = fila.nombre.trim()
      // Una fila que se agregó y se dejó completamente vacía se ignora sin
      // bloquear el guardado (el usuario pudo tocar "Agregar" por error).
      if (!nombreFila && !fila.factor.trim() && !fila.precio.trim()) continue
      if (!nombreFila) {
        toast.error('Cada presentación personalizada necesita un nombre.')
        return
      }
      if (nombreFila.length > 40) {
        toast.error(`"${nombreFila}": el nombre es muy largo (máximo 40 caracteres).`)
        return
      }
      const nombreNorm = nombreFila.toLowerCase()
      if (nombresUsados.has(nombreNorm)) {
        toast.error(`Ya existe una presentación llamada "${nombreFila}". Usa otro nombre.`)
        return
      }
      // Mismo redondeo-antes-de-validar que las presentaciones fijas (ver
      // arriba): evita que un valor diminuto pase como "mayor a 0".
      const factor = Math.round(parseFloat(fila.factor) * 1e6) / 1e6
      const precio = Math.round(parseFloat(fila.precio) * 100) / 100
      if (!Number.isFinite(factor) || factor <= 0) {
        toast.error(`"${nombreFila}": indica cuántos ${esGranel ? f.unidad : 'unidades'} contiene (mayor a 0).`)
        return
      }
      if (!Number.isFinite(precio) || precio <= 0) {
        toast.error(`"${nombreFila}": indica el precio (mayor a 0).`)
        return
      }
      nombresUsados.add(nombreNorm)
      // Clave estable: si la fila ya tenía una (viene de una presentación
      // guardada antes) se reutiliza tal cual, para no romper el enlace con
      // el historial de ventas ya hecho con esa clave; si es una fila nueva
      // de esta sesión, se genera recién ahora.
      const clave = esClavePersonalizada(fila.id) ? fila.id : clavePersonalizada(nombreFila, clavesExistentes)
      clavesExistentes.add(clave)
      presentaciones.push({ clave, nombre: nombreFila, factor, precio })
    }

    // Solo se envía la columna cuando hay presentaciones o hay que limpiar las
    // que tenía: un producto simple se guarda exactamente igual que antes.
    const teniaPresentaciones =
      !!producto && Array.isArray(producto.presentaciones) && producto.presentaciones.length > 0

    setGuardando(true)
    const payload = {
      sku: f.sku.trim(),
      nombre: f.nombre.trim(),
      categoria_id: f.categoria_id || null,
      precio_compra: parseFloat(f.precio_compra) || 0,
      precio_venta: parseFloat(f.precio_venta) || 0,
      // stock_minimo/stock_actual usan parseFloat (no parseInt) para admitir
      // decimales en productos a granel, ej. 0.5 kg.
      stock_minimo: parseFloat(f.stock_minimo) || 0,
      unidad: f.unidad,
      tipo_venta: tipoVenta,
      tiene_caja: esGranel ? false : tieneCaja,
      unidades_por_caja: !esGranel && tieneCaja ? (parseInt(f.unidades_por_caja) || null) : null,
      precio_venta_caja: !esGranel && tieneCaja ? (parseFloat(f.precio_venta_caja) || null) : null,
      tiene_saco: esGranel && tieneSaco,
      kg_por_saco: esGranel && tieneSaco ? (parseFloat(f.kg_por_saco) || null) : null,
      precio_venta_saco: esGranel && tieneSaco ? (parseFloat(f.precio_venta_saco) || null) : null,
      ...(presentaciones.length > 0 || teniaPresentaciones ? { presentaciones } : {}),
    }

    // Guarda primero los datos del producto. La foto se sube después y por
    // separado: si falla la subida (ej. bucket de Storage mal configurado),
    // el producto ya guardado no debe perderse ni reportarse como error.
    let productoId: string
    try {
      if (producto) {
        const { error } = await supabase.from('productos').update(payload).eq('id', producto.id)
        if (error) throw error
        productoId = producto.id
      } else {
        const { data, error } = await supabase
          .from('productos')
          .insert({ ...payload, stock_actual: parseFloat(f.stock_actual) || 0 })
          .select('id')
          .single()
        if (error) throw error
        productoId = data.id
      }
    } catch (e) {
      const msg = mensajeDeError(e)
      toast.error(msg.includes('duplicate') ? 'Ese SKU ya existe.' : msg)
      setGuardando(false)
      return
    }

    try {
      if (imageFile) {
        const url = await subir(imageFile, productoId)
        await supabase.from('productos').update({ image_url: url }).eq('id', productoId)
      } else if (producto && f.image_url === '' && producto.image_url) {
        await supabase.from('productos').update({ image_url: null }).eq('id', productoId)
      }
      toast.exito(producto ? 'Producto actualizado' : 'Producto creado')
    } catch (e) {
      toast.error(`Producto guardado, pero la foto no se pudo subir: ${mensajeDeError(e)}`)
    } finally {
      setGuardando(false)
      onGuardado()
      onClose()
    }
  }

  const imagenActual = imagePreview ?? (f.image_url || null)
  // Presentaciones ofrecibles con la combinacion actual de tipo de venta +
  // unidad base exacta (ej. "paquete" habilita medio/cuarto de paquete; "kg"
  // habilita arroba y fracciones de kilo; "litro" no tiene predefinidas).
  const clavesPres = clavesDisponibles(tipoVenta, f.unidad, tieneCaja)

  // Resumen de todos los niveles activos (base + caja/saco + presentaciones
  // fijas encendidas + personalizadas con datos válidos), de menor a mayor
  // equivalencia — ayuda a detectar a simple vista un error de multiplicación
  // al armar una jerarquía de varios niveles (ej. Bolsa = 10, Paquete Maestro
  // = 50): si un nivel que debería ser "mayor" aparece con menos equivalencia
  // que uno "menor", salta a la vista antes de guardar.
  const resumenNiveles: { nombre: string; factor: number }[] = [
    { nombre: esGranel ? `Por ${f.unidad}` : 'Unidad', factor: 1 },
  ]
  if (!esGranel && tieneCaja) {
    const upc = parseInt(f.unidades_por_caja, 10)
    if (Number.isFinite(upc) && upc > 0) resumenNiveles.push({ nombre: 'Caja', factor: upc })
  }
  if (esGranel && tieneSaco) {
    const kgSaco = parseFloat(f.kg_por_saco)
    if (Number.isFinite(kgSaco) && kgSaco > 0) resumenNiveles.push({ nombre: 'Saco', factor: kgSaco })
  }
  for (const clave of clavesPres) {
    const factorNum = parseFloat(pres[clave].factor)
    if (pres[clave].on && Number.isFinite(factorNum) && factorNum > 0) {
      resumenNiveles.push({ nombre: CATALOGO_PRESENTACIONES[clave].nombre, factor: factorNum })
    }
  }
  for (const fila of personalizadas) {
    const factorNum = parseFloat(fila.factor)
    if (fila.nombre.trim() && Number.isFinite(factorNum) && factorNum > 0) {
      resumenNiveles.push({ nombre: fila.nombre.trim(), factor: factorNum })
    }
  }
  resumenNiveles.sort((a, b) => a.factor - b.factor)

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={producto ? 'Editar producto' : 'Nuevo producto'}
      maxWidth="max-w-lg"
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            loading={guardando || subiendo}
            onClick={guardar}
          >
            {subiendo ? 'Subiendo imagen...' : 'Guardar'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* SKU con escáner de cámara */}
        <div>
          <span className="label mb-1.5 block">SKU / Código de barras</span>
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono"
              value={f.sku}
              onChange={(e) => set('sku', e.target.value)}
              placeholder="7501055300464"
              readOnly={scannerSku}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Desbloquea scanner.mp3 dentro del propio clic (necesario
                // en Safari/iOS: ver desbloquearAudioScanner en utils/beep).
                if (!scannerSku) desbloquearAudioScanner()
                setScannerSku((v) => !v)
              }}
              className={cx(
                'shrink-0 transition',
                scannerSku && 'border-accent-400 bg-accent-50 text-accent-700',
              )}
            >
              <ScanLine className="size-4" />
              {scannerSku ? 'Cerrar' : 'Escanear'}
            </Button>
          </div>

          {/* Scanner inline — aparece debajo del campo SKU */}
          {scannerSku && (
            <div className="mt-3 overflow-hidden rounded-2xl border border-ink-100">
              <CameraScanner activo={scannerSku} onScan={onSkuDetectado} />
              <p className="py-2 text-center text-xs text-ink-400">
                Apunta al código de barras o QR del producto.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Campo label="Nombre del producto" className="col-span-2">
            <input
              ref={nombreRef}
              className="input"
              value={f.nombre}
              onChange={(e) => set('nombre', e.target.value)}
              placeholder="Coca Cola 500ml"
            />
          </Campo>

          <Campo label="Categoría">
            <select
              className="input"
              value={f.categoria_id}
              onChange={(e) => set('categoria_id', e.target.value)}
            >
              <option value="">Sin categoría</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          </Campo>

          <Campo label="Unidad">
            <select
              className="input"
              value={f.unidad}
              onChange={(e) => set('unidad', e.target.value)}
            >
              {(esGranel ? UNIDADES_GRANEL : UNIDADES_UNIDAD).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Campo>

          <Campo label={esGranel ? `Precio compra por ${f.unidad} (S/)` : 'Precio compra (S/)'}>
            <input
              type="number"
              min={0}
              step={0.01}
              className="input tabular"
              value={f.precio_compra}
              onChange={(e) => set('precio_compra', e.target.value)}
              placeholder="0.00"
            />
          </Campo>

          <Campo label={esGranel ? `Precio venta por ${f.unidad} (S/)` : 'Precio venta (S/)'}>
            <input
              type="number"
              min={0}
              step={0.01}
              className="input tabular"
              value={f.precio_venta}
              onChange={(e) => set('precio_venta', e.target.value)}
              placeholder="0.00"
            />
          </Campo>

          {!producto && (
            <Campo label={esGranel ? `Stock inicial (en ${f.unidad})` : 'Stock inicial'}>
              <input
                type="number"
                min={0}
                step={esGranel ? 0.001 : 1}
                className="input tabular"
                value={f.stock_actual}
                onChange={(e) => set('stock_actual', e.target.value)}
                placeholder="0"
              />
            </Campo>
          )}

          <Campo
            label={esGranel ? `Stock mínimo (en ${f.unidad})` : 'Stock mínimo (alerta)'}
            className={producto ? 'col-span-2' : ''}
          >
            <input
              type="number"
              min={0}
              step={esGranel ? 0.001 : 1}
              className="input tabular"
              value={f.stock_minimo}
              onChange={(e) => set('stock_minimo', e.target.value)}
              placeholder="5"
            />
          </Campo>
        </div>

        {/* Tipo de venta: por unidad o a granel (peso fraccionado) */}
        <div className="rounded-xl border border-ink-100 p-3">
          <p className="mb-2 text-sm font-semibold text-ink-800">Tipo de venta</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => elegirTipoVenta('unidad')}
              className={cx(
                'rounded-lg border px-3 py-2 text-left text-xs font-semibold transition',
                !esGranel
                  ? 'border-accent-400 bg-accent-50 text-accent-700'
                  : 'border-ink-200 text-ink-500 hover:border-ink-300',
              )}
            >
              Por unidad
              <span className="mt-0.5 block font-normal text-ink-400">
                Piezas enteras, ej. gaseosas, galletas
              </span>
            </button>
            <button
              type="button"
              onClick={() => elegirTipoVenta('granel')}
              className={cx(
                'rounded-lg border px-3 py-2 text-left text-xs font-semibold transition',
                esGranel
                  ? 'border-accent-400 bg-accent-50 text-accent-700'
                  : 'border-ink-200 text-ink-500 hover:border-ink-300',
              )}
            >
              A granel (peso)
              <span className="mt-0.5 block font-normal text-ink-400">
                Fraccionado, ej. kg de un saco de arroz
              </span>
            </button>
          </div>
          {esGranel && (
            <p className="mt-2.5 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-500">
              En el punto de venta se pedirá la cantidad exacta en <b>{f.unidad}</b> (admite
              decimales, ej. 0.750).
            </p>
          )}
        </div>

        {/* Venta por caja (no aplica a productos a granel) */}
        {!esGranel && (
        <div className="rounded-xl border border-ink-100 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink-800">Venta por caja</p>
              <p className="text-xs text-ink-400">
                Permite vender en cajas además de unidades individuales
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={tieneCaja}
              onClick={() => setTieneCaja((v) => !v)}
              className={cx(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                tieneCaja ? 'bg-accent-500' : 'bg-ink-200',
              )}
            >
              <span
                className={cx(
                  'inline-block size-5 rounded-full bg-white shadow transition-transform',
                  tieneCaja ? 'translate-x-5' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>

          {tieneCaja && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Campo label="Unidades por caja">
                <input
                  type="number"
                  min={1}
                  className="input tabular"
                  value={f.unidades_por_caja}
                  onChange={(e) => set('unidades_por_caja', e.target.value)}
                  placeholder="12"
                />
              </Campo>
              <Campo label="Precio caja (S/)">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  className="input tabular"
                  value={f.precio_venta_caja}
                  onChange={(e) => set('precio_venta_caja', e.target.value)}
                  placeholder="0.00"
                />
              </Campo>
            </div>
          )}
        </div>
        )}

        {/* Venta por saco (solo para productos a granel) */}
        {esGranel && (
        <div className="rounded-xl border border-ink-100 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink-800">Venta por saco</p>
              <p className="text-xs text-ink-400">
                Permite vender el saco/bolsa completo además de por {f.unidad} suelto
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={tieneSaco}
              onClick={() => setTieneSaco((v) => !v)}
              className={cx(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                tieneSaco ? 'bg-accent-500' : 'bg-ink-200',
              )}
            >
              <span
                className={cx(
                  'inline-block size-5 rounded-full bg-white shadow transition-transform',
                  tieneSaco ? 'translate-x-5' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>

          {tieneSaco && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Campo label={`${f.unidad} por saco`}>
                <input
                  type="number"
                  min={0}
                  step={0.001}
                  className="input tabular"
                  value={f.kg_por_saco}
                  onChange={(e) => set('kg_por_saco', e.target.value)}
                  placeholder="50"
                />
              </Campo>
              <Campo label="Precio saco (S/)">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  className="input tabular"
                  value={f.precio_venta_saco}
                  onChange={(e) => set('precio_venta_saco', e.target.value)}
                  placeholder="0.00"
                />
              </Campo>
            </div>
          )}
        </div>
        )}

        {/* Otras presentaciones de venta: arroba / fracciones de kilo o de
            paquete (granel), docena / media docena / cuarto de docena / media
            caja (por unidad, esta última solo si "Venta por caja" está
            activo). El stock se lleva siempre en la unidad base elegida
            arriba; cada presentación solo define cuánto de ese stock consume
            y a qué precio se vende. Se oculta por completo si la unidad base
            elegida no tiene presentaciones predefinidas (ej. litro, ml). */}
        {clavesPres.length > 0 && (
        <div className="rounded-xl border border-ink-100 p-3">
          <p className="text-sm font-semibold text-ink-800">Otras presentaciones de venta</p>
          <p className="text-xs text-ink-400">
            {esGranel
              ? `Vende también fraccionado (ej. medio, cuarto u octavo). El stock siempre se lleva en ${f.unidad}.`
              : `Vende también por docena, media docena o cuarto de docena${f.unidad === 'paquete' ? ', medio o cuarto de paquete' : ''}${tieneCaja ? ', o media caja' : ''}. El stock siempre se lleva en la unidad base.`}
          </p>
          <div className="mt-3 space-y-2.5">
            {clavesPres.map((clave) => {
              const e = pres[clave]
              const nombre = CATALOGO_PRESENTACIONES[clave].nombre.toLowerCase()
              const etqBase = esGranel ? f.unidad : 'unidades'
              const factorNum = parseFloat(e.factor)
              const factorOk = Number.isFinite(factorNum) && factorNum > 0
              // Precio de referencia = precio base x equivalencia (solo como pista).
              const sugerido = factorOk
                ? Math.round((parseFloat(f.precio_venta) || 0) * factorNum * 100) / 100
                : null
              return (
                <div key={clave} className="rounded-lg bg-ink-50 p-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium capitalize text-ink-700">{nombre}</span>
                    <Interruptor
                      activo={e.on}
                      etiqueta={`Vender por ${nombre}`}
                      onClick={() => alternarPres(clave)}
                    />
                  </div>
                  {e.on && (
                    <>
                      <div className="mt-2.5 grid grid-cols-2 gap-3">
                        <Campo label={`${etqBase} por ${nombre}`}>
                          <input
                            type="number"
                            min={0}
                            step={0.001}
                            className="input tabular"
                            value={e.factor}
                            onChange={(ev) => setPresCampo(clave, 'factor', ev.target.value)}
                            placeholder="0"
                          />
                        </Campo>
                        <Campo label={`Precio ${nombre} (S/)`}>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            className="input tabular"
                            value={e.precio}
                            onChange={(ev) => setPresCampo(clave, 'precio', ev.target.value)}
                            placeholder={sugerido ? sugerido.toFixed(2) : '0.00'}
                          />
                        </Campo>
                      </div>
                      {factorOk && (
                        <p className="mt-2 text-xs text-ink-400">
                          Vender 1 {nombre} descuenta <b className="text-ink-600">{cantidad(factorNum)} {etqBase}</b> del stock.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        )}

        {/* Presentaciones personalizadas: para jerarquías de empaque propias
            del negocio que no entran en el catálogo fijo de arriba — ej. un
            "Paquete Maestro" que contiene 5 "Bolsas" de 10 unidades cada una
            (equivale a 50 unidades base). A diferencia del catálogo fijo,
            SIEMPRE está disponible (no depende del tipo de venta ni de la
            unidad elegida): cada fila define su propio nombre, cuánto
            consume de la unidad base y su precio. Cada nivel se escribe
            directamente en unidades base (no como fracción del nivel
            anterior): si 1 Bolsa = 10 unidades, escribe 10; si 1 Paquete
            Maestro = 5 Bolsas, escribe 50 (5 × 10, la equivalencia acumulada
            hasta la unidad base) — el resumen de abajo ayuda a verificarlo. */}
        <div className="rounded-xl border border-ink-100 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink-800">Presentaciones personalizadas</p>
              <p className="text-xs text-ink-400">
                Para empaques propios del negocio (ej. Bolsa, Paquete Maestro, Fardo, Ciento).
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              {!esGranel && f.unidad === 'unidad' && (
                <Button variant="outline" size="sm" onClick={aplicarPlantillaHuevos}>
                  🥚 Huevos
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={agregarPersonalizada}>
                <Plus className="size-3.5" /> Agregar
              </Button>
            </div>
          </div>
          {!esGranel && f.unidad === 'unidad' && (
            <p className="mt-1.5 text-xs text-ink-400">
              <b>Huevos:</b> agrega Docena, Media docena, Media plancha, Plancha (30), Medio ciento,
              Ciento, Media jaba y Jaba (360). El precio por unidad es el "Precio venta" de arriba.
              Ajusta la plancha si la tuya trae otra cantidad.
            </p>
          )}

          {personalizadas.length > 0 && (
            <div className="mt-3 space-y-2.5">
              {personalizadas.map((fila) => {
                const factorNum = parseFloat(fila.factor)
                const factorOk = Number.isFinite(factorNum) && factorNum > 0
                // Pista (solo placeholder, nunca se guarda sola): precio base x
                // equivalencia, ej. huevo a S/ 0.50 x 30 = S/ 15.00 la plancha.
                const precioSugerido = factorOk
                  ? Math.round((parseFloat(f.precio_venta) || 0) * factorNum * 100) / 100
                  : null
                return (
                  <div key={fila.id} className="rounded-lg bg-ink-50 p-2.5">
                    <div className="flex items-center gap-2">
                      <input
                        className="input flex-1"
                        value={fila.nombre}
                        onChange={(e) => setCampoPersonalizada(fila.id, 'nombre', e.target.value)}
                        placeholder="Ej. Bolsa, Paquete Maestro..."
                        maxLength={40}
                      />
                      <button
                        type="button"
                        onClick={() => quitarPersonalizada(fila.id)}
                        className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-red-50 hover:text-red-600"
                        aria-label={`Quitar ${fila.nombre.trim() || 'presentación personalizada'}`}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-3">
                      <Campo label={`${esGranel ? f.unidad : 'unidades'} que contiene`}>
                        <input
                          type="number"
                          min={0}
                          step={0.001}
                          className="input tabular"
                          value={fila.factor}
                          onChange={(e) => setCampoPersonalizada(fila.id, 'factor', e.target.value)}
                          placeholder="0"
                        />
                      </Campo>
                      <Campo label="Precio (S/)">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          className="input tabular"
                          value={fila.precio}
                          onChange={(e) => setCampoPersonalizada(fila.id, 'precio', e.target.value)}
                          placeholder={precioSugerido ? precioSugerido.toFixed(2) : '0.00'}
                        />
                      </Campo>
                    </div>
                    {factorOk && (
                      <p className="mt-2 text-xs text-ink-400">
                        Vender 1 {fila.nombre.trim() || 'presentación'} descuenta{' '}
                        <b className="text-ink-600">{cantidad(factorNum)} {esGranel ? f.unidad : 'unidades'}</b> del stock.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Resumen de niveles: solo lectura, ayuda a verificar la jerarquía
            completa de un vistazo antes de guardar (ej. confirmar que "Paquete
            Maestro" realmente equivale a más que "Bolsa"). Se oculta si solo
            hay un nivel (la venta suelta), donde no aporta nada nuevo. */}
        {resumenNiveles.length > 1 && (
          <div className="rounded-xl bg-ink-50 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
              Resumen de niveles
            </p>
            <ul className="space-y-1">
              {resumenNiveles.map((n) => (
                <li key={n.nombre} className="flex items-center justify-between text-xs text-ink-600">
                  <span>1 {n.nombre}</span>
                  <span className="tabular font-semibold text-ink-800">
                    = {cantidad(n.factor)} {esGranel ? f.unidad : 'u.'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Foto del producto */}
        <div>
          <span className="label mb-1.5 block">Foto del producto</span>

          {imagenActual ? (
            <div className="group relative overflow-hidden rounded-xl border border-ink-100">
              <img
                src={imagenActual}
                alt="Vista previa"
                className="h-44 w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/0 transition group-hover:bg-black/30">
                <label className="hidden cursor-pointer rounded-lg bg-white/90 px-3 py-1.5 text-xs font-semibold text-ink-800 hover:bg-white group-hover:block">
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) seleccionarImagen(file)
                    }}
                  />
                  Cambiar foto
                </label>
                <button
                  onClick={() => {
                    setImageFile(null)
                    if (imagePreview) URL.revokeObjectURL(imagePreview)
                    setImagePreview(null)
                    set('image_url', '')
                  }}
                  className="hidden rounded-lg bg-red-600/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 group-hover:block"
                >
                  <X className="mr-1 inline size-3.5" />
                  Quitar
                </button>
              </div>
            </div>
          ) : (
            <div
              onDrop={onDrop}
              onDragOver={(e) => {
                e.preventDefault()
                setArrastrando(true)
              }}
              onDragLeave={() => setArrastrando(false)}
              className={cx(
                'flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-7 text-center transition',
                arrastrando
                  ? 'border-accent-400 bg-accent-50'
                  : 'border-ink-200 bg-ink-50 hover:border-ink-300',
              )}
            >
              <Upload
                className={cx(
                  'mb-2 size-6 transition',
                  arrastrando ? 'text-accent-500' : 'text-ink-300',
                )}
              />
              <p className="text-sm font-medium text-ink-600">
                {arrastrando ? 'Suelta para subir' : 'Arrastra una foto aquí'}
              </p>
              <p className="mt-0.5 text-xs text-ink-400">
                JPG, PNG o WEBP · cualquier peso, se optimiza automáticamente
              </p>
              <div className="mt-3 flex gap-2">
                <label className="cursor-pointer rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm hover:bg-ink-50">
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) seleccionarImagen(file)
                      e.target.value = ''
                    }}
                  />
                  Subir archivo
                </label>
                <label className="cursor-pointer rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-sm hover:bg-ink-50">
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) seleccionarImagen(file)
                      e.target.value = ''
                    }}
                  />
                  <Camera className="mr-1 inline size-3.5" />
                  Tomar foto
                </label>
              </div>
            </div>
          )}
        </div>

        {producto && (
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-400">
            Stock actual:{' '}
            <b className="text-ink-700">{producto.stock_actual} {producto.unidad}</b> ·
            Usa el botón <b className="text-ink-600">Movimiento</b> para modificarlo y mantener el kardex.
          </p>
        )}
      </div>
    </Sheet>
  )
}

function Interruptor({
  activo,
  onClick,
  etiqueta,
}: {
  activo: boolean
  onClick: () => void
  etiqueta: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={etiqueta}
      onClick={onClick}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        activo ? 'bg-accent-500' : 'bg-ink-200',
      )}
    >
      <span
        className={cx(
          'inline-block size-5 rounded-full bg-white shadow transition-transform',
          activo ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function Campo({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <label className={className}>
      <span className="label mb-1.5 block">{label}</span>
      {children}
    </label>
  )
}
