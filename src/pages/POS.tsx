import { useMemo, useState, useCallback, useEffect } from 'react'
import {
  Search,
  ScanLine,
  Plus,
  Minus,
  Trash2,
  ShoppingCart,
  X,
  Camera,
  Tag,
  LockOpen,
  PackagePlus,
  WifiOff,
  RefreshCw,
  ChevronDown,
} from 'lucide-react'
import { useProductos } from '@/hooks/useProductos'
import { useCarrito } from '@/hooks/useCarrito'
import { useClientes } from '@/hooks/useClientes'
import { useKeyboardScanner } from '@/hooks/useKeyboardScanner'
import { useVentasOffline } from '@/hooks/useVentasOffline'
import { useAuth } from '@/context/AuthContext'
import { useCajaCtx } from '@/context/CajaContext'
import { mensajeVinculacion } from '@/hooks/useCaja'
import { supabase } from '@/lib/supabase'
import { Button, Badge } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { useToast } from '@/components/ui/Toast'
import { CameraScanner } from '@/components/pos/CameraScanner'
import { PaymentModal } from '@/components/pos/PaymentModal'
import { Receipt } from '@/components/pos/Receipt'
import { ProductForm } from '@/components/inventory/ProductForm'
import { money, cx, cantidad, etiquetaUnidad } from '@/utils/format'
import {
  etiquetaModalidadDe,
  factorModalidad,
  opcionesVenta,
  precioPresentacion,
  presentacionesDe,
} from '@/utils/presentaciones'
import { BRAND } from '@/config/brand'
import { beepExito, beepError, desbloquearAudioScanner } from '@/utils/beep'
import { pareceErrorDeRed, type VentaOffline } from '@/utils/offlineDB'
import type { ItemCarrito, MetodoPago, ModalidadVenta, Producto, Venta } from '@/types/database'

