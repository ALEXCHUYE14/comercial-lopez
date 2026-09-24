// Tipos del dominio del sistema Comercial López JYD EIRL

export type Rol = 'administrador' | 'supervisor' | 'cajero'
export type MetodoPago = 'efectivo' | 'yape' | 'fiado'
export type TipoMovimiento = 'entrada' | 'salida' | 'ajuste' | 'venta' | 'devolucion'
export type EstadoCompra = 'pagado' | 'pendiente'
export type MotivoMerma = 'vencido' | 'danado' | 'consumo_interno' | 'otro'
export type EstadoCaja = 'abierta' | 'cerrada'
// Veredicto del arqueo a ciegas al cerrar una caja — ver RPC cerrar_caja_arqueo.
export type ResultadoArqueo = 'ok' | 'observado' | 'critico'
export type TipoAlertaArqueo = 'moderado' | 'critico'
export type CategoriaEgreso =
  | 'proveedor'
  | 'servicios'
  | 'alquiler'
  | 'planilla'
  | 'transporte'
  | 'mantenimiento'
  | 'otro'
export type MetodoEgreso = 'efectivo' | 'yape' | 'transferencia' | 'otro'
// Metodos admitidos para un abono/cobro de deuda de cliente (subconjunto de
// MetodoPago: "fiado" no tiene sentido para cancelar una deuda existente).
export type MetodoAbono = 'efectivo' | 'yape'

export type Perfil = {
  id: string
  nombre: string
  rol: Rol
  activo: boolean
  creado_en: string
}

export type Categoria = {
  id: string
  nombre: string
  color: string
  creado_en: string
}

// 'caja' y 'saco' usan las columnas propias del producto; el resto son claves
// de presentaciones adicionales (ver ClavePresentacion / utils/presentaciones.ts).
// `(string & {})` mantiene el autocompletado de los literales y admite las claves.
export type ClavePresentacion =
  | 'arroba'
  | 'medio_kilo'
  | 'cuarto_kilo'
  | 'octavo_kilo'
  | 'paquete'
  | 'medio_paquete'
  | 'cuarto_paquete'
  | 'docena'
  | 'media_docena'
  | 'cuarto_docena'
export type ModalidadVenta = 'unidad' | 'caja' | 'saco' | ClavePresentacion | (string & {})
export type TipoVenta = 'unidad' | 'granel'

/** Presentación de venta adicional de un producto (guardada en `productos.presentaciones`).
 * `factor` = cuánto de la unidad base del stock consume vender 1 de esta
 * presentación (ej. 11.5 si la base es kg y la presentación es 1 arroba). */
export type Presentacion = {
  clave: ClavePresentacion
  nombre: string
  factor: number
  precio: number
}

export type Producto = {
  id: string
  sku: string
  nombre: string
  categoria_id: string | null
  precio_compra: number
  precio_venta: number
  precio_venta_caja: number | null
  stock_actual: number
  stock_minimo: number
  unidad: string
  activo: boolean
  image_url: string | null
  fecha_vencimiento: string | null
  tiene_caja: boolean
  unidades_por_caja: number | null
  tipo_venta: TipoVenta
  tiene_saco: boolean
  kg_por_saco: number | null
  precio_venta_saco: number | null
  /** Opcional: ausente en productos anteriores a esta función o si la
   * migración aún no se aplicó; equivale a "sin presentaciones adicionales". */
  presentaciones?: Presentacion[] | null
  creado_en: string
  actualizado_en: string
  categorias?: Categoria | null
}

export type Venta = {
  id: string
  numero: number
  cajero_id: string | null
  cajero_nombre: string | null
  caja_id: string | null
  cliente_id: string | null
  cliente_nombre: string | null
  subtotal: number
  descuento: number
  igv: number
  total: number
  metodo: MetodoPago
  pago_recibido: number
  vuelto: number
  anulada: boolean
  idempotency_key: string | null
  creado_en: string
}

export type DetalleVenta = {
  id: string
  venta_id: string
  producto_id: string | null
  producto_nombre: string
  sku: string | null
  cantidad: number
  modalidad: ModalidadVenta
  unidades: number
  precio_unitario: number
  subtotal: number
}

export type MovimientoInventario = {
  id: string
  producto_id: string | null
  producto_nombre: string | null
  tipo: TipoMovimiento
  cantidad: number
  stock_previo: number
  stock_nuevo: number
  motivo: string | null
  usuario_id: string | null
  usuario_nombre: string | null
  creado_en: string
}

export type ClienteCredito = {
  id: string
  nombre: string
  telefono: string | null
  direccion: string | null
  limite_credito: number
  deuda_actual: number
  activo: boolean
  creado_en: string
}

export type PagoCredito = {
  id: string
  cliente_id: string
  monto: number
  nota: string | null
  cajero_id: string | null
  caja_id: string | null
  metodo: MetodoAbono
  creado_en: string
}

export type CajaRegistro = {
  id: string
  cajero_id: string | null
  cajero_nombre: string | null
  monto_inicial: number
  total_efectivo: number
  total_yape: number
  total_fiado: number
  // Cobros de deuda (abonos de clientes) acreditados a esta caja, por metodo.
  total_cobros_efectivo: number
  total_cobros_yape: number
  // Egresos restados de esta caja, por metodo (efectivo afecta el arqueo
  // fisico; el resto — yape/transferencia/otro — solo el balance neto).
  total_egresos_efectivo: number
  total_egresos_otros: number
  monto_real: number | null
  estado: EstadoCaja
  abierta_en: string
  cerrada_en: string | null
  // Veredicto del arqueo a ciegas — null mientras la caja sigue abierta,
  // se completa en el cierre (ver RPC cerrar_caja_arqueo).
  resultado_arqueo: ResultadoArqueo | null
  diferencia_arqueo: number | null
  esperado_efectivo: number | null
}

