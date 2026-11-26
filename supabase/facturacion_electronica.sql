-- ============================================================================
-- FACTURACION ELECTRONICA (Boletas y Facturas via NUBEFACT)
-- ============================================================================
-- (Este bloque tambien esta incluido en schema.sql. Se puede ejecutar solo,
-- en el SQL Editor de Supabase, sobre una base que ya tenga el schema: es
-- idempotente y no borra ni modifica ventas existentes.)
--
-- Como funciona:
--  1. El navegador llama a la Edge Function "emitir-comprobante"
--     (supabase/functions/emitir-comprobante). El TOKEN de Nubefact vive SOLO
--     ahi (secretos NUBEFACT_RUTA / NUBEFACT_TOKEN), nunca en el navegador.
--  2. La funcion llama a reservar_comprobante (abajo) con la sesion del
--     usuario: valida permisos y datos, y asigna serie + correlativo en UNA
--     transaccion (sin saltos ni duplicados, aun con dos cajas a la vez).
--  3. Arma el comprobante con los montos REGISTRADOS en la base (nunca con
--     lo que mande el navegador), lo envia a Nubefact y guarda la respuesta.
--
-- Seguridad: las tablas solo se leen desde la app; nadie puede escribirlas
-- directo (no hay politicas de escritura). Solo las funciones de abajo y la
-- Edge Function (service role) las modifican.

-- ----------------------------------------------------------------------------
-- Configuracion: activar/desactivar y series (las asigna Nubefact/SUNAT).
-- En modo DEMO de Nubefact las series de prueba suelen ser BBB1 y FFF1.
-- ----------------------------------------------------------------------------
create table if not exists public.facturacion_config (
  id             smallint primary key default 1 check (id = 1),
  activo         boolean not null default false,
  serie_boleta   text not null default 'BBB1' check (serie_boleta ~ '^B[A-Z0-9]{3}$'),
  serie_factura  text not null default 'FFF1' check (serie_factura ~ '^F[A-Z0-9]{3}$'),
  actualizado_en timestamptz not null default now()
);
insert into public.facturacion_config (id) values (1) on conflict (id) do nothing;

-- Ultimo numero usado por serie. Se incrementa SOLO dentro de
-- reservar_comprobante, con bloqueo de fila.
create table if not exists public.series_correlativo (
  serie  text primary key check (serie ~ '^[BF][A-Z0-9]{3}$'),
  ultimo integer not null default 0 check (ultimo >= 0)
);

-- Un comprobante por venta (unique venta_id) y un numero por serie.
create table if not exists public.comprobantes (
  id                   uuid primary key default gen_random_uuid(),
  venta_id             uuid not null unique references public.ventas(id) on delete restrict,
  tipo                 text not null check (tipo in ('boleta', 'factura')),
  serie                text not null,
  numero               integer not null check (numero > 0),
  -- Catalogo SUNAT: '1' DNI, '6' RUC, '-' varios (boleta sin documento).
  cliente_tipo_doc     text not null check (cliente_tipo_doc in ('1', '6', '-')),
  cliente_num_doc      text not null,
  cliente_denominacion text not null,
  cliente_direccion    text,
  total                numeric(10,2) not null,
  -- pendiente: reservado, aun sin respuesta confirmada de Nubefact
  -- emitido:   Nubefact lo genero; SUNAT aun no confirma
  -- aceptado:  aceptado por SUNAT
  -- rechazado: Nubefact lo rechazo (datos invalidos); se puede corregir y reintentar
  estado               text not null default 'pendiente'
                         check (estado in ('pendiente', 'emitido', 'aceptado', 'rechazado')),
  enlace               text,
  enlace_pdf           text,
  cadena_qr            text,
  codigo_hash          text,
  sunat_descripcion    text,
  error_mensaje        text,
  intentos             integer not null default 0,
  creado_por           uuid references public.perfiles(id) on delete set null,
  creado_en            timestamptz not null default now(),
  actualizado_en       timestamptz not null default now(),
  unique (serie, numero)
);
create index if not exists idx_comprobantes_estado on public.comprobantes (estado);
create index if not exists idx_comprobantes_creado on public.comprobantes (creado_en desc);

