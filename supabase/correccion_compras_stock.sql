-- ----------------------------------------------------------------------------
-- RPC 2d: REGISTRAR COMPRA (atomico) y FIJAR STOCK (conteo fisico)
-- ----------------------------------------------------------------------------
-- (Este bloque tambien esta incluido en schema.sql. Se puede ejecutar solo en
-- el SQL Editor de Supabase sobre una base que ya tenga el schema: es
-- idempotente — "create or replace" — y no borra ni modifica datos.)
--
-- registrar_compra: antes el navegador guardaba la compra en 3 pasos
-- separados (cabecera, detalle, y un ajustar_stock por producto). El detalle
-- (detalle_compras) tiene RLS activado SIN ninguna politica de escritura, asi
-- que ese paso SIEMPRE fallaba: la cabecera quedaba guardada pero el stock de
-- la mercaderia comprada NUNCA se sumaba — por eso el negocio tenia producto
-- fisico que el sistema mostraba agotado. Ademas los errores de ajustar_stock
-- se ignoraban. Ahora todo ocurre en UNA transaccion: o se registra la compra
-- completa (cabecera + detalle + stock + kardex + costo) o no se registra nada.
create or replace function public.registrar_compra(
  p_numero            text,
  p_proveedor_id      uuid,
  p_fecha_compra      date,
  p_estado            estado_compra,
  p_notas             text,
  p_items             jsonb,
  p_actualizar_costo  boolean default true
)
returns public.compras
language plpgsql
security definer set search_path = public
as $$
declare
  v_compra     public.compras%rowtype;
  v_item       jsonb;
  v_prod       public.productos%rowtype;
  v_prod_id    uuid;
  v_nombre     text;
  v_cantidad   numeric;
  v_precio     numeric;
  v_total      numeric := 0;
  v_prov       text;
  v_usuario    text;
  v_motivo     text;
  v_nuevo      double precision;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede registrar compras.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Agrega al menos un producto a la compra.';
  end if;

  -- 1) Validar TODO antes de escribir nada.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio   := coalesce((v_item->>'precio_unitario')::numeric, 0);
    v_nombre   := nullif(btrim(coalesce(v_item->>'producto_nombre', '')), '');
    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad de "%" debe ser mayor a 0.', coalesce(v_nombre, 'un producto');
    end if;
    if v_precio < 0 then
      raise exception 'El precio de "%" no puede ser negativo.', coalesce(v_nombre, 'un producto');
    end if;
    v_prod_id := nullif(v_item->>'producto_id', '')::uuid;
    if v_prod_id is not null and not exists (select 1 from public.productos where id = v_prod_id) then
      raise exception 'El producto "%" ya no existe en el inventario.', coalesce(v_nombre, v_prod_id::text);
    end if;
    if v_prod_id is null and v_nombre is null then
      raise exception 'Hay un producto sin nombre en la compra.';
    end if;
    v_total := v_total + round(v_cantidad * v_precio, 2);
  end loop;

  select nombre into v_prov from public.proveedores where id = p_proveedor_id;
  select nombre into v_usuario from public.perfiles where id = auth.uid();

  -- 2) Cabecera.
  insert into public.compras (numero, proveedor_id, proveedor_nombre, total, estado, fecha_compra, notas)
  values (
    nullif(btrim(coalesce(p_numero, '')), ''), p_proveedor_id, v_prov, round(v_total, 2),
    coalesce(p_estado, 'pendiente'), coalesce(p_fecha_compra, current_date),
    nullif(btrim(coalesce(p_notas, '')), '')
  )
  returning * into v_compra;

  v_motivo := 'Compra ' || coalesce('#' || v_compra.numero, left(v_compra.id::text, 8));

  -- 3) Detalle + stock + kardex (+ costo).
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio   := coalesce((v_item->>'precio_unitario')::numeric, 0);
    v_prod_id  := nullif(v_item->>'producto_id', '')::uuid;
    v_nombre   := nullif(btrim(coalesce(v_item->>'producto_nombre', '')), '');

    if v_prod_id is not null then
      select * into v_prod from public.productos where id = v_prod_id for update;
      v_nombre := coalesce(v_nombre, v_prod.nombre);
      v_nuevo  := v_prod.stock_actual + v_cantidad;

      update public.productos
         set stock_actual  = v_nuevo,
             precio_compra = case when p_actualizar_costo and v_precio > 0
                                  then round(v_precio, 2) else precio_compra end
       where id = v_prod.id;

      insert into public.movimientos_inventario (
        producto_id, producto_nombre, tipo, cantidad,
        stock_previo, stock_nuevo, motivo, usuario_id, usuario_nombre
      ) values (
        v_prod.id, v_prod.nombre, 'entrada', v_cantidad,
        v_prod.stock_actual, v_nuevo, v_motivo, auth.uid(), v_usuario
      );
    end if;

    insert into public.detalle_compras (compra_id, producto_id, producto_nombre, cantidad, precio_unitario, subtotal)
    values (v_compra.id, v_prod_id, v_nombre, v_cantidad, round(v_precio, 2), round(v_cantidad * v_precio, 2));
  end loop;

  return v_compra;
end;
$$;

-- Politica de escritura que faltaba en detalle_compras (solo administrador,
-- igual que "compras"). registrar_compra no la necesita (security definer),
-- pero sin ella cualquier otro camino de escritura falla en silencio.
drop policy if exists det_compras_write on public.detalle_compras;
create policy det_compras_write on public.detalle_compras for all
  to authenticated using (public.es_admin()) with check (public.es_admin());

-- fijar_stock: "Ajuste" por conteo fisico. Antes el navegador calculaba la
-- diferencia (contado - stock que mostraba la pantalla) y enviaba esa
-- diferencia: si entre medio se vendio algo, el stock final quedaba distinto
-- a lo contado. Aqui la diferencia se calcula en el servidor, con el stock
-- REAL bloqueado, y el resultado es exactamente el numero contado.
create or replace function public.fijar_stock(
  p_producto_id uuid,
  p_stock       numeric,
  p_motivo      text default null
)
returns public.productos
language plpgsql
security definer set search_path = public
as $$
declare
  v_prod    public.productos%rowtype;
  v_usuario text;
  v_previo  double precision;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede ajustar el stock.';
  end if;
  if p_stock is null or p_stock < 0 then
    raise exception 'El stock contado no puede ser negativo.';
  end if;

  select * into v_prod from public.productos where id = p_producto_id for update;
  if not found then raise exception 'Producto no encontrado.'; end if;
  v_previo := v_prod.stock_actual;

  if abs(v_previo - p_stock) < 1e-9 then
    return v_prod; -- ya coincide: no se registra un movimiento vacio
  end if;

  update public.productos set stock_actual = p_stock where id = p_producto_id
    returning * into v_prod;

  select nombre into v_usuario from public.perfiles where id = auth.uid();
  insert into public.movimientos_inventario (
    producto_id, producto_nombre, tipo, cantidad,
    stock_previo, stock_nuevo, motivo, usuario_id, usuario_nombre
  ) values (
    v_prod.id, v_prod.nombre, 'ajuste', p_stock - v_previo,
    v_previo, p_stock, coalesce(nullif(btrim(coalesce(p_motivo, '')), ''), 'Conteo fisico'),
    auth.uid(), v_usuario
  );

  return v_prod;
end;
$$;
