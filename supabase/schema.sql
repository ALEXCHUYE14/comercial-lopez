-- ============================================================================
--  BODEGUITA CESAR RUIZ - SISTEMA DE GESTION COMERCIAL Y POS
--  Esquema COMPLETO para Supabase / PostgreSQL
--  Ejecutar en: Supabase Dashboard > SQL Editor > New query
-- ============================================================================
--  Este script es idempotente: se puede correr en un proyecto nuevo limpio.
--  Orden: extensiones → enums → tablas → funciones → RLS → realtime → semilla
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. EXTENSIONES
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. TIPOS ENUMERADOS
-- ----------------------------------------------------------------------------
do $$ begin
  create type rol_usuario as enum ('administrador', 'supervisor', 'cajero');
exception when duplicate_object then null; end $$;

-- Migracion en caliente: agrega el rol "supervisor" si el tipo ya existia
-- (proyectos creados antes de esta funcionalidad, con solo administrador/cajero).
-- Supervisor puede ver reportes (Rentabilidad, Compras, Mermas, Clientes,
-- Proveedores, Resumen) pero no crear/editar/eliminar nada — igual que un
-- cajero para todo lo que no sea lectura de reportes.
alter type rol_usuario add value if not exists 'supervisor';

do $$ begin
  create type metodo_pago as enum ('efectivo', 'tarjeta', 'yape', 'plin', 'transferencia', 'fiado');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tipo_movimiento as enum ('entrada', 'salida', 'ajuste', 'venta', 'devolucion');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estado_compra as enum ('pagado', 'pendiente');
exception when duplicate_object then null; end $$;

do $$ begin
  create type motivo_merma as enum ('vencido', 'danado', 'consumo_interno', 'otro');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estado_caja as enum ('abierta', 'cerrada');
exception when duplicate_object then null; end $$;

-- Veredicto del arqueo a ciegas al cerrar una caja (ver RPC
-- cerrar_caja_arqueo): 'ok' = dentro de tolerancia, 'observado' = descuadre
-- moderado (genera notificacion interna), 'critico' = faltante que supera el
-- umbral de alerta critica (genera Alerta Critica + flag de auditoria).
do $$ begin
  create type resultado_arqueo as enum ('ok', 'observado', 'critico');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tipo_alerta_arqueo as enum ('moderado', 'critico');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 2. PERFILES (extiende auth.users de Supabase)
-- ----------------------------------------------------------------------------
create table if not exists public.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nombre      text not null default 'Usuario',
  rol         rol_usuario not null default 'cajero',
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

comment on table public.perfiles is 'Perfil y rol de cada usuario autenticado.';

-- Crea el perfil automaticamente al registrarse un usuario en Auth.
create or replace function public.handle_nuevo_usuario()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.perfiles (id, nombre, rol)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'rol')::rol_usuario, 'cajero')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_nuevo_usuario();

-- Helper: es administrador? (evita recursion en politicas RLS)
create or replace function public.es_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol = 'administrador' and activo = true
  );
$$;

-- La politica perfiles_update (mas abajo) permite a cualquier usuario
-- actualizar SU PROPIA fila (para que pueda editar su nombre), pero eso
-- tambien le permitiria, sin este trigger, subir su propio "rol" a
-- administrador o reactivarse a si mismo llamando directamente a la API.
-- Este trigger bloquea el cambio de rol/activo salvo que quien ejecute el
-- update sea administrador (verificado en la base de datos, no en el cliente).
create or replace function public.proteger_columnas_perfil()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.es_admin() then
    if new.rol is distinct from old.rol or new.activo is distinct from old.activo then
      raise exception 'Solo un administrador puede cambiar el rol o el estado de un usuario.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_perfiles_proteger on public.perfiles;
create trigger trg_perfiles_proteger
  before update on public.perfiles
  for each row execute function public.proteger_columnas_perfil();

-- Helper: es administrador o supervisor? (rol con acceso a reportes y al
-- panel de auditoria de cajeros/arqueos — evita recursion en politicas RLS,
-- mismo patron que es_admin()).
create or replace function public.es_supervisor_o_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol in ('administrador', 'supervisor') and activo = true
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. CATEGORIAS
-- ----------------------------------------------------------------------------
create table if not exists public.categorias (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null unique,
  color      text not null default '#56564f',
  creado_en  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 4. PRODUCTOS (con columnas de caja, imagen y vencimiento)
-- ----------------------------------------------------------------------------
create table if not exists public.productos (
  id                  uuid primary key default gen_random_uuid(),
  sku                 text not null unique,
  nombre              text not null,
  categoria_id        uuid references public.categorias(id) on delete set null,
  precio_compra       numeric(10,2) not null default 0 check (precio_compra >= 0),
  precio_venta        numeric(10,2) not null default 0 check (precio_venta >= 0),
  precio_venta_caja   numeric(10,2),
  stock_actual        double precision not null default 0,
  stock_minimo        double precision not null default 5 check (stock_minimo >= 0),
  unidad              text not null default 'unidad',
  tiene_caja          boolean not null default false,
  unidades_por_caja   integer,
  tipo_venta          text not null default 'unidad',
  tiene_saco          boolean not null default false,
  kg_por_saco         double precision,
  precio_venta_saco   numeric(10,2),
  image_url           text,
  fecha_vencimiento   date,
  activo              boolean not null default true,
  creado_en           timestamptz not null default now(),
  actualizado_en      timestamptz not null default now()
);

-- Migracion en caliente: si el proyecto ya tenia esta tabla creada con los
-- tipos anteriores (integer / sin tipo_venta), estos ALTER la ponen al dia sin
-- perder datos. Son inofensivos si ya se corrieron antes o en un proyecto nuevo.
alter table public.productos alter column stock_actual type double precision using stock_actual::double precision;
alter table public.productos alter column stock_minimo type double precision using stock_minimo::double precision;
alter table public.productos add column if not exists tipo_venta text not null default 'unidad';
alter table public.productos add column if not exists tiene_saco boolean not null default false;
alter table public.productos add column if not exists kg_por_saco double precision;
alter table public.productos add column if not exists precio_venta_saco numeric(10,2);

do $$ begin
  alter table public.productos add constraint productos_tipo_venta_check
    check (tipo_venta in ('unidad', 'granel'));
exception when duplicate_object then null; end $$;

-- Un producto a granel (se vende por peso/volumen fraccionado) no tiene sentido
-- venderlo ademas por caja: son dos formas de fraccionar el mismo stock.
do $$ begin
  alter table public.productos add constraint productos_granel_sin_caja
    check (tipo_venta <> 'granel' or tiene_caja = false);
exception when duplicate_object then null; end $$;

-- "Venta por saco" (bolsa/costal completo) es la contraparte de "venta por
-- caja" pero para productos a granel: permite vender el saco entero (ej. 50kg
-- de arroz) ademas de venderlo suelto por kg.
do $$ begin
  alter table public.productos add constraint productos_saco_solo_granel
    check (tiene_saco = false or tipo_venta = 'granel');
exception when duplicate_object then null; end $$;

create index if not exists idx_productos_sku       on public.productos (sku);
create index if not exists idx_productos_categoria on public.productos (categoria_id);
create index if not exists idx_productos_stock_bajo on public.productos (stock_actual)
  where activo = true;

comment on column public.productos.sku is 'Codigo unico escaneable (QR o barras).';
comment on column public.productos.tipo_venta is
  'unidad = se vende en piezas enteras (opcionalmente tambien por caja). granel = se vende fraccionado por peso/volumen (ej. kg de un saco de arroz).';

-- Mantiene actualizado_en
create or replace function public.touch_actualizado_en()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

drop trigger if exists trg_productos_touch on public.productos;
create trigger trg_productos_touch
  before update on public.productos
  for each row execute function public.touch_actualizado_en();