alter table public.facturacion_config enable row level security;
alter table public.series_correlativo enable row level security;
alter table public.comprobantes       enable row level security;

drop policy if exists facturacion_config_select on public.facturacion_config;
create policy facturacion_config_select on public.facturacion_config for select
  to authenticated using (true);
drop policy if exists series_correlativo_select on public.series_correlativo;
create policy series_correlativo_select on public.series_correlativo for select
  to authenticated using (true);
drop policy if exists comprobantes_select on public.comprobantes;
create policy comprobantes_select on public.comprobantes for select
  to authenticated using (true);
-- Sin politicas de insert/update/delete: solo las funciones security definer
-- de abajo y la Edge Function (service role) escriben en estas tablas.

-- Realtime: que la pantalla se entere cuando un comprobante cambia de estado.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comprobantes'
     ) then
    alter publication supabase_realtime add table public.comprobantes;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Limpia un texto libre: sin caracteres de control, espacios colapsados,
-- recortado a p_max. Devuelve null si queda vacio.
-- ----------------------------------------------------------------------------
create or replace function public.limpiar_texto_comprobante(p_texto text, p_max integer)
returns text
language sql
immutable
as $$
  select nullif(left(btrim(regexp_replace(
           regexp_replace(coalesce(p_texto, ''), '[[:cntrl:]]', ' ', 'g'),
           '[[:space:]]+', ' ', 'g')), p_max), '');
$$;

-- ----------------------------------------------------------------------------
-- reservar_comprobante: valida y asigna serie + numero. Idempotente: si la
-- venta ya tiene comprobante lo devuelve (no reserva otro numero).
-- ----------------------------------------------------------------------------
create or replace function public.reservar_comprobante(
  p_venta_id  uuid,
  p_tipo      text,
  p_cli_tipo  text,
  p_cli_doc   text,
  p_cli_nombre text,
  p_cli_dir   text
)
returns public.comprobantes
language plpgsql
security definer set search_path = public
as $$
declare
  v_cfg    public.facturacion_config%rowtype;
  v_venta  public.ventas%rowtype;
  v_comp   public.comprobantes%rowtype;
  v_tipo   text;
  v_doc    text;
  v_nom    text;
  v_dir    text;
  v_serie  text;
  v_num    integer;