export type ConfiguracionCaja = {
  id: 1
  umbral_tolerancia_faltante: number
  umbral_alerta_critica: number
  actualizado_por: string | null
  actualizado_en: string
}

export type ConfiguracionNegocio = {
  id: 1
  nombre: string
  /** DNI (8 digitos) o RUC (11 digitos); '' si no se configuro. */
  documento: string
  direccion: string
  yape_qr_url: string | null
  imprimir_qr_yape: boolean
  actualizado_por: string | null
  actualizado_en: string
}

export type AlertaArqueo = {
  id: string
  caja_id: string
  cajero_id: string | null
  cajero_nombre: string | null
  tipo: TipoAlertaArqueo
  diferencia: number
  umbral_aplicado: number
  esperado_efectivo: number
  monto_real: number
  mensaje: string
  leida: boolean
  creado_en: string
}

export type Proveedor = {
  id: string
  nombre: string
  ruc: string | null
  telefono: string | null
  email: string | null
  direccion: string | null
  activo: boolean
  creado_en: string
}

export type Compra = {
  id: string
  numero: string | null
  proveedor_id: string | null
  proveedor_nombre: string | null
  total: number
  estado: EstadoCompra
  fecha_compra: string
  notas: string | null
  creado_en: string
  proveedores?: Proveedor | null
}

export type DetalleCompra = {
  id: string
  compra_id: string
  producto_id: string | null
  producto_nombre: string
  cantidad: number
  precio_unitario: number
  subtotal: number
}

export type Merma = {
  id: string
  producto_id: string | null
  producto_nombre: string
  cantidad: number
  costo_unitario: number
  costo_total: number
  motivo: MotivoMerma
  descripcion: string | null
  usuario_id: string | null
  creado_en: string
}

export type Egreso = {
  id: string
  concepto: string
  categoria: CategoriaEgreso
  monto: number
  metodo: MetodoEgreso
  proveedor_id: string | null
  proveedor_nombre: string | null
  notas: string | null
  usuario_id: string | null
  usuario_nombre: string | null
  caja_id: string | null
  creado_en: string
}

export type ItemCarrito = {
  producto: Producto
  cantidad: number
  modalidad: ModalidadVenta
}

// Tipado minimo para el cliente de Supabase (compatible con GenericSchema)
type Tabla<R> = { Row: R; Insert: Partial<R>; Update: Partial<R>; Relationships: [] }

export interface Database {
  public: {
    Tables: {
      perfiles: Tabla<Perfil>
      categorias: Tabla<Categoria>
      productos: Tabla<Producto>
      ventas: Tabla<Venta>
      detalle_ventas: Tabla<DetalleVenta>
      movimientos_inventario: Tabla<MovimientoInventario>
      clientes_credito: Tabla<ClienteCredito>
      pagos_credito: Tabla<PagoCredito>
      cajas: Tabla<CajaRegistro>
      proveedores: Tabla<Proveedor>
      compras: Tabla<Compra>
      detalle_compras: Tabla<DetalleCompra>
      mermas: Tabla<Merma>
      egresos: Tabla<Egreso>
      configuracion_caja: Tabla<ConfiguracionCaja>
      configuracion_negocio: Tabla<ConfiguracionNegocio>
      alertas_arqueo: Tabla<AlertaArqueo>
    }
    Views: Record<string, never>
    Functions: {
      registrar_venta: {
        Args: {
          p_items: unknown
          p_metodo: MetodoPago
          p_descuento: number
          p_pago_recibido: number
          p_caja_id: string | null
          p_cliente_id: string | null
          p_tasa_igv?: number
          p_idempotency_key?: string | null
        }
        Returns: Venta
      }
      registrar_cargo_fiado: {
        Args: { p_cliente_id: string; p_monto: number }
        Returns: ClienteCredito
      }
      registrar_abono_cliente: {
        Args: {
          p_cliente_id: string
          p_monto: number
          p_nota: string | null
          p_metodo: MetodoAbono
          p_caja_id: string | null
        }
        Returns: PagoCredito
      }
      registrar_egreso: {
        Args: {
          p_concepto: string
          p_categoria: CategoriaEgreso
          p_monto: number
          p_metodo: string
          p_proveedor_id: string | null
          p_notas: string | null
          p_caja_id: string | null
        }
        Returns: Egreso
      }
      eliminar_egreso: {
        Args: { p_egreso_id: string }
        Returns: void
      }
      ajustar_stock: {
        Args: {
          p_producto_id: string
          p_cantidad: number
          p_tipo: TipoMovimiento
          p_motivo: string | null
        }
        Returns: Producto
      }
      incrementar_caja: {
        Args: { p_caja_id: string; p_metodo: string; p_monto: number }
        Returns: void
      }
      anular_venta: { Args: { p_venta_id: string }; Returns: Venta }
      es_admin: { Args: Record<string, never>; Returns: boolean }
      es_supervisor_o_admin: { Args: Record<string, never>; Returns: boolean }
      cerrar_caja_arqueo: {
        Args: { p_caja_id: string; p_monto_real: number }
        Returns: CajaRegistro
      }
      marcar_alerta_leida: {
        Args: { p_alerta_id: string }
        Returns: AlertaArqueo
      }
    }
    Enums: {
      rol_usuario: Rol
      metodo_pago: MetodoPago
      tipo_movimiento: TipoMovimiento
      estado_compra: EstadoCompra
      motivo_merma: MotivoMerma
      estado_caja: EstadoCaja
      categoria_egreso: CategoriaEgreso
      resultado_arqueo: ResultadoArqueo
      tipo_alerta_arqueo: TipoAlertaArqueo
    }
    CompositeTypes: Record<string, never>
  }
}