-- ----------------------------------------------------------------------------
-- 5. CAJAS REGISTRADORAS
-- ----------------------------------------------------------------------------
create table if not exists public.cajas (
  id              uuid primary key default gen_random_uuid(),
  cajero_id       uuid references public.perfiles(id) on delete set null,
  cajero_nombre   text,
  monto_inicial   numeric(10,2) not null default 0,
  total_efectivo  numeric(10,2) not null default 0,
  total_yape      numeric(10,2) not null default 0,
  total_fiado     numeric(10,2) not null default 0,
  monto_real      numeric(10,2),
  estado          estado_caja not null default 'abierta',
  abierta_en      timestamptz not null default now(),
  cerrada_en      timestamptz
);

-- Migracion en caliente: totales de cobros de deuda (abonos de clientes) y
-- egresos, acumulados por caja igual que total_efectivo/total_yape, para que
-- el cierre de caja pueda reflejar la formula completa del dia:
--   Total en caja = (Fondo inicial + Ventas directas + Cobros de deuda) - Egresos
-- Se separan por metodo (efectivo vs. el resto) porque solo el efectivo
-- afecta el arqueo fisico de billetes/monedas al cerrar caja.
alter table public.cajas add column if not exists total_cobros_efectivo  numeric(10,2) not null default 0;
alter table public.cajas add column if not exists total_cobros_yape      numeric(10,2) not null default 0;
alter table public.cajas add column if not exists total_egresos_efectivo numeric(10,2) not null default 0;
alter table public.cajas add column if not exists total_egresos_otros    numeric(10,2) not null default 0;

create index if not exists idx_cajas_cajero on public.cajas (cajero_id);
create index if not exists idx_cajas_estado on public.cajas (estado);

-- ----------------------------------------------------------------------------
-- 6. CLIENTES CREDITO (sistema de fiado)
-- ----------------------------------------------------------------------------
create table if not exists public.clientes_credito (
  id              uuid primary key default gen_random_uuid(),
  nombre          text not null,
  telefono        text,
  direccion       text,
  limite_credito  numeric(10,2) not null default 0,
  deuda_actual    numeric(10,2) not null default 0,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now()
);

create index if not exists idx_clientes_activo on public.clientes_credito (activo);

-- ----------------------------------------------------------------------------
-- 7. VENTAS (con caja_id y cliente_id)
-- ----------------------------------------------------------------------------
create table if not exists public.ventas (
  id              uuid primary key default gen_random_uuid(),
  numero          bigint generated always as identity,
  cajero_id       uuid references public.perfiles(id) on delete set null,
  cajero_nombre   text,
  caja_id         uuid references public.cajas(id) on delete set null,
  cliente_id      uuid references public.clientes_credito(id) on delete set null,
  cliente_nombre  text,
  subtotal        numeric(10,2) not null default 0,
  descuento       numeric(10,2) not null default 0 check (descuento >= 0),
  igv             numeric(10,2) not null default 0,
  total           numeric(10,2) not null default 0,
  metodo          metodo_pago not null default 'efectivo',
  pago_recibido   numeric(10,2) not null default 0,
  vuelto          numeric(10,2) not null default 0,
  anulada         boolean not null default false,
  creado_en       timestamptz not null default now()
);

-- Migracion en caliente: clave de idempotencia opcional para el modo offline
-- del POS (ver src/utils/offlineDB.ts). El frontend genera un UUID por venta
-- ANTES de saber si hay conexion; si la venta se encola sin internet y el
-- reintento posterior de sincronizacion llega a ejecutarse dos veces (ej. el
-- primer intento SI llego al servidor pero la respuesta nunca volvio al
-- cliente por un corte de red), esta clave evita registrar la misma venta
-- por duplicado — ver el chequeo al inicio del RPC registrar_venta.
alter table public.ventas add column if not exists idempotency_key text;
do $$ begin
  create unique index idx_ventas_idempotency_key on public.ventas (idempotency_key)
    where idempotency_key is not null;
exception when duplicate_table then null; end $$;

create index if not exists idx_ventas_fecha  on public.ventas (creado_en desc);
create index if not exists idx_ventas_cajero on public.ventas (cajero_id);
create index if not exists idx_ventas_metodo on public.ventas (metodo);
create index if not exists idx_ventas_caja   on public.ventas (caja_id);

-- ----------------------------------------------------------------------------
-- 8. DETALLE DE VENTAS
-- ----------------------------------------------------------------------------
create table if not exists public.detalle_ventas (
  id               uuid primary key default gen_random_uuid(),
  venta_id         uuid not null references public.ventas(id) on delete cascade,
  producto_id      uuid references public.productos(id) on delete set null,
  producto_nombre  text not null,
  sku              text,
  cantidad         double precision not null check (cantidad > 0),
  modalidad        text not null default 'unidad',
  unidades         double precision not null default 0,
  precio_unitario  numeric(10,2) not null,
  subtotal         numeric(10,2) not null
);

-- Migracion en caliente (ver nota en la tabla productos).
alter table public.detalle_ventas alter column cantidad type double precision using cantidad::double precision;
alter table public.detalle_ventas add column if not exists modalidad text not null default 'unidad';
alter table public.detalle_ventas add column if not exists unidades double precision not null default 0;
-- Backfill unico: filas creadas antes de esta migracion no tienen "unidades"
-- (queda en 0 por el default). Para esas, "cantidad" es el mejor estimado
-- disponible (coincide siempre que la venta no haya sido por caja).
update public.detalle_ventas set unidades = cantidad where unidades = 0;

comment on column public.detalle_ventas.cantidad is
  'Cantidad tal como se vendio: N cajas, N kg o N unidades, segun modalidad.';
comment on column public.detalle_ventas.unidades is
  'Unidades reales de stock descontadas (cantidad * unidades_por_caja si modalidad=caja). Se usa para anular ventas correctamente.';

create index if not exists idx_detalle_venta    on public.detalle_ventas (venta_id);
create index if not exists idx_detalle_producto on public.detalle_ventas (producto_id);

-- ----------------------------------------------------------------------------
-- 9. MOVIMIENTOS DE INVENTARIO (Kardex simplificado)
-- ----------------------------------------------------------------------------
create table if not exists public.movimientos_inventario (
  id              uuid primary key default gen_random_uuid(),
  producto_id     uuid references public.productos(id) on delete set null,
  producto_nombre text,
  tipo            tipo_movimiento not null,
  cantidad        double precision not null,
  stock_previo    double precision not null,
  stock_nuevo     double precision not null,
  motivo          text,
  usuario_id      uuid references public.perfiles(id) on delete set null,
  creado_en       timestamptz not null default now()
);

-- Migracion en caliente (ver nota en la tabla productos).
alter table public.movimientos_inventario alter column cantidad     type double precision using cantidad::double precision;
alter table public.movimientos_inventario alter column stock_previo type double precision using stock_previo::double precision;
alter table public.movimientos_inventario alter column stock_nuevo  type double precision using stock_nuevo::double precision;

-- Migracion en caliente: nombre del usuario que hizo el movimiento, guardado
-- tal cual (denormalizado) igual que egresos.usuario_nombre — no se resuelve
-- con un join a perfiles en el momento de leer el Kardex porque la politica
-- RLS de perfiles solo deja ver la fila propia o a un administrador, asi que
-- un cajero viendo el Kardex no podria leer el nombre de otro usuario.
alter table public.movimientos_inventario add column if not exists usuario_nombre text;

create index if not exists idx_mov_producto on public.movimientos_inventario (producto_id, creado_en desc);

-- ----------------------------------------------------------------------------
-- 10. PAGOS CREDITO (abonos de clientes)
-- ----------------------------------------------------------------------------
create table if not exists public.pagos_credito (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes_credito(id) on delete cascade,
  monto       numeric(10,2) not null,
  nota        text,
  cajero_id   uuid references public.perfiles(id) on delete set null,
  creado_en   timestamptz not null default now()
);