begin
  if auth.uid() is null then
    raise exception 'Sesion no valida.';
  end if;
  if not exists (select 1 from public.perfiles where id = auth.uid() and activo = true) then
    raise exception 'Tu usuario esta inactivo.';
  end if;

  select * into v_cfg from public.facturacion_config where id = 1;
  if not found or not v_cfg.activo then
    raise exception 'La facturacion electronica no esta activada. Un administrador debe activarla en Configuracion.';
  end if;
  if p_tipo is null or p_tipo not in ('boleta', 'factura') then
    raise exception 'Tipo de comprobante invalido.';
  end if;

  select * into v_venta from public.ventas where id = p_venta_id for update;
  if not found then
    raise exception 'La venta no existe.';
  end if;
  if v_venta.cajero_id is distinct from auth.uid() and not public.es_supervisor_o_admin() then
    raise exception 'Solo el cajero que registro la venta, un supervisor o un administrador puede emitir su comprobante.';
  end if;

  -- Ya tiene comprobante: se devuelve el mismo (nunca se reserva otro numero).
  select * into v_comp from public.comprobantes where venta_id = p_venta_id for update;
  if found then
    if v_comp.estado in ('emitido', 'aceptado') then
      return v_comp;
    end if;
    if v_comp.tipo <> p_tipo then
      raise exception 'Esta venta ya tiene reservada la % %-%. Reintenta como %.',
        v_comp.tipo, v_comp.serie, v_comp.numero, v_comp.tipo;
    end if;
  end if;

  if v_venta.anulada then
    raise exception 'La venta esta anulada.';
  end if;
  if v_venta.total <= 0 then
    raise exception 'La venta no tiene monto.';
  end if;
  if p_tipo = 'factura' and v_venta.metodo::text = 'fiado' then
    raise exception 'La factura al credito (fiado) aun no esta disponible. Emite una boleta.';
  end if;

  -- Datos del cliente, validados en el servidor.
  v_tipo := coalesce(nullif(btrim(p_cli_tipo), ''), '-');
  v_doc  := regexp_replace(coalesce(p_cli_doc, ''), '[^0-9]', '', 'g');
  v_nom  := public.limpiar_texto_comprobante(p_cli_nombre, 200);
  v_dir  := public.limpiar_texto_comprobante(p_cli_dir, 250);

  if p_tipo = 'factura' then
    if v_tipo <> '6' or v_doc !~ '^(10|15|16|17|20)[0-9]{9}$' then
      raise exception 'Para factura se requiere el RUC del cliente (11 digitos, empieza con 10 o 20).';
    end if;
    if v_nom is null or char_length(v_nom) < 2 then
      raise exception 'Para factura se requiere la razon social del cliente.';
    end if;
  else
    if v_tipo = '1' then
      if v_doc !~ '^[0-9]{8}$' then
        raise exception 'El DNI debe tener 8 digitos.';
      end if;
    elsif v_tipo = '6' then
      if v_doc !~ '^(10|15|16|17|20)[0-9]{9}$' then
        raise exception 'El RUC debe tener 11 digitos y empezar con 10 o 20.';
      end if;
    elsif v_tipo = '-' then
      if v_venta.total >= 700 then
        raise exception 'Para boletas de S/ 700.00 o mas, SUNAT exige el DNI del cliente.';
      end if;
      v_doc := '-';
      v_nom := coalesce(v_nom, 'CLIENTES VARIOS');
    else
      raise exception 'Tipo de documento del cliente invalido.';
    end if;
    if v_nom is null or char_length(v_nom) < 2 then
      raise exception 'Ingresa el nombre del cliente.';
    end if;
  end if;

  -- v_comp.id (no FOUND, que cambia con cada consulta) dice si la venta ya
  -- tenia comprobante.
  if v_comp.id is not null then
    -- Reintento de un comprobante 'pendiente' o 'rechazado' de la misma venta.
    -- 'pendiente': pudo haber llegado a Nubefact; se conservan los datos tal
    -- cual para reenviar EXACTAMENTE el mismo documento.
    -- 'rechazado': Nubefact no lo registro; se permite corregir el cliente.
    if v_comp.estado = 'rechazado' then
      update public.comprobantes
         set cliente_tipo_doc = v_tipo,
             cliente_num_doc = v_doc,
             cliente_denominacion = v_nom,
             cliente_direccion = v_dir,
             total = v_venta.total,
             estado = 'pendiente',
             error_mensaje = null,
             actualizado_en = now()
       where id = v_comp.id
       returning * into v_comp;
    end if;
    return v_comp;
  end if;

  v_serie := case p_tipo when 'boleta' then v_cfg.serie_boleta else v_cfg.serie_factura end;
  insert into public.series_correlativo (serie, ultimo) values (v_serie, 1)
    on conflict (serie) do update set ultimo = public.series_correlativo.ultimo + 1
    returning ultimo into v_num;

  insert into public.comprobantes (
    venta_id, tipo, serie, numero, cliente_tipo_doc, cliente_num_doc,
    cliente_denominacion, cliente_direccion, total, creado_por
  ) values (
    p_venta_id, p_tipo, v_serie, v_num, v_tipo, v_doc,
    v_nom, v_dir, v_venta.total, auth.uid()
  ) returning * into v_comp;

  return v_comp;
