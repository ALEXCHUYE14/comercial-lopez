-- ============================================================================
-- LIMPIAR COMPROBANTES DE PRUEBA (modo DEMO) antes de pasar a la cuenta REAL
-- ============================================================================
-- Ejecutar UNA SOLA VEZ en Supabase (SQL Editor) cuando se cambie de la
-- cuenta de pruebas de Nubefact a la cuenta real del negocio
-- (RUC 20616478118 - COMERCIAL LOPEZ JYD E.I.R.L.).
--
-- Que hace:
--  1. Borra SOLO los comprobantes de las series de prueba indicadas abajo.
--     Las ventas NO se borran: vuelven a ser notas de venta normales (se
--     pueden anular/cambiar y emitirles su boleta real despues).
--  2. Reinicia el contador de esas series de prueba.
--  3. Desactiva la facturacion para que el administrador configure las
--     series REALES en Configuracion antes de volver a emitir.
--
-- Candado: si existe algun comprobante de una serie que NO esta en la lista
-- de prueba, el script se detiene sin borrar nada (nunca toca comprobantes
-- reales). Ajusta la lista si en demo usaste otras series.
do $$
declare
  v_series_demo text[] := array['BBB1', 'FFF1'];  -- <-- series de PRUEBA
  v_reales      integer;
  v_borrados    integer;
begin
  select count(*) into v_reales
    from public.comprobantes
    where serie <> all (v_series_demo);
  if v_reales > 0 then
    raise exception 'Hay % comprobante(s) de series que NO son de prueba. No se borro nada. Revisa la lista v_series_demo.', v_reales;
  end if;

  delete from public.comprobantes where serie = any (v_series_demo);
  get diagnostics v_borrados = row_count;
  delete from public.series_correlativo where serie = any (v_series_demo);
  update public.facturacion_config set activo = false, actualizado_en = now() where id = 1;

  raise notice 'Listo: % comprobante(s) de prueba eliminados. La facturacion quedo DESACTIVADA: configura las series reales en Configuracion.', v_borrados;
end $$;