-- Migracion en caliente: cada abono queda vinculado a la caja en la que se
-- cobro (igual que las ventas) y guarda el metodo de pago con el que el
-- cliente cancelo su deuda — ambos indispensables para que el cierre de caja
-- pueda sumar "Cobros de deuda" como ingreso de la sesion.
alter table public.pagos_credito add column if not exists caja_id uuid references public.cajas(id) on delete set null;
alter table public.pagos_credito add column if not exists metodo  metodo_pago not null default 'efectivo';

do $$ begin
  alter table public.pagos_credito add constraint pagos_credito_monto_positivo check (monto > 0);
exception when duplicate_object then null; end $$;

create index if not exists idx_pagos_cliente on public.pagos_credito (cliente_id, creado_en desc);
create index if not exists idx_pagos_caja    on public.pagos_credito (caja_id);

-- ----------------------------------------------------------------------------
-- 11. PROVEEDORES
-- ----------------------------------------------------------------------------
create table if not exists public.proveedores (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  ruc         text,
  telefono    text,
  email       text,
  direccion   text,
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 12. COMPRAS
-- ----------------------------------------------------------------------------
create table if not exists public.compras (
  id               uuid primary key default gen_random_uuid(),
  numero           text,
  proveedor_id     uuid references public.proveedores(id) on delete set null,
  proveedor_nombre text,
  total            numeric(10,2) not null default 0,
  estado           estado_compra not null default 'pendiente',
  fecha_compra     date not null default current_date,
  notas            text,
  creado_en        timestamptz not null default now()
);

create index if not exists idx_compras_fecha on public.compras (fecha_compra desc);

-- ----------------------------------------------------------------------------
-- 13. DETALLE DE COMPRAS
-- ----------------------------------------------------------------------------
create table if not exists public.detalle_compras (
  id               uuid primary key default gen_random_uuid(),
  compra_id        uuid not null references public.compras(id) on delete cascade,
  producto_id      uuid references public.productos(id) on delete set null,
  producto_nombre  text not null,
  cantidad         double precision not null check (cantidad > 0),
  precio_unitario  numeric(10,2) not null,
  subtotal         numeric(10,2) not null
);

-- Migracion en caliente (ver nota en la tabla productos).
alter table public.detalle_compras alter column cantidad type double precision using cantidad::double precision;

create index if not exists idx_det_compras on public.detalle_compras (compra_id);

-- ----------------------------------------------------------------------------
-- 14. MERMAS (perdidas de inventario)
-- ----------------------------------------------------------------------------
create table if not exists public.mermas (
  id               uuid primary key default gen_random_uuid(),
  producto_id      uuid references public.productos(id) on delete set null,
  producto_nombre  text not null,
  cantidad         double precision not null check (cantidad > 0),
  costo_unitario   numeric(10,2) not null default 0,
  costo_total      numeric(10,2) not null default 0,
  motivo           motivo_merma not null,
  descripcion      text,
  usuario_id       uuid references public.perfiles(id) on delete set null,
  creado_en        timestamptz not null default now()
);

-- Migracion en caliente (ver nota en la tabla productos).
alter table public.mermas alter column cantidad type double precision using cantidad::double precision;

create index if not exists idx_mermas_fecha on public.mermas (creado_en desc);

-- ----------------------------------------------------------------------------
-- 15. EGRESOS (gastos operativos del negocio: pagos a proveedores, servicios,
--     alquiler, planilla, etc. — dinero que sale de la caja/banco del negocio)
-- ----------------------------------------------------------------------------
do $$ begin
  create type categoria_egreso as enum (
    'proveedor', 'servicios', 'alquiler', 'planilla', 'transporte', 'mantenimiento', 'otro'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.egresos (
  id                uuid primary key default gen_random_uuid(),
  concepto          text not null,
  categoria         categoria_egreso not null default 'otro',
  monto             numeric(10,2) not null check (monto > 0),
  metodo            text not null default 'efectivo',
  proveedor_id      uuid references public.proveedores(id) on delete set null,
  proveedor_nombre  text,
  notas             text,
  usuario_id        uuid references public.perfiles(id) on delete set null,
  usuario_nombre    text,
  creado_en         timestamptz not null default now()
);

-- Migracion en caliente: vincula cada egreso a la caja activa en la que se
-- registro, para trazabilidad y para poder restar su monto del saldo
-- disponible de esa sesion en tiempo real (ver RPC registrar_egreso).
alter table public.egresos add column if not exists caja_id uuid references public.cajas(id) on delete set null;

create index if not exists idx_egresos_fecha      on public.egresos (creado_en desc);
create index if not exists idx_egresos_categoria  on public.egresos (categoria);
create index if not exists idx_egresos_caja       on public.egresos (caja_id);

-- ----------------------------------------------------------------------------
-- 15b. CONFIGURACION DE CAJA (politicas de tolerancia del arqueo a ciegas)
-- ----------------------------------------------------------------------------
-- Fila unica (singleton, id fijo = 1) con los umbrales que evalua el cierre
-- de caja (ver RPC cerrar_caja_arqueo). Vive en tabla -no en codigo- para que
-- el administrador pueda ajustarlos desde Configuracion sin un deploy.
create table if not exists public.configuracion_caja (
  id                          smallint primary key default 1 check (id = 1),
  umbral_tolerancia_faltante numeric(10,2) not null default 5.00  check (umbral_tolerancia_faltante >= 0),
  umbral_alerta_critica      numeric(10,2) not null default 20.00 check (umbral_alerta_critica >= 0),
  actualizado_por            uuid references public.perfiles(id) on delete set null,
  actualizado_en             timestamptz not null default now()
);

comment on table public.configuracion_caja is
  'Fila unica de configuracion global: umbrales de tolerancia del arqueo a ciegas de caja.';

-- ----------------------------------------------------------------------------
-- 15c. ALERTAS DE ARQUEO (descuadres de caja fuera de tolerancia)
-- ----------------------------------------------------------------------------
create table if not exists public.alertas_arqueo (
  id                uuid primary key default gen_random_uuid(),
  caja_id           uuid not null references public.cajas(id) on delete cascade,
  cajero_id         uuid references public.perfiles(id) on delete set null,
  cajero_nombre     text,
  tipo              tipo_alerta_arqueo not null,
  diferencia        numeric(10,2) not null,
  umbral_aplicado   numeric(10,2) not null,
  esperado_efectivo numeric(10,2) not null,
  monto_real        numeric(10,2) not null,
  mensaje           text not null,
  leida             boolean not null default false,
  creado_en         timestamptz not null default now()
);

create index if not exists idx_alertas_arqueo_caja   on public.alertas_arqueo (caja_id);
create index if not exists idx_alertas_arqueo_cajero on public.alertas_arqueo (cajero_id, creado_en desc);
create index if not exists idx_alertas_arqueo_leida  on public.alertas_arqueo (leida) where leida = false;

comment on table public.alertas_arqueo is
  'Alertas generadas automaticamente por cerrar_caja_arqueo cuando el arqueo a ciegas de un cierre de caja supera los umbrales de configuracion_caja.';

-- Columnas de resultado de arqueo en "cajas": persisten el veredicto del
-- cierre (evaluado en servidor por cerrar_caja_arqueo) para no recalcularlo
-- en cada lectura del historial/reportes, y para que quede fijo tal como se
-- evaluo en el momento del cierre aunque luego cambien los umbrales.
alter table public.cajas add column if not exists resultado_arqueo  resultado_arqueo;
alter table public.cajas add column if not exists diferencia_arqueo numeric(10,2);
alter table public.cajas add column if not exists esperado_efectivo numeric(10,2);

create index if not exists idx_cajas_resultado_arqueo on public.cajas (resultado_arqueo);

-- ----------------------------------------------------------------------------
-- 16. STORAGE - BUCKET DE FOTOS DE PRODUCTOS
-- ----------------------------------------------------------------------------
-- El frontend (useProductoImagen.ts) sube las fotos a este bucket y usa
-- getPublicUrl(), por lo que debe existir y ser publico para lectura.
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists product_images_select on storage.objects;
create policy product_images_select on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists product_images_insert on storage.objects;
create policy product_images_insert on storage.objects for insert
  to authenticated with check (bucket_id = 'product-images');

drop policy if exists product_images_update on storage.objects;
create policy product_images_update on storage.objects for update
  to authenticated using (bucket_id = 'product-images')
  with check (bucket_id = 'product-images');

drop policy if exists product_images_delete on storage.objects;
create policy product_images_delete on storage.objects for delete
  to authenticated using (bucket_id = 'product-images');

-- ============================================================================
-- FUNCIONES RPC (invocadas desde el frontend con supabase.rpc())
-- ============================================================================

-- ----------------------------------------------------------------------------
-- RPC 1: REGISTRAR VENTA (transaccional: stock + kardex + caja)
-- ----------------------------------------------------------------------------
create or replace function public.registrar_venta(
  p_items            jsonb,         -- [{ producto_id, cantidad, precio_unitario, modalidad }]
  p_metodo           metodo_pago,
  p_descuento        numeric  default 0,
  p_pago_recibido    numeric  default 0,
  p_caja_id          uuid     default null,
  p_cliente_id       uuid     default null,
  p_tasa_igv         numeric  default 0.18,
  p_idempotency_key  text     default null
)
returns public.ventas
language plpgsql
security definer set search_path = public
as $$
declare
  v_item        jsonb;
  v_producto    public.productos%rowtype;
  -- numeric (no double precision): se usan en round(x, 2) para los montos,
  -- y Postgres no tiene una funcion round(double precision, integer).
  -- Al insertar/comparar contra columnas double precision, Postgres castea
  -- implicitamente sin problema.
  v_cantidad    numeric;
  v_modalidad   text;
  v_unidades    numeric;
  v_precio      numeric(10,2);
  v_sub         numeric(10,2);
  v_subtotal    numeric(10,2) := 0;
  v_total       numeric(10,2);
  v_igv         numeric(10,2);
  v_base        numeric(10,2);
  v_venta       public.ventas%rowtype;
  v_nombre      text;
  v_cli_nombre  text;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'El carrito esta vacio.';
  end if;

  -- Reintento de una venta encolada offline (ver p_idempotency_key arriba):
  -- si esta clave ya genero una venta antes, se devuelve tal cual en vez de
  -- volver a descontar stock / registrar kardex por segunda vez.
  if p_idempotency_key is not null then
    select * into v_venta from public.ventas where idempotency_key = p_idempotency_key;
    if found then
      return v_venta;
    end if;
  end if;

  select nombre into v_nombre from public.perfiles where id = auth.uid();

  if p_cliente_id is not null then
    select nombre into v_cli_nombre from public.clientes_credito where id = p_cliente_id;
  end if;

  -- 1) Validar stock y acumular subtotal (bloqueo de filas para evitar carreras)
  --    "unidades" es siempre lo que realmente se descuenta del stock (calculado
  --    aqui, en servidor, en vez de confiar en lo que mande el frontend):
  --    - modalidad 'caja'  -> cantidad * unidades_por_caja del producto
  --    - modalidad 'saco'  -> cantidad * kg_por_saco del producto (granel)
  --    - modalidad 'unidad' -> cantidad tal cual (puede ser fraccion, ej. 0.5 kg si es granel)
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_producto from public.productos
      where id = (v_item->>'producto_id')::uuid for update;

    if not found then
      raise exception 'Producto % no existe.', v_item->>'producto_id';
    end if;

    v_cantidad  := (v_item->>'cantidad')::numeric;
    v_modalidad := coalesce(v_item->>'modalidad', 'unidad');

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'Cantidad invalida para "%".', v_producto.nombre;
    end if;

    v_unidades := case v_modalidad
                    when 'caja' then v_cantidad * coalesce(v_producto.unidades_por_caja, 1)
                    when 'saco' then v_cantidad * coalesce(v_producto.kg_por_saco, 1)
                    else v_cantidad
                  end;
    -- El precio SIEMPRE se calcula en servidor a partir del producto y la
    -- modalidad; nunca se confia en "precio_unitario" enviado por el cliente
    -- (evita que un usuario autenticado cobre a un precio arbitrario llamando
    -- al RPC directamente, por ejemplo desde devtools).
    v_precio   := case v_modalidad
                    when 'caja' then coalesce(v_producto.precio_venta_caja, v_producto.precio_venta)
                    when 'saco' then coalesce(v_producto.precio_venta_saco, v_producto.precio_venta)
                    else v_producto.precio_venta
                  end;

    if v_producto.stock_actual < v_unidades then
      raise exception 'Stock insuficiente para "%": disponible % %, solicitado %',
        v_producto.nombre, v_producto.stock_actual, v_producto.unidad, v_unidades;
    end if;

    v_subtotal := v_subtotal + (v_precio * v_cantidad);
  end loop;

  -- 2) Calculos (IGV incluido en precio de venta - modelo peruano)
  v_subtotal := round(v_subtotal, 2);
  v_total    := round(greatest(v_subtotal - coalesce(p_descuento, 0), 0), 2);
  v_base     := round(v_total / (1 + p_tasa_igv), 2);
  v_igv      := round(v_total - v_base, 2);

  -- 3) Cabecera de la venta
  -- El bloque exception cubre una carrera muy angosta pero real en el modo
  -- offline: dos reintentos de sincronizacion de la MISMA venta encolada
  -- corriendo casi al mismo tiempo (ej. el usuario toca "reintentar" justo
  -- cuando el retry automatico ya estaba en vuelo). Sin esto, el segundo en
  -- llegar reventaria con "duplicate key" en vez de simplemente devolver la
  -- venta que el primero ya creo.
  begin
    insert into public.ventas (
      cajero_id, cajero_nombre, caja_id, cliente_id, cliente_nombre,
      subtotal, descuento, igv, total, metodo, pago_recibido, vuelto,
      idempotency_key
    ) values (
      auth.uid(), v_nombre, p_caja_id, p_cliente_id, v_cli_nombre,
      v_subtotal, coalesce(p_descuento, 0), v_igv, v_total,
      p_metodo, p_pago_recibido, round(greatest(p_pago_recibido - v_total, 0), 2),
      p_idempotency_key
    ) returning * into v_venta;
  exception when unique_violation then
    if p_idempotency_key is null then
      raise;
    end if;
    select * into v_venta from public.ventas where idempotency_key = p_idempotency_key;
    if not found then
      raise;
    end if;
    return v_venta;
  end;

  -- 4) Detalle + descuento de stock + kardex
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_producto from public.productos
      where id = (v_item->>'producto_id')::uuid;
    v_cantidad  := (v_item->>'cantidad')::numeric;
    v_modalidad := coalesce(v_item->>'modalidad', 'unidad');
    v_unidades  := case v_modalidad
                     when 'caja' then v_cantidad * coalesce(v_producto.unidades_por_caja, 1)
                     when 'saco' then v_cantidad * coalesce(v_producto.kg_por_saco, 1)
                     else v_cantidad
                   end;
    v_precio    := case v_modalidad
                     when 'caja' then coalesce(v_producto.precio_venta_caja, v_producto.precio_venta)
                     when 'saco' then coalesce(v_producto.precio_venta_saco, v_producto.precio_venta)
                     else v_producto.precio_venta
                   end;
    v_sub       := round(v_precio * v_cantidad, 2);

    insert into public.detalle_ventas (
      venta_id, producto_id, producto_nombre, sku, cantidad, modalidad, unidades, precio_unitario, subtotal
    ) values (
      v_venta.id, v_producto.id, v_producto.nombre, v_producto.sku,
      v_cantidad, v_modalidad, v_unidades, v_precio, v_sub
    );

    update public.productos
      set stock_actual = stock_actual - v_unidades
      where id = v_producto.id;

    insert into public.movimientos_inventario (
      producto_id, producto_nombre, tipo, cantidad,
      stock_previo, stock_nuevo, motivo, usuario_id, usuario_nombre
    ) values (
      v_producto.id, v_producto.nombre, 'venta', -v_unidades,
      v_producto.stock_actual, v_producto.stock_actual - v_unidades,
      'Venta #' || v_venta.numero, auth.uid(), v_nombre
    );
  end loop;

  return v_venta;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 2: AJUSTE MANUAL DE STOCK (entradas / salidas / ajustes / devoluciones)