end;
$$;

-- ----------------------------------------------------------------------------
-- guardar_config_facturacion: solo administrador. Permite fijar el ultimo
-- numero ya usado de cada serie (ej. si ya emitiste comprobantes desde la web
-- de Nubefact), sin dejarlo por debajo de lo que este sistema ya emitio.
-- ----------------------------------------------------------------------------
create or replace function public.guardar_config_facturacion(
  p_activo         boolean,
  p_serie_boleta   text,
  p_serie_factura  text,
  p_ultimo_boleta  integer default null,
  p_ultimo_factura integer default null
)
returns public.facturacion_config
language plpgsql
security definer set search_path = public
as $$
declare
  v_cfg   public.facturacion_config%rowtype;
  v_sb    text := upper(btrim(coalesce(p_serie_boleta, '')));
  v_sf    text := upper(btrim(coalesce(p_serie_factura, '')));
  v_max   integer;
  v_par   record;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede cambiar la facturacion electronica.';
  end if;
  if v_sb !~ '^B[A-Z0-9]{3}$' then
    raise exception 'La serie de boleta debe tener 4 caracteres y empezar con B (ej. B001).';
  end if;
  if v_sf !~ '^F[A-Z0-9]{3}$' then
    raise exception 'La serie de factura debe tener 4 caracteres y empezar con F (ej. F001).';
  end if;

  for v_par in
    select * from (values (v_sb, p_ultimo_boleta), (v_sf, p_ultimo_factura)) as t(serie, ultimo)
  loop
    if v_par.ultimo is not null then
      if v_par.ultimo < 0 then
        raise exception 'El ultimo numero de % no puede ser negativo.', v_par.serie;
      end if;
      select coalesce(max(numero), 0) into v_max from public.comprobantes where serie = v_par.serie;
      if v_par.ultimo < v_max then
        raise exception 'El ultimo numero de % no puede ser menor a % (ya emitido por este sistema).',
          v_par.serie, v_max;
      end if;
      insert into public.series_correlativo (serie, ultimo) values (v_par.serie, v_par.ultimo)
        on conflict (serie) do update set ultimo = excluded.ultimo;
    end if;
  end loop;

  update public.facturacion_config
     set activo = coalesce(p_activo, false),
         serie_boleta = v_sb,
         serie_factura = v_sf,
         actualizado_en = now()
   where id = 1
   returning * into v_cfg;
  return v_cfg;
end;
$$;

-- ----------------------------------------------------------------------------
-- Proteccion: una venta con boleta/factura (enviada o en curso) NO se puede
-- anular ni cambiar de productos/montos: ante SUNAT eso requiere una Nota de
-- Credito. Se aplica como trigger para cubrir anular_venta, modificar_venta y
-- cualquier otro camino, sin tocar esas funciones. Solo un comprobante
-- 'rechazado' (que Nubefact nunca registro) no bloquea.
-- ----------------------------------------------------------------------------
create or replace function public.proteger_venta_con_comprobante()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_comp public.comprobantes%rowtype;
begin
  if new.anulada is distinct from old.anulada
     or new.total is distinct from old.total
     or new.subtotal is distinct from old.subtotal
     or new.descuento is distinct from old.descuento
     or new.metodo is distinct from old.metodo
     or new.modificada_en is distinct from old.modificada_en then
    select * into v_comp from public.comprobantes
      where venta_id = old.id and estado <> 'rechazado';
    if found then
      raise exception 'Esta venta tiene la % electronica %-%: no se puede anular ni cambiar. Ante SUNAT se requiere una Nota de Credito.',
        v_comp.tipo, v_comp.serie, v_comp.numero;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_proteger_venta_con_comprobante on public.ventas;
create trigger trg_proteger_venta_con_comprobante
  before update on public.ventas
  for each row execute function public.proteger_venta_con_comprobante();
