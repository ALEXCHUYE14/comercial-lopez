-- ----------------------------------------------------------------------------
-- RPC 1b: NOMBRE DEL CLIENTE EN LA NOTA DE VENTA
-- ----------------------------------------------------------------------------
-- (Este bloque tambien esta incluido en schema.sql. Se puede ejecutar solo,
-- en el SQL Editor de Supabase, sobre una base que ya tenga el schema: es
-- idempotente — "create or replace" — y no borra ni modifica datos.)
--
-- Permite escribir el nombre del cliente al entregarle su nota de venta
-- (ventas al contado: efectivo, yape, mixto). Solo cambia el texto
-- ventas.cliente_nombre: NO toca montos, stock, caja ni deudas.
--
-- Reglas (el servidor no confia en el navegador):
--  - Solo el cajero que registro la venta o un administrador.
--  - No en ventas anuladas.
--  - No en ventas al fiado (cliente_id): ahi el cliente es el de la cuenta de
--    credito y no debe poder cambiarse.
--  - El nombre se limpia (sin caracteres de control, espacios colapsados) y
--    se limita a 80 caracteres. Vacio = vuelve a "Publico General".
create or replace function public.asignar_cliente_nota_venta(
  p_venta_id uuid,
  p_nombre   text
)
returns public.ventas
language plpgsql
security definer set search_path = public
as $$
declare
  v_venta  public.ventas%rowtype;
  v_nombre text;
begin
  if auth.uid() is null then
    raise exception 'Sesion no valida.';
  end if;

  v_nombre := regexp_replace(coalesce(p_nombre, ''), '[[:cntrl:]]', ' ', 'g');
  v_nombre := nullif(btrim(regexp_replace(v_nombre, '[[:space:]]+', ' ', 'g')), '');
  if v_nombre is not null and char_length(v_nombre) > 80 then
    raise exception 'El nombre del cliente no puede superar 80 caracteres.';
  end if;

  select * into v_venta from public.ventas where id = p_venta_id for update;
  if not found then
    raise exception 'La venta no existe.';
  end if;
  if v_venta.cajero_id is distinct from auth.uid() and not public.es_admin() then
    raise exception 'Solo el cajero que registro la venta o un administrador puede cambiar el cliente.';
  end if;
  if v_venta.anulada then
    raise exception 'La venta esta anulada.';
  end if;
  if v_venta.cliente_id is not null then
    raise exception 'Es una venta al fiado: el cliente ya esta asignado y no se puede cambiar.';
  end if;

  update public.ventas
     set cliente_nombre = v_nombre
   where id = p_venta_id
   returning * into v_venta;
  return v_venta;
end;
$$;