-- ----------------------------------------------------------------------------
-- El parametro p_cantidad cambio de integer a numeric (para soportar ajustes
-- fraccionados en productos a granel), por lo que hay que tumbar la firma vieja:
-- "create or replace" no permite cambiar el tipo de un parametro existente.
drop function if exists public.ajustar_stock(uuid, integer, tipo_movimiento, text);

create or replace function public.ajustar_stock(
  p_producto_id uuid,
  p_cantidad    numeric,
  p_tipo        tipo_movimiento,
  p_motivo      text default null
)
returns public.productos
language plpgsql
security definer set search_path = public
as $$
declare
  v_prod    public.productos%rowtype;
  v_nuevo   double precision;
  v_nombre  text;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede ajustar el stock.';
  end if;

  select * into v_prod from public.productos where id = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado.'; end if;

  v_nuevo := v_prod.stock_actual + p_cantidad;
  if v_nuevo < 0 then
    raise exception 'El ajuste dejaria el stock en negativo (% + %).',
      v_prod.stock_actual, p_cantidad;
  end if;

  update public.productos set stock_actual = v_nuevo where id = p_producto_id
    returning * into v_prod;

  select nombre into v_nombre from public.perfiles where id = auth.uid();

  insert into public.movimientos_inventario (
    producto_id, producto_nombre, tipo, cantidad,
    stock_previo, stock_nuevo, motivo, usuario_id, usuario_nombre
  ) values (
    p_producto_id, v_prod.nombre, p_tipo, p_cantidad,
    v_nuevo - p_cantidad, v_nuevo, p_motivo, auth.uid(), v_nombre
  );

  return v_prod;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 3: ANULAR VENTA (solo admin) - repone stock y marca anulada
