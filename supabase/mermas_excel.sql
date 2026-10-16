-- ----------------------------------------------------------------------------
-- RPC 2c: REGISTRAR MERMA (atomico) e IMPORTAR MERMAS DESDE EXCEL (backup)
-- ----------------------------------------------------------------------------
-- (Este bloque tambien esta incluido en schema.sql. Se puede ejecutar solo,
-- en el SQL Editor de Supabase, sobre una base que ya tenga el schema: es
-- idempotente — "create or replace" — y no borra ni modifica datos.)
--
-- registrar_merma: registra la merma y descuenta el stock en UNA transaccion.
-- Antes el navegador hacia dos llamadas separadas (insertar la merma y luego
-- ajustar_stock): si la segunda fallaba, la merma quedaba registrada sin
-- descontar stock. Ademas se enviaba la cantidad en POSITIVO a ajustar_stock,
-- que SUMA lo que recibe — cada merma aumentaba el stock en vez de restarlo.
create or replace function public.registrar_merma(
  p_producto_id     uuid,
  p_producto_nombre text,
  p_cantidad        numeric,
  p_costo_unitario  numeric,
  p_motivo          motivo_merma,
  p_descripcion     text default null,
  p_fecha           timestamptz default null
)
returns public.mermas
language plpgsql
security definer set search_path = public
as $$
declare
  v_prod     public.productos%rowtype;
  v_merma    public.mermas%rowtype;
  v_nombre   text;
  v_usuario  text;
  v_nuevo    double precision;
  v_costo    numeric;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede registrar mermas.';
  end if;
  if p_cantidad is null or p_cantidad <= 0 then
    raise exception 'La cantidad debe ser mayor a 0.';
  end if;
  if p_costo_unitario is not null and p_costo_unitario < 0 then
    raise exception 'El costo unitario no puede ser negativo.';
  end if;

  v_nombre := nullif(btrim(coalesce(p_producto_nombre, '')), '');
  v_costo  := p_costo_unitario;

  if p_producto_id is not null then
    select * into v_prod from public.productos where id = p_producto_id for update;
    if not found then raise exception 'Producto no encontrado.'; end if;

    v_nuevo := v_prod.stock_actual - p_cantidad;
    if v_nuevo < -1e-9 then
      raise exception 'Stock insuficiente para "%": disponible %, merma %.',
        v_prod.nombre, v_prod.stock_actual, p_cantidad;
    end if;
    if v_nuevo < 0 then v_nuevo := 0; end if; -- residuo de redondeo

    update public.productos set stock_actual = v_nuevo where id = v_prod.id;

    select nombre into v_usuario from public.perfiles where id = auth.uid();
    insert into public.movimientos_inventario (
      producto_id, producto_nombre, tipo, cantidad,
      stock_previo, stock_nuevo, motivo, usuario_id, usuario_nombre
    ) values (
      v_prod.id, v_prod.nombre, 'salida', -p_cantidad,
      v_prod.stock_actual, v_nuevo,
      'Merma: ' || case p_motivo
        when 'vencido' then 'Producto vencido'
        when 'danado' then 'Producto dañado'
        when 'consumo_interno' then 'Consumo interno'
        else 'Otro motivo'
      end,
      auth.uid(), v_usuario
    );

    v_nombre := coalesce(v_nombre, v_prod.nombre);
    v_costo  := coalesce(v_costo, v_prod.precio_compra);
  end if;

  if v_nombre is null then
    raise exception 'Falta el nombre del producto.';
  end if;
  v_costo := coalesce(v_costo, 0);

  insert into public.mermas (
    producto_id, producto_nombre, cantidad, costo_unitario, costo_total,
    motivo, descripcion, usuario_id, creado_en
  ) values (
    p_producto_id, v_nombre, p_cantidad, round(v_costo, 2), round(p_cantidad * v_costo, 2),
    p_motivo, nullif(btrim(coalesce(p_descripcion, '')), ''), auth.uid(), coalesce(p_fecha, now())
  )
  returning * into v_merma;

  return v_merma;
end;
$$;

