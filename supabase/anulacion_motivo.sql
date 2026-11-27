-- ----------------------------------------------------------------------------
-- RPC 3 (v2): ANULAR VENTA con MOTIVO OBLIGATORIO
-- ----------------------------------------------------------------------------
-- (Este bloque tambien esta incluido en schema.sql. Se puede ejecutar solo,
-- en el SQL Editor de Supabase, sobre una base que ya tenga el schema: es
-- idempotente y no borra ni modifica ventas existentes.)
--
-- Igual que antes repone el stock, revierte la caja/deuda y deja el kardex;
-- ademas exige un MOTIVO y guarda el NOMBRE de quien anulo, para que el
-- administrador y el supervisor revisen las anulaciones en Auditoria (un
-- supervisor no puede leer los perfiles de otros usuarios, por eso el nombre
-- se guarda aqui, igual que cajero_nombre).
alter table public.ventas add column if not exists anulada_por uuid;
alter table public.ventas add column if not exists anulada_en  timestamptz;
alter table public.ventas add column if not exists anulada_motivo     text;
alter table public.ventas add column if not exists anulada_por_nombre text;

-- La firma vieja (solo p_venta_id) se elimina: si quedaran las dos, una
-- llamada con un solo parametro seria ambigua y fallaria.
drop function if exists public.anular_venta(uuid);
create or replace function public.anular_venta(
  p_venta_id uuid,
  -- Obligatorio (minimo 5 caracteres). Tiene default solo para que una
  -- version vieja de la app reciba un mensaje claro en vez de "funcion no
  -- encontrada".
  p_motivo   text default null
)
returns public.ventas
language plpgsql
security definer set search_path = public
as $$
declare
  v_venta   public.ventas%rowtype;
  v_det     record;
  v_prod    public.productos%rowtype;
  v_caja    public.cajas%rowtype;
  v_nombre  text;
  v_admin   boolean;
  v_pg      record;
  v_motivo  text;
begin
  if auth.uid() is null then
    raise exception 'Sesion no valida.';
  end if;
  v_admin := public.es_admin();

  -- Motivo obligatorio: queda en el historial para la auditoria.
  v_motivo := nullif(btrim(regexp_replace(
    regexp_replace(coalesce(p_motivo, ''), '[[:cntrl:]]', ' ', 'g'), '[[:space:]]+', ' ', 'g')), '');
  if v_motivo is null or char_length(v_motivo) < 5 then
    raise exception 'Indica el motivo de la anulacion (minimo 5 caracteres). Si no ves el campo, recarga la app.';
  end if;
  if char_length(v_motivo) > 200 then
    raise exception 'El motivo es demasiado largo (maximo 200 caracteres).';
  end if;

  select * into v_venta from public.ventas where id = p_venta_id for update;
  if not found then raise exception 'Venta no encontrada.'; end if;
  if v_venta.anulada then raise exception 'La venta ya esta anulada.'; end if;

  if not v_admin then
    if v_venta.cajero_id is distinct from auth.uid() then
      raise exception 'Solo puedes anular tus propias ventas. Pide a un administrador que anule esta.';
    end if;
    if v_venta.caja_id is null then
      raise exception 'Esta venta no esta asociada a una caja abierta. Pide a un administrador que la anule.';
    end if;
    select * into v_caja from public.cajas where id = v_venta.caja_id;
    if not found or v_caja.estado <> 'abierta' or v_caja.cajero_id is distinct from auth.uid() then
      raise exception 'La caja de esta venta ya fue cerrada. Pide a un administrador que la anule.';
    end if;
  end if;

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

  -- Caja: solo si sigue abierta (ver cabecera). greatest(...,0) evita un total
  -- negativo si por una falla previa esa venta nunca llego a sumarse a la caja.
  if v_venta.caja_id is not null then
    select * into v_caja from public.cajas where id = v_venta.caja_id for update;
    if found and v_caja.estado = 'abierta' then
      if v_venta.metodo = 'efectivo' then
        update public.cajas set total_efectivo = greatest(total_efectivo - v_venta.total, 0) where id = v_caja.id;
      elsif v_venta.metodo = 'yape' then
        update public.cajas set total_yape = greatest(total_yape - v_venta.total, 0) where id = v_caja.id;
      elsif v_venta.metodo = 'fiado' then
        update public.cajas set total_fiado = greatest(total_fiado - v_venta.total, 0) where id = v_caja.id;
      elsif v_venta.metodo::text = 'mixto' and jsonb_typeof(v_venta.pagos) = 'array' then
        -- Pago mixto: cada parte se resta del acumulado de SU metodo (la parte
        -- en efectivo del efectivo, la de yape del yape).
        for v_pg in
          select e.item->>'metodo' as metodo, (e.item->>'monto')::numeric as monto
          from jsonb_array_elements(v_venta.pagos) as e(item)
        loop
          if v_pg.metodo = 'efectivo' then
            update public.cajas set total_efectivo = greatest(total_efectivo - v_pg.monto, 0) where id = v_caja.id;
          elsif v_pg.metodo = 'yape' then
            update public.cajas set total_yape = greatest(total_yape - v_pg.monto, 0) where id = v_caja.id;
          end if;
        end loop;
      end if;
    end if;
  end if;

  -- Fiado: la deuda que esta venta le cargo al cliente deja de existir.
  if v_venta.metodo = 'fiado' and v_venta.cliente_id is not null then
    update public.clientes_credito
      set deuda_actual = greatest(deuda_actual - v_venta.total, 0)
      where id = v_venta.cliente_id;
  end if;

  update public.ventas
    set anulada = true, anulada_por = auth.uid(), anulada_en = now(),
        anulada_por_nombre = v_nombre, anulada_motivo = v_motivo
    where id = p_venta_id
    returning * into v_venta;

  return v_venta;
end;
$$;