-- ----------------------------------------------------------------------------
create or replace function public.anular_venta(p_venta_id uuid)
returns public.ventas
language plpgsql
security definer set search_path = public
as $$
declare
  v_venta   public.ventas%rowtype;
  v_det     record;
  v_prod    public.productos%rowtype;
  v_nombre  text;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede anular ventas.';
  end if;

  select * into v_venta from public.ventas where id = p_venta_id for update;
  if not found then raise exception 'Venta no encontrada.'; end if;
  if v_venta.anulada then raise exception 'La venta ya esta anulada.'; end if;

  select nombre into v_nombre from public.perfiles where id = auth.uid();

  for v_det in
    select * from public.detalle_ventas where venta_id = p_venta_id
  loop
    if v_det.producto_id is not null then
      select * into v_prod from public.productos
        where id = v_det.producto_id for update;
      if found then
        -- Se repone "unidades" (stock real descontado), no "cantidad" (que
        -- para ventas por caja es el numero de cajas, no de unidades).
        update public.productos
          set stock_actual = stock_actual + v_det.unidades
          where id = v_det.producto_id
          returning * into v_prod;

        insert into public.movimientos_inventario (
          producto_id, producto_nombre, tipo, cantidad,
          stock_previo, stock_nuevo, motivo, usuario_id, usuario_nombre
        ) values (
          v_prod.id, v_prod.nombre, 'devolucion', v_det.unidades,
          v_prod.stock_actual - v_det.unidades, v_prod.stock_actual,
          'Anulacion venta #' || v_venta.numero, auth.uid(), v_nombre
        );
      end if;
    end if;
  end loop;

  update public.ventas set anulada = true where id = p_venta_id
    returning * into v_venta;

  return v_venta;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 4: INCREMENTAR CAJA (acumula totales por metodo de pago)