export function POS() {
  const { productos, categorias, cargando } = useProductos()
  const { clientes } = useClientes()
  const { perfil, esAdmin } = useAuth()
  const nombreDisplay = perfil?.rol === 'administrador' ? BRAND.operador : (perfil?.nombre?.split(' ')[0] ?? 'Cajero')
  const {
    caja,
    cargando: cajaCargando,
    abrir: abrirCaja,
    sumarVenta,
    aplicarVentaLocal,
    confirmarVentaRemota,
  } = useCajaCtx()
  const toast = useToast()
  const carrito = useCarrito()

  // Efecto secundario que falta aplicar cuando una venta ENCOLADA offline
  // finalmente se sincroniza: acreditar su monto a la caja en el servidor.
  // (El fiado esta excluido del modo offline — ver PaymentModal — asi que
  // aqui nunca hace falta replicar registrar_cargo_fiado.)
  const aplicarEfectosVentaSincronizada = useCallback(
    async (venta: Venta, pendiente: VentaOffline) => {
      if (pendiente.cajaId) {
        await confirmarVentaRemota(pendiente.cajaId, pendiente.metodo, venta.total)
      }
    },
    [confirmarVentaRemota],
  )
  const avisarSincronizacion = useCallback((mensaje: string) => toast.error(mensaje), [toast])
  const ventasOffline = useVentasOffline(aplicarEfectosVentaSincronizada, avisarSincronizacion)

  const [busqueda, setBusqueda] = useState('')
  const [catSel, setCatSel] = useState<string | null>(null)
  const [camAbierta, setCamAbierta] = useState(false)
  const [carritoMovil, setCarritoMovil] = useState(false)
  const [pagoAbierto, setPagoAbierto] = useState(false)
  const [procesando, setProcesando] = useState(false)
  const [ventaHecha, setVentaHecha] = useState<Venta | null>(null)
  const [itemsTicket, setItemsTicket] = useState<ItemCarrito[]>([])
  const [abrirCajaOpen, setAbrirCajaOpen] = useState(false)
  const [montoInicial, setMontoInicial] = useState('')
  const [abriendoCaja, setAbriendoCaja] = useState(false)
  const [granelSel, setGranelSel] = useState<Producto | null>(null)
  const [cantGranel, setCantGranel] = useState('1')
  // Producto con presentaciones múltiples (arroba, docena, saco, caja...) cuyo
  // selector de presentación está abierto.
  const [presSel, setPresSel] = useState<Producto | null>(null)
  // Alta rapida: cuando un escaneo (camara o lector fisico) no encuentra
  // coincidencia y quien esta en caja es administrador, se ofrece crear el
  // producto al vuelo en vez de solo mostrar el error — sin esto, un
  // producto nuevo que aun no esta en el catalogo obliga a cortar la venta,
  // ir a Inventario, crearlo, y volver.
  const [codigoDesconocido, setCodigoDesconocido] = useState<string | null>(null)
  const [crearProductoAbierto, setCrearProductoAbierto] = useState(false)

  // Nadie puede vender sin caja abierta — incluye al administrador. Antes
  // se eximia al admin, lo que permitia registrar ventas sin caja activa:
  // esas ventas se guardaban igual (con caja_id null) pero quedaban fuera
  // de cualquier cierre/cuadre de caja, dando la falsa impresion de que
  // "no se guardaron".
  const necesitaCaja = !cajaCargando && !caja

  // --- Manejo de escaneo (camara o lector fisico) ---
  const onScan = useCallback(
    (codigo: string) => {
      const limpio = codigo.trim()
      const prod = productos.find((p) => p.sku === limpio)
      if (!prod) {
        beepError()
        toast.error(`Código no encontrado: ${codigo}`)
        // Solo el administrador puede dar de alta productos (RLS de
        // "productos"); a un cajero regular no le serviria de nada ver el
        // banner de "Crear producto" porque el guardado le fallaria igual.
        if (esAdmin) setCodigoDesconocido(limpio)
        return
      }
      setCodigoDesconocido(null)
      if (prod.stock_actual <= 0) {
        beepError()
        toast.error(`Sin stock: ${prod.nombre}`)
        return
      }
      beepExito()
      carrito.agregar(prod, 'unidad')
      toast.exito(`+ ${prod.nombre}`)
    },
    [productos, carrito, toast, esAdmin],
  )

  // Lector fisico siempre activo (emulacion teclado) en desktop
  useKeyboardScanner(onScan)

  // Desbloquea scanner.mp3 dentro del propio clic que abre la camara (ver
  // desbloquearAudioScanner en utils/beep): en Safari/iOS, reproducir un
  // <audio> por script solo funciona si antes se reprodujo dentro de un
  // gesto del usuario como este.
  function abrirCamara() {
    desbloquearAudioScanner()
    setCamAbierta(true)
  }

  // --- Productos a granel: piden la cantidad exacta (admite decimales) ---
  function abrirGranel(p: Producto) {
    setGranelSel(p)
    setCantGranel('1')
  }

  function confirmarGranel() {
    if (!granelSel) return
    const c = parseFloat(cantGranel) || 0
    if (c <= 0) {
      toast.error('Ingresa una cantidad valida.')
      return
    }
    if (c > granelSel.stock_actual) {
      toast.error(`Stock insuficiente: disponible ${cantidad(granelSel.stock_actual)} ${granelSel.unidad}`)
      return
    }
    carrito.agregar(granelSel, 'unidad', c)
    toast.exito(`+ ${cantidad(c)} ${granelSel.unidad} de ${granelSel.nombre}`)
    setGranelSel(null)
  }

  // --- Productos con presentaciones múltiples: el cajero elige cómo vender ---
  function elegirPresentacion(p: Producto, modalidad: ModalidadVenta) {
    setPresSel(null)
    // Venta suelta de un producto a granel: pide la cantidad exacta (kg, etc.).
    if (modalidad === 'unidad' && p.tipo_venta === 'granel') {
      abrirGranel(p)
      return
    }
    carrito.agregar(p, modalidad)
    toast.exito(`+ 1 ${(etiquetaModalidadDe(p, modalidad) ?? 'unidad').toLowerCase()} de ${p.nombre}`)
  }

  // Versión viva del producto abierto en el selector (el stock cambia por
  // tiempo real mientras el selector está abierto).
  const presActual = presSel ? (productos.find((p) => p.id === presSel.id) ?? presSel) : null

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    return productos.filter((p) => {
      const matchCat = !catSel || p.categoria_id === catSel
      const matchQ =
        !q || p.nombre.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
      return matchCat && matchQ
    })
  }, [productos, busqueda, catSel])

  async function confirmarAbrirCaja() {
    setAbriendoCaja(true)
    try {
      const resultado = await abrirCaja(parseFloat(montoInicial) || 0)
      toast.exito(mensajeVinculacion(resultado))
      setAbrirCajaOpen(false)
      setMontoInicial('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al abrir la caja')
    } finally {
      setAbriendoCaja(false)
    }
  }

  // Guarda la venta en la cola offline (ver hooks/useVentasOffline.ts):
  // acredita el monto a la caja EN PANTALLA de inmediato (aplicarVentaLocal,
  // sin llamar al servidor todavia) e imprime el ticket con el carrito ya
  // conocido — el cajero puede seguir cobrando como si nada. El numero de
  // comprobante definitivo lo asigna el servidor recien al sincronizar.
  async function encolarOffline(metodo: 'efectivo' | 'yape', pagoRecibido: number) {
    const clientId = crypto.randomUUID()
    const pendiente: VentaOffline = {
      clientId,
      creadoEnLocal: new Date().toISOString(),
      itemsCarrito: carrito.items,
      metodo,
      descuento: carrito.descuento,
      pagoRecibido,
      cajaId: caja?.id ?? null,
      cajeroNombre: nombreDisplay,
      totales: carrito.totales,
      intentos: 0,
    }
    await ventasOffline.encolar(pendiente)
    if (caja?.id) aplicarVentaLocal(caja.id, metodo, carrito.totales.total)

    // Venta "sintetica" solo para mostrar/imprimir el ticket: numero=0 es la
    // señal que ticket.ts / Receipt.tsx usan para mostrar "pendiente de
    // sincronizar" en vez de un numero de comprobante que todavia no existe.
    const ventaSintetica: Venta = {
      id: clientId,
      numero: 0,
      cajero_id: null,
      cajero_nombre: nombreDisplay,
      caja_id: caja?.id ?? null,
      cliente_id: null,
      cliente_nombre: null,
      subtotal: carrito.totales.subtotal,
      descuento: carrito.totales.descuento,
      igv: carrito.totales.igv,
      total: carrito.totales.total,
      metodo,
      pago_recibido: pagoRecibido,
      vuelto: Math.max(pagoRecibido - carrito.totales.total, 0),
      anulada: false,
      idempotency_key: clientId,
      creado_en: pendiente.creadoEnLocal,
    }
    setItemsTicket(carrito.items)
    setVentaHecha(ventaSintetica)
    carrito.limpiar()
    setPagoAbierto(false)
    setCarritoMovil(false)
    toast.info('Sin conexión: la venta se guardó en este dispositivo y se sincronizará sola cuando vuelva internet.')
  }

  // Descarta una venta offline que el servidor rechazo permanentemente al
  // sincronizar (ver banner de abajo). Revierte el ajuste optimista que
  // encolarOffline le habia aplicado a la caja en pantalla — de lo
  // contrario, el total mostrado quedaria contando para siempre una venta
  // que en realidad nunca se registro en el servidor.
  async function descartarPendienteOffline(p: VentaOffline) {
    if (p.cajaId) aplicarVentaLocal(p.cajaId, p.metodo, -p.totales.total)
    await ventasOffline.descartar(p.clientId)
  }

  async function cobrar(metodo: MetodoPago, pagoRecibido: number, clienteId?: string) {
    // El fiado depende de validar en el servidor el limite de credito
    // actualizado del cliente (otro dispositivo pudo haberle vendido al
    // mismo cliente mientras este estaba offline) — nunca se encola.
    // PaymentModal ya oculta la opcion "Fiado" sin conexion; este chequeo es
    // el respaldo por si la conexion se cae justo entre elegir el metodo y
    // confirmar el cobro.
    if (metodo === 'fiado' && !navigator.onLine) {
      toast.error('Fiado no está disponible sin conexión a internet. Usa efectivo o Yape.')
      return
    }

    // Sin conexion desde antes de intentar (no solo "se cayo a mitad de
    // camino"): no tiene sentido esperar a que el fetch truene por timeout,
    // se encola directo.
    if (!navigator.onLine && (metodo === 'efectivo' || metodo === 'yape')) {
      setProcesando(true)
      try {
        await encolarOffline(metodo, pagoRecibido)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'No se pudo guardar la venta sin conexión')
      } finally {
        setProcesando(false)
      }
      return
    }

    setProcesando(true)
    try {
      const items = carrito.items.map((i) => ({
        producto_id: i.producto.id,
        cantidad: i.cantidad,
        precio_unitario: precioItem(i),
        // El RPC calcula las unidades reales de stock a descontar en el
        // servidor a partir de la modalidad + unidades_por_caja/kg_por_saco
        // del producto (no confia en un total pre-calculado enviado por el cliente).
        modalidad: i.modalidad,
      }))
      const { data, error } = await supabase.rpc('registrar_venta', {
        p_items: items,
        p_metodo: metodo,
        p_descuento: carrito.descuento,
        p_pago_recibido: pagoRecibido,
        p_caja_id: caja?.id ?? null,
        p_cliente_id: clienteId ?? null,
      })
      if (error) throw error

      // A partir de aqui la venta ya quedo registrada y el stock descontado
      // en el servidor: si algo falla despues NO se debe relanzar (el catch de
      // abajo re-habilitaria "Confirmar cobro" y el cajero reintentaria,
      // duplicando la venta). Cualquier error en los pasos siguientes solo se
      // muestra como advertencia, sin deshacer el cobro ya completado.
      let advertencia: string | null = null

      // Actualizar totales de la caja
      if (caja?.id) {
        try {
          await sumarVenta(caja.id, metodo, carrito.totales.total)
        } catch {
          advertencia = 'La venta se registró, pero no se pudo actualizar el total de caja. Avisa al administrador.'
        }
      }

      // Actualizar deuda del cliente si la venta es al fiado
      if (metodo === 'fiado' && clienteId) {
        try {
          // supabase-js NO lanza ante un error del RPC: lo devuelve en
          // `error`. Sin este chequeo el catch de abajo jamas se ejecutaba y
          // un rechazo (limite de credito, cliente inactivo) pasaba en
          // silencio: la venta quedaba al fiado sin deuda cargada.
          const { error: errCargo } = await supabase.rpc('registrar_cargo_fiado', {
            p_cliente_id: clienteId,
            p_monto: carrito.totales.total,
          })
          if (errCargo) throw new Error(errCargo.message)
        } catch (e) {
          // El RPC ahora tambien puede rechazar el cargo por una razon de
          // negocio real (limite de credito superado — ver schema.sql), no
          // solo por una falla de red: se muestra el motivo devuelto por el
          // servidor en vez de un mensaje generico, para que el cajero sepa
          // que la deuda de este cliente quedo sin actualizar y por que.
          const motivo = e instanceof Error ? e.message : null
          advertencia = motivo
            ? `La venta se registró, pero no se pudo cargar la deuda al cliente: ${motivo}`
            : 'La venta se registró, pero no se pudo cargar la deuda al cliente. Avisa al administrador.'
        }
      }

      setItemsTicket(carrito.items)
      setVentaHecha(data as unknown as Venta)
      carrito.limpiar()
      setPagoAbierto(false)
      setCarritoMovil(false)
      if (advertencia) {
        toast.error(advertencia)
      } else {
        toast.exito('Venta registrada correctamente')
      }
    } catch (e) {
      // Si el request nunca llego al servidor por falta de red, se encola en
      // vez de mostrar un error y obligar al cajero a reintentar a mano.
      // "fiado" ya quedo descartado arriba, asi que aca metodo es siempre
      // efectivo/yape cuando se cumple esta condicion.
      if ((metodo === 'efectivo' || metodo === 'yape') && pareceErrorDeRed(e)) {
        try {
          await encolarOffline(metodo, pagoRecibido)
        } catch (e2) {
          toast.error(e2 instanceof Error ? e2.message : 'No se pudo guardar la venta sin conexión')
        }
        setProcesando(false)
        return
      }
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === 'object' && e !== null && 'message' in e
          ? String((e as { message: unknown }).message)
          : 'No se pudo registrar la venta'
      toast.error(msg)
    } finally {
      setProcesando(false)
    }
  }

  // Banner de caja cerrada — bloquea ventas para cualquier rol, incluido administrador
  if (necesitaCaja) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 grid size-16 place-items-center rounded-2xl bg-amber-100">
          <LockOpen className="size-8 text-amber-600" />
        </div>
        <h2 className="font-display text-xl font-bold text-ink-900">Caja cerrada</h2>
        <p className="mt-1 max-w-xs text-sm text-ink-400">
          Debes abrir la caja con el monto inicial antes de registrar ventas.
        </p>
        <Button className="mt-6" variant="primary" onClick={() => setAbrirCajaOpen(true)}>
          <LockOpen className="size-4" /> Abrir caja ahora
        </Button>

        <Sheet
          open={abrirCajaOpen}
          onClose={() => setAbrirCajaOpen(false)}
          title="Abrir caja"
          maxWidth="max-w-sm"
          footer={
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              loading={abriendoCaja}
              onClick={confirmarAbrirCaja}
            >
              <LockOpen className="size-5" /> Confirmar apertura
            </Button>
          }
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-500">
              Ingresa el efectivo con el que inicias el turno (fondo de caja).
            </p>
            <label className="block">
              <span className="label mb-1.5 block">Monto inicial en caja (S/)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                className="input tabular text-xl"
                value={montoInicial}
                onChange={(e) => setMontoInicial(e.target.value)}
                placeholder="0.00"
                autoFocus
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {[0, 50, 100, 150, 200].map((v) => (
                <button
                  key={v}
                  onClick={() => setMontoInicial(String(v))}
                  className="rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
                >
                  {v === 0 ? 'Sin fondo' : `S/ ${v}`}
                </button>
              ))}
            </div>
          </div>
        </Sheet>
      </div>
    )
  }

  return (
    <div className="lg:grid lg:grid-cols-[1fr_22rem] lg:gap-6">
      {/* Estado offline / cola de sincronizacion */}
      {(!ventasOffline.online || ventasOffline.pendientes.length > 0) && (
        <div className="mb-4 lg:col-span-2">
          <div
            className={cx(
              'flex items-center gap-3 rounded-xl border px-4 py-3',
              ventasOffline.online
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-red-200 bg-red-50 text-red-800',
            )}
          >
            <WifiOff className="size-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm">
              {!ventasOffline.online && 'Sin conexión — las ventas se guardan en este dispositivo. '}
              {ventasOffline.pendientes.length > 0 &&
                `${ventasOffline.pendientes.length} venta${ventasOffline.pendientes.length === 1 ? '' : 's'} por sincronizar.`}
            </p>
            {ventasOffline.online && ventasOffline.pendientes.length > 0 && (
              <button
                onClick={() => ventasOffline.sincronizar()}
                disabled={ventasOffline.sincronizando}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs font-semibold hover:bg-white disabled:opacity-50"
              >
                <RefreshCw className={cx('size-3.5', ventasOffline.sincronizando && 'animate-spin')} />
                Reintentar
              </button>
            )}
          </div>

          {/* Ventas que el servidor SI rechazo al sincronizar (ej. el stock ya
              no alcanzaba) — a diferencia de una simple falta de conexion,
              estas no se van a resolver solas reintentando: alguien tiene que
              revisarlas y descartarlas. */}
          {ventasOffline.pendientes.some((p) => p.ultimoError) && (
            <ul className="mt-2 space-y-1.5">
              {ventasOffline.pendientes
                .filter((p) => p.ultimoError)
                .map((p) => (
                  <li
                    key={p.clientId}
                    className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800"
                  >
                    <span className="min-w-0 flex-1">
                      Venta de {money(p.totales.total)} ({p.itemsCarrito.length} producto
                      {p.itemsCarrito.length === 1 ? '' : 's'}) no se pudo sincronizar:{' '}
                      <b>{p.ultimoError}</b>
                    </span>
                    <button
                      onClick={() => descartarPendienteOffline(p)}
                      className="shrink-0 rounded-lg bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-700"
                    >
                      Descartar
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {/* ---------------- Catalogo ---------------- */}
      <section>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-ink-900">Punto de venta</h1>
            <p className="text-sm text-ink-400">
              Hola, {nombreDisplay} · escanea o busca
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="lg:hidden"
            onClick={abrirCamara}
          >
            <Camera className="size-4" /> Escanear
          </Button>
        </div>

        {/* Alta rapida: codigo escaneado sin coincidencia (solo administrador) */}
        {codigoDesconocido && (
          <div className="mb-3 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 animate-fade-up">
            <PackagePlus className="size-4 shrink-0 text-amber-600" />
            <p className="min-w-0 flex-1 truncate text-sm text-amber-800">
              Código <span className="font-mono font-semibold">{codigoDesconocido}</span> no está
              en el catálogo.
            </p>
            <button
              onClick={() => setCrearProductoAbierto(true)}
              className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              Crear producto
            </button>
            <button
              onClick={() => setCodigoDesconocido(null)}
              className="shrink-0 text-amber-500 hover:text-amber-700"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {/* Buscador + scan desktop */}
        <div className="mb-3 flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-ink-300" />
            <input
              data-scanner="true"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar producto o SKU..."
              className="input pl-10"
            />
          </div>
          <Button
            variant="outline"
            className="hidden lg:inline-flex"
            onClick={abrirCamara}
          >
            <ScanLine className="size-[18px]" /> Camara
          </Button>
        </div>

        {/* Filtro de categorias */}
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
          <Chip activo={!catSel} onClick={() => setCatSel(null)}>
            Todo
          </Chip>
          {categorias.map((c) => (
            <Chip key={c.id} activo={catSel === c.id} onClick={() => setCatSel(c.id)}>
              {c.nombre}
            </Chip>
          ))}
        </div>

        {/* Grilla de productos */}
        {cargando ? (
          <GridSkeleton />
        ) : filtrados.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-ink-200 py-16 text-center">
            <Tag className="mb-2 size-7 text-ink-300" />
            <p className="text-sm font-medium text-ink-500">Sin resultados</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
            {filtrados.map((p) => (
              <ProductoCard
                key={p.id}
                producto={p}
                onAgregar={(modalidad) => carrito.agregar(p, modalidad)}
                onGranel={() => abrirGranel(p)}
                onPresentaciones={() => setPresSel(p)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Carrito desktop ---------------- */}
      <aside className="hidden lg:block">
        <div className="sticky top-8">
          <CartPanel carrito={carrito} onCobrar={() => setPagoAbierto(true)} />
        </div>
      </aside>

      {/* ---------------- FAB carrito (movil) ---------------- */}
      {!carrito.vacio && (
        <button
          onClick={() => setCarritoMovil(true)}
          className="fixed bottom-20 right-4 z-30 flex items-center gap-2.5 rounded-full bg-ink-900 px-5 py-3.5 text-white shadow-pop animate-scale-in lg:hidden"
        >
          <ShoppingCart className="size-5" />
          <span className="font-display font-bold">{money(carrito.totales.total)}</span>
          <span className="grid size-6 place-items-center rounded-full bg-accent-500 text-xs font-bold">
            {carrito.totales.unidades}
          </span>
        </button>
      )}

      {/* Carrito movil como bottom sheet */}
      <Sheet
        open={carritoMovil}
        onClose={() => setCarritoMovil(false)}
        title="Carrito"
        maxWidth="max-w-md"
        footer={
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            disabled={carrito.vacio}
            onClick={() => {
              setCarritoMovil(false)
              setPagoAbierto(true)
            }}
          >
            Cobrar · {money(carrito.totales.total)}
          </Button>
        }
      >
        <CartItems carrito={carrito} />
      </Sheet>

      {/* Escaner camara */}
      <Sheet open={camAbierta} onClose={() => setCamAbierta(false)} title="Escanear producto" maxWidth="max-w-md">
        <CameraScanner activo={camAbierta} onScan={onScan} />
        <p className="mt-3 text-center text-xs text-ink-400">
          Apunta al codigo de barras o QR del producto.
        </p>
      </Sheet>

      {/* Selector de presentación: precio y disponibilidad de cada forma de vender */}
      <Sheet
        open={!!presActual}
        onClose={() => setPresSel(null)}
        title={presActual ? presActual.nombre : 'Presentación'}
        maxWidth="max-w-sm"
      >
        {presActual && (
          <div className="space-y-3">
            <p className="text-sm text-ink-500">
              Stock total:{' '}
              <b className="text-ink-800">
                {cantidad(presActual.stock_actual)} {etiquetaUnidad(presActual)}
              </b>
              . Cada presentación descuenta su equivalente de este stock.
            </p>
            <ul className="space-y-2">
              {opcionesVenta(presActual).map((o) => (
                <li key={o.modalidad}>
                  <button
                    onClick={() => elegirPresentacion(presActual, o.modalidad)}
                    disabled={o.disponible <= 0}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-ink-100 px-3.5 py-3 text-left transition hover:border-ink-300 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink-800">{o.etiqueta}</span>
                      <span className="block text-xs text-ink-400">
                        {o.detalle ? `${o.detalle} · ` : ''}
                        {o.disponible > 0 ? `disp. ${cantidad(o.disponible)}` : 'sin stock'}
                      </span>
                    </span>
                    <span className="tabular shrink-0 font-display text-base font-bold text-ink-900">
                      {money(o.precio)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Sheet>

      {/* Cantidad exacta para productos a granel (kg, litros, etc.) */}
      <Sheet
        open={!!granelSel}
        onClose={() => setGranelSel(null)}
        title={granelSel ? granelSel.nombre : 'Cantidad'}
        maxWidth="max-w-sm"
        footer={
          <Button variant="secondary" size="lg" className="w-full" onClick={confirmarGranel}>
            Agregar al carrito
          </Button>
        }
      >
        {granelSel && (
          <div className="space-y-4">
            <p className="text-sm text-ink-500">
              Disponible: <b className="text-ink-800">{cantidad(granelSel.stock_actual)} {granelSel.unidad}</b>
              {' · '}
              {money(granelSel.precio_venta)} / {granelSel.unidad}
            </p>
            <label className="block">
              <span className="label mb-1.5 block">Cantidad en {granelSel.unidad}</span>
              <input
                type="number"
                inputMode="decimal"
                step={0.001}
                min={0}
                autoFocus
                className="input tabular text-xl"
                value={cantGranel}
                onChange={(e) => setCantGranel(e.target.value)}
                placeholder="0.000"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {[0.25, 0.5, 1, 2, 5].map((v) => (
                <button
                  key={v}
                  onClick={() => setCantGranel(String(v))}
                  className="rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
                >
                  {v} {granelSel.unidad}
                </button>
              ))}
            </div>
            {(parseFloat(cantGranel) || 0) > 0 && (
              <div className="flex items-center justify-between rounded-xl bg-ink-900 px-4 py-3 text-white">
                <span className="text-sm text-white/60">Subtotal</span>
                <span className="tabular font-display text-lg font-bold">
                  {money((parseFloat(cantGranel) || 0) * granelSel.precio_venta)}
                </span>
              </div>
            )}
          </div>
        )}
      </Sheet>

      <PaymentModal
        open={pagoAbierto}
        onClose={() => setPagoAbierto(false)}
        total={carrito.totales.total}
        procesando={procesando}
        clientes={clientes}
        onConfirmar={cobrar}
        offline={!ventasOffline.online}
      />

      {ventaHecha && (
        <Receipt
          open
          onClose={() => setVentaHecha(null)}
          venta={ventaHecha}
          items={itemsTicket}
        />
      )}

      {/* Alta rapida de producto (ver banner de "codigo no encontrado" arriba).
          No hace falta recargar productos manualmente al guardar: useProductos
          ya esta suscrito en tiempo real a la tabla y lo agrega solo. */}
      {esAdmin && (
        <ProductForm
          open={crearProductoAbierto}
          onClose={() => setCrearProductoAbierto(false)}
          producto={null}
          categorias={categorias}
          onGuardado={() => setCodigoDesconocido(null)}
          skuInicial={codigoDesconocido ?? undefined}
        />
      )}
    </div>
  )
}

/* ----------------------- Subcomponentes ----------------------- */

function Chip({
  children,
  activo,
  onClick,
}: {
  children: React.ReactNode
  activo: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold transition focusable',
        activo ? 'bg-ink-900 text-white' : 'bg-white text-ink-500 border border-ink-200 hover:border-ink-300',
      )}
    >
      {children}
    </button>
  )
}

function ProductoCard({
  producto,
  onAgregar,
  onGranel,
  onPresentaciones,
}: {
  producto: Producto
  onAgregar: (modalidad: ModalidadVenta) => void
  onGranel: () => void
  onPresentaciones: () => void
}) {
  const agotado = producto.stock_actual <= 0
  const bajo = producto.stock_actual > 0 && producto.stock_actual <= producto.stock_minimo
  const esGranel = producto.tipo_venta === 'granel'
  const cajaDisp = producto.tiene_caja
    ? Math.floor(producto.stock_actual / (producto.unidades_por_caja ?? 1))
    : 0
  const sacoDisp = producto.tiene_saco
    ? Math.floor(producto.stock_actual / (producto.kg_por_saco ?? 1))
    : 0
  const etiqStock = `${cantidad(producto.stock_actual)} ${etiquetaUnidad(producto)}`

  const imgSection = (
    <div className="relative aspect-square w-full overflow-hidden bg-ink-50">
      {producto.image_url ? (
        <img
          src={producto.image_url}
          alt={producto.nombre}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition group-hover:scale-[1.03]"
        />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <span
            className="size-5 rounded-full opacity-60"
            style={{ background: producto.categorias?.color ?? '#d4d4d0' }}
          />
        </div>
      )}
      <div className="absolute bottom-1.5 right-1.5">
        {agotado ? (
          <Badge tone="danger">Agotado</Badge>
        ) : bajo ? (
          <Badge tone="warning">{etiqStock}</Badge>
        ) : null}
      </div>
    </div>
  )

  const infoSection = (
    <div className="p-2.5">
      <p className="line-clamp-2 text-xs font-semibold leading-snug text-ink-800">
        {producto.nombre}
      </p>
      <div className="mt-1 flex items-center justify-between gap-1">
        <p className="tabular font-display text-base font-bold text-ink-900">
          {money(producto.precio_venta)}
          {esGranel && <span className="text-xs font-medium text-ink-400">/{producto.unidad}</span>}
        </p>
        {!agotado && !bajo && (
          <span className="text-[0.65rem] font-medium text-ink-300">{etiqStock}</span>
        )}
      </div>
    </div>
  )

  // Producto con presentaciones adicionales (arroba, docena, ...): un solo
  // botón abre el selector con todas las formas de vender y sus precios.
  if (presentacionesDe(producto).length > 0) {
    return (
      <div
        className={cx(
          'group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white text-left transition',
          agotado && 'opacity-50',
        )}
      >
        {imgSection}
        {infoSection}
        <div className="border-t border-ink-100 p-1.5">
          <button
            onClick={onPresentaciones}
            disabled={agotado}
            className="flex w-full items-center justify-center gap-1 rounded-lg bg-accent-100 py-1.5 text-xs font-semibold text-accent-700 transition hover:bg-accent-200 disabled:opacity-40"
          >
            Presentaciones
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  if (esGranel && producto.tiene_saco) {
    return (
      <div
        className={cx(
          'group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white text-left transition',
          agotado && 'opacity-50',
        )}
      >
        {imgSection}
        {infoSection}
        <div className="flex gap-1 border-t border-ink-100 p-1.5">
          <button
            onClick={onGranel}
            disabled={agotado}
            className="flex-1 rounded-lg bg-ink-100 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-200 disabled:opacity-40"
          >
            {producto.unidad}
          </button>
          <button
            onClick={() => onAgregar('saco')}
            disabled={agotado || sacoDisp <= 0}
            className="flex-1 rounded-lg bg-accent-100 py-1.5 text-xs font-semibold text-accent-700 transition hover:bg-accent-200 disabled:opacity-40"
          >
            Saco{sacoDisp > 0 ? ` (${sacoDisp})` : ''}
          </button>
        </div>
      </div>
    )
  }

  if (esGranel) {
    return (
      <button
        onClick={onGranel}
        disabled={agotado}
        className={cx(
          'group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white text-left transition focusable',
          'hover:border-ink-300 hover:shadow-card active:scale-[0.98]',
          agotado && 'cursor-not-allowed opacity-50',
        )}
      >
        {imgSection}
        {infoSection}
      </button>
    )
  }

  if (producto.tiene_caja) {
    return (
      <div
        className={cx(
          'group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white text-left transition',
          agotado && 'opacity-50',
        )}
      >
        {imgSection}
        {infoSection}
        <div className="flex gap-1 border-t border-ink-100 p-1.5">
          <button
            onClick={() => onAgregar('unidad')}
            disabled={agotado}
            className="flex-1 rounded-lg bg-ink-100 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-200 disabled:opacity-40"
          >
            Unidad
          </button>
          <button
            onClick={() => onAgregar('caja')}
            disabled={agotado || cajaDisp <= 0}
            className="flex-1 rounded-lg bg-accent-100 py-1.5 text-xs font-semibold text-accent-700 transition hover:bg-accent-200 disabled:opacity-40"
          >
            Caja{cajaDisp > 0 ? ` (${cajaDisp})` : ''}
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      onClick={() => onAgregar('unidad')}
      disabled={agotado}
      className={cx(
        'group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white text-left transition focusable',
        'hover:border-ink-300 hover:shadow-card active:scale-[0.98]',
        agotado && 'cursor-not-allowed opacity-50',
      )}
    >
      {imgSection}
      {infoSection}
    </button>
  )
}

type CarritoCtx = ReturnType<typeof useCarrito>

function CartPanel({ carrito, onCobrar }: { carrito: CarritoCtx; onCobrar: () => void }) {
  return (
    <div className="card flex max-h-[calc(100vh-5rem)] flex-col">
      <div className="flex items-center justify-between px-4 py-3.5 border-b border-ink-100">
        <h2 className="font-display font-bold text-ink-900">Carrito</h2>
        {!carrito.vacio && (
          <button
            onClick={carrito.limpiar}
            className="text-xs font-semibold text-ink-400 hover:text-red-600"
          >
            Vaciar
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <CartItems carrito={carrito} />
      </div>
      <div className="border-t border-ink-100 px-4 py-3">
        <Totales carrito={carrito} />
        <Button
          variant="secondary"
          size="lg"
          className="mt-3 w-full"
          disabled={carrito.vacio}
          onClick={onCobrar}
        >
          Cobrar · {money(carrito.totales.total)}
        </Button>
      </div>
    </div>
  )
}

function precioItem(item: ItemCarrito): number {
  if (item.modalidad === 'caja') return item.producto.precio_venta_caja ?? item.producto.precio_venta
  if (item.modalidad === 'saco') return item.producto.precio_venta_saco ?? item.producto.precio_venta
  return precioPresentacion(item.producto, item.modalidad)
}

function maxDisp(item: ItemCarrito): number {
  if (item.modalidad === 'caja') {
    return Math.floor(item.producto.stock_actual / (item.producto.unidades_por_caja ?? 1))
  }
  if (item.modalidad === 'saco') {
    return Math.floor(item.producto.stock_actual / (item.producto.kg_por_saco ?? 1))
  }
  if (item.modalidad !== 'unidad') {
    return Math.floor(item.producto.stock_actual / factorModalidad(item.producto, item.modalidad) + 1e-9)
  }
  return item.producto.stock_actual
}

function CartItems({ carrito }: { carrito: CarritoCtx }) {
  if (carrito.vacio) {
    return (
      <div className="grid place-items-center px-4 py-12 text-center text-ink-300">
        <ShoppingCart className="mb-2 size-8" />
        <p className="text-sm font-medium">El carrito esta vacio</p>
        <p className="text-xs">Escanea o toca un producto</p>
      </div>
    )
  }
  return (
    <ul className="space-y-1">
      {carrito.items.map((i) => {
        const precio = precioItem(i)
        const max = maxDisp(i)
        const esCaja = i.modalidad === 'caja'
        const esSaco = i.modalidad === 'saco'
        // Presentación adicional (arroba, docena, ...): nombre para la etiqueta
        // y equivalencia real que se descuenta del stock por cada una.
        const nombrePres = !esCaja && !esSaco ? etiquetaModalidadDe(i.producto, i.modalidad) : undefined
        const equivalePres = nombrePres
          ? `${cantidad(factorModalidad(i.producto, i.modalidad))} ${i.producto.tipo_venta === 'granel' ? i.producto.unidad : 'u.'}`
          : ''
        // Solo se pide cantidad fraccionada (kg) cuando es granel vendido
        // "suelto" (modalidad 'unidad'); por saco es una cantidad entera.
        const esKgFraccionado = i.producto.tipo_venta === 'granel' && i.modalidad === 'unidad'
        return (
          <li
            key={`${i.producto.id}::${i.modalidad}`}
            className="flex items-center gap-2 rounded-xl p-2 hover:bg-ink-50"
          >
            {/* Thumbnail: mismo patron que la fila de Inventario, para
                reconocer de un vistazo que producto se esta cobrando. */}
            <div className="size-9 shrink-0 overflow-hidden rounded-lg border border-ink-100 bg-ink-50">
              {i.producto.image_url ? (
                <img
                  src={i.producto.image_url}
                  alt={i.producto.nombre}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ background: i.producto.categorias?.color ?? '#d4d4d0' }}
                  />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink-800">{i.producto.nombre}</p>
              <p className="tabular text-xs text-ink-400">
                {(esCaja || esSaco || nombrePres) && (
                  <span className="mr-1 rounded bg-accent-100 px-1 py-0.5 text-[0.6rem] font-bold uppercase text-accent-700">
                    {esCaja ? 'Caja' : esSaco ? 'Saco' : nombrePres}
                  </span>
                )}
                {money(precio)} c/{esCaja ? 'caja' : esSaco ? 'saco' : nombrePres ? nombrePres.toLowerCase() : esKgFraccionado ? i.producto.unidad : 'u'}
                {nombrePres && <span className="ml-1 text-ink-300">({equivalePres})</span>}
              </p>
            </div>
            {esKgFraccionado ? (
              <CantidadGranelInput item={i} cambiarCantidad={carrito.cambiarCantidad} />
            ) : (
              <div className="flex items-center gap-1 rounded-lg bg-ink-100 p-0.5">
                <button
                  onClick={() => carrito.cambiarCantidad(i.producto.id, i.modalidad, i.cantidad - 1)}
                  className="grid size-7 place-items-center rounded-md text-ink-600 hover:bg-white"
                >
                  <Minus className="size-3.5" />
                </button>
                <span className="tabular w-6 text-center text-sm font-bold">{i.cantidad}</span>
                <button
                  onClick={() => carrito.cambiarCantidad(i.producto.id, i.modalidad, i.cantidad + 1)}
                  disabled={i.cantidad >= max}
                  className="grid size-7 place-items-center rounded-md text-ink-600 hover:bg-white disabled:opacity-30"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
            )}
            <p className="tabular w-16 shrink-0 text-right text-sm font-bold text-ink-900">
              {money(precio * i.cantidad)}
            </p>
            <button
              onClick={() => carrito.quitar(i.producto.id, i.modalidad)}
              className="grid size-7 place-items-center rounded-md text-ink-300 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// Input de cantidad para productos a granel: mantiene su propio texto mientras
// se escribe (para no borrar el item del carrito al pasar por "0" al tipear,
// ej. "0.75") y solo confirma la cantidad final al perder el foco / Enter.
function CantidadGranelInput({
  item,
  cambiarCantidad,
}: {
  item: ItemCarrito
  cambiarCantidad: CarritoCtx['cambiarCantidad']
}) {
  const [valor, setValor] = useState(String(item.cantidad))

  useEffect(() => {
    setValor(String(item.cantidad))
  }, [item.cantidad])

  function confirmar() {
    cambiarCantidad(item.producto.id, item.modalidad, parseFloat(valor) || 0)
  }

  return (
    <input
      type="number"
      inputMode="decimal"
      step={0.001}
      min={0}
      value={valor}
      onChange={(e) => setValor(e.target.value)}
      onBlur={confirmar}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="input tabular w-20 py-1 text-center text-sm"
    />
  )
}

function Totales({ carrito }: { carrito: CarritoCtx }) {
  const { totales } = carrito
  const [editar, setEditar] = useState(false)
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex justify-between text-ink-500">
        <span>Subtotal</span>
        <span className="tabular">{money(totales.subtotal)}</span>
      </div>
      <div className="flex items-center justify-between text-ink-500">
        <button onClick={() => setEditar((v) => !v)} className="flex items-center gap-1 hover:text-ink-800">
          Descuento {editar ? <X className="size-3" /> : <Plus className="size-3" />}
        </button>
        {editar ? (
          <input
            type="number"
            autoFocus
            value={carrito.descuento || ''}
            onChange={(e) => carrito.setDescuento(parseFloat(e.target.value) || 0)}
            className="tabular w-20 rounded-md border border-ink-200 px-2 py-0.5 text-right text-sm"
            placeholder="0.00"
          />
        ) : (
          <span className="tabular">- {money(totales.descuento)}</span>
        )}
      </div>
      <div className="flex justify-between text-ink-400 text-xs">
        <span>IGV incluido (18%)</span>
        <span className="tabular">{money(totales.igv)}</span>
      </div>
      <div className="flex justify-between border-t border-ink-100 pt-2 font-display text-lg font-bold text-ink-900">
        <span>Total</span>
        <span className="tabular">{money(totales.total)}</span>
      </div>
    </div>
  )
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-ink-100 bg-white">
          <div className="aspect-square w-full bg-ink-100/70" />
          <div className="p-2.5 space-y-1.5">
            <div className="h-3 w-3/4 rounded bg-ink-100" />
            <div className="h-4 w-1/2 rounded bg-ink-100" />
          </div>
        </div>
      ))}
    </div>
  )
}
