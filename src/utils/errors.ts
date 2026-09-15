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

/**
 * Igual que mensajeError, pero para errores de `supabase.functions.invoke()`
 * (Edge Functions). Cuando la funcion responde con un status distinto de 2xx,
 * supabase-js NO expone el cuerpo JSON de la respuesta en `error.message`
 * (que queda con un texto generico tipo "Edge Function returned a non-2xx
 * status code") — el mensaje real que arma la funcion (ej. "Ya existe un
 * usuario con ese correo electrónico.") viaja en `error.context`, la
 * Response cruda, y hay que leerla aparte.
 */
export async function mensajeErrorFuncion(e: unknown, fallback: string): Promise<string> {
  if (e && typeof e === 'object' && 'context' in e) {
    const contexto = (e as { context?: unknown }).context
    if (contexto instanceof Response) {
      try {
        const cuerpo = await contexto.clone().json()
        if (cuerpo && typeof cuerpo === 'object' && typeof (cuerpo as { error?: unknown }).error === 'string') {
          return (cuerpo as { error: string }).error
        }
      } catch {
        // El cuerpo no era JSON valido (ej. la funcion ni siquiera respondio,
        // ni un 500 gateway) — cae al mensaje generico de abajo.
      }
    }
  }
  return mensajeError(e, fallback)
}