-- ----------------------------------------------------------------------------
create or replace function public.incrementar_caja(
  p_caja_id uuid,
  p_metodo  text,
  p_monto   numeric
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_caja public.cajas%rowtype;
begin
  select * into v_caja from public.cajas where id = p_caja_id for update;
  if not found then
    raise exception 'Caja no encontrada.';
  end if;
  if v_caja.estado <> 'abierta' then
    raise exception 'La caja ya esta cerrada.';
  end if;
  if v_caja.cajero_id <> auth.uid() and not public.es_admin() then
    raise exception 'No puedes modificar los totales de una caja ajena.';
  end if;

  if p_metodo = 'efectivo' then
    update public.cajas set total_efectivo = total_efectivo + p_monto where id = p_caja_id;
  elsif p_metodo = 'yape' then
    update public.cajas set total_yape = total_yape + p_monto where id = p_caja_id;
  elsif p_metodo = 'fiado' then
    update public.cajas set total_fiado = total_fiado + p_monto where id = p_caja_id;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 5: REGISTRAR CARGO FIADO (suma deuda al cliente)
-- ----------------------------------------------------------------------------
-- El limite de credito antes solo se validaba en el navegador (PaymentModal),
-- nunca aqui en el servidor: dos cajeros vendiendole al fiado al mismo
-- cliente en dispositivos distintos, casi al mismo tiempo, podian pasar
-- ambos la validacion en pantalla (cada uno viendo la deuda_actual de ANTES
-- de la venta del otro) y terminar la deuda del cliente muy por encima de su
-- limite, sin que el sistema lo bloqueara ni lo avisara. El "for update" de
-- abajo bloquea la fila del cliente (mismo patron que ya usa
-- registrar_abono_cliente) para que el segundo cargo en llegar SIEMPRE lea
-- la deuda ya actualizada por el primero y se valide contra el limite real.
create or replace function public.registrar_cargo_fiado(
  p_cliente_id uuid,
  p_monto      numeric
)
returns public.clientes_credito
language plpgsql
security definer set search_path = public
as $$
declare
  v_cliente    public.clientes_credito%rowtype;
  v_disponible numeric(10,2);
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto del cargo debe ser mayor a 0.';
  end if;

  select * into v_cliente from public.clientes_credito where id = p_cliente_id for update;
  if not found then raise exception 'Cliente no encontrado.'; end if;

  if not v_cliente.activo then
    raise exception 'El cliente "%" esta inactivo y no puede recibir mas fiado.', v_cliente.nombre;
  end if;

  v_disponible := v_cliente.limite_credito - v_cliente.deuda_actual;
  if p_monto > v_disponible then
    raise exception 'Limite de credito superado para "%": disponible %, solicitado %.',
      v_cliente.nombre, v_disponible, p_monto;
  end if;

  update public.clientes_credito
    set deuda_actual = deuda_actual + p_monto
    where id = p_cliente_id
    returning * into v_cliente;

  return v_cliente;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 6: REGISTRAR ABONO CLIENTE
-- Resta la deuda del cliente, guarda el pago y — si se indica una caja
-- abierta — acredita el monto como "Cobro de deuda" en esa sesion de caja,
-- todo en una unica transaccion (la funcion completa o no hace nada).
-- ----------------------------------------------------------------------------
-- El parametro p_metodo y p_caja_id son nuevos (version anterior solo tenia
-- p_cliente_id, p_monto, p_nota): "create or replace" NO reemplaza una
-- funcion cuando cambia la lista de tipos de parametros, sino que crea una
-- SEGUNDA funcion sobrecargada con el mismo nombre. Hay que tumbar la firma
-- vieja explicitamente primero (mismo patron que ya usa ajustar_stock mas
-- abajo) para evitar dos versiones de registrar_abono_cliente coexistiendo,
-- lo que confunde al cache de esquema de PostgREST y rompe las llamadas
-- desde el frontend con "Could not find the function ... in the schema cache".
drop function if exists public.registrar_abono_cliente(uuid, numeric, text);

create or replace function public.registrar_abono_cliente(
  p_cliente_id uuid,
  p_monto      numeric,
  p_nota       text        default null,
  p_metodo     metodo_pago default 'efectivo',
  p_caja_id    uuid        default null
)
returns public.pagos_credito
language plpgsql
security definer set search_path = public
as $$
declare
  v_cliente public.clientes_credito%rowtype;
  v_caja    public.cajas%rowtype;
  v_pago    public.pagos_credito%rowtype;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede registrar abonos de clientes.';
  end if;

  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto del abono debe ser mayor a 0.';
  end if;

  if p_metodo not in ('efectivo', 'yape') then
    raise exception 'Metodo de pago no soportado para abonos: %', p_metodo;
  end if;

  -- Bloquea la fila del cliente para evitar que dos abonos simultaneos lean
  -- la misma deuda_actual y ambos pasen la validacion (condicion de carrera).
  select * into v_cliente from public.clientes_credito where id = p_cliente_id for update;
  if not found then raise exception 'Cliente no encontrado.'; end if;

  if p_monto > v_cliente.deuda_actual then
    raise exception 'El abono (%) no puede superar la deuda actual del cliente (%).',
      p_monto, v_cliente.deuda_actual;
  end if;

  -- Si se indica una caja, debe estar abierta y pertenecer al cajero actual
  -- (o quien ejecuta debe ser administrador) — misma regla que incrementar_caja.
  if p_caja_id is not null then
    select * into v_caja from public.cajas where id = p_caja_id for update;
    if not found then
      raise exception 'Caja no encontrada.';
    end if;
    if v_caja.estado <> 'abierta' then
      raise exception 'La caja indicada ya esta cerrada.';
    end if;
    if v_caja.cajero_id <> auth.uid() and not public.es_admin() then
      raise exception 'No puedes registrar cobros en una caja ajena.';
    end if;
  end if;

  update public.clientes_credito
    set deuda_actual = greatest(deuda_actual - p_monto, 0)
    where id = p_cliente_id;

  insert into public.pagos_credito (cliente_id, monto, nota, cajero_id, caja_id, metodo)
    values (p_cliente_id, p_monto, p_nota, auth.uid(), p_caja_id, p_metodo)
    returning * into v_pago;

  if p_caja_id is not null then
    if p_metodo = 'efectivo' then
      update public.cajas set total_cobros_efectivo = total_cobros_efectivo + p_monto where id = p_caja_id;
    else
      update public.cajas set total_cobros_yape = total_cobros_yape + p_monto where id = p_caja_id;
    end if;
  end if;

  return v_pago;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 7: REGISTRAR EGRESO
-- Inserta el egreso y — si se indica una caja abierta — resta de inmediato
-- su monto del saldo disponible de esa sesion, todo en una unica transaccion.
-- Un egreso en efectivo no puede superar el efectivo disponible en la caja.
-- ----------------------------------------------------------------------------
create or replace function public.registrar_egreso(
  p_concepto     text,
  p_categoria    categoria_egreso,
  p_monto        numeric,
  p_metodo       text,
  p_proveedor_id uuid default null,
  p_notas        text default null,
  p_caja_id      uuid default null
)
returns public.egresos
language plpgsql
security definer set search_path = public
as $$
declare
  v_caja        public.cajas%rowtype;
  v_prov_nombre text;
  v_nombre      text;
  v_egreso      public.egresos%rowtype;
  v_disponible  numeric(10,2);
begin
  -- Cualquier usuario autenticado puede registrar un egreso de SU PROPIO
  -- turno abierto (antes solo el administrador podia registrar egresos en
  -- absoluto). El administrador conserva la flexibilidad de registrar
  -- egresos de back-office sin caja (p_caja_id null) para gastos que no
  -- pertenecen a ningun turno (alquiler, planilla, proveedores, etc.); un
  -- cajero, en cambio, siempre debe indicar su caja abierta. La verificacion
  -- de mas abajo (v_caja.cajero_id <> auth.uid()) ya impide que registre
  -- egresos en una caja ajena.
  if not public.es_admin() and p_caja_id is null then
    raise exception 'Debes tener una caja abierta para registrar un egreso.';
  end if;

  if p_concepto is null or btrim(p_concepto) = '' then
    raise exception 'El concepto del egreso es obligatorio.';
  end if;

  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto del egreso debe ser mayor a 0.';
  end if;

  select nombre into v_nombre from public.perfiles where id = auth.uid();
  if p_proveedor_id is not null then
    select nombre into v_prov_nombre from public.proveedores where id = p_proveedor_id;
  end if;

  if p_caja_id is not null then
    select * into v_caja from public.cajas where id = p_caja_id for update;
    if not found then
      raise exception 'Caja no encontrada.';
    end if;
    if v_caja.estado <> 'abierta' then
      raise exception 'La caja indicada ya esta cerrada.';
    end if;
    if v_caja.cajero_id <> auth.uid() and not public.es_admin() then
      raise exception 'No puedes registrar egresos en una caja ajena.';
    end if;

    -- Regla de negocio: un egreso en efectivo no puede dejar el efectivo de
    -- la caja en negativo (fondo inicial + ventas efectivo + cobros efectivo
    -- - egresos efectivo ya registrados = disponible actual).
    if p_metodo = 'efectivo' then
      v_disponible := v_caja.monto_inicial + v_caja.total_efectivo
                       + v_caja.total_cobros_efectivo - v_caja.total_egresos_efectivo;
      if p_monto > v_disponible then
        raise exception 'Efectivo insuficiente en caja: disponible %, solicitado %.',
          v_disponible, p_monto;
      end if;
    end if;
  end if;

  insert into public.egresos (
    concepto, categoria, monto, metodo, proveedor_id, proveedor_nombre,
    notas, usuario_id, usuario_nombre, caja_id
  ) values (
    btrim(p_concepto), p_categoria, p_monto, p_metodo, p_proveedor_id, v_prov_nombre,
    p_notas, auth.uid(), v_nombre, p_caja_id
  ) returning * into v_egreso;

  if p_caja_id is not null then
    if p_metodo = 'efectivo' then
      update public.cajas set total_egresos_efectivo = total_egresos_efectivo + p_monto where id = p_caja_id;
    else
      update public.cajas set total_egresos_otros = total_egresos_otros + p_monto where id = p_caja_id;
    end if;
  end if;

  return v_egreso;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 8: ELIMINAR EGRESO
-- Revierte el total acreditado en la caja (solo si esta sigue abierta; una
-- caja ya cerrada quedo archivada junto a su reporte PDF y no se toca) y
-- borra el registro, en una unica transaccion.
-- ----------------------------------------------------------------------------
create or replace function public.eliminar_egreso(p_egreso_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_egreso public.egresos%rowtype;
  v_caja   public.cajas%rowtype;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede eliminar egresos.';
  end if;

  select * into v_egreso from public.egresos where id = p_egreso_id for update;
  if not found then raise exception 'Egreso no encontrado.'; end if;

  if v_egreso.caja_id is not null then
    select * into v_caja from public.cajas where id = v_egreso.caja_id for update;
    if found and v_caja.estado = 'abierta' then
      if v_egreso.metodo = 'efectivo' then
        update public.cajas set total_egresos_efectivo = greatest(total_egresos_efectivo - v_egreso.monto, 0)
          where id = v_egreso.caja_id;
      else
        update public.cajas set total_egresos_otros = greatest(total_egresos_otros - v_egreso.monto, 0)
          where id = v_egreso.caja_id;
      end if;
    end if;
  end if;

  delete from public.egresos where id = p_egreso_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 9: CERRAR CAJA CON ARQUEO A CIEGAS
-- Transaccional: calcula en SERVIDOR (nunca confiando en un valor enviado
-- por el cliente) el efectivo esperado, lo compara contra el conteo fisico
-- declarado por el cajero, evalua el resultado segun los umbrales vigentes en
-- configuracion_caja, cierra la caja y — si el descuadre supera la
-- tolerancia — registra una alerta de auditoria (moderada o critica). Este
-- calculo en servidor es lo que hace posible el arqueo a ciegas: el frontend
-- nunca conoce el efectivo esperado antes de que el cajero declare su conteo.
-- ----------------------------------------------------------------------------
create or replace function public.cerrar_caja_arqueo(
  p_caja_id    uuid,
  p_monto_real numeric
)
returns public.cajas
language plpgsql
security definer set search_path = public
as $$
declare
  v_caja        public.cajas%rowtype;
  v_config      public.configuracion_caja%rowtype;
  v_esperado    numeric(10,2);
  v_diferencia  numeric(10,2);
  v_resultado   resultado_arqueo;
  v_tipo_alerta tipo_alerta_arqueo;
  v_umbral      numeric(10,2);
  v_mensaje     text;
begin
  if p_monto_real is null or p_monto_real < 0 then
    raise exception 'El monto contado debe ser un numero valido mayor o igual a 0.';
  end if;

  select * into v_caja from public.cajas where id = p_caja_id for update;
  if not found then
    raise exception 'Caja no encontrada.';
  end if;
  if v_caja.estado <> 'abierta' then
    raise exception 'Esta caja ya esta cerrada.';
  end if;
  if v_caja.cajero_id <> auth.uid() and not public.es_admin() then
    raise exception 'No puedes cerrar una caja ajena.';
  end if;

  -- Umbrales vigentes (fila unica; se autocrea con los valores por defecto si
  -- nunca se guardo una configuracion — ver semilla al final del script,
  -- cubierto aqui tambien por si la fila fue borrada manualmente).
  select * into v_config from public.configuracion_caja where id = 1;
  if not found then
    insert into public.configuracion_caja (id) values (1) returning * into v_config;
  end if;

  -- Efectivo fisico esperado en caja: fondo inicial + ventas efectivo +
  -- cobros de deuda en efectivo - egresos en efectivo.
  v_esperado   := round(
    v_caja.monto_inicial + v_caja.total_efectivo
    + v_caja.total_cobros_efectivo - v_caja.total_egresos_efectivo,
    2
  );
  v_diferencia := round(p_monto_real - v_esperado, 2);

  if abs(v_diferencia) <= v_config.umbral_tolerancia_faltante then
    v_resultado := 'ok';
  elsif v_diferencia < 0 and abs(v_diferencia) > v_config.umbral_alerta_critica then
    v_resultado := 'critico';
  else
    v_resultado := 'observado';
  end if;

  update public.cajas set
    estado            = 'cerrada',
    cerrada_en        = now(),
    monto_real        = p_monto_real,
    resultado_arqueo  = v_resultado,
    diferencia_arqueo = v_diferencia,
    esperado_efectivo = v_esperado
  where id = p_caja_id
  returning * into v_caja;

  -- Alerta de auditoria: se genera tanto para descuadre moderado (fuera de
  -- tolerancia pero no critico, punto 2 de la politica) como critico (punto
  -- 3) — solo difiere el "tipo", que el frontend usa para resaltar el
  -- critico en el feed del administrador.
  if v_resultado in ('observado', 'critico') then
    v_tipo_alerta := case when v_resultado = 'critico' then 'critico' else 'moderado' end;
    v_umbral      := case when v_resultado = 'critico'
                       then v_config.umbral_alerta_critica
                       else v_config.umbral_tolerancia_faltante end;
    v_mensaje := format(
      '%s de %s en el cierre de caja de %s (esperado %s, contado %s).',
      case when v_diferencia < 0 then 'Faltante' else 'Sobrante' end,
      to_char(abs(v_diferencia), 'FM999999990.00'),
      coalesce(v_caja.cajero_nombre, 'un cajero'),
      to_char(v_esperado, 'FM999999990.00'),
      to_char(p_monto_real, 'FM999999990.00')
    );

    insert into public.alertas_arqueo (
      caja_id, cajero_id, cajero_nombre, tipo, diferencia,
      umbral_aplicado, esperado_efectivo, monto_real, mensaje
    ) values (
      v_caja.id, v_caja.cajero_id, v_caja.cajero_nombre, v_tipo_alerta, v_diferencia,
      v_umbral, v_esperado, p_monto_real, v_mensaje
    );
  end if;

  return v_caja;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC 10: MARCAR ALERTA DE ARQUEO COMO LEIDA (admin/supervisor)
-- ----------------------------------------------------------------------------
create or replace function public.marcar_alerta_leida(p_alerta_id uuid)
returns public.alertas_arqueo
language plpgsql
security definer set search_path = public
as $$
declare
  v_alerta public.alertas_arqueo%rowtype;
begin
  if not public.es_supervisor_o_admin() then
    raise exception 'No tienes permiso para gestionar alertas de arqueo.';
  end if;

  update public.alertas_arqueo set leida = true where id = p_alerta_id
    returning * into v_alerta;
  if not found then raise exception 'Alerta no encontrada.'; end if;

  return v_alerta;
end;
$$;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table public.perfiles                enable row level security;
alter table public.categorias              enable row level security;
alter table public.productos               enable row level security;
alter table public.cajas                   enable row level security;
alter table public.clientes_credito        enable row level security;
alter table public.ventas                  enable row level security;
alter table public.detalle_ventas          enable row level security;
alter table public.movimientos_inventario  enable row level security;
alter table public.pagos_credito           enable row level security;
alter table public.proveedores             enable row level security;
alter table public.compras                 enable row level security;
alter table public.detalle_compras         enable row level security;
alter table public.mermas                  enable row level security;
alter table public.egresos                 enable row level security;
alter table public.configuracion_caja      enable row level security;
alter table public.alertas_arqueo          enable row level security;

-- PERFILES
drop policy if exists perfiles_select on public.perfiles;
create policy perfiles_select on public.perfiles for select
  using (id = auth.uid() or public.es_admin());

drop policy if exists perfiles_update on public.perfiles;
create policy perfiles_update on public.perfiles for update
  using (id = auth.uid() or public.es_admin());

-- CATEGORIAS
drop policy if exists categorias_select on public.categorias;
create policy categorias_select on public.categorias for select
  to authenticated using (true);
drop policy if exists categorias_write on public.categorias;
create policy categorias_write on public.categorias for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- PRODUCTOS
drop policy if exists productos_select on public.productos;
create policy productos_select on public.productos for select
  to authenticated using (true);
drop policy if exists productos_write on public.productos;
create policy productos_write on public.productos for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- CAJAS
drop policy if exists cajas_select on public.cajas;
create policy cajas_select on public.cajas for select
  to authenticated using (true);
drop policy if exists cajas_insert on public.cajas;
create policy cajas_insert on public.cajas for insert
  to authenticated with check (cajero_id = auth.uid());
drop policy if exists cajas_update on public.cajas;
create policy cajas_update on public.cajas for update
  to authenticated using (cajero_id = auth.uid() or public.es_admin());

-- CLIENTES CREDITO
drop policy if exists clientes_select on public.clientes_credito;
create policy clientes_select on public.clientes_credito for select
  to authenticated using (true);
drop policy if exists clientes_write on public.clientes_credito;
create policy clientes_write on public.clientes_credito for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- VENTAS
drop policy if exists ventas_select on public.ventas;
create policy ventas_select on public.ventas for select
  to authenticated using (true);
drop policy if exists ventas_insert on public.ventas;
create policy ventas_insert on public.ventas for insert
  to authenticated with check (cajero_id = auth.uid());
drop policy if exists ventas_update on public.ventas;
create policy ventas_update on public.ventas for update
  to authenticated using (public.es_admin());

-- DETALLE VENTAS
drop policy if exists detalle_select on public.detalle_ventas;
create policy detalle_select on public.detalle_ventas for select
  to authenticated using (true);

-- MOVIMIENTOS INVENTARIO
drop policy if exists mov_select on public.movimientos_inventario;
create policy mov_select on public.movimientos_inventario for select
  to authenticated using (true);

-- PAGOS CREDITO
drop policy if exists pagos_select on public.pagos_credito;
create policy pagos_select on public.pagos_credito for select
  to authenticated using (true);
-- El INSERT normal de un abono va por el RPC registrar_abono_cliente (que ya
-- valida todo y corre con privilegios de servidor, sin depender de RLS). Esta
-- politica solo habilita el UPDATE que hace un administrador al abrir caja,
-- para vincular caja_id a los abonos de hoy que se registraron sin caja
-- abierta (ver useCaja.abrir en el frontend) — sin ella, ese update quedaba
-- bloqueado para todo el mundo al no existir ninguna politica de escritura.
drop policy if exists pagos_write on public.pagos_credito;
create policy pagos_write on public.pagos_credito for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- PROVEEDORES
drop policy if exists proveedores_select on public.proveedores;
create policy proveedores_select on public.proveedores for select
  to authenticated using (true);
drop policy if exists proveedores_write on public.proveedores;
create policy proveedores_write on public.proveedores for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- COMPRAS
drop policy if exists compras_select on public.compras;
create policy compras_select on public.compras for select
  to authenticated using (true);
drop policy if exists compras_write on public.compras;
create policy compras_write on public.compras for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- DETALLE COMPRAS
drop policy if exists det_compras_select on public.detalle_compras;
create policy det_compras_select on public.detalle_compras for select
  to authenticated using (true);

-- MERMAS
drop policy if exists mermas_select on public.mermas;
create policy mermas_select on public.mermas for select
  to authenticated using (true);
drop policy if exists mermas_write on public.mermas;
create policy mermas_write on public.mermas for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- EGRESOS
drop policy if exists egresos_select on public.egresos;
create policy egresos_select on public.egresos for select
  to authenticated using (true);
drop policy if exists egresos_write on public.egresos;
create policy egresos_write on public.egresos for all
  to authenticated using (public.es_admin()) with check (public.es_admin());
-- Nota: el INSERT de un egreso por un cajero (su propio turno) va siempre por
-- el RPC registrar_egreso, que corre con privilegios de servidor (security
-- definer) y por lo tanto no depende de esta politica — igual que ya ocurria
-- con el resto de RPCs de este archivo (ver registrar_venta, movimientos_
-- inventario). Esta politica solo sigue gateando accesos directos a la tabla
-- (ej. eliminar vía Supabase Studio), que se mantienen admin-only.

-- CONFIGURACION_CAJA
drop policy if exists config_caja_select on public.configuracion_caja;
create policy config_caja_select on public.configuracion_caja for select
  to authenticated using (true);
drop policy if exists config_caja_write on public.configuracion_caja;
create policy config_caja_write on public.configuracion_caja for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- ALERTAS_ARQUEO
-- Solo administrador/supervisor pueden ver el feed de auditoria de
-- descuadres. El INSERT ocurre unicamente desde cerrar_caja_arqueo (security
-- definer) — por eso no existe una politica de insert para "authenticated"
-- (mismo patron que movimientos_inventario, que tampoco la tiene).
drop policy if exists alertas_arqueo_select on public.alertas_arqueo;
create policy alertas_arqueo_select on public.alertas_arqueo for select
  to authenticated using (public.es_supervisor_o_admin());
drop policy if exists alertas_arqueo_update on public.alertas_arqueo;
create policy alertas_arqueo_update on public.alertas_arqueo for update
  to authenticated using (public.es_supervisor_o_admin());

-- ============================================================================
-- REALTIME: publicar tablas para sincronizacion instantanea
-- ============================================================================
do $$
begin
  alter publication supabase_realtime add table public.ventas;
exception when duplicate_object then null; end $$;

do $$
begin
  alter publication supabase_realtime add table public.productos;
exception when duplicate_object then null; end $$;

do $$
begin
  alter publication supabase_realtime add table public.detalle_ventas;
exception when duplicate_object then null; end $$;

do $$
begin
  alter publication supabase_realtime add table public.alertas_arqueo;
exception when duplicate_object then null; end $$;

alter table public.productos replica identity full;
alter table public.ventas replica identity full;

-- ============================================================================
-- DATOS DE EJEMPLO (semilla - comenta estas lineas si no las necesitas)
-- ============================================================================
insert into public.categorias (nombre, color) values
  ('Abarrotes',  '#059669'),
  ('Bebidas',    '#0ea5e9'),
  ('Snacks',     '#f59e0b'),
  ('Limpieza',   '#6366f1'),
  ('Lacteos',    '#ec4899')
on conflict (nombre) do nothing;

insert into public.productos (sku, nombre, categoria_id, precio_compra, precio_venta, stock_actual, stock_minimo, unidad)
select v.sku, v.nombre,
       (select id from public.categorias where nombre = v.cat),
       v.pc, v.pv, v.stock, v.minimo, v.unidad
from (values
  ('7501055300464','Coca Cola 500ml','Bebidas',1.80,3.00,48,12,'unidad'),
  ('7750885000123','Inca Kola 1L','Bebidas',3.20,5.00,30,10,'unidad'),
  ('7411001010108','Arroz Costeno 1kg','Abarrotes',3.50,4.80,60,15,'unidad'),
  ('7750243011037','Aceite Primor 1L','Abarrotes',7.20,9.50,24,8,'unidad'),
  ('7622300336738','Galleta Oreo','Snacks',1.10,1.80,80,20,'unidad'),
  ('7750670001234','Papas Lays 110g','Snacks',2.40,3.80,40,12,'unidad'),
  ('7501032300012','Detergente Bolivar 780g','Limpieza',4.10,6.20,18,6,'unidad'),
  ('7750885110556','Leche Gloria Tarro','Lacteos',2.80,4.20,52,15,'unidad'),
  ('7750182000019','Yogurt Laive 1L','Lacteos',5.00,7.50,16,6,'unidad'),
  ('7411001020107','Azucar Rubia 1kg','Abarrotes',3.00,4.20,45,12,'unidad')
) as v(sku, nombre, cat, pc, pv, stock, minimo, unidad)
on conflict (sku) do nothing;

-- Umbrales de tolerancia del arqueo a ciegas por defecto (S/ 5.00 tolerancia,
-- S/ 20.00 alerta critica) — el administrador puede ajustarlos desde
-- Configuracion sin volver a correr este script.
insert into public.configuracion_caja (id) values (1)
on conflict (id) do nothing;

-- ============================================================================
--  FIN DEL ESQUEMA
--  Siguiente paso: crea tu primer usuario en Authentication > Users y luego
--  marca su rol como administrador ejecutando:
--    update public.perfiles set rol = 'administrador' where id = 'UUID-DEL-USUARIO';
-- ============================================================================