-- importar_mermas: recibe las filas ya leidas del .xlsx (ver
-- src/utils/mermasExcel.ts). Cada fila en su propia sub-transaccion (igual que
-- importar_productos): una fila con error no bloquea las demas.
--   - Fila CON "id" (viene de un Excel exportado = backup): se RESTAURA el
--     registro historico tal cual, SIN tocar el stock (el stock de ese momento
--     ya se desconto cuando la merma se registro; descontarlo otra vez seria
--     duplicarlo). Si ese id ya existe, se omite: subir el mismo backup dos
--     veces no duplica nada.
--   - Fila SIN "id" (merma nueva escrita en el Excel): se registra con
--     registrar_merma (descuenta stock). Si trae fecha y ya existe una merma
--     identica (mismo producto, cantidad, motivo y minuto), se omite como
--     posible duplicado.
--   - El producto se vincula por SKU; sin SKU, por nombre exacto si hay uno
--     solo con ese nombre. Una merma nueva con un SKU que no existe es un
--     error (no se registra sin descontar stock en silencio).
create or replace function public.importar_mermas(p_filas jsonb)
returns table (fila integer, producto text, accion text, mensaje text)
language plpgsql
security definer set search_path = public
as $$
declare
  v_fila         jsonb;
  v_fila_num     integer;
  v_id           uuid;
  v_sku          text;
  v_nombre       text;
  v_cantidad     numeric;
  v_costo        numeric;
  v_costo_total  numeric;
  v_motivo_txt   text;
  v_motivo       motivo_merma;
  v_desc         text;
  v_fecha        timestamptz;
  v_fecha_txt    text;
  v_usuario      uuid;
  v_prod_id      uuid;
  v_prod_nombre  text;
  v_coincid      integer;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede importar mermas.';
  end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then
    raise exception 'El archivo no tiene filas para importar.';
  end if;

  for v_fila in select * from jsonb_array_elements(p_filas)
  loop
    v_fila_num := coalesce((v_fila->>'fila')::integer, 0);
    v_nombre   := nullif(btrim(coalesce(v_fila->>'producto', '')), '');
    begin -- sub-transaccion por fila
      -- ID (opcional)
      begin
        v_id := nullif(btrim(coalesce(v_fila->>'id', '')), '')::uuid;
      exception when others then
        raise exception 'El ID "%" no es valido (no lo edites; dejalo vacio para una merma nueva).', v_fila->>'id';
      end;

      if v_id is not null and exists (select 1 from public.mermas where id = v_id) then
        fila := v_fila_num; producto := coalesce(v_nombre, ''); accion := 'omitida';
        mensaje := 'Ya existe en el sistema.';
        return next;
        continue;
      end if;

      v_sku      := nullif(btrim(coalesce(v_fila->>'sku', '')), '');
      v_cantidad := (v_fila->>'cantidad')::numeric;
      v_costo    := (v_fila->>'costo_unitario')::numeric;
      v_costo_total := (v_fila->>'costo_total')::numeric;
      v_desc     := nullif(btrim(coalesce(v_fila->>'descripcion', '')), '');

      if v_cantidad is null or v_cantidad <= 0 then
        raise exception 'La cantidad debe ser mayor a 0.';
      end if;
      if v_costo is not null and v_costo < 0 then
        raise exception 'El costo unitario no puede ser negativo.';
      end if;

      v_motivo_txt := lower(btrim(coalesce(v_fila->>'motivo', '')));
      if v_motivo_txt not in ('vencido', 'danado', 'consumo_interno', 'otro') then
        raise exception 'Motivo "%" no valido. Usa: Producto vencido, Producto dañado, Consumo interno u Otro motivo.',
          coalesce(v_fila->>'motivo', '');
      end if;
      v_motivo := v_motivo_txt::motivo_merma;

      v_fecha_txt := nullif(btrim(coalesce(v_fila->>'fecha', '')), '');
      begin
        v_fecha := v_fecha_txt::timestamptz;
      exception when others then
        raise exception 'La fecha "%" no es valida (usa AAAA-MM-DD HH:MM).', v_fecha_txt;
      end;

      -- Producto: por SKU, o por nombre exacto si es unico.
      v_prod_id := null;
      v_prod_nombre := null;
      if v_sku is not null then
        select id, nombre into v_prod_id, v_prod_nombre from public.productos where productos.sku = v_sku;
        if v_prod_id is null and v_id is null then
          raise exception 'No existe un producto con SKU "%".', v_sku;
        end if;
      elsif v_nombre is not null then
        select count(*) into v_coincid from public.productos
          where lower(btrim(productos.nombre)) = lower(v_nombre) and activo;
        if v_coincid = 1 then
          select id, nombre into v_prod_id, v_prod_nombre from public.productos
            where lower(btrim(productos.nombre)) = lower(v_nombre) and activo;
        end if;
      end if;
      v_nombre := coalesce(v_nombre, v_prod_nombre);
      if v_nombre is null then
        raise exception 'Falta el nombre del producto.';
      end if;

      if v_id is not null then
        -- RESTAURAR registro historico (sin tocar stock).
        begin
          v_usuario := nullif(btrim(coalesce(v_fila->>'usuario_id', '')), '')::uuid;
        exception when others then
          v_usuario := null;
        end;
        if v_usuario is not null and not exists (select 1 from public.perfiles where id = v_usuario) then
          v_usuario := null;
        end if;
        v_costo := coalesce(v_costo, 0);
        insert into public.mermas (
          id, producto_id, producto_nombre, cantidad, costo_unitario, costo_total,
          motivo, descripcion, usuario_id, creado_en
        ) values (
          v_id, v_prod_id, v_nombre, v_cantidad, round(v_costo, 2),
          round(coalesce(v_costo_total, v_cantidad * v_costo), 2),
          v_motivo, v_desc, v_usuario, coalesce(v_fecha, now())
        );
        fila := v_fila_num; producto := v_nombre; accion := 'restaurada';
        mensaje := null;
        return next;
      else
        -- MERMA NUEVA (descuenta stock). Evita duplicar si ya se importo.
        if v_fecha is not null and exists (
          select 1 from public.mermas m
          where m.producto_nombre = v_nombre
            and m.producto_id is not distinct from v_prod_id
            and abs(m.cantidad - v_cantidad) < 1e-9
            and m.motivo = v_motivo
            and date_trunc('minute', m.creado_en) = date_trunc('minute', v_fecha)
        ) then
          fila := v_fila_num; producto := v_nombre; accion := 'omitida';
          mensaje := 'Ya existe una merma igual con la misma fecha (posible duplicado).';
          return next;
          continue;
        end if;

        perform public.registrar_merma(v_prod_id, v_nombre, v_cantidad, v_costo, v_motivo, v_desc, v_fecha);
        fila := v_fila_num; producto := v_nombre; accion := 'registrada';
        mensaje := case when v_prod_id is null
          then 'Sin vincular al inventario: no se descontó stock.' else null end;
        return next;
      end if;

    exception when others then
      fila := v_fila_num; producto := coalesce(v_nombre, ''); accion := 'error'; mensaje := sqlerrm;
      return next;
    end;
  end loop;

  return;
end;
$$;
