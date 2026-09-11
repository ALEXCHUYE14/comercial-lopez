// Extrae un mensaje legible de un error atrapado en un catch (tipado como
// `unknown`). No basta con `e instanceof Error`: los errores que arma
// supabase-js para una llamada RPC (PostgrestError) SI extienden Error, pero
// otros casos (network errors serializados, objetos planos con "message"
// levantados por libs de terceros, etc.) no lo hacen — y en ese caso
// `e instanceof Error` es false aunque el objeto tenga info util en
// `.message`. Devolver un mensaje generico ahi oculta el motivo real del
// fallo (ver bug: cierre de caja mostraba "Error al cerrar la caja" sin mas
// detalle porque el catch de Caja.tsx solo miraba `instanceof Error`).
export function mensajeError(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return fallback
}
